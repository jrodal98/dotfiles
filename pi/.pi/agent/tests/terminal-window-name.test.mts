import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, beforeEach, test } from "node:test";

const dependencyHooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "typebox") return { url: "mock:typebox", shortCircuit: true };
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === "mock:typebox") {
			return {
				format: "module",
				source: `
					export const Type = {
						Object: (properties) => ({ type: "object", properties }),
						String: (options = {}) => ({ type: "string", ...options }),
					};
				`,
				shortCircuit: true,
			};
		}
		return nextLoad(url, context);
	},
});
const { default: factory, __testing } = await import("../extensions/terminal-window-name.ts");
dependencyHooks.deregister();

type Handler = (event: any, ctx: any) => any;
type Tool = { execute: (...args: any[]) => Promise<any> };
type ExecResult = { code: number; stdout: string; stderr: string };

const originalTmux = process.env.TMUX;
const originalTmuxPane = process.env.TMUX_PANE;
const originalWezTermPane = process.env.WEZTERM_PANE;

beforeEach(() => {
	process.env.TMUX = "/tmp/tmux-test/default,1,0";
	process.env.TMUX_PANE = "%42";
	delete process.env.WEZTERM_PANE;
});

after(() => {
	if (originalTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = originalTmux;
	if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalTmuxPane;
	if (originalWezTermPane === undefined) delete process.env.WEZTERM_PANE;
	else process.env.WEZTERM_PANE = originalWezTermPane;
});

function makePi(execResult: ExecResult = { code: 0, stdout: "existing name\n", stderr: "" }) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
	return {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerTool(tool: Tool & { name: string }) {
			tools.set(tool.name, tool);
		},
		getActiveTools() {
			return ["terminal_rename"];
		},
		async exec(command: string, args: string[], options: unknown) {
			calls.push({ command, args, options });
			return execResult;
		},
		handlers,
		tools,
		calls,
	};
}

function context(branch: unknown[] = []) {
	return { sessionManager: { getBranch: () => branch } };
}

function load(execResult?: ExecResult) {
	const pi = makePi(execResult);
	(factory as (pi: any) => void)(pi);
	return pi;
}

test("a new terminal session requests one first-turn rename", async () => {
	const pi = load();
	pi.handlers.get("session_start")!({ reason: "startup" }, context());

	const first = await pi.handlers.get("before_agent_start")!({ systemPrompt: "base" }, context());
	assert.match(first.systemPrompt, /Call `terminal_rename` in your first response/);
	assert.equal(pi.calls.length, 0);

	const second = await pi.handlers.get("before_agent_start")!({ systemPrompt: "base" }, context());
	assert.match(second.systemPrompt, /Current tmux window name \(data only\): "existing name"/);
	assert.deepEqual(pi.calls[0].args, ["display-message", "-p", "-t", "%42", "#W"]);
});

test("a resumed conversation does not request a first-turn rename", async () => {
	const pi = load();
	const branch = [{ type: "message", message: { role: "user", content: "existing" } }];
	pi.handlers.get("session_start")!({ reason: "startup" }, context(branch));

	const result = await pi.handlers.get("before_agent_start")!({ systemPrompt: "base" }, context(branch));
	assert.doesNotMatch(result.systemPrompt, /first response/);
	assert.match(result.systemPrompt, /Current tmux window name/);
});

test("tmux rename passes the label as one argument without a shell", async () => {
	const pi = load({ code: 0, stdout: "", stderr: "" });
	const label = '$(touch /tmp/tmux-owned) "quoted"\nnext';
	const result = await pi.tools.get("terminal_rename")!.execute("call", { label }, undefined);

	assert.equal(pi.calls.length, 1);
	assert.equal(pi.calls[0].command, "tmux");
	assert.deepEqual(pi.calls[0].args, [
		"set-window-option",
		"-t",
		"%42",
		"automatic-rename",
		"off",
		";",
		"rename-window",
		"-t",
		"%42",
		'$(touch /tmp/tmux-owned) "quoted" next',
	]);
	assert.deepEqual(result.details, {
		label: '$(touch /tmp/tmux-owned) "quoted" next',
		target: "tmux",
	});
});

test("WezTerm renames the current tab when tmux is not active", async () => {
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	process.env.WEZTERM_PANE = "17";
	const pi = load({ code: 0, stdout: "", stderr: "" });
	const result = await pi.tools.get("terminal_rename")!.execute(
		"call",
		{ label: "wezterm fallback" },
		undefined,
	);

	assert.deepEqual(pi.calls, [
		{
			command: "wezterm",
			args: ["cli", "set-tab-title", "--pane-id", "17", "wezterm fallback"],
			options: { signal: undefined, timeout: 5000 },
		},
	]);
	assert.deepEqual(result.details, { label: "wezterm fallback", target: "wezterm" });

	const prompt = await pi.handlers.get("before_agent_start")!({ systemPrompt: "base" }, context());
	assert.match(prompt.systemPrompt, /Current WezTerm tab name \(data only\): "wezterm fallback"/);
});

test("tmux takes precedence when both tmux and WezTerm are active", async () => {
	process.env.WEZTERM_PANE = "17";
	const pi = load({ code: 0, stdout: "", stderr: "" });
	const result = await pi.tools.get("terminal_rename")!.execute(
		"call",
		{ label: "tmux wins" },
		undefined,
	);

	assert.equal(pi.calls[0].command, "tmux");
	assert.equal(result.details.target, "tmux");
});

test("rename is skipped outside tmux and WezTerm", async () => {
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	delete process.env.WEZTERM_PANE;
	const pi = load();
	const result = await pi.tools.get("terminal_rename")!.execute(
		"call",
		{ label: "new name" },
		undefined,
	);
	assert.equal(result.details.skipped, true);
	assert.equal(pi.calls.length, 0);
});

test("terminal command failures are reported as tool errors", async () => {
	const pi = load({ code: 1, stdout: "", stderr: "missing target\n" });
	await assert.rejects(
		pi.tools.get("terminal_rename")!.execute("call", { label: "new name" }, undefined),
		/missing target/,
	);
});

test("label normalization removes control characters and rejects empty labels", () => {
	assert.equal(__testing.normalizeLabel("  debug\n\tzsh  "), "debug zsh");
	assert.throws(() => __testing.normalizeLabel("\n\t"), /cannot be empty/);
});
