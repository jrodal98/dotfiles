/**
 * Code Review extension
 *
 * Multi-model, multi-focus code review via parallel pi child processes.
 *
 * - /review [target]  Interactive flow: resolve target, auto-suggest focus areas
 *                     (you confirm/edit), pick reviewer models (cross-family
 *                     defaults), pick speed, run focus×model reviewers in
 *                     parallel, aggregate + cross-compare, then review the
 *                     findings yourself (with an optional clarifier Q&A agent)
 *                     before sending them to the main agent.
 * - review tool       Same pipeline without UI. The main agent should only call
 *                     it when you explicitly ask for a self-review; findings go
 *                     straight back to the agent to fix.
 *
 * Config: ~/.pi/agent/code-review.json (see config.ts for defaults).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CHEAP_MODEL,
	defaultReviewModels,
	loadConfig,
	modelWithThinking,
	type ReviewConfig,
	type ReviewSpeed,
	shortModelName,
	TOOLS_BY_SPEED,
} from "./config.js";
import {
	buildAggregatorTask,
	buildClarifierSeedTask,
	buildFocusSuggestPrompt,
	buildReviewerSystemPrompt,
	buildReviewerTask,
	extractJsonBlock,
	findFocusArea,
	FOCUS_CATALOG,
	type FocusArea,
	parseFocusSuggestion,
	stripJsonBlocks,
} from "./prompts.js";
import {
	type ChildResult,
	isChildError,
	mapWithConcurrencyLimit,
	reviewSessionFile,
	runPiChild,
} from "./runner.js";
import { resolveTarget, type Exec, type ReviewTarget } from "./targets.js";
import { multiToggle, withLoader, withPhasedLoader } from "./ui.js";

// ---------------------------------------------------------------------------
// Shared review orchestration
// ---------------------------------------------------------------------------

interface ReviewerRun {
	focus: FocusArea;
	model: string; // provider/id
	status: "queued" | "running" | "done" | "failed";
	lastEvent: string;
	result?: ChildResult;
}

interface ReviewRunResult {
	report: string;
	findings: any[];
	runs: ReviewerRun[];
	totalCost: number;
	aggregatorFailed: boolean;
}

interface RunReviewOptions {
	cwd: string;
	target: ReviewTarget;
	focusAreas: FocusArea[];
	models: string[];
	speed: ReviewSpeed;
	aggregatorModel?: string; // provider/id; falls back to first reviewer model
	cfg: ReviewConfig;
	signal?: AbortSignal;
	onProgress?: (runs: ReviewerRun[], phase: "reviewing" | "aggregating") => void;
}

async function runReview(opts: RunReviewOptions): Promise<ReviewRunResult> {
	const { cwd, target, focusAreas, models, speed, cfg, signal, onProgress } = opts;

	const runs: ReviewerRun[] = [];
	for (const focus of focusAreas) {
		for (const model of models) {
			runs.push({ focus, model, status: "queued", lastEvent: "" });
		}
	}

	const emit = (phase: "reviewing" | "aggregating") => onProgress?.(runs, phase);
	emit("reviewing");

	await mapWithConcurrencyLimit(runs, cfg.maxConcurrency, async (run) => {
		if (signal?.aborted) {
			run.status = "failed";
			run.lastEvent = "cancelled";
			return;
		}
		run.status = "running";
		emit("reviewing");
		const tools = TOOLS_BY_SPEED[speed].slice();
		if (target.truncated && tools.length === 0) tools.push("read");
		const result = await runPiChild({
			model: modelWithThinking(run.model, speed),
			systemPrompt: buildReviewerSystemPrompt(run.focus, speed),
			task: buildReviewerTask(target),
			tools,
			cwd,
			signal,
			onProgress: (p) => {
				run.lastEvent = p.text;
				emit("reviewing");
			},
		});
		run.result = result;
		run.status = isChildError(result) ? "failed" : "done";
		run.lastEvent = run.status === "failed" ? result.errorMessage || "failed" : "";
		emit("reviewing");
	});

	if (signal?.aborted) throw new Error("Review cancelled");

	const usable = runs.filter((r) => r.status === "done");
	if (usable.length === 0) {
		const firstError = runs.find((r) => r.result)?.result;
		throw new Error(
			`All ${runs.length} reviewers failed. ${firstError?.errorMessage || firstError?.stderr?.slice(0, 500) || ""}`.trim(),
		);
	}

	emit("aggregating");
	const aggTools =
		speed === "thorough" ? TOOLS_BY_SPEED.thorough.slice() : target.truncated ? ["read"] : [];
	const aggModelBase = opts.aggregatorModel ?? models[0];
	const agg = await runPiChild({
		model: modelWithThinking(aggModelBase, speed === "quick" ? "normal" : speed),
		task: buildAggregatorTask(
			target,
			runs.map((r) => ({
				model: shortModelName(r.model),
				focus: r.focus.id,
				output: r.result?.finalText ?? "",
				failed: r.status !== "done",
			})),
			speed,
		),
		tools: aggTools,
		cwd,
		signal,
	});

	let report: string;
	let findings: any[] = [];
	let aggregatorFailed = false;
	if (isChildError(agg)) {
		aggregatorFailed = true;
		report =
			"# Code review report (aggregation failed — raw reviewer outputs)\n\n" +
			usable
				.map((r) => `## ${shortModelName(r.model)} · ${r.focus.name}\n\n${stripJsonBlocks(r.result!.finalText)}`)
				.join("\n\n---\n\n");
	} else {
		report = stripJsonBlocks(agg.finalText);
		const parsed = extractJsonBlock(agg.finalText);
		if (Array.isArray(parsed)) findings = parsed;
	}

	const totalCost = runs.reduce((sum, r) => sum + (r.result?.usage.cost ?? 0), 0) + (agg?.usage.cost ?? 0);
	return { report, findings, runs, totalCost, aggregatorFailed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
	return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
}

function currentModelString(ctx: ExtensionContext): string | undefined {
	const provider = ctx.model?.provider;
	const id = ctx.model?.id;
	return provider && id ? `${provider}/${id}` : undefined;
}

/** Files modified in the current session branch via edit/write tool calls. */
function collectSessionPaths(ctx: ExtensionContext): string[] {
	const paths = new Set<string>();
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = (entry as any).message;
			if (message?.role !== "assistant") continue;
			for (const part of message.content ?? []) {
				if (part.type !== "toolCall") continue;
				if (part.name !== "edit" && part.name !== "write") continue;
				const raw = part.arguments?.path ?? part.arguments?.file_path;
				if (typeof raw === "string" && raw.trim()) {
					paths.add(raw.trim().replace(/^@/, ""));
				}
			}
		}
	} catch {
		// session manager unavailable; return what we have
	}
	return [...paths];
}

