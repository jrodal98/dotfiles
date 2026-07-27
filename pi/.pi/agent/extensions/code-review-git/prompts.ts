import type { ReviewSpeed } from "./config.js";
import type { ReviewTarget } from "./targets.js";

export interface FocusArea {
	id: string;
	name: string;
	description: string;
}

export const FOCUS_CATALOG: FocusArea[] = [
	{
		id: "bugs",
		name: "Bugs & correctness",
		description: "Logic errors, edge cases, off-by-one, broken invariants, incorrect behavior",
	},
	{
		id: "slop",
		name: "Slop & over-engineering",
		description: "Dead code, needless abstraction, duplicated logic, AI-generated cruft, inconsistency",
	},
	{
		id: "security",
		name: "Security",
		description: "Injection, authz/authn gaps, unsafe data handling, secrets, path traversal, SSRF",
	},
	{
		id: "tests",
		name: "Test coverage",
		description: "Missing or weak tests, untested edge cases, brittle or tautological tests",
	},
	{
		id: "performance",
		name: "Performance",
		description: "Unnecessary work, N+1 patterns, blocking calls, memory misuse, hot-path regressions",
	},
	{
		id: "error-handling",
		name: "Error handling & resilience",
		description: "Swallowed errors, missing timeouts/retries, bad failure modes, unclear error messages",
	},
	{
		id: "api-design",
		name: "API & interface design",
		description: "Confusing signatures, leaky abstractions, backwards compatibility, naming",
	},
	{
		id: "concurrency",
		name: "Concurrency",
		description: "Races, deadlocks, shared mutable state, async misuse",
	},
	{
		id: "readability",
		name: "Readability & maintainability",
		description: "Clarity, structure, naming, comments, documentation",
	},
];

export function findFocusArea(idOrName: string): FocusArea | undefined {
	const needle = idOrName.trim().toLowerCase();
	return FOCUS_CATALOG.find(
		(f) => f.id === needle || f.name.toLowerCase() === needle || f.name.toLowerCase().startsWith(needle),
	);
}

export function targetBlock(target: ReviewTarget): string {
	const lines = [`Review target: ${target.label}`];
	if (target.context) lines.push("", target.context);
	lines.push("", "--- BEGIN DIFF ---", target.diff, "--- END DIFF ---");
	return lines.join("\n");
}

/** Extract the last fenced ```json block from model output. */
export function extractJsonBlock(text: string): unknown | null {
	const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
	if (matches.length === 0) return null;
	try {
		return JSON.parse(matches[matches.length - 1][1]);
	} catch {
		return null;
	}
}

/** Remove fenced ```json blocks (used to keep reports human-readable). */
export function stripJsonBlocks(text: string): string {
	return text.replace(/```json\s*\n[\s\S]*?```/g, "").trim();
}

// ---------------------------------------------------------------------------
// Focus area suggestion
// ---------------------------------------------------------------------------

export function buildFocusSuggestPrompt(target: ReviewTarget): string {
	const catalog = FOCUS_CATALOG.map((f) => `- ${f.id}: ${f.name} — ${f.description}`).join("\n");
	return [
		"You select reviewer focus areas for a code review. Analyze the diff below and pick the 3-6 focus areas from the catalog that would produce the most valuable review for THIS change. Add custom focus areas only if the change carries a specific risk not covered by the catalog.",
		"",
		"Catalog:",
		catalog,
		"",
		'Respond with ONLY a fenced json block, no other text:',
		"```json",
		'{"selected": ["bugs", "slop"], "custom": [{"id": "migration-safety", "name": "Migration safety", "description": "..."}]}',
		"```",
		"",
		targetBlock(target),
	].join("\n");
}

export interface FocusSuggestion {
	selected: string[];
	custom: FocusArea[];
}

export function parseFocusSuggestion(text: string): FocusSuggestion | null {
	const parsed = extractJsonBlock(text) as any;
	if (!parsed || !Array.isArray(parsed.selected)) return null;
	const custom: FocusArea[] = [];
	for (const c of parsed.custom ?? []) {
		if (c && typeof c.name === "string") {
			custom.push({
				id: typeof c.id === "string" ? c.id : c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
				name: c.name,
				description: typeof c.description === "string" ? c.description : "",
			});
		}
	}
	return { selected: parsed.selected.map(String), custom };
}

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

const SPEED_RULES: Record<ReviewSpeed, string> = {
	quick: [
		"You have NO tools. Review the diff text only.",
		"Do not speculate about code you cannot see; if a finding depends on unseen code, flag the uncertainty explicitly.",
		"Where the analysis playbooks below require reading surrounding code, instead flag the risk explicitly as unverified.",
	].join("\n"),
	normal: [
		"You have read-only tools (read, grep, find, ls, bash). Use them to confirm suspicions by inspecting surrounding code.",
		"Use bash ONLY for read-only commands (git log, git blame, etc.). Never modify files or repo state.",
		"Timebox exploration — the diff is the primary subject; do not audit the whole repo.",
	].join("\n"),
	thorough: [
		"You have read-only tools (read, grep, find, ls, bash). Use bash ONLY for read-only commands. Never modify files or repo state.",
		"Verify EVERY finding against the actual code before reporting it: read the surrounding implementations, callers, and tests.",
		"Report only verified findings, or clearly mark a finding as unverified with the reason you could not verify it.",
	].join("\n"),
};

