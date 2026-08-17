/**
 * Shared helpers for gitignore-guard (read tool) and bashguard (bash tool).
 * Kept at ~/.pi/agent/gitignore-shared.ts so both:
 *   - extensions/gitignore-guard.ts
 *   - bashguard/local.ts
 * can import the same effective-enabled and check-ignore logic.
 *
 * Fail-open everywhere: missing git, not a repo, spawn errors, bad config
 * never block.
 */

import {
  existsSync,
  readFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
} from "node:path";
import { realpathSync } from "node:fs";

export const SITE_CONFIG = join(homedir(), ".pi", "agent", "gitignore-guard.json");
export const MARKER_FILENAME = ".gitignore-guard";

export interface SiteConfig {
  enabled?: boolean;
  allow?: string[];
  blockTracked?: boolean;
}

export function loadConfig(): {
  enabled: boolean | undefined;
  allow: string[];
  blockTracked: boolean;
  siteError?: string;
  raw?: SiteConfig;
} {
  let raw: SiteConfig = {};
  let siteError: string | undefined;
  if (existsSync(SITE_CONFIG)) {
    try {
      raw = JSON.parse(readFileSync(SITE_CONFIG, "utf8")) as SiteConfig;
    } catch (e) {
      siteError = e instanceof Error ? e.message : String(e);
    }
  }
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
  return {
    enabled,
    allow: Array.isArray(raw.allow) ? raw.allow : [],
    blockTracked: raw.blockTracked === true,
    siteError,
    raw,
  };
}

export function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolvePath(path: string, cwd: string): string {
  const exp = expandUser(path);
  const abs = isAbsolute(exp) ? normalize(exp) : normalize(join(cwd, exp));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
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

export function matchesAny(resolved: string, patterns: string[]): string | undefined {
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

export interface GitIgnoreVerdict {
  ignored: boolean;
  pattern?: string;
  rawOutput?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Repo root / marker detection (cached, fail-open)
// ---------------------------------------------------------------------------

const repoRootCache = new Map<string, { root: string | null; expires: number }>();
export const REPO_CACHE_TTL_MS = 5000;

export function getRepoRoot(cwd: string): string | null {
  const now = Date.now();
  const cached = repoRootCache.get(cwd);
  if (cached && cached.expires > now) return cached.root;

  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.error || result.status !== 0) {
      repoRootCache.set(cwd, { root: null, expires: now + REPO_CACHE_TTL_MS });
      return null;
    }
    const root = (result.stdout ?? "").trim() || null;
    repoRootCache.set(cwd, { root, expires: now + REPO_CACHE_TTL_MS });
    return root;
  } catch {
    repoRootCache.set(cwd, { root: null, expires: now + REPO_CACHE_TTL_MS });
    return null;
  }
}

export function hasMarkerAtRoot(cwd: string): boolean {
  const root = getRepoRoot(cwd);
  if (!root) return false;
  try {
    return existsSync(join(root, MARKER_FILENAME));
  } catch {
    return false;
  }
}

/** Resolve whether the marker enables the guard for this cwd/path. */
export function hasMarkerForRequest(cwd: string, resolvedPath?: string): boolean {
  if (resolvedPath) {
    try {
      const dir = dirname(resolvedPath);
      if (existsSync(dir) && hasMarkerAtRoot(dir)) return true;
    } catch {
      // fall through
    }
  }
  return hasMarkerAtRoot(cwd);
}

export function getEffectiveEnabled(
  cwd: string,
  resolvedPath?: string,
): { enabled: boolean; source: string } {
  const cfg = loadConfig();
  if (typeof cfg.enabled === "boolean") {
    return {
      enabled: cfg.enabled,
      source: cfg.enabled ? "site config (on)" : "site config (off)",
    };
  }
  if (hasMarkerForRequest(cwd, resolvedPath)) {
    const root = getRepoRoot(
      (() => {
        if (resolvedPath) {
          try {
            const d = dirname(resolvedPath);
            if (existsSync(d) && getRepoRoot(d)) return d;
          } catch {
            // ignore
          }
        }
        return cwd;
      })(),
    );
    return {
      enabled: true,
      source: root ? `marker ${join(root, MARKER_FILENAME)}` : `marker ${MARKER_FILENAME} at repo root`,
    };
  }
  return { enabled: false, source: "default (off)" };
}

/**
 * Check if an absolute path is gitignored from the perspective of its
 * containing directory. Uses `git check-ignore --verbose` so we can report
 * the matching pattern.
 *
 * Fail-open: any error, timeout, missing git, or non-repo => not ignored.
 */
export function isGitIgnored(
  resolved: string,
  cwd: string,
  blockTracked = false,
): GitIgnoreVerdict {
  let gitCwd = cwd;
  try {
    const dir = dirname(resolved);
    if (existsSync(dir)) gitCwd = dir;
    else if (existsSync(cwd)) gitCwd = cwd;
  } catch {
    gitCwd = cwd;
  }

  const args = ["-C", gitCwd, "check-ignore", "--verbose"];
  if (blockTracked) args.push("--no-index");
  args.push("--", resolved);

  try {
    const result = spawnSync("git", args, {
      encoding: "utf8",
      timeout: 3000,
    });

    if (result.error) {
      return { ignored: false, error: String(result.error) };
    }

    if (result.status === 0) {
      const out = (result.stdout ?? "").trim();
      let pattern: string | undefined;
      const tabIdx = out.lastIndexOf("\t");
      const left = tabIdx >= 0 ? out.slice(0, tabIdx) : out;
      const lastColon = left.lastIndexOf(":");
      if (lastColon >= 0) pattern = left.slice(lastColon + 1);
      else pattern = left;
      return { ignored: true, pattern: pattern || left, rawOutput: out };
    }

    if (result.status === 1) {
      return { ignored: false };
    }

    const err = (result.stderr ?? "").trim();
    return { ignored: false, error: err || undefined };
  } catch (e) {
    return { ignored: false, error: e instanceof Error ? e.message : String(e) };
  }
}
