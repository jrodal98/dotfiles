/**
 * bg-pid-tracker — makes backgrounded processes announce their PIDs.
 *
 * When an LLM bash command backgrounds work (`job &`), the PID is lost as
 * soon as the tool call's shell exits, leaving later calls to guess with
 * pgrep or — worse — poll with long sleeps. This extension appends a
 * self-gating reporter to bash commands that look like they background
 * something, so the tool result always ends with
 * `[background pids: <jobs -p> (last: $!)]` and the model can wait on the
 * PID directly (e.g. `timeout <N> tail --pid=<pid> -f /dev/null`).
 *
 * Notes:
 *   - The reporter saves and re-raises the user command's exit status, so
 *     appended text never masks a failure.
 *   - `jobs -p` misses disowned jobs and subshell spawns (`( job & )`);
 *     the `$!` fallback still covers the most recent one.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

/** Backgrounding `&`: not `&&`, and not part of a redirect (`>&`, `<&`, `&>`). */
const BACKGROUND_AMP = /(?<![&<>])&(?![&>])/;

const REPORTER = `\n__bgpid_status=$?; [ -z "$(jobs -p)" ] || echo "[background pids: $(jobs -p | tr '\\n' ' ')(last: $!)]"; exit $__bgpid_status`;

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command;
    if (!BACKGROUND_AMP.test(command)) return;
    if (command.includes("__bgpid_status")) return;
    event.input.command = command + REPORTER;
  });
}
