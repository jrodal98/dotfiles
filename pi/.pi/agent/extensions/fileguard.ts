/**
 * fileguard — blocks the `read` tool on sensitive file paths (secrets,
 * credentials, private keys). Companion to bashguard, which covers the same
 * files against bash-side readers (`cat .env`, `grep KEY .env`, ...); this
 * extension covers pi's structured read tool, where the path is already
 * parsed and a simple glob match suffices.
 *
 * Threat model: accident prevention. A well-meaning agent that reads .env
 * puts the secrets into its context, session logs, and potentially into
 * generated code or commit messages. This is not adversary-proofing.
 *
 * PATTERNS
 * --------
 * Two pattern kinds, matched against the resolved (~-expanded, cwd-resolved,
 * symlink-chased) absolute path:
 *   - basename patterns (no "/"): match the file name anywhere, e.g. ".env",
 *     "id_rsa*", "*.pem"
 *   - path patterns (contain "/"): match the full absolute path; "~" expands,
 *     "**" crosses directories, "*"/"?" stay within one segment
 * Allow patterns win over block patterns (".env.example" stays readable).
 *
 * Site-specific additions live in ~/.pi/agent/fileguard.json:
 *   { "block": ["pattern", ...], "allow": ["pattern", ...] }
 * merged additively over the defaults below.
 *
 * Commands:
 *   /fileguard              status: pattern list + recent blocks
 *   /fileguard test <path>  dry-run a path against the live pattern set
 */

import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUDIT_LOG = process.env.FILEGUARD_AUDIT_LOG ?? "/tmp/fileguard-audit.log";
const SITE_CONFIG = join(homedir(), ".pi", "agent", "fileguard.json");

export const DEFAULT_BLOCK: string[] = [
  // dotenv secrets
  ".env",
  ".env.*",
  // private key material (any location)
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  "id_dsa*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  // classic credential files
  ".netrc",
  ".git-credentials",
  ".pgpass",
  "~/.aws/credentials",
  "~/.gnupg/**",
  "~/.config/gh/hosts.yml",
  "~/.docker/config.json",
  "~/.pi/agent/auth.json",
];

export const DEFAULT_ALLOW: string[] = [
  "*.pub", // public halves of keypairs
  ".env.example",
  ".env.sample",
  ".env.template",
];

interface SiteConfig {
  block?: string[];
  allow?: string[];
}

function loadPatterns(): { block: string[]; allow: string[]; siteError?: string } {
  let site: SiteConfig = {};
  let siteError: string | undefined;
  if (existsSync(SITE_CONFIG)) {
    try {
      site = JSON.parse(readFileSync(SITE_CONFIG, "utf8")) as SiteConfig;
    } catch (e) {
      siteError = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    block: [...DEFAULT_BLOCK, ...(site.block ?? [])],
    allow: [...DEFAULT_ALLOW, ...(site.allow ?? [])],
    siteError,
  };
}

/** Glob -> RegExp. `**` crosses "/", `*` and `?` stay within a segment. */
export function globToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolvePath(path: string, cwd: string): string {
  const exp = expandUser(path);
  const abs = isAbsolute(exp) ? normalize(exp) : normalize(join(cwd, exp));
  try {
    return realpathSync(abs); // chase symlinks so links to secrets still match
  } catch {
    return abs;
  }
}

function matchesAny(resolved: string, patterns: string[]): string | undefined {
  const base = resolved.slice(resolved.lastIndexOf("/") + 1);
  for (const pattern of patterns) {
    const target = pattern.includes("/") ? resolved : base;
    const subject = pattern.includes("/") ? expandUser(pattern) : pattern;
    try {
      if (globToRegex(subject).test(target)) return pattern;
    } catch {
      // bad pattern: skip
    }
  }
  return undefined;
}

export interface PathVerdict {
  blocked: boolean;
  pattern?: string;
  resolved: string;
}

export function checkPath(
  path: string,
  cwd: string,
  block: string[],
  allow: string[],
): PathVerdict {
  const resolved = resolvePath(path, cwd);
  if (matchesAny(resolved, allow)) return { blocked: false, resolved };
  const pattern = matchesAny(resolved, block);
  return { blocked: pattern !== undefined, pattern, resolved };
}

function audit(resolved: string, pattern: string, session?: string): void {
  if (!AUDIT_LOG) return;
  try {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString().slice(0, 19),
      path: resolved,
      pattern,
    };
    if (session) record.session = session;
    appendFileSync(AUDIT_LOG, `${JSON.stringify(record)}\n`);
  } catch {
    // fail open
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "read") return;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path !== "string" || !path) return;
    try {
      const { block, allow } = loadPatterns();
      const verdict = checkPath(path, ctx.cwd, block, allow);
      if (verdict.blocked) {
        let session: string | undefined;
        try {
          session = ctx.sessionManager.getSessionId();
        } catch {
          // ephemeral context
        }
        audit(verdict.resolved, verdict.pattern as string, session);
        return {
          block: true,
          reason:
            `BLOCKED by fileguard: ${verdict.resolved} matches sensitive pattern ` +
            `'${verdict.pattern}'. Reading it would put secrets into the agent context ` +
            "and logs. Ask the user for the specific value you need (allow-list " +
            `overrides live in ${SITE_CONFIG}).`,
        };
      }
    } catch {
      // fail open: never let a guard bug take down the read tool
    }
  });

  pi.registerCommand("fileguard", {
    description: "fileguard status, or 'test <path>' to dry-run a sensitive-path check",
    handler: (args, ctx) => {
      const { block, allow, siteError } = loadPatterns();
      const trimmed = (args ?? "").trim();
      if (trimmed.startsWith("test ")) {
        const verdict = checkPath(trimmed.slice(5).trim(), ctx.cwd, block, allow);
        ctx.ui.notify(
          verdict.blocked
            ? `BLOCK ${verdict.resolved} (pattern '${verdict.pattern}')`
            : `ALLOW ${verdict.resolved}`,
          verdict.blocked ? "warning" : "info",
        );
        return;
      }
      const lines = [
        `block patterns (${block.length}): ${block.join(", ")}`,
        `allow patterns (${allow.length}): ${allow.join(", ")}`,
        `site config: ${existsSync(SITE_CONFIG) ? SITE_CONFIG : "none"}${siteError ? ` (PARSE ERROR: ${siteError})` : ""}`,
      ];
      if (existsSync(AUDIT_LOG)) {
        try {
          const tail = readFileSync(AUDIT_LOG, "utf8").trim().split("\n").slice(-5);
          lines.push(`recent blocks (${AUDIT_LOG}):`, ...tail.map((l) => `  ${l}`));
        } catch {
          // ignore
        }
      }
      ctx.ui.notify(lines.join("\n"), siteError ? "warning" : "info");
    },
  });
}