function findingsSummary(findings: any[]): string {
	if (!findings.length) return "no critical issues";
	const counts: Record<string, number> = {};
	for (const f of findings) {
		const sev = typeof f?.severity === "string" ? f.severity.toLowerCase() : "other";
		counts[sev] = (counts[sev] ?? 0) + 1;
	}
	const parts = ["high", "medium", "blocker", "major", "minor", "nit"]
		.filter((s) => counts[s])
		.map((s) => `${counts[s]} ${s}`);
	return parts.length ? parts.join(", ") : `${findings.length} findings`;
}

function progressLines(runs: ReviewerRun[], phase: string, cost: number): string[] {
	const finished = runs.filter((r) => r.status === "done" || r.status === "failed").length;
	const failed = runs.filter((r) => r.status === "failed").length;
	const lines = [
		`Code review [${phase}] ${finished}/${runs.length} reviewers${failed ? ` (${failed} failed)` : ""}${cost ? ` $${cost.toFixed(3)}` : ""}`,
	];
	for (const r of runs) {
		const icon = r.status === "done" ? "✓" : r.status === "failed" ? "✗" : r.status === "running" ? "⏳" : "·";
		const detail = r.status === "running" && r.lastEvent ? ` — ${r.lastEvent}` : r.status === "failed" && r.lastEvent ? ` — ${r.lastEvent.slice(0, 60)}` : "";
		lines.push(` ${icon} ${shortModelName(r.model)} · ${r.focus.id}${detail}`);
	}
	return lines;
}

