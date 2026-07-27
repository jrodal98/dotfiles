/**
 * Stop-check extension: pi port of the Claude Code "Stop" prompt hook.
 *
 * When the agent settles (would stop working), a secondary LLM call evaluates
 * the conversation to decide whether the agent is actually finished:
 *   1. All user-requested tasks are complete
 *   2. All skill prompts and user instructions are followed
 *   3. Any errors or warnings need to be addressed
 *   4. Follow-up work is needed
 *
 * The evaluator responds with {"ok": true} to allow stopping, or
 * {"ok": false, "reason": "..."} — in which case the reason is injected back
 * into the session and a new turn is triggered so the agent keeps working.
 *
 * Safeguards:
 * - Max 3 consecutive auto-continues (reset on real user input)
 * - 30s evaluation timeout (fail-open: allow stopping)
 * - Skipped when the last run was aborted (Esc) or errored
 * - In-flight evaluation is cancelled if the user types a new prompt
 *
 * RPC note: the continuation is injected seconds *after* `agent_settled` is
 * emitted (the eval takes an LLM round-trip). RPC clients that treat
 * `agent_settled` as terminal will miss the auto-continue turn; watch for a
 * subsequent `agent_start` instead of exiting immediately.
 *
 * Toggle with /stop-check [on|off|status].
 *
 * Debugging:
 * - STOP_CHECK_DEBUG=1 logs verdicts/errors to /tmp/stop-check.log
 * - STOP_CHECK_FORCE_CONTINUE=1 forces {"ok": false} to exercise the continue path
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

const debugLog = (msg: string) => {
	if (!process.env.STOP_CHECK_DEBUG) return;
	try {
		appendFileSync("/tmp/stop-check.log", `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// ignore
	}
};

const MAX_CONSECUTIVE_CONTINUES = 3;
const EVAL_TIMEOUT_MS = 30_000;
const MAX_CONVERSATION_CHARS = 40_000;
const MAX_TOOL_ARG_CHARS = 300;
const MAX_TOOL_RESULT_CHARS = 300;
const MAX_TOOL_ERROR_CHARS = 500;

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	customType?: string;
	summary?: string;
	content?: unknown;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		isError?: boolean;
		stopReason?: string;
	};
};

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts;
};

const extractToolCallLines = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];

	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;

		let args = JSON.stringify(block.arguments ?? {});
		if (args.length > MAX_TOOL_ARG_CHARS) {
			args = `${args.slice(0, MAX_TOOL_ARG_CHARS)}…`;
		}
		lines.push(`[tool call] ${block.name} ${args}`);
	}
	return lines;
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];

	for (const entry of entries) {
		// Compaction and branch summaries carry the original task context.
		if (entry.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
			sections.push(`[summary of earlier conversation]\n${entry.summary.trim()}`);
			continue;
		}
		if (entry.type === "branch_summary" && typeof entry.summary === "string" && entry.summary.trim()) {
			sections.push(`[summary of abandoned branch]\n${entry.summary.trim()}`);
			continue;
		}
		if (entry.type === "custom_message") {
			const text =
				typeof entry.content === "string"
					? entry.content.trim()
					: extractTextParts(entry.content).join("\n").trim();
			if (text) sections.push(`[injected context: ${entry.customType ?? "extension"}]\n${text}`);
			continue;
		}

		if (entry.type !== "message" || !entry.message?.role) continue;
		const { role } = entry.message;

		if (role === "user") {
			const text = extractTextParts(entry.message.content).join("\n").trim();
			if (text) sections.push(`User: ${text}`);
		} else if (role === "assistant") {
			const lines: string[] = [];
			const text = extractTextParts(entry.message.content).join("\n").trim();
			if (text) lines.push(`Assistant: ${text}`);
			lines.push(...extractToolCallLines(entry.message.content));
			if (lines.length > 0) sections.push(lines.join("\n"));
		} else if (role === "toolResult") {
			const toolName = entry.message.toolName ?? "unknown";
			const text = extractTextParts(entry.message.content).join("\n").trim();
			if (entry.message.isError) {
				const preview = text.length > MAX_TOOL_ERROR_CHARS ? `${text.slice(0, MAX_TOOL_ERROR_CHARS)}…` : text;
				sections.push(`[tool error] ${toolName}: ${preview}`);
			} else if (text) {
				// Keep the tail: warnings from builds/tests usually appear at the end.
				const preview = text.length > MAX_TOOL_RESULT_CHARS ? `…${text.slice(-MAX_TOOL_RESULT_CHARS)}` : text;
				sections.push(`[tool result] ${toolName}: ${preview}`);
			}
		}
	}

	let conversation = sections.join("\n\n");
	if (conversation.length > MAX_CONVERSATION_CHARS) {
		conversation = `[earlier conversation truncated]\n…${conversation.slice(-MAX_CONVERSATION_CHARS)}`;
	}
	return conversation;
};

const buildEvalPrompt = (conversationText: string): string =>
	[
		"Evaluate whether a coding agent should stop working.",
		"",
		"Analyze the conversation below to determine if:",
		"1. All user-requested tasks are complete",
		"2. All skill prompts and user instructions are followed",
		"3. Any errors or warnings need to be addressed",
		"4. Follow-up work is needed",
		"",
		"Only report unfinished work for concrete, actionable gaps in what the user explicitly asked for.",
		"If the agent is waiting on user input, asked the user a question, or was told to stop, it should be allowed to stop.",
		"",
		'Respond with ONLY JSON: {"ok": true} to allow stopping, or {"ok": false, "reason": "your explanation"} to continue working.',
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");

const parseVerdict = (raw: string): { ok: boolean; reason?: string } | undefined => {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;

	try {
		const parsed = JSON.parse(raw.slice(start, end + 1)) as { ok?: unknown; reason?: unknown };
		if (typeof parsed.ok !== "boolean") return undefined;
		return {
			ok: parsed.ok,
			reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
		};
	} catch {
		return undefined;
	}
};

const getLastAssistantStopReason = (entries: SessionEntry[]): string | undefined => {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message?.role === "assistant") {
			return entry.message.stopReason;
		}
	}
	return undefined;
};

// A compaction summary counts as user context: after compaction the original
// user messages may no longer be present in the context entries.
const hasUserContext = (entries: SessionEntry[]): boolean =>
	entries.some(
		(e) => (e.type === "message" && e.message?.role === "user") || e.type === "compaction",
	);

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let continueCount = 0;
	let checking = false;
	let inflight: AbortController | undefined;

	const clearStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("stop-check", undefined);
	};

	pi.on("session_start", () => {
		continueCount = 0;
		checking = false;
	});

	pi.on("session_shutdown", () => {
		inflight?.abort();
	});

	// Real user input resets the loop guard and cancels any in-flight check.
	pi.on("input", (event) => {
		if (event.source !== "extension") {
			continueCount = 0;
			inflight?.abort();
		}
		return { action: "continue" };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Print/json mode exits when prompts finish; injecting a continuation
		// there races session teardown. Only run where we can act on the verdict.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (!enabled || checking || !ctx.isIdle() || ctx.hasPendingMessages()) return;

		const entries = ctx.sessionManager.buildContextEntries() as SessionEntry[];
		if (!hasUserContext(entries)) return;

		// Don't fight the user: skip if the run was aborted (Esc) or errored.
		const stopReason = getLastAssistantStopReason(entries);
		if (stopReason === "aborted" || stopReason === "error") return;

		if (continueCount >= MAX_CONSECUTIVE_CONTINUES) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`stop-check: reached ${MAX_CONSECUTIVE_CONTINUES} auto-continues, allowing stop`,
					"warning",
				);
			}
			return;
		}

		const conversationText = buildConversationText(entries);
		if (!conversationText.trim()) return;

		const model = ctx.model;
		if (!model) return;

		// Establish cancellation state before ANY await so user input (or a
		// concurrent agent_settled) can abort/skip during the auth lookup too.
		checking = true;
		const controller = new AbortController();
		inflight = controller;
		const timeout = setTimeout(() => controller.abort(), EVAL_TIMEOUT_MS);

		try {
			if (ctx.hasUI) ctx.ui.setStatus("stop-check", "checking if finished…");

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) return; // fail open
			if (controller.signal.aborted) return;

			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: buildEvalPrompt(conversationText) }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					maxTokens: 1024,
					signal: controller.signal,
				},
			);

			// Provider-side aborts/errors can resolve (not throw) with partial
			// content; never parse a verdict out of a truncated response.
			if (response.stopReason !== "stop") {
				debugLog(`skipping verdict: stopReason=${response.stopReason}`);
				return;
			}

			const raw = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			let verdict = parseVerdict(raw);
			debugLog(`verdict: ${raw.trim()}`);
			if (process.env.STOP_CHECK_FORCE_CONTINUE) {
				verdict = { ok: false, reason: "forced continue for testing" };
			}
			if (!verdict) return; // unparseable → fail open

			if (verdict.ok) {
				continueCount = 0;
				return;
			}

			// Re-validate: the user may have submitted a prompt or disabled the
			// hook while the evaluation was in flight.
			if (!enabled || controller.signal.aborted || !ctx.isIdle()) return;

			continueCount++;
			const reason = verdict.reason ?? "The completion check determined the work is not finished.";
			if (ctx.hasUI) {
				ctx.ui.notify(`stop-check: not finished — continuing (${continueCount}/${MAX_CONSECUTIVE_CONTINUES})`, "info");
			}

			pi.sendMessage(
				{
					customType: "stop-check",
					content: [
						"An automated completion check determined the work is not finished.",
						`Reason: ${reason}`,
						"",
						"Continue working and address this. If you believe the work is actually complete, briefly explain why and stop.",
					].join("\n"),
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (err) {
			// Timeout, abort, or provider error → fail open (allow stopping)
			debugLog(`error: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			clearTimeout(timeout);
			if (inflight === controller) inflight = undefined;
			checking = false;
			clearStatus(ctx);
		}
	});

	pi.registerCommand("stop-check", {
		description: "Toggle the 'check if finished' stop hook (on|off|status)",
		getArgumentCompletions: (prefix: string) => {
			const items = ["on", "off", "status"]
				.filter((v) => v.startsWith(prefix))
				.map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else if (arg !== "status" && arg) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /stop-check [on|off|status]", "warning");
				return;
			} else if (!arg) enabled = !enabled;

			// Commands bypass the input event, so cancel any in-flight check here.
			if (!enabled) inflight?.abort();

			if (ctx.hasUI) {
				ctx.ui.notify(`stop-check: ${enabled ? "enabled" : "disabled"}`, "info");
			}
		},
	});
}
