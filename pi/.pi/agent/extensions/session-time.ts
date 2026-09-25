import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "session-time";
const TICK_MS = 5_000;

function isStaleCtxError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return (
		msg.includes("stale after session replacement") ||
		msg.includes("ctx is stale") ||
		msg.includes("staleMessage")
	);
}

function fmtDur(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) {
		const r = s % 60;
		return r === 0 ? `${m}m` : `${m}m${String(r).padStart(2, "0")}s`;
	}
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

export default function (pi: ExtensionAPI) {
	let sessionStart = 0;
	let llmMs = 0;
	let llmDepth = 0;
	let llmWindowStart: number | null = null;
	// Diagnostic counters, surfaced via /time.
	let nBeforeReq = 0;
	let nAfterResp = 0;
	let nMsgStart = 0;
	let nMsgEnd = 0;
	let toolUnionMs = 0;
	let toolWindowStart: number | null = null;
	const toolActive = new Map<string, number>();
	const toolTotals = new Map<string, number>();
	let toolSeq = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let activeCtx: ExtensionContext | null = null;

	const now = () => Date.now();

	// LLM time is a refcounted union of two nestable spans:
	// - before_provider_request -> after_provider_response covers request setup,
	//   but after_provider_response fires when response *headers* arrive,
	//   before any thinking/text streams.
	// - message_start -> message_end (assistant role) covers the actual streaming.
	// Typical nesting: before_req -> msg_start -> msg_end -> after_resp.
	function acquireLlm(t = now()): void {
		if (llmDepth === 0) llmWindowStart = t;
		llmDepth += 1;
	}

	function releaseLlm(t = now()): void {
		if (llmDepth <= 0) return;
		llmDepth -= 1;
		if (llmDepth === 0 && llmWindowStart !== null) {
			llmMs += Math.max(0, t - llmWindowStart);
			llmWindowStart = null;
		}
	}

	function drainLlm(t = now()): void {
		if (llmWindowStart !== null) llmMs += Math.max(0, t - llmWindowStart);
		llmDepth = 0;
		llmWindowStart = null;
	}

	function isAssistantMessage(event: Record<string, unknown>): boolean {
		const msg = event["message"] as Record<string, unknown> | undefined;
		return !!msg && msg["role"] === "assistant";
	}

	function toolKey(event: Record<string, unknown>): string {
		for (const k of ["toolCallId", "toolUseId", "executionId", "id", "callId"]) {
			const v = event[k];
			if (typeof v === "string" && v) return v;
		}
		toolSeq += 1;
		return `anon-${toolSeq}`;
	}

	function toolNameOf(event: Record<string, unknown>): string {
		const v = event["toolName"];
		return typeof v === "string" && v ? v : "tool";
	}

	function openToolWindow(key: string, t = now()): void {
		if (toolActive.size === 0) toolWindowStart = t;
		toolActive.set(key, t);
	}

	function closeToolWindow(key: string, name: string, t = now()): void {
		let start = toolActive.get(key);
		if (start === undefined && toolActive.size === 1) {
			// Fall back to the single outstanding execution when ids don't correlate.
			const first = toolActive.entries().next();
			if (!first.done) {
				key = first.value[0];
				start = first.value[1];
			}
		}
		if (start === undefined) return;
		toolActive.delete(key);
		const dur = Math.max(0, t - start);
		toolTotals.set(name, (toolTotals.get(name) ?? 0) + dur);
		if (toolActive.size === 0 && toolWindowStart !== null) {
			toolUnionMs += Math.max(0, t - toolWindowStart);
			toolWindowStart = null;
		}
	}

	function snapshot(t = now()): { total: number; llm: number; tools: number } {
		const total = Math.max(0, t - sessionStart);
		const llm = llmMs + (llmWindowStart !== null ? Math.max(0, t - llmWindowStart) : 0);
		const tools =
			toolUnionMs + (toolWindowStart !== null ? Math.max(0, t - toolWindowStart) : 0);
		return { total, llm, tools };
	}

	function statusText(): string {
		const s = snapshot();
		return `🧠${fmtDur(s.llm)} 🔧${fmtDur(s.tools)}`;
	}

	function pushStatus(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		try {
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", statusText()));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
	}

	function refreshActive(): void {
		const ctx = activeCtx;
		if (ctx) pushStatus(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		sessionStart = now();
		llmMs = 0;
		llmDepth = 0;
		llmWindowStart = null;
		nBeforeReq = 0;
		nAfterResp = 0;
		nMsgStart = 0;
		nMsgEnd = 0;
		toolUnionMs = 0;
		toolWindowStart = null;
		toolActive.clear();
		toolTotals.clear();
		activeCtx = ctx;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		pushStatus(ctx);
		if (ctx.mode === "tui") {
			const captured = ctx;
			timer = setInterval(() => {
				try {
					void captured.cwd;
					pushStatus(captured);
				} catch (e) {
					if (isStaleCtxError(e)) return;
					throw e;
				}
			}, TICK_MS);
		}
	});

	pi.on("before_provider_request", () => {
		nBeforeReq += 1;
		acquireLlm();
		refreshActive();
	});

	pi.on("after_provider_response", () => {
		nAfterResp += 1;
		releaseLlm();
		refreshActive();
	});

	pi.on("message_start", (event) => {
		const e = event as unknown as Record<string, unknown>;
		if (!isAssistantMessage(e)) return;
		nMsgStart += 1;
		acquireLlm();
		refreshActive();
	});

	pi.on("message_end", (event) => {
		const e = event as unknown as Record<string, unknown>;
		if (!isAssistantMessage(e)) return;
		nMsgEnd += 1;
		releaseLlm();
		refreshActive();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const e = event as unknown as Record<string, unknown>;
		// An execution window supersedes the speculative call-hook window for
		// the same invocation; drop the oldest unmatched one so per-tool
		// totals don't count the same call twice.
		for (const k of toolActive.keys()) {
			if (k.startsWith("call-")) {
				toolActive.delete(k);
				break;
			}
		}
		openToolWindow(toolKey(e), now());
		activeCtx = ctx;
		refreshActive();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const e = event as unknown as Record<string, unknown>;
		closeToolWindow(toolKey(e), toolNameOf(e), now());
		activeCtx = ctx;
		refreshActive();
	});

	// Fallback for runtimes that only emit call/result hooks.
	pi.on("tool_call", () => {
		openToolWindow(`call-${toolSeq + 1}`, now());
		toolSeq += 1;
		refreshActive();
	});

	pi.on("tool_result", (_event, ctx) => {
		// Close the most recent unmatched call-hook entry, if any.
		if (toolActive.size > 0) {
			const keys = [...toolActive.keys()].filter((k) => k.startsWith("call-"));
			const last = keys[keys.length - 1];
			if (last) closeToolWindow(last, "tool", now());
		}
		activeCtx = ctx;
		refreshActive();
	});

	pi.on("agent_end", (_event, ctx) => {
		drainLlm();
		activeCtx = ctx;
		refreshActive();
	});

	pi.on("agent_settled", (_event, ctx) => {
		drainLlm();
		activeCtx = ctx;
		refreshActive();
	});

	pi.on("session_shutdown", () => {
		activeCtx = null;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});

	pi.registerCommand("time", {
		description: "Show session time breakdown (llm vs tools)",
		handler: async (_args, ctx) => {
			const s = snapshot();
			const active = s.llm + s.tools;
			const pct = (v: number) => (active > 0 ? `${Math.round((v / active) * 100)}%` : "—");
			const lines = [
				`Session time — ${fmtDur(active)} active of ${fmtDur(s.total)} total`,
				`  llm   ${fmtDur(s.llm)} (${pct(s.llm)})`,
				`  tools ${fmtDur(s.tools)} (${pct(s.tools)})`,
			];
			if (toolTotals.size > 0) {
				lines.push("  by tool:");
				for (const [name, ms] of [...toolTotals.entries()].sort((a, b) => b[1] - a[1])) {
					lines.push(`    ${name}: ${fmtDur(ms)}`);
				}
			}
			lines.push("parallel tools count once (union of execution windows).");
			lines.push(
				`events: provider ${nBeforeReq}/${nAfterResp} req/resp, assistant msgs ${nMsgStart}/${nMsgEnd} start/end` +
					(llmWindowStart !== null ? " (llm window OPEN now)" : ""),
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
