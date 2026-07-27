import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Registers `/exit` as an alias for `/quit` (quit pi).
 * Uses `ctx.shutdown()`, which emits `session_shutdown` to all
 * extensions before exiting, same as the built-in `/quit`.
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Alias for /quit — quit pi",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
