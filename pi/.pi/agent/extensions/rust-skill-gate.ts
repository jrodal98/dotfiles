import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKILL_MARKER = "skills/simple-rust/SKILL.md";
const SKILL_COMMAND = "/skill:simple-rust";
const SKILL_PATH = "~/.pi/agent/skills/simple-rust/SKILL.md";
const MUTATING_TOOLS = new Set(["edit", "write"]);

export function isRustPath(path: unknown): boolean {
  return typeof path === "string" && path.replace(/^@/, "").endsWith(".rs");
}

export default function (pi: ExtensionAPI) {
  let skillLoaded = false;

  pi.on("session_start", (_event, ctx) => {
    try {
      skillLoaded = ctx.sessionManager.getEntries().some((entry) => {
        const serialized = JSON.stringify(entry);
        return serialized.includes(SKILL_MARKER) || serialized.includes(SKILL_COMMAND);
      });
    } catch {
      skillLoaded = false;
    }
  });

  pi.on("input", (event) => {
    if (event.text.includes(SKILL_COMMAND)) skillLoaded = true;
  });

  pi.on("tool_call", (event) => {
    if (skillLoaded) return;

    try {
      if (event.toolName === "read") {
        const path = String((event.input as { path?: unknown }).path ?? "");
        if (path.includes(SKILL_MARKER)) skillLoaded = true;
        return;
      }

      if (event.toolName === "bash") {
        const command = String((event.input as { command?: unknown }).command ?? "");
        if (command.includes(SKILL_MARKER)) skillLoaded = true;
        return;
      }

      if (!MUTATING_TOOLS.has(event.toolName)) return;
      const path = (event.input as { path?: unknown }).path;
      if (!isRustPath(path)) return;

      return {
        block: true,
        reason:
          `simple-rust-skill-gate: load the simple-rust skill before editing Rust files — ` +
          `read ${SKILL_PATH}, then retry this ${event.toolName} call. ` +
          `The gate stays open for the rest of the session.`,
      };
    } catch {
      return;
    }
  });
}
