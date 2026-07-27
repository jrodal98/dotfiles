/**
 * Pi Notify Extension
 *
 * Port of the Claude Code Notification hook (~/.claude/notify-hook.sh).
 * Sends a WezTerm toast notification (via weznotify from
 * ~/.jrodal_zsh_utils/wezterm/init.sh) when pi finishes working and is
 * waiting for input. Prefixes the message with tmux session/window/pane
 * info when running inside tmux, matching the Claude hook behavior.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WEZTERM_INIT = join(homedir(), ".jrodal_zsh_utils/wezterm/init.sh");
const TIMEOUT_MS = 10000;

const SCRIPT = `
source "$1"
# If we have no controlling terminal (e.g. spawned from pi), walk the
# process tree to find the parent pts (same trick as the claude hook).
if ! { : > /dev/tty; } 2>/dev/null; then
  __wezterm_output_target=$(__find_parent_tty)
  [[ -z "$__wezterm_output_target" ]] && exit 0
fi
msg="$3"
if [[ -n "\${TMUX-}" ]]; then
  tmux_info=$(tmux display-message -p '#S:#I.#P (#W)')
  msg="[$tmux_info] $msg"
fi
weznotify --title "$2" --message "$msg" --timeout "$4"
`;

function weznotify(title: string, message: string, timeoutMs: number): void {
	if (!existsSync(WEZTERM_INIT)) return;
	execFile(
		"zsh",
		[
			"-c",
			SCRIPT,
			"weznotify",
			WEZTERM_INIT,
			title,
			message,
			String(timeoutMs),
		],
		{ timeout: 5000 },
		() => {
			// Fire-and-forget; ignore errors (mirrors `|| true` in claude hooks)
		},
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx) => {
		// Only notify in interactive TUI sessions
		if (ctx.mode !== "tui") return;
		weznotify("pi", "Ready for input", TIMEOUT_MS);
	});
}
