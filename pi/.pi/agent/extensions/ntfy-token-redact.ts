/**
 * ntfy-token-redact — redacts ntfy `tk_` tokens from all tool results before
 * they reach the model. Companion to `pi-redact-all`, which does not yet
 * have a `tk_` pattern (entropy threshold misses it, vendor list has no tk_).
 *
 * This is intentionally narrow + separate from pi-redact-all so it can be
 * removed or upstreamed without touching the vendor package. It runs as a
 * `tool_result` extension hook, same phase as pi-redact-all; pi runs
 * extension hooks in the order extensions were registered (alphabetical load
 * in 0.84+), and `ntfy-*` sorts after `pi-redact-all` (pi < n), so this
 * acts as a catch-all after the other layers.
 *
 * Marker format matches pi-redact-all: `[REDACTED:ntfy Token]`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ntfy tokens: `tk_` + ~26-32 [a-z0-9] chars. Observed length 32 inc prefix in this
// homelab (`tk_k7a4...`). Be permissive on tail length (20+) to catch variants.
const NTFY_RE = /\btk_[A-Za-z0-9]{20,}\b/g;
const MARKER = "[REDACTED:ntfy Token]";

function redactNtfy(text: string): string {
  // Avoid double-redacting spans already marked by pi-redact-all.
  // If text already contains a `[REDACTED:` marker that overlaps this match,
  // skip it. Cheap: just check if that exact marker is near the match.
  if (!text.includes("tk_")) return text;
  // Guard: don't redact inside path-like contexts or already-redacted spans.
  // For ntfy tokens this is simple — no legitimate file path contains tk_.
  // But we still avoid touching text already containing `[REDACTED:`
  // to not fight pi-redact-all's marker cache.
  return text.replace(NTFY_RE, (match, offset: number) => {
    const before = text.slice(Math.max(0, offset - 40), offset);
    const after = text.slice(offset + match.length, offset + match.length + 40);
    // If this match sits inside an existing marker, skip.
    if (before.includes("[REDACTED:") && !before.includes("]")) return match;
    if (after.startsWith("]") && before.includes("[REDACTED:")) return match;
    const prefix = match.slice(0, 4);
    return `${prefix}****${MARKER}`;
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    let changed = false;
    const nextContent: typeof event.content = [];
    for (const item of event.content as Array<{ type: string; text?: string } & Record<string, unknown>>) {
      if (item.type !== "text" || typeof item.text !== "string" || !item.text.includes("tk_")) {
        nextContent.push(item);
        continue;
      }
      const redacted = redactNtfy(item.text);
      if (redacted !== item.text) {
        changed = true;
        nextContent.push({ ...item, text: redacted });
      } else {
        nextContent.push(item);
      }
    }
    if (changed) return { content: nextContent };
  });
}
