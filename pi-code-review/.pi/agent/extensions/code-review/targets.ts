import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ReviewTarget {
	kind: "uncommitted" | "stack" | "commit" | "paths" | "rev" | "session";
	/** Human-readable label, e.g. "uncommitted changes", "abc1234" */
	label: string;
	/** Canonical diff text (possibly truncated; see diffFile) */
	diff: string;
	/** Extra context: commit messages, status output, etc. */
	context?: string;
	/** When truncated, the full diff lives here */
	diffFile?: string;
	truncated: boolean;
}

export type Exec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

async function tryExec(exec: Exec, command: string, args: string[], signal?: AbortSignal): Promise<string | null> {
	try {
		const result = await exec(command, args, { signal, timeout: 180_000 });
		return result.code === 0 ? result.stdout : null;
	} catch {
		return null;
	}
}

function applyTruncation(target: ReviewTarget, maxInlineBytes: number): ReviewTarget {
	if (Buffer.byteLength(target.diff, "utf8") <= maxInlineBytes) return target;
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-code-review-"));
	const diffFile = path.join(tmpDir, "full.diff");
	fs.writeFileSync(diffFile, target.diff, { encoding: "utf8", mode: 0o600 });
	const truncated = target.diff.slice(0, maxInlineBytes);
	return {
		...target,
		diff: `${truncated}\n\n[DIFF TRUNCATED at ${maxInlineBytes} bytes of ${Buffer.byteLength(target.diff, "utf8")}. Full diff saved to: ${diffFile} — read it with the read tool if you have one.]`,
		diffFile,
		truncated: true,
	};
}

/** Find the merge base between HEAD and the upstream/default branch. */
async function findMergeBase(exec: Exec, signal?: AbortSignal): Promise<string | null> {
	for (const ref of ["@{upstream}", "origin/main", "origin/master", "main", "master"]) {
		const out = await tryExec(exec, "git", ["merge-base", "HEAD", ref], signal);
		if (out?.trim()) return out.trim();
	}
	return null;
}

/**
 * Resolve a review target from a freeform argument string.
 *
 * - "" | "uncommitted" | "wip"    -> uncommitted changes (git diff HEAD)
 * - "this" | "session"            -> changes made in the current session (sessionPaths)
 * - "stack" | "branch"            -> local commits on top of the upstream/default branch
 * - "commit" | "." | "head"       -> current commit (HEAD)
 * - existing paths                -> uncommitted changes limited to those paths
 * - anything else                 -> treated as a git commit-ish or range (git show / git diff A..B)
 */
