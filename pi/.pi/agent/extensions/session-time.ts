import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "session-time";
const TICK_MS = 5_000;

// Tool/span names counted as subagent delegations rather than plain tools.
// Classification is exclusive: every execution window lands in exactly one bucket.
const SUBAGENT_TOOLS = new Set(["agent", "subagent", "review"]);

interface Bucket {
	active: Map<string, number>;
	unionMs: number;
	windowStart: number | null;
	totals: Map<string, number>;
}

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
	const tools: Bucket = { active: new Map(), unionMs: 0, windowStart: null, totals: new Map() };
	const subagents: Bucket = { active: new Map(), unionMs: 0, windowStart: null, totals: new Map() };
	const extNames = new Map<string, string>();
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

	function isSubagent(name: string): boolean {
		return SUBAGENT_TOOLS.has(name.toLowerCase());
	}

	function bucketFor(name: string): Bucket {
		return isSubagent(name) ? subagents : tools;
	}

	function openWindow(b: Bucket, key: string, t = now()): void {
		if (b.active.size === 0) b.windowStart = t;
		b.active.set(key, t);
	}

	function closeWindow(b: Bucket, key: string, name: string, t = now()): void {
		let start = b.active.get(key);
		if (start === undefined && b.active.size === 1) {
			// Fall back to the single outstanding execution when ids don't correlate.
			const first = b.active.entries().next();
			if (!first.done) {
				key = first.value[0];
				start = first.value[1];
			}
		}
		if (start === undefined) return;
		b.active.delete(key);
		const dur = Math.max(0, t - start);
		b.totals.set(name, (b.totals.get(name) ?? 0) + dur);
		if (b.active.size === 0 && b.windowStart !== null) {
			b.unionMs += Math.max(0, t - b.windowStart);
			b.windowStart = null;
		}
	}

	// Close by key identity first so a span always settles in the bucket
	// that opened it; fall back to name classification for unknown keys.
	function closeByKey(key: string, name: string, t = now()): void {
		const b = tools.active.has(key) ? tools : subagents.active.has(key) ? subagents : bucketFor(name);
		closeWindow(b, key, name, t);
	}

	function closeLastCall(name: string, t = now()): void {
		for (const b of [tools, subagents]) {
			const keys = [...b.active.keys()].filter((k) => k.startsWith("call-"));
			const last = keys[keys.length - 1];
			if (last) {
				closeWindow(b, last, name, t);
				return;
			}
		}
	}

	function bucketUnionMs(b: Bucket, t: number): number {
		return b.unionMs + (b.windowStart !== null ? Math.max(0, t - b.windowStart) : 0);
	}

	function snapshot(t = now()): { total: number; llm: number; subagents: number; tools: number } {
		const total = Math.max(0, t - sessionStart);
		const llm = llmMs + (llmWindowStart !== null ? Math.max(0, t - llmWindowStart) : 0);
		return { total, llm, subagents: bucketUnionMs(subagents, t), tools: bucketUnionMs(tools, t) };
	}

	function statusText(): string {
		const s = snapshot();
		const parts = [`🧠${fmtDur(s.llm)}`];
		if (s.subagents > 0) parts.push(`🤖${fmtDur(s.subagents)}`);
		parts.push(`🔧${fmtDur(s.tools)}`);
		return parts.join(" ");
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
		extNames.clear();
		for (const b of [tools, subagents]) {
			b.unionMs = 0;
			b.windowStart = null;
			b.active.clear();
			b.totals.clear();
		}
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
		const b = bucketFor(toolNameOf(e));
		// An execution window supersedes the speculative call-hook window for
		// the same invocation; drop the oldest unmatched one so per-tool
		// totals don't count the same call twice.
		for (const k of b.active.keys()) {
			if (k.startsWith("call-")) {
				b.active.delete(k);
				break;
			}
		}
		openWindow(b, toolKey(e), now());
		activeCtx = ctx;
		refreshActive();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const e = event as unknown as Record<string, unknown>;
		closeByKey(toolKey(e), toolNameOf(e), now());
		activeCtx = ctx;
		refreshActive();
	});

	// Fallback for runtimes that only emit call/result hooks.
	pi.on("tool_call", (event) => {
		const e = event as unknown as Record<string, unknown>;
		openWindow(bucketFor(toolNameOf(e)), `call-${toolSeq + 1}`, now());
		toolSeq += 1;
		refreshActive();
	});

	pi.on("tool_result", (event, ctx) => {
		// Close the most recent unmatched call-hook entry, if any.
		const e = event as unknown as Record<string, unknown>;
		closeLastCall(toolNameOf(e), now());
		activeCtx = ctx;
		refreshActive();
	});

	// Spans reported by other extensions over the inter-extension bus, for
	// work (e.g. child-process runs from command handlers) that emits no
	// tool lifecycle events of its own. Routed to subagents or tools by
	// span name, unioned as usual.
	pi.events.on("session-time:external-start", (data) => {
		const d = data as { id?: unknown; name?: unknown };
		if (typeof d.id !== "string" || !d.id) return;
		const key = `ext:${d.id}`;
		const name = typeof d.name === "string" && d.name ? d.name : "external";
		extNames.set(key, name);
		openWindow(bucketFor(name), key, now());
		refreshActive();
	});

	pi.events.on("session-time:external-end", (data) => {
		const d = data as { id?: unknown };
		if (typeof d.id !== "string" || !d.id) return;
		const key = `ext:${d.id}`;
		closeByKey(key, extNames.get(key) ?? "external", now());
		extNames.delete(key);
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
		description: "Show session time breakdown (llm vs subagents vs tools)",
		handler: async (_args, ctx) => {
			const s = snapshot();
			const active = s.llm + s.subagents + s.tools;
			const pct = (v: number) => (active > 0 ? `${Math.round((v / active) * 100)}%` : "—");
			const lines = [
				`Session time — ${fmtDur(active)} active of ${fmtDur(s.total)} total`,
				`  🧠 llm        ${fmtDur(s.llm)} (${pct(s.llm)})`,
				`  🤖 subagents  ${fmtDur(s.subagents)} (${pct(s.subagents)})`,
				`  🔧 tools      ${fmtDur(s.tools)} (${pct(s.tools)})`,
			];
			const rows: Array<{ name: string; ms: number; sub: boolean }> = [];
			for (const [name, ms] of tools.totals) rows.push({ name, ms, sub: false });
			for (const [name, ms] of subagents.totals) rows.push({ name, ms, sub: true });
			if (rows.length > 0) {
				lines.push("  by tool:");
				for (const r of rows.sort((a, b) => b.ms - a.ms)) {
					lines.push(`    ${r.name}: ${fmtDur(r.ms)}${r.sub ? " (subagent)" : ""}`);
				}
			}
			lines.push("windows are exclusive: parallel spans count once per bucket.");
			lines.push(
				`events: provider ${nBeforeReq}/${nAfterResp} req/resp, assistant msgs ${nMsgStart}/${nMsgEnd} start/end` +
					(llmWindowStart !== null ? " (llm window OPEN now)" : ""),
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
