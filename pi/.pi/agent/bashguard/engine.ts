/**
 * bashguard engine — a declarative, evasion-resistant guard for agent bash
 * commands. Pure library: no I/O besides rule-file reads and audit logging.
 *
 * Instead of substring-matching raw command strings (bypassable via
 * `sudo`/`timeout`/`cd` prefixes and prone to false positives), the engine:
 *
 *   - tokenizes with a POSIX-ish scanner (quotes, escapes, comments,
 *     line continuations; newlines inside quotes are handled correctly),
 *   - strips heredoc bodies (they are data, not commands),
 *   - extracts command/process substitutions ($(...), `...`, <(...), >(...))
 *     and evaluates their contents as commands too,
 *   - splits into segments on shell chain operators (&& || | ; & newline
 *     and subshell/group delimiters),
 *   - peels command modifiers (sudo/env/nice/timeout/nohup/xargs/...) so
 *     `timeout 30 find ...` is judged as `find ...`,
 *   - recurses into `bash|sh|zsh|dash|ksh -c '<script>'` and `eval ...`
 *     payloads,
 *   - tracks a cwd cursor across literal `cd <path>` segments,
 *   - then evaluates each segment against data-driven JSON rules.
 *
 * RULES
 * -----
 * A rule is an object whose non-reserved keys are matchers; ALL matchers
 * must pass (and no exempter may fire) for the rule to trigger. Built-ins:
 *
 *   command:            basename of seg[0] equals this
 *   command_in:         basename of seg[0] is in this list
 *   subcommand:         seg[1] equals this
 *   subcommand_in:      seg[1] is in this list
 *   verb_in:            token after the matched subcommand (seg[2] if
 *                       subcommand/subcommand_in present, else seg[1])
 *                       is in this list
 *   any_flag:           at least one of these tokens appears in seg
 *   any_flag_regex:     regex matched (anchored) against tokens starting "-"
 *   arg_regex:          regex searched against seg[1..] joined by spaces
 *   python_target_in:   python script/module invoked (basename, no .py)
 *                       is in this list; handles `python3 X.py`,
 *                       `python3 -m X`, `./X.py`
 *   unless_any_flag:    EXEMPTER — rule does not fire if any token matches
 *   unless_arg_regex:   EXEMPTER — rule does not fire if this regex matches
 *                       the args (inverse of arg_regex)
 *   exempt_shallow_via: EXEMPTER — {"flags": [...], "max_value": N}; rule
 *                       does not fire if a listed flag carries an int <= N
 *   severity:           "block" (default) or "warn"
 *   reason:             text reported when the rule fires
 *
 * Additional matchers/exempters can be registered via registerMatcher /
 * registerExempter (see docs in this repo). FAIL-SAFE: a rule containing an
 * unregistered key never fires; it is reported in Verdict.skippedRules so
 * a missing site extension surfaces as a visible skip, not as over-blocking.
 *
 * LAYERED SOURCES
 * ---------------
 * Rules load from an ordered list of JSON files ({rules: [...],
 * disable_rules: [...], ...config}). Later layers replace earlier rules with
 * the same id; disable_rules from any layer removes that id; other config
 * keys (used by registered matchers) are merged per-key, later wins.
 * BASHGUARD_RULES (colon-separated paths) overrides the source list.
 *
 * ENVIRONMENT
 * -----------
 *   BASHGUARD_RULES      colon-separated rule files (overrides all defaults)
 *   BASHGUARD_MODE       "warn" downgrades every firing rule to a warning
 *   BASHGUARD_AUDIT_LOG  audit path (default /tmp/bashguard-audit.log,
 *                        empty string disables)
 *
 * Evaluation is budgeted (soft deadline); on overrun the remainder of the
 * command is allowed and the overrun is noted in the verdict and stall log.
 */

import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "block" | "warn";

export interface Rule {
  id?: string;
  severity?: Severity;
  reason?: string;
  [key: string]: unknown;
}

export interface RulesConfig {
  rules: Rule[];
  disable_rules?: string[];
  [key: string]: unknown;
}

/** Passed to matchers; `cache` lets extensions memoize (e.g. mount scans). */
export interface EvalContext {
  cwd: string;
  config: RulesConfig;
  cache: Map<string, unknown>;
}

export type MatcherFn = (value: unknown, seg: string[], ctx: EvalContext, rule: Rule) => boolean;

export interface Fire {
  ruleId: string;
  severity: Severity;
  reason: string;
  seg: string[];
}

export interface SkippedRule {
  id: string;
  unknownKeys: string[];
}

export interface Verdict {
  decision: "block" | "warn" | "allow";
  /** All fired rules in evaluation order; on block, the block is last. */
  fires: Fire[];
  blocked?: Fire;
  skippedRules: SkippedRule[];
  /** Load errors, budget overruns, recursion caps — anything non-fatal. */
  notes: string[];
}

export interface EvaluateOptions {
  cwd: string;
  /** Rule files, in layer order. Default: resolveSources(). */
  sources?: string[];
  /** "warn" downgrades blocks. Default: BASHGUARD_MODE. */
  mode?: string;
  /** Included in audit records for attribution. */
  session?: string;
  /** Write audit records for fires (default true). */
  audit?: boolean;
}

const BUDGET_MS = 800;
const MAX_DEPTH = 4;
const MAX_SEGMENTS = 400;
const DEFAULT_AUDIT_LOG = "/tmp/bashguard-audit.log";
const STALL_LOG = "/tmp/bashguard-stalls.log";

