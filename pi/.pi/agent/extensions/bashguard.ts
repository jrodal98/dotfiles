/**
 * bashguard bridge — runs the bashguard guard engine (../bashguard/engine.ts)
 * in-process against pi's bash tool calls.
 *
 * The engine is a pure library (no subprocess), so evaluation adds no spawn
 * latency and has no spawn/timeout fail-open windows. The same engine is
 * exposed to hook-protocol harnesses via ../bashguard/cli.ts.
 *
 * Behavior:
 *   - block-severity rule fires  -> the bash call is blocked with the reason
 *   - warn-severity rule fires   -> UI notification, and the warning is
 *     appended to the tool result so the model sees it too
 *   - engine/extension errors    -> deliberate fail open (a broken guard
 *     must never wedge the agent); pi's default for tool_call handler errors
 *     is fail-closed, hence the explicit try/catch
 *
 * Site-local customization lives in ~/.pi/agent/bashguard/local.ts
 * (exporting setup(engine)): extra matchers and the layered rule-source
 * list. BASHGUARD_RULES / BASHGUARD_MODE / BASHGUARD_AUDIT_LOG env vars work
 * as documented in engine.ts.
 *
 * Commands:
 *   /bashguard            status: engine, sources, lint, recent audit fires
 *   /bashguard test <cmd> dry-run a command against the live rule set
 */

import { existsSync, readFileSync } from "node:fs";
import * as engine from "../bashguard/engine.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_AUDIT_LOG = "/tmp/bashguard-audit.log";

interface LocalState {
  info?: engine.LocalInfo;
  error?: string;
}

let localState: Promise<LocalState> | undefined;

function loadLocalOnce(): Promise<LocalState> {
  localState ??= (async () => {
    try {
      return { info: await engine.loadLocal(engine) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  })();
  return localState;
}

function formatFire(f: engine.Fire): string {
  return `[${f.ruleId}] ${f.reason}`;
}

export default function (pi: ExtensionAPI) {
  // toolCallId -> warning lines to surface in the tool result.
  const pendingWarnings = new Map<string, string[]>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || !command) return;

    try {
      const { info } = await loadLocalOnce();
      const sources = engine.resolveSources(info?.sources);
      let session: string | undefined;
      try {
        session = ctx.sessionManager.getSessionId();
      } catch {
        // ephemeral contexts: audit without attribution
      }
      const verdict = engine.evaluateCommand(command, { cwd: ctx.cwd, sources, session });

      if (verdict.blocked) {
        return { block: true, reason: `BLOCKED by bashguard: ${formatFire(verdict.blocked)}` };
      }
      if (verdict.fires.length > 0) {
        const lines = verdict.fires.map((f) => `bashguard warning: ${formatFire(f)}`);
        pendingWarnings.set(event.toolCallId, lines);
        if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "warning");
      }
    } catch {
      // fail open: never let a guard bug take down bash
    }
  });

  // Surface warn-severity fires to the model, not just the human.
  pi.on("tool_result", (event) => {
    const lines = pendingWarnings.get(event.toolCallId);
    if (!lines) return;
    pendingWarnings.delete(event.toolCallId);
    return {
      content: [...event.content, { type: "text" as const, text: lines.join("\n") }],
    };
  });

  // One-time health check: stay quiet when healthy, surface real problems.
  pi.on("session_start", async (_event, ctx) => {
    try {
      const { info, error } = await loadLocalOnce();
      const problems: string[] = [];
      if (error) problems.push(`site extension failed to load: ${error}`);
      const sources = engine.resolveSources(info?.sources);
      const issues = engine.lintSources(sources).filter((i) => i.problem !== "file missing");
      for (const i of issues.slice(0, 5)) problems.push(`${i.source}: [${i.ruleId}] ${i.problem}`);
      try {
        problems.push(...(info?.lint?.() ?? []));
      } catch (e) {
        problems.push(`site lint failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (problems.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`bashguard: ${problems.join("\n")}`, "warning");
      }
    } catch {
      // health check must not break startup
    }
  });

  pi.registerCommand("bashguard", {
    description: "bashguard guard status, or 'test <command>' to dry-run a rule check",
    handler: async (args, ctx) => {
      const { info, error } = await loadLocalOnce();
      const sources = engine.resolveSources(info?.sources);

      const trimmed = (args ?? "").trim();
      if (trimmed.startsWith("test ")) {
        const cmd = trimmed.slice(5).trim();
        const verdict = engine.evaluateCommand(cmd, { cwd: ctx.cwd, sources, audit: false });
        const lines: string[] = [];
        for (const f of verdict.fires) {
          lines.push(`${f === verdict.blocked ? "BLOCK" : "WARN"} ${formatFire(f)}`);
        }
        for (const s of verdict.skippedRules) {
          lines.push(`skipped: ${s.id} (unknown keys: ${s.unknownKeys.join(", ")})`);
        }
        for (const nInfo of verdict.notes) lines.push(`note: ${nInfo}`);
        if (verdict.decision === "allow") lines.push("ALLOW");
        ctx.ui.notify(lines.join("\n"), verdict.decision === "block" ? "warning" : "info");
        return;
      }

      const { config, errors } = engine.loadRules(sources);
      const lines = [
        `mode: ${process.env.BASHGUARD_MODE || "enforce"}`,
        `local: ${
          error
            ? `FAILED to load (${error})`
            : info
              ? (info.name ?? engine.LOCAL_MODULE_PATH)
              : "none (generic rules only)"
        }`,
        `rules: ${config.rules.length} effective from ${sources.length} source(s)${
          process.env.BASHGUARD_RULES ? " (BASHGUARD_RULES override)" : ""
        }`,
        ...sources.map((s) => `  - ${s}${existsSync(s) ? "" : " (missing)"}`),
        ...errors.map((e) => `  ! ${e}`),
      ];
      const issues = engine.lintSources(sources).filter((i) => i.problem !== "file missing");
      if (issues.length > 0) {
        lines.push(`lint: ${issues.length} issue(s)`);
        for (const i of issues.slice(0, 5)) lines.push(`  ! ${i.source}: [${i.ruleId}] ${i.problem}`);
      }
      try {
        lines.push(...(info?.lint?.() ?? []).map((m) => `site: ${m}`));
      } catch (e) {
        lines.push(`site lint failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const auditLog = process.env.BASHGUARD_AUDIT_LOG ?? DEFAULT_AUDIT_LOG;
      if (auditLog && existsSync(auditLog)) {
        try {
          const tail = readFileSync(auditLog, "utf8").trim().split("\n").slice(-5);
          lines.push(`recent fires (${auditLog}):`, ...tail.map((l) => `  ${l}`));
        } catch {
          // ignore
        }
      }
      ctx.ui.notify(lines.join("\n"), error ? "warning" : "info");
    },
  });
}
