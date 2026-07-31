/**
 * Pi WezCopy Extension
 *
 * Copies text to the system clipboard via the `wezcopy` helper from
 * ~/.jrodal_zsh_utils/wezterm/init.sh (WezTerm `event:copy` user var).
 * The sourced shell integration handles tmux passthrough and neovim
 * terminals; the parent-tty walk mirrors notify.ts for the case where
 * the spawned process has no controlling terminal.
 *
 * Provides:
 * - `copy_to_clipboard` tool: lets the LLM copy text on request
 * - `/copy` command: copies the last assistant message
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const WEZTERM_INIT = join(homedir(), ".jrodal_zsh_utils/wezterm/init.sh");
const TIMEOUT_MS = 5000;

const SCRIPT = `
source "$1"
# If we have no controlling terminal (e.g. spawned from pi), walk the
# process tree to find the parent pts (same trick as the notify hook).
if ! { : > /dev/tty; } 2>/dev/null; then
  __wezterm_output_target=$(__find_parent_tty)
  [[ -z "$__wezterm_output_target" ]] && { echo "no parent tty found" >&2; exit 1; }
fi
wezcopy
`;

/** Copy text to the clipboard. Text is piped via stdin (wezcopy reads $(cat)). */
function wezcopy(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!existsSync(WEZTERM_INIT)) {
			reject(new Error(`wezterm init script not found: ${WEZTERM_INIT}`));
			return;
		}
		const child = execFile(
			"zsh",
			["-c", SCRIPT, "wezcopy", WEZTERM_INIT],
			{ timeout: TIMEOUT_MS },
			(error, _stdout, stderr) => {
				if (error) {
					reject(new Error(stderr.trim() || error.message));
				} else {
					resolve();
				}
			},
		);
		child.stdin?.write(text);
		child.stdin?.end();
	});
}

type ContentBlock = { type?: string; text?: string };
type SessionEntry = {
	type: string;
	message?: { role?: string; content?: unknown };
};

/** Extract the text of the most recent assistant message on the current branch. */
function lastAssistantText(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch() as SessionEntry[];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") {
			continue;
		}
		const content = entry.message.content;
		const parts: string[] =
			typeof content === "string"
				? [content]
				: Array.isArray(content)
					? content
							.filter(
								(p): p is ContentBlock & { text: string } =>
									!!p &&
									typeof p === "object" &&
									(p as ContentBlock).type === "text" &&
									typeof (p as ContentBlock).text === "string",
							)
							.map((p) => p.text)
					: [];
		const text = parts.join("\n").trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "copy_to_clipboard",
		label: "Copy to Clipboard",
		description:
			"Copy text to the user's system clipboard (via WezTerm wezcopy). " +
			"Use whenever the user asks to copy something to their clipboard, " +
			"e.g. generated text, a command, a code snippet, or file contents.",
		parameters: Type.Object({
			text: Type.String({ description: "The exact text to copy" }),
		}),
		async execute(_toolCallId, params) {
			try {
				await wezcopy(params.text);
				return {
					content: [
						{
							type: "text",
							text: `Copied ${params.text.length} characters to clipboard.`,
						},
					],
					details: {},
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to copy to clipboard: ${
								error instanceof Error ? error.message : String(error)
							}`,
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerCommand("copy", {
		description: "Copy the last assistant message to the clipboard",
		handler: async (_args, ctx) => {
			const text = lastAssistantText(ctx);
			if (!text) {
				ctx.ui.notify("No assistant message to copy", "warning");
				return;
			}
			try {
				await wezcopy(text);
				ctx.ui.notify(
					`Copied last assistant message (${text.length} chars)`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Copy failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