function runningCost(runs: ReviewerRun[]): number {
	return runs.reduce((sum, r) => sum + (r.result?.usage.cost ?? 0), 0);
}

function buildAgentMessage(
	target: ReviewTarget,
	review: ReviewRunResult,
	models: string[],
	speed: ReviewSpeed,
	focusAreas: FocusArea[],
): string {
	return [
		`A multi-model code review was performed on: ${target.label}.`,
		`Speed: ${speed}. Reviewer models: ${models.map(shortModelName).join(", ")}. Focus areas: ${focusAreas.map((f) => f.name).join(", ")}.`,
		"",
		review.report,
		"",
		"Please address the findings above, starting with the highest severity. If you disagree with a finding, say why instead of silently skipping it.",
	].join("\n");
}

async function suggestFocusAreas(
	cfg: ReviewConfig,
	target: ReviewTarget,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ suggestedIds: Set<string>; custom: FocusArea[] }> {
	const fallback = { suggestedIds: new Set(["bugs", "slop"]), custom: [] as FocusArea[] };
	try {
		const result = await runPiChild({
			model: cfg.focusSuggestModel,
			task: buildFocusSuggestPrompt(target),
			tools: [],
			cwd,
			signal,
		});
		if (isChildError(result)) return fallback;
		const parsed = parseFocusSuggestion(result.finalText);
		if (!parsed || parsed.selected.length === 0) return fallback;
		return { suggestedIds: new Set(parsed.selected), custom: parsed.custom };
	} catch {
		return fallback;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

interface ReviewToolDetails {
	label: string;
	speed: ReviewSpeed;
	phase: string;
	runs: { model: string; focus: string; status: string; lastEvent: string }[];
	report?: string;
	summary?: string;
	cost: number;
}

export default function codeReviewExtension(pi: ExtensionAPI) {
	const execFn: Exec = (command, args, options) => pi.exec(command, args, options);

	// ---- Entry renderers ----------------------------------------------------

	pi.registerEntryRenderer("code-review-report", (entry, { expanded }, theme) => {
		const data = entry.data as {
			label: string;
			speed: string;
			models: string[];
			focus: string[];
			report: string;
			findings: any[];
			cost: number;
		};
		const container = new Container();
		const header = `Code review — ${data.label} (${data.speed}; ${data.models.map(shortModelName).join(", ")}${data.cost ? `; $${data.cost.toFixed(3)}` : ""})`;
		container.addChild(new Text(theme.fg("accent", theme.bold(header)), 0, 0));
		if (expanded) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(data.report ?? "(no report)", 0, 0, getMarkdownTheme()));
		} else {
			container.addChild(new Text(theme.fg("muted", `Findings: ${findingsSummary(data.findings ?? [])}`), 0, 0));
			for (const f of (data.findings ?? []).slice(0, 10)) {
				container.addChild(new Text(theme.fg("dim", ` • [${f.severity ?? "?"}] ${f.title ?? "(untitled)"}`), 0, 0));
			}
			container.addChild(new Text(theme.fg("dim", "(expand tool output to read the full report)"), 0, 0));
		}
		return container;
	});

	pi.registerEntryRenderer("code-review-clarifier", (entry, { expanded }, theme) => {
		const data = entry.data as { question: string; answer: string };
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(`Clarifier ❯ ${data.question}`)), 0, 0));
		container.addChild(new Spacer(1));
		const answer = expanded ? data.answer : data.answer.split("\n").slice(0, 12).join("\n");
		container.addChild(new Markdown(answer, 0, 0, getMarkdownTheme()));
		return container;
	});

	// ---- /review command ----------------------------------------------------

	pi.registerCommand("review", {
		description:
			"Multi-model code review: uncommitted (default), this (session changes), stack, commit, paths, or a git commit/range. Flags: --auto (accept all defaults), --fix (send findings straight to the main agent), --cheap (single cheap model: muse-spark-1.3-contributor), --quick/--normal/--thorough (speed)",
		getArgumentCompletions: (prefix: string) => {
			const options = ["uncommitted", "this", "stack", "commit", "--auto", "--fix", "--cheap", "--quick", "--normal", "--thorough"];
			const parts = prefix.split(/\s+/);
			const last = parts[parts.length - 1] ?? "";
			const before = parts.slice(0, -1).join(" ");
			const items = options
				.filter((o) => o.startsWith(last) && !parts.slice(0, -1).includes(o))
				.map((o) => ({ value: before ? `${before} ${o}` : o, label: o }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/review requires an interactive UI", "error");
				return;
			}
			const cfg = loadConfig();

			// Parse flags: --auto (accept defaults), --fix (auto-send findings),
			// --cheap (single cheap model), --quick/--normal/--thorough (speed override). Rest is the target.
			const tokens = (args ?? "").split(/\s+/).filter(Boolean);
			const flags = new Set(tokens.filter((t) => t.startsWith("--")));
			const targetArg = tokens.filter((t) => !t.startsWith("--")).join(" ");
			const auto = flags.has("--auto");
			const autoFix = flags.has("--fix");
			const cheap = flags.has("--cheap");
			const speedOverride: ReviewSpeed | undefined = flags.has("--quick")
				? "quick"
				: flags.has("--thorough")
					? "thorough"
					: flags.has("--normal")
						? "normal"
						: undefined;

			// 1. Resolve target
			const sessionPaths = collectSessionPaths(ctx);
			const targetResult = await withLoader(ctx.ui, ctx.mode, `Resolving review target${targetArg ? `: ${targetArg}` : ""}…`, (signal) =>
				resolveTarget(execFn, ctx.cwd, targetArg, cfg.maxInlineDiffBytes, signal, sessionPaths),
			);
			if (!targetResult.ok) {
				if (!targetResult.cancelled) ctx.ui.notify(targetResult.error ?? "Failed to resolve target", "error");
				return;
			}
			const target = targetResult.value;

			// 2. Suggest focus areas
			const suggestResult = await withLoader(ctx.ui, ctx.mode, "Analyzing diff to suggest focus areas…", (signal) =>
				suggestFocusAreas(cfg, target, ctx.cwd, signal),
			);
			if (!suggestResult.ok && suggestResult.cancelled) return;
			const { suggestedIds, custom } = suggestResult.ok
				? suggestResult.value
				: { suggestedIds: new Set(["bugs", "slop"]), custom: [] as FocusArea[] };

			// 3. Confirm/edit focus areas (skipped with --auto)
			const allAreas: FocusArea[] = [...FOCUS_CATALOG, ...custom.filter((c) => !findFocusArea(c.id))];
			let focusAreas: FocusArea[];
			if (auto) {
				focusAreas = allAreas.filter((f) => suggestedIds.has(f.id));
				if (focusAreas.length === 0) focusAreas = FOCUS_CATALOG.slice(0, 2);
			} else {
				const focusPick = await multiToggle(
					ctx.ui,
					ctx.mode,
					`Reviewer focus areas (suggested for ${target.label})`,
					allAreas.map((f) => ({ id: f.id, label: f.name, description: f.description, checked: suggestedIds.has(f.id) })),
				);
				if (focusPick === null) return;
				const extraRaw = await ctx.ui.input("Additional custom focus areas (comma-separated, empty to skip):", "");
				const extraAreas: FocusArea[] = (extraRaw ?? "")
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
					.map((name) => findFocusArea(name) ?? { id: slugify(name), name, description: "" });
				focusAreas = [
					...allAreas.filter((f) => focusPick.has(f.id)),
					...extraAreas.filter((e) => !focusPick.has(e.id)),
				];
				if (focusAreas.length === 0) {
					ctx.ui.notify("No focus areas selected — review cancelled", "warning");
					return;
				}
			}

			// 4. Pick reviewer models (defaults with --auto, or cheap single-model)
			const defaults = defaultReviewModels(ctx.model, cfg);
			let models: string[];
			if (cheap) {
				models = [CHEAP_MODEL];
			} else if (auto) {
				models = defaults;
			} else {
				let available: string[] = [];
				try {
					const availableModels = await ctx.modelRegistry.getAvailable();
					available = availableModels.map((m: any) => `${m.provider}/${m.id}`);
				} catch {
					// fall through to defaults only
				}
				for (const d of defaults) if (!available.includes(d)) available.push(d);
				const modelPick = await multiToggle(
					ctx.ui,
					ctx.mode,
					"Reviewer models (each model runs every focus area)",
					available.map((m) => ({ id: m, label: m, checked: defaults.includes(m) })),
				);
				if (modelPick === null || modelPick.size === 0) {
					ctx.ui.notify("No models selected — review cancelled", "warning");
					return;
				}
				models = [...modelPick];
			}

			// 5. Speed (flag override > --auto default > prompt)
			let speed: ReviewSpeed;
			if (speedOverride) {
				speed = speedOverride;
			} else if (auto) {
				speed = cfg.defaultSpeed;
			} else {
				const speedChoice = await ctx.ui.select("Review speed:", [
					"quick — diff-only, no repo exploration, low thinking",
					"normal — reviewers may read surrounding code, medium thinking",
					"thorough — deep exploration + finding verification, high thinking",
				]);
				if (!speedChoice) return;
				speed = speedChoice.split(" ")[0] as ReviewSpeed;
			}

			// 6. Confirm (skipped with --auto)
			const totalRuns = focusAreas.length * models.length;
			const summaryText = [
				`Target: ${target.label}`,
				`Reviewers: ${totalRuns} (${focusAreas.length} focus × ${models.length} models)`,
				`Focus: ${focusAreas.map((f) => f.name).join(", ")}`,
				`Models: ${models.map(shortModelName).join(", ")}`,
				`Speed: ${speed}`,
			].join("\n");
			if (auto) {
				ctx.ui.notify(
					`Auto review: ${totalRuns} reviewers (${focusAreas.map((f) => f.id).join(", ")} × ${models.map(shortModelName).join(", ")}), speed ${speed}${autoFix ? ", findings auto-sent" : ""}`,
					"info",
				);
			} else {
				const ok = await ctx.ui.confirm("Run code review?", summaryText);
				if (!ok) return;
			}

			// 7. Run reviewers + aggregation
			const runResult = await withPhasedLoader(
				ctx.ui,
				ctx.mode,
				`Running ${totalRuns} reviewers (${speed})…`,
				(signal, setMessage) =>
					runReview({
						cwd: ctx.cwd,
						target,
						focusAreas,
						models,
						speed,
						aggregatorModel: cheap ? CHEAP_MODEL : currentModelString(ctx),
						cfg,
						signal,
						onProgress: (runs, phase) => {
							ctx.ui.setWidget("code-review", progressLines(runs, phase, runningCost(runs)));
							if (phase === "aggregating") {
								const done = runs.filter((r) => r.status === "done").length;
								setMessage(
									`Aggregating findings from ${done} reviewer${done === 1 ? "" : "s"}${speed === "thorough" ? " (verifying against repo)" : ""}…`,
								);
							}
						},
					}),
			);
			ctx.ui.setWidget("code-review", undefined);
			if (!runResult.ok) {
				if (!runResult.cancelled) ctx.ui.notify(runResult.error ?? "Review failed", "error");
				else ctx.ui.notify("Review cancelled", "info");
				return;
			}
			const review = runResult.value;

			// 8. Persist report into transcript
			pi.appendEntry("code-review-report", {
				label: target.label,
				speed,
				models,
				focus: focusAreas.map((f) => f.name),
				report: review.report,
				findings: review.findings,
				cost: review.totalCost,
			});

			const agentMessage = buildAgentMessage(target, review, models, speed, focusAreas);

			// 9a. --fix: send findings straight to the main agent, no menu
			if (autoFix) {
				if (review.findings.length === 0 && !review.aggregatorFailed) {
					ctx.ui.notify(`Review done: ${findingsSummary(review.findings)} — nothing to fix`, "info");
					return;
				}
				try {
					pi.sendUserMessage(agentMessage);
				} catch {
					pi.sendUserMessage(agentMessage, { deliverAs: "followUp" });
				}
				ctx.ui.notify(`Review done (${findingsSummary(review.findings)}) — findings sent to main agent`, "info");
				return;
			}

			// 9b. Findings review loop (human in the loop)
			const clarifierKey = `clarifier-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			let clarifierSeeded = false;

			while (true) {
				const choice = await ctx.ui.select(`Review done (${findingsSummary(review.findings)}). Next?`, [
					"Send findings to main agent",
					"Edit findings in editor before sending",
					"Ask the clarifier a question",
					"Save report to file",
					"Done (do not send)",
				]);
				if (!choice || choice.startsWith("Done")) break;

				if (choice.startsWith("Send")) {
					try {
						pi.sendUserMessage(agentMessage);
					} catch {
						pi.sendUserMessage(agentMessage, { deliverAs: "followUp" });
					}
					break;
				}

				if (choice.startsWith("Edit")) {
					ctx.ui.setEditorText(agentMessage);
					ctx.ui.notify("Findings loaded into the editor — edit and send when ready", "info");
					break;
				}

				if (choice.startsWith("Save")) {
					const defaultPath = path.join(ctx.cwd, `code-review-${Date.now()}.md`);
					const savePath = await ctx.ui.input("Save report to:", defaultPath);
					if (savePath) {
						try {
							fs.writeFileSync(savePath.trim() || defaultPath, review.report, "utf8");
							ctx.ui.notify(`Saved: ${savePath.trim() || defaultPath}`, "info");
						} catch (error) {
							ctx.ui.notify(`Save failed: ${error instanceof Error ? error.message : error}`, "error");
						}
					}
					continue;
				}

				if (choice.startsWith("Ask")) {
					const question = await ctx.ui.input("Question for the clarifier:", "");
					if (!question?.trim()) continue;
					const sessionFile = reviewSessionFile(ctx.cwd, clarifierKey);
					const task = clarifierSeeded ? question : buildClarifierSeedTask(target, review.report, question);
					const answer = await withLoader(ctx.ui, ctx.mode, "Clarifier is thinking… esc to cancel", (signal) =>
						runPiChild({
							model: currentModelString(ctx),
							task,
							tools: ["read", "grep", "find", "ls", "bash"],
							sessionFile,
							cwd: ctx.cwd,
							signal,
						}),
					);
					if (answer.ok && !isChildError(answer.value)) {
						clarifierSeeded = true;
						pi.appendEntry("code-review-clarifier", { question, answer: answer.value.finalText });
					} else if (answer.ok) {
						ctx.ui.notify(answer.value.errorMessage || "Clarifier failed", "error");
					} else if (!answer.cancelled) {
						ctx.ui.notify(answer.error ?? "Clarifier failed", "error");
					}
					continue;
				}
			}
		},
	});

	// ---- review tool (agent-invoked self-review) -----------------------------

	pi.registerTool({
		name: "review",
		label: "Code Review",
		description: [
			"Run a multi-model code review of a change. Spawns one reviewer subagent per (focus area × model),",
			"cross-compares their findings, and returns a single aggregated report.",
			"Target: omit for uncommitted changes, or pass 'this' (changes made in the current session),",
			"'stack', 'commit', paths, or a git commit/range.",
		].join(" "),
		promptSnippet: "Run a multi-model code review of changes and get an aggregated findings report",
		promptGuidelines: [
			"Only call the review tool when the user explicitly asks you to review code (e.g. 'review your changes when done').",
			"After the review tool returns findings, address them directly without waiting for user confirmation, unless the user asked otherwise.",
		],
		parameters: Type.Object({
			target: Type.Optional(
				Type.String({
					description:
						"Review target: omit for uncommitted changes, or 'this' (changes made in the current session), 'stack', 'commit', file paths, or a git commit/range",
				}),
			),
			speed: Type.Optional(
				StringEnum(["quick", "normal", "thorough"] as const, {
					description: "Review depth: quick (diff-only), normal (may read code), thorough (verifies findings). Default: normal.",
				}),
			),
			models: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Reviewer models as provider/model-id. Default: cross-family best (Claude author → best GPT reviewer, and vice versa). Ignored when cheap is true.",
				}),
			),
			focusAreas: Type.Optional(
				Type.Array(Type.String(), {
					description: "Focus area ids (bugs, slop, security, tests, performance, error-handling, api-design, concurrency, readability) or custom names. Default: auto-suggested from the diff.",
				}),
			),
			cheap: Type.Optional(
				Type.Boolean({
					description: "When true, run all reviewers with just meta/muse-spark-1.3-contributor (cheap). Equivalent to --cheap on /review.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cfg = loadConfig();
			const target = await resolveTarget(
				execFn,
				ctx.cwd,
				params.target ?? "",
				cfg.maxInlineDiffBytes,
				signal,
				collectSessionPaths(ctx),
			);

			let focusAreas: FocusArea[];
			if (params.focusAreas?.length) {
				focusAreas = params.focusAreas.map(
					(s) => findFocusArea(s) ?? { id: slugify(s), name: s, description: "" },
				);
			} else {
				const { suggestedIds, custom } = await suggestFocusAreas(cfg, target, ctx.cwd, signal);
				focusAreas = [
					...FOCUS_CATALOG.filter((f) => suggestedIds.has(f.id)),
					...custom.filter((c) => suggestedIds.has(c.id) || !findFocusArea(c.id)),
				];
				if (focusAreas.length === 0) focusAreas = FOCUS_CATALOG.slice(0, 2);
			}

			const models = (params as any).cheap ? [CHEAP_MODEL] : params.models?.length ? params.models : defaultReviewModels(ctx.model, cfg);
			const speed: ReviewSpeed = params.speed ?? cfg.defaultSpeed;

			const makeDetails = (
				runs: ReviewerRun[],
				phase: string,
				report?: string,
				findings: any[] = [],
			): ReviewToolDetails => ({
				label: target.label,
				speed,
				phase,
				runs: runs.map((r) => ({
					model: shortModelName(r.model),
					focus: r.focus.id,
					status: r.status,
					lastEvent: r.lastEvent,
				})),
				report,
				summary: findings.length ? findingsSummary(findings) : undefined,
				cost: runningCost(runs),
			});

			const result = await runReview({
				cwd: ctx.cwd,
				target,
				focusAreas,
				models,
				speed,
				aggregatorModel: (params as any).cheap ? CHEAP_MODEL : currentModelString(ctx),
				cfg,
				signal,
				onProgress: (runs, phase) => {
					onUpdate?.({
						content: [{ type: "text", text: progressLines(runs, phase, runningCost(runs)).join("\n") }],
						details: makeDetails(runs, phase),
					});
				},
			});

			const summary = findingsSummary(result.findings);
			return {
				content: [
					{
						type: "text",
						text: `Code review of ${target.label} (${speed}; ${models.map(shortModelName).join(", ")}): ${summary}\n\n${result.report}`,
					},
				],
				details: makeDetails(result.runs, "done", result.report, result.findings),
			};
		},

		renderCall(args: any, theme: any) {
			const target = args?.target || "uncommitted changes";
			const speed = args?.speed ?? "normal";
			const models = args?.models?.length ? ` [${args.models.map(shortModelName).join(", ")}]` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("review ")) +
					theme.fg("accent", target) +
					theme.fg("dim", ` (${speed})${models}`),
				0,
				0,
			);
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
			const details = result.details as ReviewToolDetails | undefined;
			if (!details) {
				const text = result.content?.[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const container = new Container();
			const finished = details.runs.filter((r) => r.status === "done" || r.status === "failed").length;
			const header =
				details.phase === "done"
					? `✓ review ${details.label} — ${details.summary ?? "complete"}${details.cost ? ` ($${details.cost.toFixed(3)})` : ""}`
					: `⏳ review [${details.phase}] ${finished}/${details.runs.length} reviewers`;
			container.addChild(new Text(theme.fg(details.phase === "done" ? "success" : "warning", header), 0, 0));

			for (const r of details.runs) {
				const icon = r.status === "done" ? "✓" : r.status === "failed" ? "✗" : r.status === "running" ? "⏳" : "·";
				const detail = r.status === "running" && r.lastEvent ? theme.fg("dim", ` — ${r.lastEvent}`) : "";
				container.addChild(
					new Text(` ${icon} ${theme.fg("accent", r.model)} ${theme.fg("muted", `· ${r.focus}`)}${detail}`, 0, 0),
				);
			}

			if (expanded && details.report) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(details.report, 0, 0, getMarkdownTheme()));
			}
			return container;
		},
	});
}