// --- tainted-var tracking for sensitive file indirection ---
// The "for f in arr/.env; do cat \"$f\"; done" bypass worked because the
// reader segment "cat \"$f\"" contains no literal ".env". We track vars
// whose assigned value contained a sensitive literal and flag readers that
// dereference them. Whole-script fallback also catches cases where the
// assignment was missed by segment splitting.
const DOTENV_READERS = new Set([
  "cat", "head", "tail", "bat", "nl", "tac", "strings", "xxd", "hexdump", "od", "base64",
  "grep", "egrep", "fgrep", "rg", "ag", "awk", "sed", "cut", "paste", "column", "sort", "uniq",
]);
// Anything that can consume or exfiltrate a file path without being in the
// narrow DOTENV_READERS list. If a tainted var flows here we still want to
// block — "cp $f /tmp/x" is as bad as "cat $f".
const SENSITIVE_CONSUMERS = new Set([
  ...DOTENV_READERS,
  "less", "more", "cp", "mv", "install", "dd", "tar", "zip", "unzip", "scp", "sftp", "rsync",
  "curl", "wget", "nc", "ncat", "netcat", "socat", "python", "python2", "python3", "node", "php", "ruby", "perl",
  "source", ".", "env", "printenv", "set", "export",
]);
// Harmless commands that merely mention a path — don't block the fallback for these.
const HARMLESS_WITH_TAINTED_VAR = new Set(["echo", "printf", "ls", "test", "[", "true", "false"]);
// Same shape as the no-read-dotenv rule, but anchored to fire inside an
// arbitrary value string (pad with spaces so (^|[\\s/]) still applies).
const DOTENV_IN_VALUE_RE = /(^|[\s\/])\.env(?!\.(?:example|sample|template))(?:\.[A-Za-z0-9_.-]+)?(?:\s|$)/;
function containsDotenvLiteral(s: string): boolean {
  return DOTENV_IN_VALUE_RE.test(` ${s} `) || DOTENV_IN_VALUE_RE.test(` ${s}/ `);
}
// General sensitive substrings for taint (mirrors fileguard block list). Overblocking
// here is preferable to leaking secrets via indirection.
const SENSITIVE_SUBSTR_RE = /(?:\.env(?!\.(?:example|sample|template))|id_(?:rsa|ed25519|ecdsa|dsa)[\w.-]*|\.pem\b|\.key\b|\.p12\b|\.pfx\b|\.netrc\b|\.git-credentials\b|\.pgpass\b|\.aws\/credentials|\.gnupg\/|\.pi\/agent\/auth\.json)/;
function containsSensitiveLiteral(s: string): boolean {
  if (containsDotenvLiteral(s)) return true;
  return SENSITIVE_SUBSTR_RE.test(s);
}
function isDotenvReader(seg: string[]): boolean {
  if (seg.length === 0) return false;
  return DOTENV_READERS.has(baseName(seg[0]));
}
const VAR_REF_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
function isSensitiveConsumer(seg: string[]): boolean {
  if (seg.length === 0) return false;
  return SENSITIVE_CONSUMERS.has(baseName(seg[0]));
}
function segReferencesVar(seg: string[], varName: string): boolean {
  for (let i = 1; i < seg.length; i++) {
    VAR_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VAR_REF_RE.exec(seg[i])) !== null) if (m[1] === varName) return true;
  }
  return false;
}
function taintedVarRefsInSeg(seg: string[], tainted: Set<string>): string[] {
  const hits: string[] = [];
  for (let i = 1; i < seg.length; i++) {
    const tok = seg[i];
    if (!tok.includes("$")) continue;
    // Tokenizer stripped quotes, so '$f' inside single quotes looks like a ref
    // — we tolerate the false positive (over-block is safe).
    let m: RegExpExecArray | null;
    VAR_REF_RE.lastIndex = 0;
    while ((m = VAR_REF_RE.exec(tok)) !== null) {
      const name = m[1];
      if (tainted.has(name) && !hits.includes(name)) hits.push(name);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export interface Token {
  text: string;
  /** Chain/group operator that separates segments. */
  op: boolean;
}

export interface TokenizeResult {
  tokens: Token[];
  /** Contents of $(...), `...`, <(...), >(...) — evaluated as commands. */
  substitutions: string[];
}

const OP_CHAIN = new Set(["&&", "||", "|", ";", "&", "\n", "(", ")", "{", "}"]);

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\r";
}

function isDigits(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

/**
 * POSIX-ish tokenization. Never throws; unterminated quotes are closed at
 * EOF (bash itself would reject the command, so best-effort is safe and
 * strictly better than failing open).
 */
export function tokenize(cmd: string): TokenizeResult {
  const tokens: Token[] = [];
  const substitutions: string[] = [];
  let word = "";
  let wordStarted = false;
  let i = 0;
  const n = cmd.length;
  // Heredocs queued on the current line; bodies skipped at the newline.
  let pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];

  const pushWord = () => {
    if (wordStarted) {
      tokens.push({ text: word, op: false });
      word = "";
      wordStarted = false;
    }
  };
  const pushOp = (t: string) => {
    pushWord();
    tokens.push({ text: t, op: true });
  };

  /** Scan a $(...)-style region starting at `start` (index of "(").
      Returns index just past the closing ")". Collects inner content. */
  const scanParenSubstitution = (start: number): number => {
    let depth = 1;
    let j = start + 1;
    let quote: string | null = null;
    while (j < n && depth > 0) {
      const c = cmd[j];
      if (quote) {
        if (c === "\\" && quote === '"') j += 1;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === "\\") {
        j += 1;
      } else if (c === "(") {
        depth += 1;
      } else if (c === ")") {
        depth -= 1;
      }
      j += 1;
    }
    const content = cmd.slice(start + 1, depth === 0 ? j - 1 : j);
    if (content.trim()) substitutions.push(content);
    return j;
  };

  /** Scan `...` starting at index of opening backtick; returns index past
      the closing backtick. */
  const scanBacktick = (start: number): number => {
    let j = start + 1;
    let content = "";
    while (j < n) {
      const c = cmd[j];
      if (c === "\\" && j + 1 < n) {
        content += cmd[j + 1];
        j += 2;
        continue;
      }
      if (c === "`") {
        j += 1;
        break;
      }
      content += c;
      j += 1;
    }
    if (content.trim()) substitutions.push(content);
    return j;
  };

  /** Skip heredoc bodies following a newline at index `i` (points at "\n").
      Returns index of the first char after the last terminator line. */
  const skipHeredocBodies = (afterNewline: number): number => {
    let j = afterNewline;
    while (pendingHeredocs.length > 0 && j < n) {
      const { delim, stripTabs } = pendingHeredocs[0];
      let lineEnd = cmd.indexOf("\n", j);
      if (lineEnd === -1) lineEnd = n;
      let line = cmd.slice(j, lineEnd);
      if (stripTabs) line = line.replace(/^\t+/, "");
      j = lineEnd + 1;
      if (line === delim) pendingHeredocs.shift();
    }
    if (j > n) j = n;
    if (pendingHeredocs.length > 0) pendingHeredocs = []; // unterminated: rest was body
    return j;
  };

  /** Read a heredoc delimiter word at index j (after << / <<-). */
  const readHeredocDelim = (start: number): { delim: string; next: number } => {
    let j = start;
    while (j < n && isSpace(cmd[j])) j += 1;
    let delim = "";
    while (j < n && !isSpace(cmd[j]) && cmd[j] !== "\n" && !"<>|&;()".includes(cmd[j])) {
      const c = cmd[j];
      if (c === "'" || c === '"') {
        const close = cmd.indexOf(c, j + 1);
        if (close === -1) {
          delim += cmd.slice(j + 1);
          j = n;
        } else {
          delim += cmd.slice(j + 1, close);
          j = close + 1;
        }
      } else if (c === "\\") {
        if (j + 1 < n) delim += cmd[j + 1];
        j += 2;
      } else {
        delim += c;
        j += 1;
      }
    }
    return { delim, next: j };
  };

  while (i < n) {
    const c = cmd[i];

    if (c === "\\") {
      if (i + 1 < n && cmd[i + 1] === "\n") {
        i += 2; // line continuation
        continue;
      }
      if (i + 1 < n) {
        word += cmd[i + 1];
        wordStarted = true;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (c === "'") {
      let close = cmd.indexOf("'", i + 1);
      if (close === -1) close = n;
      word += cmd.slice(i + 1, close);
      wordStarted = true;
      i = close + 1;
      continue;
    }

    if (c === '"') {
      wordStarted = true;
      i += 1;
      while (i < n && cmd[i] !== '"') {
        const d = cmd[i];
        if (d === "\\" && i + 1 < n && '"$`\\\n'.includes(cmd[i + 1])) {
          if (cmd[i + 1] !== "\n") word += cmd[i + 1];
          i += 2;
          continue;
        }
        if (d === "$" && cmd[i + 1] === "(") {
          if (cmd[i + 2] === "(") {
            // $((arithmetic)) — raw text, no substitution
            const end = cmd.indexOf("))", i + 3);
            const stop = end === -1 ? n : end + 2;
            word += cmd.slice(i, stop);
            i = stop;
            continue;
          }
          const end = scanParenSubstitution(i + 1);
          word += cmd.slice(i, end);
          i = end;
          continue;
        }
        if (d === "`") {
          const end = scanBacktick(i);
          word += cmd.slice(i, end);
          i = end;
          continue;
        }
        word += d;
        i += 1;
      }
      i += 1; // closing quote (or EOF)
      continue;
    }

    if (c === "#" && !wordStarted) {
      let end = cmd.indexOf("\n", i);
      if (end === -1) end = n;
      i = end;
      continue;
    }

    if (isSpace(c)) {
      pushWord();
      i += 1;
      continue;
    }

    if (c === "\n") {
      pushWord();
      pushOp("\n");
      i += 1;
      if (pendingHeredocs.length > 0) i = skipHeredocBodies(i);
      continue;
    }

    if (c === "&") {
      if (cmd[i + 1] === "&") {
        pushOp("&&");
        i += 2;
      } else {
        pushOp("&");
        i += 1;
      }
      continue;
    }

    if (c === "|") {
      if (cmd[i + 1] === "|") {
        pushOp("||");
        i += 2;
      } else {
        pushOp("|");
        i += cmd[i + 1] === "&" ? 2 : 1; // |& behaves like |
      }
      continue;
    }

    if (c === ";") {
      pushOp(";");
      i += cmd[i + 1] === ";" ? 2 : 1; // ;; (case) behaves like ;
      continue;
    }

    if (c === "(" || c === ")" || c === "{" || c === "}") {
      // Subshell/group delimiters separate segments. `{`/`}` are only
      // grouping at word boundaries; mid-word (e.g. brace expansion a{b,c})
      // they are word chars.
      if ((c === "{" || c === "}") && (wordStarted || (cmd[i + 1] !== undefined && !isSpace(cmd[i + 1]) && cmd[i + 1] !== "\n" && c === "{"))) {
        word += c;
        wordStarted = true;
        i += 1;
        continue;
      }
      pushOp(c);
      i += 1;
      continue;
    }

    if (c === "<" || c === ">") {
      // Process substitution <(...) / >(...)
      if (cmd[i + 1] === "(") {
        const end = scanParenSubstitution(i + 1);
        word += cmd.slice(i, end);
        wordStarted = true;
        i = end;
        continue;
      }
      // Heredoc / herestring
      if (c === "<" && cmd[i + 1] === "<") {
        if (cmd[i + 2] === "<") {
          // <<< herestring: drop operator, following word is data
          pushWord();
          i += 3;
          continue;
        }
        let j = i + 2;
        let stripTabs = false;
        if (cmd[j] === "-") {
          stripTabs = true;
          j += 1;
        }
        // fd digits before << belong to the redirect (rare: 3<<EOF)
        if (isDigits(word)) {
          word = "";
          wordStarted = false;
        }
        pushWord();
        const { delim, next } = readHeredocDelim(j);
        if (delim) pendingHeredocs.push({ delim, stripTabs });
        i = next;
        continue;
      }
      // Plain redirect: drop pure-digit fd word (2>&1) and operator chars
      if (isDigits(word)) {
        word = "";
        wordStarted = false;
      }
      pushWord();
      let j = i;
      while (j < n && (cmd[j] === "<" || cmd[j] === ">")) j += 1;
      if (cmd[j] === "&") {
        j += 1;
        if (cmd[j] === "-") j += 1;
        while (j < n && /[0-9]/.test(cmd[j])) j += 1;
      }
      i = j;
      continue;
    }

    if (c === "`") {
      const end = scanBacktick(i);
      word += cmd.slice(i, end);
      wordStarted = true;
      i = end;
      continue;
    }

    if (c === "$" && cmd[i + 1] === "(") {
      if (cmd[i + 2] === "(") {
        const end = cmd.indexOf("))", i + 3);
        const stop = end === -1 ? n : end + 2;
        word += cmd.slice(i, stop);
        wordStarted = true;
        i = stop;
        continue;
      }
      const end = scanParenSubstitution(i + 1);
      word += cmd.slice(i, end);
      wordStarted = true;
      i = end;
      continue;
    }

    word += c;
    wordStarted = true;
    i += 1;
  }
  pushWord();
  return { tokens, substitutions };
}

/** Split a token stream into command segments on chain operators. */
export function splitSegments(tokens: Token[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const t of tokens) {
    if (t.op && OP_CHAIN.has(t.text)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    } else {
      current.push(t.text);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

// ---------------------------------------------------------------------------
// Modifier peeling
// ---------------------------------------------------------------------------

/** name -> [flags that take a separate-token value, positional args before
    the wrapped command] (e.g. `timeout DURATION cmd` has 1 positional). */
const MODIFIER_SPECS: Record<string, [Set<string>, number]> = {
  sudo: [new Set(["-u", "-g", "-p", "-C", "-D", "-r", "-t", "-T", "-U", "-h", "-c"]), 0],
  env: [new Set(["-u", "-S", "-C"]), 0],
  nice: [new Set(["-n"]), 0],
  ionice: [new Set(["-c", "-n", "-p", "-t", "-P", "-u"]), 0],
  timeout: [new Set(["-k", "-s", "--kill-after", "--signal"]), 1],
  nohup: [new Set(), 0],
  time: [new Set(["-f", "-o", "-a"]), 0],
  exec: [new Set(["-a"]), 0],
  command: [new Set(), 0],
  builtin: [new Set(), 0],
  xargs: [new Set(["-n", "-L", "-I", "-P", "-E", "-d", "-a", "-s", "-R", "-i", "-l"]), 0],
  setsid: [new Set(), 0],
  unshare: [new Set(["-S", "-G", "--map-user", "--map-group"]), 0],
  stdbuf: [new Set(["-i", "-o", "-e"]), 0],
};

/** Shell keywords consumed transparently at segment starts. */
const BARE_MODIFIERS = new Set(["do", "then", "else", "!"]);

export function looksLikeEnvVar(token: string): boolean {
  const eq = token.indexOf("=");
  if (eq <= 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq));
}

function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Peel env-var assignments and modifier wrappers so seg[0] is the actual
    command. Loops so `sudo nohup timeout 5 find` peels fully. */
export function stripModifiers(seg: string[]): string[] {
  let i = 0;
  while (i < seg.length) {
    const tok = seg[i];
    if (!tok) break;
    if (looksLikeEnvVar(tok)) {
      i += 1;
      continue;
    }
    const bn = baseName(tok);
    if (BARE_MODIFIERS.has(bn)) {
      i += 1;
      continue;
    }
    const spec = MODIFIER_SPECS[bn];
    if (spec === undefined) break;
    const [valueFlags, positionalCount] = spec;
    i += 1;
    let positionalSeen = 0;
    while (i < seg.length) {
      const t = seg[i];
      if (t.startsWith("-") && t !== "-") {
        if (t.startsWith("--") && t.includes("=")) {
          i += 1;
          continue;
        }
        if (valueFlags.has(t) && i + 1 < seg.length) {
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (positionalSeen < positionalCount) {
        positionalSeen += 1;
        i += 1;
        continue;
      }
      break;
    }
  }
  return seg.slice(i);
}

// ---------------------------------------------------------------------------
// Path / python helpers (used by built-in matchers; exported for extensions)
// ---------------------------------------------------------------------------

export function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** realpath with graceful fallback; touches the FS — call sparingly. */
export function canonicalize(p: string): string {
  try {
    return realpathSync(expandUser(p));
  } catch {
    return normalize(expandUser(p));
  }
}

export function looksLikePath(token: string): boolean {
  if (!token || token.startsWith("-")) return false;
  if (token === "." || token === "..") return true;
  return token.startsWith("~") || token.includes("/") || token.includes("**");
}

export function resolveAgainst(p: string, cwd: string): string {
  const exp = expandUser(p);
  return isAbsolute(exp) ? exp : normalize(join(cwd, exp));
}

export function explicitPathArgs(seg: string[]): string[] {
  return seg.slice(1).filter(looksLikePath);
}

const PY_INTERPRETERS = new Set(["python", "python2", "python3"]);
const PY_FLAGS_WITH_VALUE = new Set(["-W", "-X", "-c", "-Q"]);

export function pythonTarget(seg: string[]): string | null {
  if (seg.length === 0) return null;
  let idx = 0;
  if (PY_INTERPRETERS.has(baseName(seg[0])) && seg.length > 1) {
    idx = 1;
    while (idx < seg.length && seg[idx].startsWith("-")) {
      const flag = seg[idx];
      idx += 1;
      if (flag === "-m") break;
      if (PY_FLAGS_WITH_VALUE.has(flag) && idx < seg.length) idx += 1;
    }
  }
  if (idx >= seg.length) return null;
  const target = baseName(seg[idx]);
  return target.endsWith(".py") ? target.slice(0, -3) : target;
}

function hasShallowVia(seg: string[], spec: { flags?: string[]; max_value?: number }): boolean {
  const flags = spec.flags ?? [];
  const maxValue = spec.max_value;
  if (flags.length === 0 || maxValue === undefined) return false;
  const flagSet = new Set(flags);
  for (let i = 0; i < seg.length; i++) {
    const t = seg[i];
    if (flagSet.has(t) && i + 1 < seg.length) {
      const v = Number.parseInt(seg[i + 1], 10);
      if (!Number.isNaN(v) && String(v) === seg[i + 1] && v <= maxValue) return true;
    }
    for (const f of flags) {
      if (t.startsWith(`${f}=`)) {
        const raw = t.slice(f.length + 1);
        const v = Number.parseInt(raw, 10);
        if (!Number.isNaN(v) && String(v) === raw && v <= maxValue) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Matcher registry
// ---------------------------------------------------------------------------

const RESERVED_KEYS = new Set(["id", "reason", "severity", "_comment"]);

const regexCache = new Map<string, RegExp | null>();
function compileRegex(src: string): RegExp | null {
  let re = regexCache.get(src);
  if (re === undefined) {
    try {
      re = new RegExp(src);
    } catch {
      re = null;
    }
    regexCache.set(src, re);
  }
  return re;
}

function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const MATCHERS = new Map<string, MatcherFn>();
const EXEMPTERS = new Map<string, MatcherFn>();

export function registerMatcher(key: string, fn: MatcherFn): void {
  MATCHERS.set(key, fn);
}

export function registerExempter(key: string, fn: MatcherFn): void {
  EXEMPTERS.set(key, fn);
}

export function knownRuleKeys(): Set<string> {
  return new Set([...RESERVED_KEYS, ...MATCHERS.keys(), ...EXEMPTERS.keys()]);
}

registerMatcher("command", (v, seg) => typeof v === "string" && baseName(seg[0]) === v);
registerMatcher("command_in", (v, seg) => asList(v).includes(baseName(seg[0])));
registerMatcher("subcommand", (v, seg) => typeof v === "string" && seg.length >= 2 && seg[1] === v);
registerMatcher("subcommand_in", (v, seg) => seg.length >= 2 && asList(v).includes(seg[1]));
registerMatcher("verb_in", (v, seg, _ctx, rule) => {
  const pos = "subcommand" in rule || "subcommand_in" in rule ? 2 : 1;
  return pos < seg.length && asList(v).includes(seg[pos]);
});
registerMatcher("any_flag", (v, seg) => {
  const flags = new Set(asList(v));
  return seg.some((t) => flags.has(t));
});
registerMatcher("any_flag_regex", (v, seg) => {
  if (typeof v !== "string") return false;
  const re = compileRegex(v.startsWith("^") ? v : `^(?:${v})`);
  if (!re) return false;
  return seg.some((t) => t.startsWith("-") && re.test(t));
});
registerMatcher("arg_regex", (v, seg) => {
  if (typeof v !== "string") return false;
  const re = compileRegex(v);
  if (!re) return false;
  return re.test(seg.slice(1).join(" "));
});
registerMatcher("python_target_in", (v, seg) => {
  const target = pythonTarget(seg);
  return target !== null && asList(v).includes(target);
});
registerExempter("unless_any_flag", (v, seg) => {
  const flags = new Set(asList(v));
  return seg.some((t) => flags.has(t));
});
registerExempter("unless_arg_regex", (v, seg) => {
  if (typeof v !== "string") return false;
  const re = compileRegex(v);
  return re !== null && re.test(seg.slice(1).join(" "));
});
registerExempter("exempt_shallow_via", (v, seg) =>
  typeof v === "object" && v !== null && hasShallowVia(seg, v as { flags?: string[]; max_value?: number }),
);

/** null = rule fired; otherwise list of unknown keys (fail-safe skip) or
    undefined when the rule simply didn't match. */
function evaluateRule(rule: Rule, seg: string[], ctx: EvalContext): "fired" | "no-match" | string[] {
  const unknown: string[] = [];
  const exempterKeys: string[] = [];
  for (const key of Object.keys(rule)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (EXEMPTERS.has(key)) {
      exempterKeys.push(key);
      continue;
    }
    const matcher = MATCHERS.get(key);
    if (matcher === undefined) {
      unknown.push(key);
      continue;
    }
    if (unknown.length === 0 && !matcher(rule[key], seg, ctx, rule)) return "no-match";
  }
  if (unknown.length > 0) return unknown;
  for (const key of exempterKeys) {
    const ex = EXEMPTERS.get(key);
    if (ex !== undefined && ex(rule[key], seg, ctx, rule)) return "no-match";
  }
  return "fired";
}

// ---------------------------------------------------------------------------
// Rule loading (layered, cached)
// ---------------------------------------------------------------------------

interface LayerCacheEntry {
  mtimeMs: number;
  config: RulesConfig | null;
  error?: string;
}

const layerCache = new Map<string, LayerCacheEntry>();

function loadLayer(path: string): LayerCacheEntry {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { mtimeMs: -1, config: null, error: "missing" };
  }
  const cached = layerCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  let entry: LayerCacheEntry;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      entry = { mtimeMs, config: { rules: raw as Rule[] } };
    } else if (typeof raw === "object" && raw !== null) {
      const obj = raw as RulesConfig;
      entry = { mtimeMs, config: { ...obj, rules: Array.isArray(obj.rules) ? obj.rules : [] } };
    } else {
      entry = { mtimeMs, config: null, error: "not an object" };
    }
  } catch (e) {
    entry = { mtimeMs, config: null, error: e instanceof Error ? e.message : String(e) };
  }
  layerCache.set(path, entry);
  return entry;
}

export interface LoadedRules {
  config: RulesConfig;
  /** Per-source problems: parse errors etc. Missing files are silent. */
  errors: string[];
  sources: string[];
}

export function loadRules(sources: string[]): LoadedRules {
  const errors: string[] = [];
  const byId = new Map<string, Rule>();
  const anonymous: Rule[] = [];
  const disabled = new Set<string>();
  const merged: RulesConfig = { rules: [] };
  for (const src of sources) {
    const entry = loadLayer(src);
    if (entry.config === null) {
      if (entry.error && entry.error !== "missing") errors.push(`${src}: ${entry.error}`);
      continue;
    }
    for (const [k, v] of Object.entries(entry.config)) {
      if (k !== "rules" && k !== "disable_rules") merged[k] = v;
    }
    for (const rule of entry.config.rules) {
      if (typeof rule.id === "string") byId.set(rule.id, rule);
      else anonymous.push(rule);
    }
    for (const id of asList(entry.config.disable_rules)) disabled.add(id);
  }
  merged.rules = [...byId.values(), ...anonymous].filter(
    (r) => typeof r.id !== "string" || !disabled.has(r.id),
  );
  return { config: merged, errors, sources };
}

function engineDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return join(homedir(), ".pi", "agent", "bashguard");
  }
}

/** Base sources when no override applies: the rules.json next to the engine. */
export function defaultSources(): string[] {
  return [join(engineDir(), "rules.json")];
}

/** BASHGUARD_RULES (colon-separated) > local-extension sources > default. */
export function resolveSources(localSources?: string[]): string[] {
  const env = process.env.BASHGUARD_RULES;
  if (env) return env.split(":").filter(Boolean);
  if (localSources && localSources.length > 0) return localSources;
  return defaultSources();
}

// ---------------------------------------------------------------------------
// cd tracking
// ---------------------------------------------------------------------------

export function updateCwdFromCd(seg: string[], cwd: string): string {
  if (seg.length === 0 || seg[0] !== "cd") return cwd;
  if (seg.length < 2) return canonicalize("~");
  const target = seg[1];
  if (target === "-" || target.includes("$") || target.includes("`")) return cwd;
  const exp = expandUser(target);
  return canonicalize(isAbsolute(exp) ? exp : join(cwd, exp));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function audit(fire: Fire, mode: string, session: string | undefined): void {
  const path = process.env.BASHGUARD_AUDIT_LOG ?? DEFAULT_AUDIT_LOG;
  if (!path) return;
  try {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString().slice(0, 19),
      id: fire.ruleId,
      severity: fire.severity,
      mode,
      command: fire.seg.join(" "),
    };
    if (session) record.session = session;
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // fail open
  }
}

function noteStall(msg: string): void {
  try {
    appendFileSync(STALL_LOG, `${new Date().toISOString().slice(0, 19)} ${msg}\n`);
  } catch {
    // ignore
  }
}

const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** True for -c and combined short-flag clusters containing c (-lc, -xec). */
function isDashCFlag(t: string): boolean {
  return /^-[a-zA-Z]+$/.test(t) && t.includes("c");
}

/** Extract the script payload of `bash -c '<script>' [name args...]`. */
function shellDashCPayload(seg: string[]): string | null {
  if (!SHELL_WRAPPERS.has(baseName(seg[0]))) return null;
  for (let i = 1; i < seg.length; i++) {
    const t = seg[i];
    if (isDashCFlag(t)) {
      for (let j = i + 1; j < seg.length; j++) {
        if (!seg[j].startsWith("-") || seg[j] === "-") return seg[j];
      }
      return null;
    }
    if (!t.startsWith("-")) return null; // script file, not -c
  }
  return null;
}

export function evaluateCommand(command: string, opts: EvaluateOptions): Verdict {
  const mode = opts.mode ?? process.env.BASHGUARD_MODE ?? "enforce";
  const doAudit = opts.audit ?? true;
  const sources = opts.sources ?? resolveSources();
  const { config, errors } = loadRules(sources);
  const verdict: Verdict = { decision: "allow", fires: [], skippedRules: [], notes: [...errors] };
  if (config.rules.length === 0) return verdict;

  const ctx: EvalContext = { cwd: opts.cwd, config, cache: new Map() };
  const deadline = Date.now() + BUDGET_MS;
  const skippedIds = new Set<string>();
  let segmentsSeen = 0;
  // Tainted vars whose value is known to contain a sensitive literal (e.g.
  // ".env"). Shared across recursive evalScript calls so `bash -c 'cat $f'`
  // still sees outer taint. Populated both incrementally per-segment and via
  // whole-script pre-scan as fallback.
  const taintedVars = new Set<string>();
  const scriptContainsSensitive = containsSensitiveLiteral(command);
  // Pre-scan for obvious `for VAR in ... .env ...` and `VAR=... .env ...` patterns
  // so the taint is present before the first reader segment is evaluated.
  {
    const forInRe = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b([^;\n]*)/g;
    let m: RegExpExecArray | null;
    while ((m = forInRe.exec(command)) !== null) {
      if (containsSensitiveLiteral(m[2])) taintedVars.add(m[1]);
    }
    const assignRe = /(?:^|[\s;\n])(?:export\s+|declare\s+|local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\s;\n"']+|"[^"]*"|'[^']*')/g;
    while ((m = assignRe.exec(command)) !== null) {
      const val = m[2].replace(/^['"]|['"]$/g, "");
      if (containsSensitiveLiteral(val) || containsSensitiveLiteral(m[2])) taintedVars.add(m[1]);
    }
  }

  const evalScript = (script: string, cwd: string, depth: number): boolean => {
    if (depth > MAX_DEPTH) {
      verdict.notes.push("recursion depth cap reached; remainder allowed");
      return false;
    }
    const { tokens, substitutions } = tokenize(script);
    let effCwd = cwd;
    for (const seg of splitSegments(tokens)) {
      segmentsSeen += 1;
      if (segmentsSeen > MAX_SEGMENTS || Date.now() > deadline) {
        verdict.notes.push("evaluation budget exceeded; remainder allowed");
        noteStall(`budget exceeded evaluating: ${script.slice(0, 200)}`);
        return false;
      }
      // Incrementally taint vars defined in this segment before evaluating
      // rules on it, so `f=.env; cat $f` in the same script is caught even
      // when both are in one evalScript invocation. Also propagates through
      // `b=$a` where $a is already tainted (transitive taint).
      {
        const rawJoined = seg.join(" ");
        const hasTaintedRef = (s: string): boolean => {
          VAR_REF_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = VAR_REF_RE.exec(s)) !== null) if (taintedVars.has(m[1])) return true;
          return false;
        };
        // for VAR in <list>  — if list contains sensitive literal OR a tainted var, taint VAR
        if (seg.length >= 4 && seg[0] === "for" && seg[2] === "in") {
          const varName = seg[1];
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
            const listPart = seg.slice(3).join(" ");
            if (containsSensitiveLiteral(listPart) || containsSensitiveLiteral(rawJoined) || hasTaintedRef(listPart)) {
              taintedVars.add(varName);
            }
          }
        }
        // Also handle `for f in "$tainted"; do ...` where tokenizer split differently: last seg before ; may be `for f in $a`
        if (seg[0] === "for" && seg.length === 4 && seg[2] === "in" && hasTaintedRef(seg[3])) {
          taintedVars.add(seg[1]);
        }
        // VAR=val / export VAR=val  (value part may be seg[0] itself)
        for (const tok of seg) {
          const eq = tok.indexOf("=");
          if (eq > 0) {
            const name = tok.slice(0, eq);
            const rawVal = tok.slice(eq + 1);
            const val = rawVal.replace(/^['"]|['"]$/g, "");
            const cleanName = name.includes(":") ? name.split(":")[0] : name;
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanName) && (containsSensitiveLiteral(val + " " + rawVal) || hasTaintedRef(rawVal) || hasTaintedRef(val))) {
              taintedVars.add(cleanName);
            }
          }
        }
        // export VAR=val split across tokens: "export", "VAR=val"
        if (seg[0] === "export" || seg[0] === "declare" || seg[0] === "local") {
          for (let i = 1; i < seg.length; i++) {
            const tok = seg[i];
            const eq = tok.indexOf("=");
            if (eq > 0 && (containsSensitiveLiteral(tok.slice(eq + 1)) || hasTaintedRef(tok.slice(eq + 1)))) {
              taintedVars.add(tok.slice(0, eq));
            }
          }
        }
      }

      const stripped = stripModifiers(seg);
      if (stripped.length === 0) {
        effCwd = updateCwdFromCd(seg, effCwd);
        continue;
      }
      // Synthetic block: consumer dereferences a tainted var. Run BEFORE normal
      // rules so the reason is specific to the indirection.
      {
        const isConsumer = isSensitiveConsumer(stripped);
        const refs = taintedVarRefsInSeg(stripped, taintedVars);
        if (isConsumer && refs.length > 0) {
          const fire: Fire = {
            ruleId: "no-read-dotenv-via-var",
            severity: mode === "warn" ? "warn" : "block",
            reason: `Dumping sensitive file via tainted variable $${refs[0]} — that variable was assigned a value containing a sensitive path (.env / private key / credential file) earlier in the same command (or transitively via another tainted var). The guard can't verify what ${"$" + refs[0]} expands to at runtime, so this is treated like reading the sensitive file directly. Use .env.example for variable names or ask the user for the specific value.`,
            seg: stripped,
          };
          verdict.fires.push(fire);
          if (doAudit) audit(fire, mode, opts.session);
          if (fire.severity === "block") {
            verdict.blocked = fire;
            verdict.decision = "block";
            return true;
          }
        } else if (isConsumer && scriptContainsSensitive && stripped.slice(1).some((t) => t.includes("$"))) {
          // Fallback: whole command contained a sensitive literal somewhere and
          // this consumer takes a variable — we can't prove the var is tainted
          // but the combination is high-risk (covers missed for/assign parses).
          const fire: Fire = {
            ruleId: "no-read-dotenv-via-var",
            severity: mode === "warn" ? "warn" : "block",
            reason: `Consumer ${"\"" + stripped.join(" ") + "\""} takes a variable while this command contains a sensitive path (.env / private key / credential file) elsewhere — treated as indirection to avoid leaking secrets via $ expansion. Use .env.example or ask the user.`,
            seg: stripped,
          };
          verdict.fires.push(fire);
          if (doAudit) audit(fire, mode, opts.session);
          if (fire.severity === "block") {
            verdict.blocked = fire;
            verdict.decision = "block";
            return true;
          }
        } else if (!isConsumer && refs.length > 0 && scriptContainsSensitive) {
          // Generic fallback: ANY non-harmless command taking a tainted var
          // when sensitive literal was present elsewhere. Covers `cp $f /tmp/x`
          // etc. that aren't in the consumer set. Harmless mentioners (echo/ls)
          // are exempt to keep the guard usable.
          if (HARMLESS_WITH_TAINTED_VAR.has(baseName(stripped[0]))) {
            // exempt: echo/ls of the path leaks the name, not the contents
          } else {
            const fire: Fire = {
              ruleId: "no-sensitive-via-var",
              severity: mode === "warn" ? "warn" : "block",
              reason: `Command ${"\"" + stripped.join(" ") + "\""} takes tainted variable $${refs[0]} while this command contains a sensitive path elsewhere — indirection could leak secrets via $ expansion. If this is safe (e.g. ls/echo of the path, not its contents), rewrite to avoid passing the tainted value to this command or ask the user.`,
              seg: stripped,
            };
            verdict.fires.push(fire);
            if (doAudit) audit(fire, mode, opts.session);
            if (fire.severity === "block") {
              verdict.blocked = fire;
              verdict.decision = "block";
              return true;
            }
          }
        }
      }
      ctx.cwd = effCwd;
      for (const rule of config.rules) {
        const result = evaluateRule(rule, stripped, ctx);
        if (result === "no-match") continue;
        const rid = rule.id ?? "<unnamed>";
        if (Array.isArray(result)) {
          if (!skippedIds.has(rid)) {
            skippedIds.add(rid);
            verdict.skippedRules.push({ id: rid, unknownKeys: result });
          }
          continue;
        }
        const severity: Severity = mode === "warn" ? "warn" : (rule.severity ?? "block");
        const fire: Fire = {
          ruleId: rid,
          severity,
          reason: rule.reason ?? "rule violation",
          seg: stripped,
        };
        verdict.fires.push(fire);
        if (doAudit) audit(fire, mode, opts.session);
        if (severity === "block") {
          verdict.blocked = fire;
          verdict.decision = "block";
          return true;
        }
      }
      // Recurse into shell -c payloads and eval
      const payload = shellDashCPayload(stripped);
      if (payload !== null) {
        if (evalScript(payload, effCwd, depth + 1)) return true;
      } else if (stripped[0] === "eval" && stripped.length > 1) {
        if (evalScript(stripped.slice(1).join(" "), effCwd, depth + 1)) return true;
      }
      effCwd = updateCwdFromCd(stripped, effCwd);
    }
    for (const sub of substitutions) {
      if (evalScript(sub, effCwd, depth + 1)) return true;
    }
    return false;
  };

  evalScript(command, opts.cwd, 0);
  if (verdict.decision !== "block" && verdict.fires.length > 0) verdict.decision = "warn";
  return verdict;
}

// ---------------------------------------------------------------------------
// Explain / lint (rule-authoring support)
// ---------------------------------------------------------------------------

export interface ExplainSegment {
  raw: string[];
  stripped: string[];
  cwd: string;
}

export interface Explanation {
  segments: ExplainSegment[];
  substitutions: string[];
}

export function explainCommand(command: string, cwd: string): Explanation {
  const { tokens, substitutions } = tokenize(command);
  const segments: ExplainSegment[] = [];
  let effCwd = cwd;
  for (const seg of splitSegments(tokens)) {
    const stripped = stripModifiers(seg);
    segments.push({ raw: seg, stripped, cwd: effCwd });
    effCwd = updateCwdFromCd(stripped.length > 0 ? stripped : seg, effCwd);
  }
  return { segments, substitutions };
}

export interface LintIssue {
  source: string;
  ruleId: string;
  problem: string;
}

export function lintSources(sources: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const known = knownRuleKeys();
  for (const src of sources) {
    if (!existsSync(src)) {
      issues.push({ source: src, ruleId: "-", problem: "file missing" });
      continue;
    }
    const entry = loadLayer(src);
    if (entry.config === null) {
      issues.push({ source: src, ruleId: "-", problem: entry.error ?? "unreadable" });
      continue;
    }
    const seen = new Set<string>();
    for (const rule of entry.config.rules) {
      const rid = rule.id ?? "<unnamed>";
      if (rule.id === undefined) issues.push({ source: src, ruleId: rid, problem: "missing id" });
      else if (seen.has(rule.id))
        issues.push({ source: src, ruleId: rid, problem: "duplicate id within layer" });
      seen.add(rid);
      if (typeof rule.reason !== "string" || rule.reason.length === 0)
        issues.push({ source: src, ruleId: rid, problem: "missing reason" });
      for (const key of Object.keys(rule)) {
        if (!known.has(key))
          issues.push({ source: src, ruleId: rid, problem: `unknown matcher key '${key}'` });
      }
      for (const key of ["any_flag_regex", "arg_regex"]) {
        const v = rule[key];
        if (typeof v === "string" && compileRegex(v) === null)
          issues.push({ source: src, ruleId: rid, problem: `invalid regex in ${key}` });
      }
      const sev = rule.severity;
      if (sev !== undefined && sev !== "block" && sev !== "warn")
        issues.push({ source: src, ruleId: rid, problem: `invalid severity '${String(sev)}'` });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Local (site-specific) extension contract
// ---------------------------------------------------------------------------

/** What a site-local extension module may provide from setup(engine). */
export interface LocalInfo {
  name?: string;
  /** Layered rule sources, first = lowest precedence. */
  sources?: string[];
  /** Extra health checks surfaced by lint/status (e.g. upstream drift). */
  lint?: () => string[];
}

export const LOCAL_MODULE_PATH = join(homedir(), ".pi", "agent", "bashguard", "local.ts");

/**
 * Load the optional site extension and hand it the HOST'S engine module to
 * register matchers on: `engine.loadLocal(engine)`. Hosts must pass their
 * own module reference instead of letting local.ts import the engine
 * itself — engine files can be reached via both a stow symlink path and
 * its realpath, which the ESM loader treats as two different modules, so a
 * direct import could register matchers on the wrong instance.
 */
export async function loadLocal(engineModule: unknown): Promise<LocalInfo | undefined> {
  if (!existsSync(LOCAL_MODULE_PATH)) return undefined;
  const mod = (await import(LOCAL_MODULE_PATH)) as {
    setup?: (engine: unknown) => LocalInfo | undefined;
  };
  if (typeof mod.setup !== "function") return undefined;
  return mod.setup(engineModule) ?? undefined;
}
