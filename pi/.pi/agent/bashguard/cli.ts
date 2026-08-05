#!/usr/bin/env node
/**
 * bashguard CLI — hook entry point and rule-authoring tool for the engine
 * in ./engine.ts.
 *
 * Modes:
 *   (default)               Claude-Code-style PreToolUse hook: reads
 *                           {"tool_name":"Bash","tool_input":{"command":..},
 *                           "cwd":..} JSON on stdin; exit 2 + stderr blocks,
 *                           exit 0 allows (stderr = advisory warnings).
 *   --test '<cmd>' [--cwd DIR]     evaluate a command, print the verdict;
 *                                  exit 2 on block, 0 otherwise.
 *   --explain '<cmd>' [--cwd DIR]  show tokenization: segments, modifier
 *                                  peeling, cwd tracking, substitutions.
 *   --lint                  validate all rule sources; exit 1 on issues.
 *   --dump-rules            print effective merged rules + sources as JSON.
 *
 * A site-local extension at ~/.pi/agent/bashguard/local.ts (exporting
 * setup(engine)) is loaded first when present; it may register extra
 * matchers and supply the layered rule-source list. BASHGUARD_RULES
 * (colon-separated paths) overrides sources either way.
 *
 * Requires node >= 23.6 (native TypeScript type stripping).
 */

import { readFileSync } from "node:fs";
import * as engine from "./engine.ts";

interface Args {
  mode: "hook" | "test" | "explain" | "lint" | "dump-rules";
  command?: string;
  cwd: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "hook", cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--test" || a === "--explain") {
      args.mode = a === "--test" ? "test" : "explain";
      args.command = argv[++i];
    } else if (a === "--lint") {
      args.mode = "lint";
    } else if (a === "--dump-rules") {
      args.mode = "dump-rules";
    } else if (a === "--cwd") {
      args.cwd = argv[++i];
    } else {
      process.stderr.write(`bashguard: unknown argument '${a}'\n`);
      process.exit(64);
    }
  }
  if ((args.mode === "test" || args.mode === "explain") && !args.command) {
    process.stderr.write(`bashguard: --${args.mode} requires a command string\n`);
    process.exit(64);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let local: engine.LocalInfo | undefined;
  let localError: string | undefined;
  try {
    local = await engine.loadLocal(engine);
  } catch (e) {
    localError = e instanceof Error ? e.message : String(e);
  }
  const sources = engine.resolveSources(local?.sources);

  if (args.mode === "lint") {
    const issues = engine.lintSources(sources);
    const extra = (() => {
      try {
        return local?.lint?.() ?? [];
      } catch (e) {
        return [`local lint failed: ${e instanceof Error ? e.message : String(e)}`];
      }
    })();
    if (localError) console.log(`local extension failed to load: ${localError}`);
    for (const s of sources) console.log(`source: ${s}`);
    for (const i of issues) console.log(`${i.source}: [${i.ruleId}] ${i.problem}`);
    for (const m of extra) console.log(m);
    console.log(
      issues.length === 0 && extra.length === 0 && !localError
        ? "OK"
        : `${issues.length + extra.length + (localError ? 1 : 0)} issue(s)`,
    );
    process.exit(issues.length > 0 || localError ? 1 : 0);
  }

  if (args.mode === "dump-rules") {
    const { config, errors } = engine.loadRules(sources);
    console.log(JSON.stringify({ sources, errors, config }, null, 2));
    process.exit(0);
  }

  if (args.mode === "explain") {
    const ex = engine.explainCommand(args.command as string, args.cwd);
    for (const [i, seg] of ex.segments.entries()) {
      console.log(`segment ${i} (cwd ${seg.cwd}):`);
      console.log(`  raw:      ${JSON.stringify(seg.raw)}`);
      console.log(`  stripped: ${JSON.stringify(seg.stripped)}`);
    }
    for (const sub of ex.substitutions) console.log(`substitution: ${JSON.stringify(sub)}`);
    process.exit(0);
  }

  if (args.mode === "test") {
    const verdict = engine.evaluateCommand(args.command as string, {
      cwd: args.cwd,
      sources,
      audit: false,
    });
    if (localError) console.log(`note: local extension failed to load: ${localError}`);
    for (const f of verdict.fires) {
      if (f !== verdict.blocked) console.log(`WARN [${f.ruleId}] ${f.reason}`);
    }
    for (const s of verdict.skippedRules)
      console.log(`skipped: ${s.id} (unknown keys: ${s.unknownKeys.join(", ")})`);
    for (const nInfo of verdict.notes) console.log(`note: ${nInfo}`);
    if (verdict.blocked) {
      console.log(`BLOCK [${verdict.blocked.ruleId}] ${verdict.blocked.reason}`);
      process.exit(2);
    }
    console.log("ALLOW");
    process.exit(0);
  }

  // Hook mode (stdin protocol). Any parse problem fails open (exit 0).
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  if (typeof payload !== "object" || payload === null) process.exit(0);
  const data = payload as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  if (data.tool_name !== "Bash") process.exit(0);
  const toolInput = data.tool_input;
  if (typeof toolInput !== "object" || toolInput === null) process.exit(0);
  const command = (toolInput as { command?: unknown }).command;
  if (typeof command !== "string" || command.length === 0) process.exit(0);
  const cwd = typeof data.cwd === "string" && data.cwd.length > 0 ? data.cwd : process.cwd();

  if (localError) {
    process.stderr.write(`WARN by bashguard: site extension failed to load: ${localError}\n`);
  }
  let verdict: engine.Verdict;
  try {
    verdict = engine.evaluateCommand(command, { cwd, sources, session: process.env.BASHGUARD_SESSION });
  } catch {
    process.exit(0); // engine bug: fail open, never wedge the agent
  }
  for (const f of verdict.fires) {
    if (f !== verdict.blocked) {
      process.stderr.write(`WARN by bashguard: [${f.ruleId}] ${f.reason}\n`);
    }
  }
  if (verdict.blocked) {
    process.stderr.write(`BLOCKED by bashguard: [${verdict.blocked.ruleId}] ${verdict.blocked.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

await main();
