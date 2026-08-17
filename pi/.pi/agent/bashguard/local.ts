/**
 * Site-local bashguard extension: blocks reading gitignored files via
 * bash readers (cat/grep/sed/... ) when gitignore-guard is effectively
 * enabled.
 *
 * Enablement is shared with extensions/gitignore-guard.ts via
 * ../gitignore-shared.ts so the marker file (.gitignore-guard at the
 * repo root) and ~/.pi/agent/gitignore-guard.json toggle control both
 * the read-tool guard and the bash guard in lockstep.
 *
 * Matcher: `gitignored`
 *   value: string or string[] of command basenames to guard. If empty
 *          or absent, the rule applies to any command that has a
 *          gitignored path arg (not recommended — scope it).
 *   Fires only if:
 *     1) gitignore-guard is effectively enabled for the segment's cwd
 *        (site-config override or repo-root marker), AND
 *     2) any path-like arg in the segment resolves to a gitignored file
 *        (git check-ignore --verbose). Non-path args are ignored.
 *   allow-list and blockTracked are respected via shared helpers.
 */

import { existsSync } from "node:fs";
import * as shared from "../gitignore-shared.ts";

type EngineModule = typeof import("./engine.ts");

export function setup(engine: EngineModule) {
  engine.registerMatcher("gitignored", (value, seg, ctx, _rule) => {
    // Fast path: guard off for this cwd => never fire, no git spawns.
    // ctx.cwd is the engine's per-segment tracked cwd (cd-aware).
    if (!shared.getEffectiveEnabled(ctx.cwd).enabled) return false;

    // Scope to requested commands.
    let commands: string[] = [];
    if (Array.isArray(value)) {
      commands = (value as unknown[]).filter((x): x is string => typeof x === "string");
    } else if (typeof value === "string" && value.length > 0) {
      commands = [value];
    }
    if (commands.length > 0) {
      const cmdBase = seg[0]?.includes("/") ? seg[0].slice(seg[0].lastIndexOf("/") + 1) : seg[0];
      if (!commands.includes(cmdBase)) return false;
    }

    const cfg = shared.loadConfig();

    // Path-like args via engine helpers when available.
    let pathArgs: string[] = [];
    if (typeof engine.explicitPathArgs === "function") {
      pathArgs = engine.explicitPathArgs(seg);
    } else {
      for (let i = 1; i < seg.length; i++) {
        const t = seg[i];
        if (!t || t.startsWith("-")) continue;
        const isPath =
          typeof engine.looksLikePath === "function"
            ? engine.looksLikePath(t)
            : t.includes("/") || t.startsWith("~") || t.startsWith(".");
        if (isPath) pathArgs.push(t);
      }
    }

    // Bare filenames (no slash) are filtered by explicitPathArgs but may
    // still be gitignored via a bare pattern like `*.log` or `ignored.txt`.
    // Include any non-flag arg containing a dot.
    for (let i = 1; i < seg.length; i++) {
      const t = seg[i];
      if (!t || t.startsWith("-") || t.includes("$") || t.includes("`")) continue;
      if (!t.includes("/") && t.includes(".") && !pathArgs.includes(t)) {
        pathArgs.push(t);
      }
    }

    if (pathArgs.length === 0) return false;

    for (const raw of pathArgs) {
      if (raw.includes("*") || raw.includes("?") || raw.includes("{") || raw.includes("$") || raw.includes("`"))
        continue;

      let resolved: string;
      try {
        const exp =
          typeof engine.expandUser === "function" ? engine.expandUser(raw) : shared.expandUser(raw);
        if (typeof engine.resolveAgainst === "function") {
          resolved = engine.resolveAgainst(exp, ctx.cwd);
        } else {
          resolved = exp.startsWith("/") ? exp : `${ctx.cwd}/${exp}`;
        }
        if (typeof engine.canonicalize === "function") {
          // canonicalize chases symlinks when the file exists; fallback is expandUser+normalize
          const canon = engine.canonicalize(resolved);
          // engine.canonicalize falls back gracefully, so use it
          resolved = canon;
        } else if (existsSync(resolved)) {
          try {
            const { realpathSync } = awaitRequireRealpath();
            resolved = realpathSync(resolved);
          } catch {
            // keep as-is
          }
        }
      } catch {
        continue;
      }

      // Respect effective enabled for the file's own repo (handles
      // `cat /tmp/other-repo/ignored.txt` correctly).
      if (!shared.getEffectiveEnabled(ctx.cwd, resolved).enabled) continue;
      if (shared.matchesAny(resolved, cfg.allow)) continue;

      const verdict = shared.isGitIgnored(resolved, ctx.cwd, cfg.blockTracked);
      if (verdict.ignored) return true;
    }
    return false;
  });

  return {
    name: "gitignore-guard bashguard bridge",
  };
}

let _realpathSync: ((p: string) => string) | null = null;
function awaitRequireRealpath(): { realpathSync: (p: string) => string } {
  if (_realpathSync) return { realpathSync: _realpathSync };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    _realpathSync = fs.realpathSync;
  } catch {
    _realpathSync = (p: string) => p;
  }
  return { realpathSync: _realpathSync! };
}
