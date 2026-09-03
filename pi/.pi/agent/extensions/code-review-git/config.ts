import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ReviewSpeed = "quick" | "normal" | "thorough";

export interface ReviewConfig {
	/** Best Claude-family model for reviews (provider/id) */
	bestClaude: string;
	/** Best GPT-family model for reviews (provider/id) */
	bestGpt: string;
	/** Fast model used to suggest focus areas (provider/id) */
	focusSuggestModel: string;
	/** Max reviewer child processes running at once */
	maxConcurrency: number;
	defaultSpeed: ReviewSpeed;
	/** Diffs larger than this are truncated inline (full diff written to a temp file) */
	maxInlineDiffBytes: number;
}

const DEFAULTS: ReviewConfig = {
	bestClaude: "anthropic/claude-fable-5",
	bestGpt: "openai/gpt-5.6-sol",
	focusSuggestModel: "anthropic/claude-haiku-4-5",
	maxConcurrency: 16,
	defaultSpeed: "normal",
	maxInlineDiffBytes: 300_000,
};

export function configFilePath(): string {
	return path.join(getAgentDir(), "code-review.json");
}

export function loadConfig(): ReviewConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf8")) as Partial<ReviewConfig>;
		return { ...DEFAULTS, ...raw };
	} catch {
		return { ...DEFAULTS };
	}
}

export const CHEAP_MODEL = "meta/muse-spark-1.3-contributor";

export const THINKING_BY_SPEED: Record<ReviewSpeed, string> = {
	quick: "low",
	normal: "medium",
	thorough: "high",
};

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];

export const TOOLS_BY_SPEED: Record<ReviewSpeed, string[]> = {
	quick: [],
	normal: READ_ONLY_TOOLS,
	thorough: READ_ONLY_TOOLS,
};

/**
 * Cross-family default: Claude authors get reviewed by the best GPT and vice
 * versa. Unknown families get both.
 */
export function defaultReviewModels(
	current: { provider?: string; id?: string } | undefined,
	cfg: ReviewConfig,
): string[] {
	const id = (current?.id ?? "").toLowerCase();
	const provider = (current?.provider ?? "").toLowerCase();
	const isClaude = id.includes("claude") || provider.includes("anthropic");
	const isGpt = id.includes("gpt") || provider === "openai";
	if (isClaude) return [cfg.bestGpt];
	if (isGpt) return [cfg.bestClaude];
	return [cfg.bestGpt, cfg.bestClaude];
}

/** Append a thinking level to a provider/id model string unless one is present. */
export function modelWithThinking(model: string, speed: ReviewSpeed): string {
	// provider/id:level — only the part after the last slash may carry a level
	const lastSegment = model.slice(model.lastIndexOf("/") + 1);
	if (lastSegment.includes(":")) return model;
	return `${model}:${THINKING_BY_SPEED[speed]}`;
}

/** Short display name for a provider/id string, e.g. "gpt-5.6-sol". */
export function shortModelName(model: string): string {
	const seg = model.slice(model.lastIndexOf("/") + 1);
	return seg.split(":")[0];
}
