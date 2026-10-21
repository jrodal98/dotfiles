import assert from "node:assert/strict";
import { test } from "node:test";

const { default: factory, isRustPath } = await import("../extensions/rust-skill-gate.ts");

type Handler = (event: any, ctx: any) => any;

function load(entries: unknown[] = []) {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  (factory as (pi: unknown) => void)(pi);
  handlers.get("session_start")?.({}, {
    sessionManager: { getEntries: () => entries },
  });
  return handlers;
}

function call(handlers: Map<string, Handler>, toolName: string, input: unknown) {
  return handlers.get("tool_call")?.({ toolName, input }, {});
}

test("recognizes Rust source paths", () => {
  assert.equal(isRustPath("src/lib.rs"), true);
  assert.equal(isRustPath("@src/main.rs"), true);
  assert.equal(isRustPath("src/lib.rs.bak"), false);
  assert.equal(isRustPath("src/lib.ts"), false);
});

test("blocks edit and write calls for Rust files before the skill is loaded", () => {
  for (const toolName of ["edit", "write"]) {
    const result = call(load(), toolName, { path: "src/lib.rs" });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /load the simple-rust skill/);
  }
});

test("allows non-Rust mutations without loading the skill", () => {
  assert.equal(call(load(), "edit", { path: "README.md" }), undefined);
  assert.equal(call(load(), "write", { path: "Cargo.toml" }), undefined);
});

test("reading the Rust skill opens the gate", () => {
  const handlers = load();
  assert.equal(call(handlers, "read", { path: "/home/me/.pi/agent/skills/simple-rust/SKILL.md" }), undefined);
  assert.equal(call(handlers, "edit", { path: "src/lib.rs" }), undefined);
});

test("the Rust skill command opens the gate", () => {
  const handlers = load();
  handlers.get("input")?.({ text: "/skill:simple-rust" }, {});
  assert.equal(call(handlers, "write", { path: "src/main.rs" }), undefined);
});

test("a shell read of the Rust skill opens the gate", () => {
  const handlers = load();
  assert.equal(
    call(handlers, "bash", { command: "cat ~/.pi/agent/skills/simple-rust/SKILL.md" }),
    undefined,
  );
  assert.equal(call(handlers, "edit", { path: "src/lib.rs" }), undefined);
});

test("session history restores the loaded state", () => {
  const handlers = load([
    { type: "message", message: { role: "user", content: "/skill:simple-rust" } },
  ]);
  assert.equal(call(handlers, "edit", { path: "src/lib.rs" }), undefined);
});
