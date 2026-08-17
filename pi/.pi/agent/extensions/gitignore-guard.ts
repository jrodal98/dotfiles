/**
 * gitignore-guard — blocks the `read` tool on files that are ignored by git
 * when the guard is effectively enabled.
 *
 * Threat model: accident prevention. Gitignored files often contain secrets,
 * build artifacts, local env, or large generated content that should not be
 * fed to the model. This guard delegates the "is this sensitive?" decision
 * to the repository's own `.gitignore` (plus global excludes).
 *
 * How it works:
 *   - Toggle with `/gitignore-guard on|off` (persists to
 *     `~/.pi/agent/gitignore-guard.json`). `reset`/`auto` clears the
 *     explicit toggle and falls back to the default/marker.
 *   - Effective enabled state (in priority order):
 *       1. explicit `enabled` in site config (`on`/`off`)
 *       2. marker file `.gitignore-guard` at the repo root  -> ON
 *       3. otherwise OFF by default
 *   - Bash coverage lives in `../bashguard/local.ts` + the `no-read-gitignored`
 *     rule in `../bashguard/rules.json` — the bash `gitignored` matcher
 *     consults the same effective-enabled check, so the read and bash guards
 *     stay in lockstep without duplicating marker/config logic.
 *   - When enabled, every `read` tool call resolves its path and runs
 *     `git -C <fileDir> check-ignore --verbose -- <absolutePath>`.
 *     Exit 0 => ignored => blocked. Exit 1 => not ignored => allowed.
 *     Exit 128 => not a git repo or path outside repo => allowed (fail open).
 *   - Tracked files that match a .gitignore pattern are *allowed* (git's
 *     default `check-ignore` semantics). Use `blockTracked: true` in the
 *     site config to also block those via `--no-index` semantics if desired.
 *   - An `allow` list in the site config can exempt specific paths/patterns
 *     even though they are gitignored (same glob dialect as fileguard).
 *
 * Site config: `~/.pi/agent/gitignore-guard.json`
 *   { "enabled": boolean, "allow": ["glob", ...], "blockTracked": boolean }
 *   `enabled` when absent means "follow marker/default". `allow` and
 *   `blockTracked` are optional.
 *
 * Commands:
 *   /gitignore-guard              status (enabled, allow list, recent blocks)
 *   /gitignore-guard on           enable (persists)
 *   /gitignore-guard off          disable (persists)
 *   /gitignore-guard auto|reset   clear explicit toggle, follow marker/default
 *   /gitignore-guard test <path>  dry-run a path against gitignore + allow list
 *
 * Fail-open: git not installed, not a repo, spawn errors, or bad config
 * never block a read.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as shared from "../gitignore-shared.ts";

const AUDIT_LOG =
  process.env.GITIGNORE_GUARD_AUDIT_LOG ?? "/tmp/gitignore-guard-audit.log";

// Re-export shared helpers for external consumers / tests.
export const SITE_CONFIG = shared.SITE_CONFIG;
export const MARKER_FILENAME = shared.MARKER_FILENAME;
export const resolvePath = shared.resolvePath;
export const globToRegex = shared.globToRegex;
export const isGitIgnored = shared.isGitIgnored;
export type GitIgnoreVerdict = shared.GitIgnoreVerdict;

function saveConfig(patch: Partial<shared.SiteConfig>): void {
  let current: shared.SiteConfig = {};
  if (existsSync(shared.SITE_CONFIG)) {
    try {
      current = JSON.parse(readFileSync(shared.SITE_CONFIG, "utf8")) as shared.SiteConfig;
    } catch {
      current = {};
    }
  }
  const next: shared.SiteConfig = { ...current, ...patch };
  mkdirSync(dirname(shared.SITE_CONFIG), { recursive: true });
  writeFileSync(shared.SITE_CONFIG, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function clearExplicitEnabled(): void {
  if (!existsSync(shared.SITE_CONFIG)) return;
  try {
    const raw = JSON.parse(readFileSync(shared.SITE_CONFIG, "utf8")) as shared.SiteConfig;
    if (!("enabled" in raw)) return;
    delete raw.enabled;
    if (
      (raw as Record<string, unknown>).allow === undefined &&
      (raw as Record<string, unknown>).blockTracked === undefined &&
      Object.keys(raw).length === 0
    ) {
      writeFileSync(shared.SITE_CONFIG, "{}\n", "utf8");
    } else {
      mkdirSync(dirname(shared.SITE_CONFIG), { recursive: true });
      writeFileSync(shared.SITE_CONFIG, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    }
  } catch {
    try {
      writeFileSync(shared.SITE_CONFIG, "{}\n", "utf8");
    } catch {
      // fail open
    }
  }
}

function audit(resolved: string, pattern: string, session?: string): void {
  if (!AUDIT_LOG) return;
  try {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString().slice(0, 19),
      path: resolved,
      pattern,
      guard: "gitignore",
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
      const resolved = shared.resolvePath(path, ctx.cwd);
      const eff = shared.getEffectiveEnabled(ctx.cwd, resolved);
      if (!eff.enabled) return;

      const cfg = shared.loadConfig();
      if (shared.matchesAny(resolved, cfg.allow)) return;

      const verdict = shared.isGitIgnored(resolved, ctx.cwd, cfg.blockTracked);
      if (verdict.ignored) {
        let session: string | undefined;
        try {
          session = ctx.sessionManager.getSessionId();
        } catch {
          // ephemeral context
        }
        audit(resolved, verdict.pattern ?? "(unknown)", session);
        return {
          block: true,
          reason:
            `BLOCKED by gitignore-guard: ${resolved} is ignored by git` +
            (verdict.pattern ? ` (pattern '${verdict.pattern}')` : "") +
            `. Disable with /gitignore-guard off or allow-list it in ${shared.SITE_CONFIG}.` +
            (verdict.rawOutput ? ` [${verdict.rawOutput}]` : ""),
        };
      }
    } catch {
      // fail open: never let a guard bug take down the read tool
    }
  });

  pi.registerCommand("gitignore-guard", {
    description:
      "gitignore-guard status / on / off / auto|reset / test <path> — block reads of gitignored files",
    handler: (args, ctx) => {
      const trimmed = (args ?? "").trim();
      const cfg = shared.loadConfig();
      const eff = shared.getEffectiveEnabled(ctx.cwd);

      if (trimmed === "on" || trimmed === "enable") {
        saveConfig({ enabled: true });
        ctx.ui.notify(`gitignore-guard: enabled (explicit on, config: ${shared.SITE_CONFIG})`, "info");
        return;
      }
      if (trimmed === "off" || trimmed === "disable") {
        saveConfig({ enabled: false });
        ctx.ui.notify(`gitignore-guard: disabled (explicit off, config: ${shared.SITE_CONFIG})`, "info");
        return;
      }
      if (trimmed === "auto" || trimmed === "reset" || trimmed === "clear" || trimmed === "default") {
        clearExplicitEnabled();
        const after = shared.getEffectiveEnabled(ctx.cwd);
        ctx.ui.notify(
          `gitignore-guard: explicit toggle cleared — now ${after.enabled ? "ENABLED" : "DISABLED"} via ${after.source}`,
          "info",
        );
        return;
      }

      if (trimmed.startsWith("test ")) {
        const rawPath = trimmed.slice(5).trim();
        if (!rawPath) {
          ctx.ui.notify("Usage: /gitignore-guard test <path>", "warning");
          return;
        }
        const resolved = shared.resolvePath(rawPath, ctx.cwd);
        const allowHit = shared.matchesAny(resolved, cfg.allow);
        if (allowHit) {
          ctx.ui.notify(`ALLOW ${resolved} (allow-list pattern '${allowHit}' overrides gitignore)`, "info");
          return;
        }
        const effForPath = shared.getEffectiveEnabled(ctx.cwd, resolved);
        const verdict = shared.isGitIgnored(resolved, ctx.cwd, cfg.blockTracked);
        if (verdict.ignored) {
          const wouldBlock = effForPath.enabled;
          ctx.ui.notify(
            `${wouldBlock ? "BLOCK" : "would BLOCK (guard OFF)"} ${resolved} (gitignore pattern '${verdict.pattern ?? "unknown"}')` +
              (verdict.rawOutput ? ` — ${verdict.rawOutput}` : "") +
              ` — guard ${wouldBlock ? "ENABLED" : "DISABLED"} via ${effForPath.source}`,
            wouldBlock ? "warning" : "info",
          );
        } else {
          ctx.ui.notify(
            `ALLOW ${resolved}` +
              (verdict.error ? ` (git: ${verdict.error})` : " (not ignored)") +
              ` — guard ${effForPath.enabled ? "ENABLED" : "DISABLED"} via ${effForPath.source}`,
            "info",
          );
        }
        return;
      }

      const markerNote = shared.hasMarkerForRequest(ctx.cwd)
        ? `marker present: ${join(shared.getRepoRoot(ctx.cwd) ?? "<repo>", shared.MARKER_FILENAME)}`
        : "marker: none";
      const explicitNote =
        typeof cfg.enabled === "boolean"
          ? `explicit ${cfg.enabled ? "on" : "off"} in ${shared.SITE_CONFIG}`
          : `no explicit toggle (following ${eff.source})`;
      const lines = [
        `gitignore-guard: ${eff.enabled ? "ENABLED" : "DISABLED"} via ${eff.source}`,
        `config: ${existsSync(shared.SITE_CONFIG) ? shared.SITE_CONFIG : `${shared.SITE_CONFIG} (not yet created, defaults apply)`}${cfg.siteError ? ` (PARSE ERROR: ${cfg.siteError})` : ""}`,
        `effective: ${explicitNote}; ${markerNote}`,
        `allow patterns (${cfg.allow.length}): ${cfg.allow.length ? cfg.allow.join(", ") : "(none)"}`,
        `blockTracked: ${cfg.blockTracked}`,
        `usage: /gitignore-guard on | off | auto | test <path>`,
      ];
      if (AUDIT_LOG && existsSync(AUDIT_LOG)) {
        try {
          const tail = readFileSync(AUDIT_LOG, "utf8").trim().split("\n").filter(Boolean).slice(-5);
          if (tail.length) lines.push(`recent blocks (${AUDIT_LOG}):`, ...tail.map((l) => `  ${l}`));
        } catch {
          // ignore
        }
      }
      ctx.ui.notify(lines.join("\n"), cfg.siteError ? "warning" : "info");
    },
  });
}
