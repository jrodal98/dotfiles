import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ChildUsage {
	input: number;
	output: number;
	cost: number;
	turns: number;
}

export interface ChildResult {
	exitCode: number;
	/** Last non-empty assistant message text */
	finalText: string;
	usage: ChildUsage;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
	aborted: boolean;
}

export interface ChildProgress {
	kind: "tool" | "assistant" | "status";
	text: string;
}

export interface ChildSpec {
	/** provider/id or provider/id:thinking. Omit to inherit pi's default. */
	model?: string;
	task: string;
	/** Appended to the child's system prompt via a temp file */
	systemPrompt?: string;
	/** undefined = pi defaults; [] = --no-builtin-tools; otherwise --tools list */
	tools?: string[];
	/** Persistent session file (used by the clarifier) */
	sessionFile?: string;
	cwd: string;
	signal?: AbortSignal;
	onProgress?: (progress: ChildProgress) => void;
}

function emptyUsage(): ChildUsage {
	return { input: 0, output: 0, cost: 0, turns: 0 };
}

export function reviewSessionFile(cwd: string, key: string): string {
	const cwdHash = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12);
	const dir = path.join(getAgentDir(), "code-review-sessions", cwdHash);
	fs.mkdirSync(dir, { recursive: true });
	const safe = key.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
	return path.join(dir, `${safe}.jsonl`);
}

function getMessageText(message: any): string {
	const chunks: string[] = [];
	for (const part of message?.content ?? []) {
		if (part.type === "text") chunks.push(part.text);
	}
	return chunks.join("\n");
}

/** Spawn a `pi --mode json -p` child and collect its final output. */
export async function runPiChild(spec: ChildSpec): Promise<ChildResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-skills"];
	if (spec.sessionFile) args.push("--session", spec.sessionFile);
	if (spec.model) args.push("--model", spec.model);
	if (spec.tools !== undefined) {
		if (spec.tools.length === 0) args.push("--no-builtin-tools");
		else args.push("--tools", spec.tools.join(","));
	}

	let tmpDir: string | null = null;
	let tmpPromptFile: string | null = null;
	if (spec.systemPrompt) {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-code-review-prompt-"));
		tmpPromptFile = path.join(tmpDir, `prompt-${randomUUID().slice(0, 8)}.md`);
		await fs.promises.writeFile(tmpPromptFile, spec.systemPrompt, { encoding: "utf8", mode: 0o600 });
		args.push("--append-system-prompt", tmpPromptFile);
	}
	args.push(spec.task);

	const result: ChildResult = {
		exitCode: -1,
		finalText: "",
		usage: emptyUsage(),
		stderr: "",
		aborted: false,
	};

	try {
		result.exitCode = await new Promise<number>((resolve) => {
			const child = spawn("pi", args, {
				cwd: spec.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "tool_execution_start") {
					const toolName = event.toolName ?? event.tool_name ?? "tool";
					const rawArgs = event.args ?? event.input ?? {};
					let preview = "";
					if (typeof rawArgs.command === "string") preview = rawArgs.command;
					else if (typeof rawArgs.pattern === "string") preview = rawArgs.pattern;
					else if (typeof rawArgs.path === "string") preview = rawArgs.path;
					preview = preview.replace(/\s+/g, " ").slice(0, 60);
					spec.onProgress?.({ kind: "tool", text: preview ? `${toolName}: ${preview}` : toolName });
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					if (msg.role === "assistant") {
						const text = getMessageText(msg).trim();
						if (text) {
							result.finalText = text;
							spec.onProgress?.({ kind: "assistant", text: text.replace(/\s+/g, " ").slice(0, 80) });
						}
						result.usage.turns++;
						if (msg.usage) {
							result.usage.input += msg.usage.input || 0;
							result.usage.output += msg.usage.output || 0;
							result.usage.cost += msg.usage.cost?.total || 0;
						}
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
				}
			};

			child.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			child.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			child.on("error", (error) => {
				result.stderr += `${error instanceof Error ? error.message : String(error)}\n`;
				resolve(1);
			});

			if (spec.signal) {
				const abort = () => {
					result.aborted = true;
					child.kill("SIGTERM");
					setTimeout(() => {
						if (!child.killed) child.kill("SIGKILL");
					}, 5000);
				};
				if (spec.signal.aborted) abort();
				else spec.signal.addEventListener("abort", abort, { once: true });
			}
		});
		return result;
	} finally {
		if (tmpPromptFile) fs.promises.unlink(tmpPromptFile).catch(() => {});
		if (tmpDir) fs.promises.rmdir(tmpDir).catch(() => {});
	}
}

export function isChildError(result: ChildResult): boolean {
	return result.aborted || result.exitCode !== 0 || result.stopReason === "error" || !result.finalText.trim();
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const results: TOut[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}