export function buildReviewerSystemPrompt(focus: FocusArea, speed: ReviewSpeed): string {
	return [
		`# Code reviewer: ${focus.name}`,
		"",
		`You are a specialist code reviewer with a single focus: **${focus.name}** — ${focus.description}.`,
		"Findings outside your focus area should be reported only if they are High severity.",
		"",
		"## Depth rules",
		SPEED_RULES[speed],
		"",
		"## Analysis playbooks",
		"Apply the playbook when the diff matches its trigger:",
		"",
		"### Consumer/caller analysis",
		"When the diff changes how data is produced (return values, output formats, library swaps):",
		"- Read every function that consumes the output of the changed code.",
		"- Search for call sites of modified functions and check how return values are used.",
		"- Look for implicit behavioral contracts: null representation, type semantics, error signaling.",
		"",
		"### Library/API migration",
		"When the diff replaces one library with another:",
		"- Identify behavioral differences between old and new: return types, null handling, error modes, default settings.",
		"- Scan downstream code for patterns that depend on the old library's behavior.",
		"- Flag missing tests: a library migration with zero test changes is a red flag.",
		"- Check for inconsistencies: if surrounding code uses a defensive pattern but the changed area doesn't, flag it.",
		"",
		"### Data schema awareness",
		"When reviewing code that processes structured data (query results, API responses, parsed files):",
		"- Read the query or schema that produces the data to understand field types.",
		"- Verify that null-check and type-check patterns match the actual data types.",
		"- Flag bare truthiness checks on values that could be null/empty in ambiguous ways.",
		"",
		"## What to flag",
		"Only Medium and High priority issues. Review ONLY the change in the provided diff; pre-existing code is context, not the subject.",
		"- High: bugs, security vulnerabilities, data races, memory leaks",
		"- Medium: logic errors, missing error handling, performance issues",
		"",
		"## What NOT to flag",
		"- Low priority issues",
		"- Style preferences (unless clearly wrong)",
		'- "Consider adding a comment" suggestions',
		"- Trivial nitpicks or minor formatting issues",
		"",
		"## Output format",
		"Jump straight to findings — do NOT summarize what the diff does (the author knows).",
		"For each finding:",
		"### <High|Medium>: <short title>",
		"- **Where**: <file>:<line or range>",
		"- Description (1-2 sentences max) and suggested fix (1 sentence or a code snippet). If the fix is obvious, omit it.",
		"",
		"Conciseness rules:",
		"- At most 8 findings; each finding max 3 sentences total.",
		'- No praise, no "positive notes" section, no hedging ("this could potentially...").',
		'- If there are no issues: say exactly "Looks good — no critical issues." Do not elaborate or add positive notes.',
		"",
		"End your final message with a fenced json block summarizing findings (empty array if none):",
		"```json",
		'[{"severity": "high", "title": "...", "file": "path/to/file", "line": 42, "detail": "...", "suggestion": "..."}]',
		"```",
	].join("\n");
}

export function buildReviewerTask(target: ReviewTarget): string {
	return `Perform your focused code review of the following change.\n\n${targetBlock(target)}`;
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export interface ReviewerOutput {
	model: string;
	focus: string;
	output: string;
	failed: boolean;
}

export function buildAggregatorTask(
	target: ReviewTarget,
	outputs: ReviewerOutput[],
	speed: ReviewSpeed,
): string {
	const sections = outputs.map((o) =>
		[
			`### Reviewer: ${o.focus} (model: ${o.model})${o.failed ? " [FAILED — no usable output]" : ""}`,
			"",
			o.failed ? "(reviewer failed)" : o.output,
		].join("\n"),
	);

	const verify =
		speed === "thorough"
			? [
					"- THOROUGH MODE: you have read-only tools. Verify each candidate finding against the repository before including it. Mark each accepted finding [verified] or [unverified]. Move findings you disprove to Dismissed with the reason.",
				]
			: [];

	return [
		"You are the code review aggregator. Multiple specialist reviewers (focus area × model) independently reviewed the same change. Merge their reports into one final report.",
		"",
		"Rules:",
		"- Dedupe: merge findings that describe the same underlying issue; record every reviewer (model · focus) that found it.",
		"- Cross-compare: findings independently reported by more than one MODEL get higher confidence — mark them with ✅ (model agreement).",
		"- When reviewers disagree about the same code, present the disagreement and give your judgment.",
		"- Dismiss clearly wrong, irrelevant, low-priority, or nitpicky findings (style preferences, comment suggestions, formatting); list them briefly under Dismissed with a one-line reason.",
		...verify,
		"- Order findings by severity: High first, then Medium.",
		"- Keep each finding to 3 sentences max. No praise, no restating what the diff does.",
		"",
		"Output format:",
		"# Code review report",
		"One-sentence overall verdict (ship it / fix high-severity first / needs rework).",
		"## Findings",
		"### <n>. [<High|Medium>] <title>  (found by: <model·focus>, ...)",
		"- **Where**: <file>:<line>",
		"- Description and suggested fix, concise.",
		"## Dismissed",
		"## Notes (optional: disagreements, coverage gaps)",
		"",
		'If all reviewers found nothing: verdict is "Looks good — no critical issues." with empty findings.',
		"",
		"End with a fenced json block of accepted findings (empty array if none):",
		"```json",
		'[{"id": 1, "severity": "high", "title": "...", "file": "...", "line": 42, "foundBy": ["gpt-5.6-sol·bugs"], "agreement": false}]',
		"```",
		"",
		targetBlock(target),
		"",
		"## Reviewer reports",
		"",
		sections.join("\n\n---\n\n"),
	].join("\n");
}

// ---------------------------------------------------------------------------
// Clarifier
// ---------------------------------------------------------------------------

export function buildClarifierSeedTask(target: ReviewTarget, report: string, question: string): string {
	return [
		"You are a clarifier agent for a completed code review. The user will ask questions about the findings below. Answer concisely and concretely. Use your read-only tools to check the actual code when needed. Never modify files.",
		"",
		targetBlock(target),
		"",
		"## Final review report",
		"",
		report,
		"",
		"## User question",
		"",
		question,
	].join("\n");
}
