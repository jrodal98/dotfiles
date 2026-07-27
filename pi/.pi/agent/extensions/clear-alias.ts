import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Registers `/clear` as an alias for `/new` (start a new session).
 * Uses the same code path as `/new`, so any `session_before_switch`
 * confirmations from other extensions still apply.
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Alias for /new — start a new session",
    handler: async (_args, ctx) => {
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
      });
    },
  });
}
