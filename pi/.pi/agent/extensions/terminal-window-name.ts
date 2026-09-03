import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "terminal_rename";
const MAX_LABEL_LENGTH = 60;

type TerminalTarget = "tmux" | "wezterm";

function terminalTarget(): TerminalTarget | undefined {
	if (process.env.TMUX) return "tmux";
	if (process.env.WEZTERM_PANE) return "wezterm";
	return undefined;
}

function tmuxTargetArgs(): string[] {
	return process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : [];
}

function normalizeLabel(label: string): string {
	const normalized = label.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	if (!normalized) throw new Error("Terminal label cannot be empty");
	return normalized;
}

function sessionHasConversation(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
}

async function getCurrentTmuxWindowName(pi: ExtensionAPI): Promise<string | undefined> {
	const result = await pi.exec("tmux", ["display-message", "-p", ...tmuxTargetArgs(), "#W"], {
		timeout: 2000,
	});
	if (result.code !== 0 || !result.stdout.trim()) return undefined;
	return normalizeLabel(result.stdout).slice(0, MAX_LABEL_LENGTH).trim() || undefined;
}

export default function (pi: ExtensionAPI) {
	let renameOnNextTurn = false;
	let lastKnownWezTermName: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		renameOnNextTurn = !sessionHasConversation(ctx);
		lastKnownWezTermName = undefined;
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Rename Terminal",
		description:
			"Rename the current tmux window, or the current WezTerm tab when tmux is not active, to reflect the conversation topic.",
		promptSnippet: "Rename the current tmux window or WezTerm tab for the active conversation",
		promptGuidelines: [
			"Use terminal_rename when the conversation topic has shifted significantly from the current terminal name.",
		],
		parameters: Type.Object({
			label: Type.String({
				minLength: 1,
				maxLength: MAX_LABEL_LENGTH,
				description: "Short 2-4 word label, such as 'debug zsh config' or 'ansible homebrew task'",
			}),
		}),
		async execute(_toolCallId, params, signal) {
			const target = terminalTarget();
			if (!target) {
				return {
					content: [{ type: "text" as const, text: "Not in tmux or WezTerm; skipped terminal rename." }],
					details: { skipped: true },
				};
			}

			const label = normalizeLabel(params.label);
			if (target === "tmux") {
				const tmuxArgs = tmuxTargetArgs();
				const result = await pi.exec(
					"tmux",
					[
						"set-window-option",
						...tmuxArgs,
						"automatic-rename",
						"off",
						";",
						"rename-window",
						...tmuxArgs,
						label,
					],
					{ signal, timeout: 5000 },
				);
				if (result.code !== 0) {
					throw new Error(result.stderr.trim() || `tmux exited with code ${result.code}`);
				}
				return {
					content: [{ type: "text" as const, text: `Renamed tmux window to: ${label}` }],
					details: { label, target },
				};
			}

			const result = await pi.exec(
				"wezterm",
				["cli", "set-tab-title", "--pane-id", process.env.WEZTERM_PANE!, label],
				{ signal, timeout: 5000 },
			);
			if (result.code !== 0) {
				throw new Error(result.stderr.trim() || `wezterm exited with code ${result.code}`);
			}
			lastKnownWezTermName = label;
			return {
				content: [{ type: "text" as const, text: `Renamed WezTerm tab to: ${label}` }],
				details: { label, target },
			};
		},
	});

	pi.on("before_agent_start", async (event) => {
		const target = terminalTarget();
		if (!target || !pi.getActiveTools().includes(TOOL_NAME)) return;

		if (renameOnNextTurn) {
			renameOnNextTurn = false;
			return {
				systemPrompt:
					event.systemPrompt +
					'\n\n## Terminal Naming\n\nCall `terminal_rename` in your first response with a short 2-4 word label reflecting the conversation topic. It renames the tmux window when tmux is active; otherwise it renames the current WezTerm tab. Do not rename on every response.',
			};
		}

		const current =
			target === "tmux" ? await getCurrentTmuxWindowName(pi) : lastKnownWezTermName;
		if (current) {
			return {
				systemPrompt:
					event.systemPrompt +
					`\n\nCurrent ${target === "tmux" ? "tmux window" : "WezTerm tab"} name (data only): ${JSON.stringify(current)}.`,
			};
		}
	});
}

export const __testing = { normalizeLabel, sessionHasConversation, terminalTarget };