export async function resolveTarget(
	exec: Exec,
	cwd: string,
	rawArg: string,
	maxInlineBytes: number,
	signal?: AbortSignal,
	/** Files modified in the current session; used by the "this" target */
	sessionPaths?: string[],
): Promise<ReviewTarget> {
	const arg = (rawArg ?? "").trim();

	// Changes made in the current session
	if (/^(this|session|session changes)$/i.test(arg)) {
		const paths = Array.from(new Set(sessionPaths ?? []))
			.map((p) => path.resolve(cwd, p))
			.filter((p) => fs.existsSync(p));
		if (paths.length === 0) {
			throw new Error('No files were modified in this session (target "this" found no edit/write tool calls)');
		}

		// Handle each file independently: files may live in different repos or
		// outside any repo entirely, and one bad path must not sink the rest.
		const sections: string[] = [];
		const skipped: string[] = [];
		for (const abs of paths) {
			const dir = path.dirname(abs);
			const diff = await tryExec(exec, "git", ["-C", dir, "diff", "HEAD", "--", abs], signal);
			if (diff?.trim()) {
				sections.push(diff);
				continue;
			}
			// No pending VCS diff: the file is new/untracked, outside a repo, or
			// was committed during the session. Include its full current content.
			try {
				const content = fs.readFileSync(abs, "utf8");
				if (content.includes("\0")) {
					skipped.push(`${abs} (binary)`);
					continue;
				}
				sections.push(
					`--- FULL FILE CONTENT (no pending VCS diff; new, untracked, outside a repo, or committed during the session): ${abs} ---\n${content}`,
				);
			} catch {
				skipped.push(`${abs} (unreadable)`);
			}
		}

		if (sections.length === 0) {
			throw new Error(
				`Could not build a review payload for session-modified files: ${paths.join(", ")}${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}`,
			);
		}
		const contextLines = [`Files modified in this session:`, ...paths];
		if (skipped.length) contextLines.push(`Skipped (not reviewable): ${skipped.join(", ")}`);
		return applyTruncation(
			{
				kind: "session",
				label: `changes from this session (${paths.length} file${paths.length === 1 ? "" : "s"})`,
				diff: sections.join("\n\n"),
				context: contextLines.join("\n"),
				truncated: false,
			},
			maxInlineBytes,
		);
	}

	// Local commits on top of the upstream/default branch
	if (/^(stack|branch|local stack|my stack)$/i.test(arg)) {
		const base = await findMergeBase(exec, signal);
		if (!base) {
			throw new Error(
				"Could not find a merge base (tried @{upstream}, origin/main, origin/master, main, master)",
			);
		}
		const diff = await tryExec(exec, "git", ["diff", base, "HEAD"], signal);
		if (!diff || !diff.trim()) throw new Error("No local commits found on top of the base branch");
		const log = await tryExec(exec, "git", ["log", "--reverse", "--format=%h: %s", `${base}..HEAD`], signal);
		return applyTruncation(
			{
				kind: "stack",
				label: "local branch commits",
				diff,
				context: log ? `Commits in branch:\n${log.trim()}` : undefined,
				truncated: false,
			},
			maxInlineBytes,
		);
	}

	// Current commit
	if (/^(commit|\.|head|current commit)$/i.test(arg)) {
		const diff = await tryExec(exec, "git", ["show", "--format=", "--patch", "HEAD"], signal);
		if (!diff || !diff.trim()) throw new Error("Could not get current commit diff");
		const msg = await tryExec(exec, "git", ["log", "-1", "--format=%B"], signal);
		return applyTruncation(
			{
				kind: "commit",
				label: "current commit",
				diff,
				context: msg ? `Commit message:\n${msg.trim()}` : undefined,
				truncated: false,
			},
			maxInlineBytes,
		);
	}

	// Uncommitted changes (default)
	if (arg === "" || /^(uncommitted|wip|working|changes)$/i.test(arg)) {
		const diff = await tryExec(exec, "git", ["diff", "HEAD"], signal);
		const status = await tryExec(exec, "git", ["status", "--short"], signal);
		if (!diff || !diff.trim()) throw new Error("No uncommitted changes found (git diff HEAD is empty)");
		return applyTruncation(
			{
				kind: "uncommitted",
				label: "uncommitted changes",
				diff,
				context: status?.trim() ? `Working copy status:\n${status.trim()}` : undefined,
				truncated: false,
			},
			maxInlineBytes,
		);
	}

	// Existing paths -> uncommitted changes for those paths
	const tokens = arg.split(/\s+/);
	if (tokens.every((t) => fs.existsSync(path.resolve(cwd, t)))) {
		const diff = await tryExec(exec, "git", ["diff", "HEAD", "--", ...tokens], signal);
		if (!diff || !diff.trim()) throw new Error(`No uncommitted changes found for: ${arg}`);
		return applyTruncation(
			{ kind: "paths", label: `uncommitted changes in ${arg}`, diff, truncated: false },
			maxInlineBytes,
		);
	}

	// Fallback: treat as a git commit-ish or range
	if (arg.includes("..")) {
		const diff = await tryExec(exec, "git", ["diff", arg], signal);
		if (diff?.trim()) {
			const log = await tryExec(exec, "git", ["log", "--reverse", "--format=%h: %s", arg], signal);
			return applyTruncation(
				{
					kind: "rev",
					label: arg,
					diff,
					context: log ? `Commits in range:\n${log.trim()}` : undefined,
					truncated: false,
				},
				maxInlineBytes,
			);
		}
	} else {
		const diff = await tryExec(exec, "git", ["show", "--format=", "--patch", arg], signal);
		if (diff?.trim()) {
			const msg = await tryExec(exec, "git", ["log", "-1", "--format=%B", arg], signal);
			return applyTruncation(
				{
					kind: "rev",
					label: arg,
					diff,
					context: msg ? `Commit message:\n${msg.trim()}` : undefined,
					truncated: false,
				},
				maxInlineBytes,
			);
		}
	}

	throw new Error(
		`Could not resolve review target "${arg}". Supported: (empty)=uncommitted, this, stack, commit, paths, or a git commit/range.`,
	);
}
