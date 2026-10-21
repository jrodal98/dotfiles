---
name: simple-rust
description: Use when writing, reviewing, refactoring, testing, or designing Rust code. Focuses on Cargo workflows, production Rust APIs, explicit errors, testable design, async/FFI safety, and CLI idioms such as clap subcommands, try_main, and snapshot-style CLI tests.
---

# Simple Rust

## Use This Skill

- Use for Rust changes, especially when editing `.rs` files, `Cargo.toml` manifests, developer CLIs, bindings, tests, or public APIs.
- Apply **Operational Defaults**, **Crate Shape**, **Error Handling**, and **API Design** on every Rust task.
- Read later sections only for touched domains: CLI, testing, async, dependencies/platforms, performance, logging, macros, unsafe, or FFI.
- Local code wins over this guide. If nearby Rust code has a clear convention, follow it and keep the change consistent.
- If the project uses a build system other than Cargo (Bazel, Nix, Make, etc.), that build system is the source of truth; map the Cargo commands below to its equivalents.

## Operational Defaults

- Inspect the nearest `Cargo.toml`, the workspace root manifest, and nearby Rust modules before editing; copy package layout, module style, dependency declaration style, and test wiring.
- Format with `cargo fmt`. Format a single file with `rustfmt <file.rs>` when that is more useful. Respect any `rustfmt.toml`.
- Typecheck with `cargo check --all-targets`. Run Clippy with `cargo clippy --all-targets -- -D warnings`.
- Build with `cargo build` and test with `cargo test`. Use the narrowest scope that covers the change (`-p <crate>`, `--test <name>`, or a test-name filter).
- Before committing, run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`. Add `--all-features` or a feature matrix when the crate has optional features.
- Check for unused dependencies with `cargo machete` (or `cargo +nightly udeps`) when touching dependencies.
- Expand macros with `cargo expand` (from `cargo-expand`).
- Keep `[dependencies]`, `[dev-dependencies]`, and workspace dependency tables alphabetized.
- In workspaces, declare shared versions once in `[workspace.dependencies]` and reference them with `foo.workspace = true`; configure lints once in `[workspace.lints]` and opt in with `[lints] workspace = true`.
- Commit `Cargo.lock` for binaries and workspaces with binaries; follow the project's existing policy for library-only crates.
- Never suppress lints with `#[allow]`. Use `#[expect(lint_name, reason = "…")]` (Rust 1.81+) so the suppression fails when the lint stops firing. Keep it local; never crate-wide.
- Add dependencies only when local code or the task justifies them; prefer `std`, crates already in the dependency tree, and nearby precedent.

## Crate Shape

- Keep `main.rs` thin: initialize logging, parse config, call command/library code, and map top-level errors to exit behavior.
- Put business logic in `lib.rs` or domain modules so unit tests can exercise it without invoking a binary.
- Organize modules by domain. Avoid deep module trees and one-off abstractions unless they isolate real complexity.
- Inline single-use helpers under about 10 lines unless extraction adds domain meaning, isolates complexity, or enables focused tests.
- Keep top-level `mod` declarations easy to scan; alphabetize them when local style does not say otherwise.
- Prefer `foo.rs` plus `foo/` over `mod.rs`; use `pub(super)` before `pub(crate)` for sibling-only sharing.
- Prefer modules inside one crate; split into separate workspace crates only for a real second consumer, ownership boundary, test boundary, or compile-time win.
- For new CLI binaries, use one package with `src/lib.rs` plus `src/main.rs`, set `publish = false` for internal tools, and set `edition` and `rust-version` explicitly.
- Small libraries can stay as `src/lib.rs`. Add extra binaries under `src/bin/` only when they share the library; otherwise keep them as separate packages.
- If embedding files with `include_str!` or `include_bytes!`, keep them inside the package directory and make sure the manifest's `include`/`exclude` lists do not drop them from published crates.
- Follow the project's license header convention (for example, an SPDX identifier). Do not invent new headers.

## CLI Pattern

- Default developer CLIs to synchronous code. Do not add `tokio` or `async-std` unless the requested behavior needs async and nearby code already supports that direction.
- Use `clap` derive or the local parser for non-trivial CLIs. Convert raw flags into typed config before calling business logic.
- For subcommand CLIs, use `src/main.rs`, `src/commands.rs`, one `src/commands/<name>.rs` per subcommand, and CLI integration tests under `tests/`.
- `main` delegates to `try_main() -> anyhow::Result<ExitCode>` and centralizes error chain rendering (walk `.chain()`, no `Debug` formatting).
- Each subcommand exposes `pub struct Opts` and `pub fn run(opts: Opts) -> anyhow::Result<ExitCode>`.
- Use doc comments on clap command structs and fields so `--help` output is useful.
- Use `#[command(flatten)]` for shared argument groups and `#[group(...)]` or `conflicts_with` for mutually exclusive flags.
- Return `ExitCode`; avoid `std::process::exit()` when destructors or buffered output should run.
- Print diagnostics to `stderr` and normal output to `stdout`. Treat broken pipe as success.
- Respect `NO_COLOR` and terminal detection (`std::io::IsTerminal`) before emitting color.
- Destructure `Opts` in `run` when it helps catch silent field drift during refactors.
- Use captured format strings like `{var}` where they improve clarity.

## Error Handling

- Libraries expose structured, matchable errors with `thiserror` when callers can branch on failure kind.
- Never use `error-chain` or `failure`; both are deprecated.
- Keep error variants small and payload-focused; use a struct error instead of a tuple variant with many fields.
- CLIs and applications use `anyhow` at the top level. Import `anyhow::Context as _`; use `.context()`, `.with_context(...)`, `bail!`, and `ensure!` where they add actionable context.
- If one layer needs both typed failures and opportunistic propagation, use a wrapper enum with typed variants plus an `anyhow::Error` escape hatch.
- Preserve error sources with `#[source]` or transparent wrappers.
- Implement `From` only for unambiguous conversions; use `TryFrom` for fallible construction.
- Use `Option` for meaningful absence and `Result<T, E>` for failure.
- Reserve panics for bugs and invariant violations, not input, I/O, or configuration errors.
- Avoid `.unwrap()` outside tests; use `?`, `bail!`, `ensure!`, or a justified `expect("reason")`.
- Use `#[track_caller]` on public panic/assert helpers and caller-input-sensitive constructors; document public `# Panics`.

## API Design

- Accept broad borrowed inputs: `&str`, `&[T]`, `&Path`, or `impl AsRef<Path>` instead of owned container references. Prefer `Option<&T>` over `&Option<T>` — more general and optimizes to a null pointer.
- Take ownership only to store, transfer, spawn, or transform independently. Return borrowed values from getters.
- Prefer enums, bitflags, or option structs over booleans when the value has domain meaning or affects multiple code paths.
- Use newtypes for IDs, units, validated strings, paths, and primitives that are easy to mix up.
- For more than four function arguments, take a struct (preferred) or use a `bon` builder.
- Pair validation with typed errors. For serde inputs that must validate, use `#[serde(try_from = "String")]` when it fits; add `AsRef<str>`, `AsRef<OsStr>`, or `AsRef<Path>` when the newtype feeds existing APIs.
- Keep fields private by default and expose invariants through constructors and methods.
- Treat public structs, trait impls, re-exports, wire formats, and CLI output as compatibility commitments. For published crates, follow SemVer and consider `cargo semver-checks` before releasing.
- Mark public builders, lazy values, guards, handles, and non-mutating transformations `#[must_use]` when silently dropping them is likely a bug.
- Implement `Default` only when the value is meaningful and unsurprising.
- Derive standard traits when semantics are clear: at least `Debug` for public types, plus `Clone`, `Eq`, `Hash`, `Default`, or ordering traits as needed.
- Use serde attributes for wire names, defaults, and unknown-field behavior; do not rely on Rust field names matching external schemas.
- Use `#[serde(deny_unknown_fields)]` only for config or protocol inputs where unknown fields are genuinely errors.
- Use private fields or `#[non_exhaustive]` for public structs/enums that must evolve without breaking downstream matches or constructors.
- Use `#[repr(C)]` for FFI layouts and `#[repr(transparent)]` for ABI-compatible newtypes.
- Follow the Rust API Guidelines naming conventions; avoid `get_` for simple getters, use `as_*` for cheap borrowed views, `to_*` for owned conversions, and `into_*` for consuming conversions.

## Design And Ownership

- Keep designs simple. Add traits, builders, macros, modules, or new crates only for current complexity, invariants, reuse, or testability.
- Do not clone to satisfy the borrow checker. Revisit ownership, borrowing, data layout, or lifetimes first.
- Borrow by default; use `Arc<T>`, locks, atomics, or interior mutability only for intentional shared ownership or mutation.
- Keep lock scopes short and never hold locks across callbacks or `.await`.
- Use `mem::take`, `mem::replace`, or `Option::take` to move values out of mutable references.
- Prefer guard clauses (early return, `let-else`) over deep nesting; small branches should exit before the main logic, not wrap it.
- Use newtype for validated primitives, builder for many construction options, strategy/policy for swappable behavior, RAII guard for cleanup, and index handles for stable references into collections.
- Prefer static dispatch with generics or `impl Trait`; use `dyn Trait` for heterogeneous collections, plugin points, branch-selected implementations, or code-size control.
- Prefer enums over `dyn Trait` when the implementation set is closed in this crate; reach for `dyn` only when callers outside the crate must contribute implementations. `enum_dispatch` gives trait-like ergonomics without losing exhaustive matching.
- Check object safety before exposing `dyn Trait`; use sealed traits for public traits that should not be implemented outside the crate.
- Introduce a small custom trait with associated types when repeated generic bounds become unreadable.
- Do not expose `Box<dyn std::error::Error>` from library APIs when callers need structured handling.
- Prefer functions and generics before macros.

## Testing And Documentation

- Put unit tests beside implementation in `#[cfg(test)] mod tests`; use integration tests in `tests/` for public CLI behavior and cross-module flows.
- Test success paths, error paths, boundaries, and regressions with focused test names.
- Keep pure logic separate from I/O, network, time, environment, and randomness so tests can inject controlled dependencies.
- Use `#[cfg(test)]` for test-only inspection hooks instead of weakening production visibility.
- Use the `assert_matches` crate (or `matches!`) for pattern assertions and `tempfile`/`TempDir` for filesystem fixtures.
- For CLIs, cover help text, error text, stdout/stderr behavior, exit codes, structured output, and platform-specific output with `assert_cmd` + `predicates`, `trycmd`, or `insta` snapshots.
- Normalize paths, colors, environment, and ordering in golden/snapshot-style tests.
- Add property tests (`proptest`, `quickcheck`) or fuzzing (`cargo fuzz`) for parsers, serializers, protocol handlers, and state machines when input space is large.
- Document public items with a one-sentence summary; add `# Examples`, `# Errors`, `# Panics`, and `# Safety` sections when applicable. Keep doc examples compiling under `cargo test --doc`.
- Do not manually edit generated Rust. Regenerate with the owning tool (`build.rs`, `bindgen`, `prost-build`, etc.).

## Async And Concurrency

- For service code, follow the existing runtime and executor pattern in that crate.
- Do not block async runtimes; use `tokio::task::spawn_blocking` (or the runtime's equivalent) or keep the flow synchronous.
- In async contexts use `tokio::fs`; in sync contexts use `std::fs`. If a change uses `std::fs` inside an async runtime, justify it in a comment or convert it to `tokio::fs`.
- Keep values held across `.await` small and ensure spawned futures satisfy required `Send + 'static` bounds.
- Use async-aware synchronization when waiting in async code or holding guards across `.await`; use `std::sync` only for short, non-awaiting critical sections.
- Prefer channels for one-way data flow. Use locks only for actual shared mutable state.
- Use `OnceLock` or `LazyLock` for synchronous one-time initialization; use async once-cells (`tokio::sync::OnceCell`) only when initialization is actually async.
- Start threaded concurrency with channels, locks, worker pools, actors, or `rayon`; use atomics only when higher-level primitives are insufficient.
- Use `Relaxed` atomics only for independent metrics/counters; use Acquire/Release for handoff protocols and `SeqCst` until weaker ordering is justified.

## Dependencies And Platforms

- Common CLI crates: `anyhow`, `clap`, `thiserror`, `serde`, `serde_json`, `tempfile`, `assert_matches`, `assert_cmd`, `rayon`, `dunce`, `which`, `log`, `env_logger`, `tracing`, and `tracing-subscriber`.
- Be critical before adding async runtimes, HTTP clients, `regex`, or broad utility crates. Prefer a small parser, existing client, process invocation, or handwritten impl when clear.
- Keep Cargo features additive. Use `default-features = false` and enable only needed features when a dependency's defaults pull in heavy code.
- Prefer derive macros for boilerplate trait impls: `thiserror` for errors, `derive_more` (`Display`, `From`, `Into`) for non-error types, and `strum` for enum-string conversions. Hand-written `Display`/`From`/`Into` should be the exception, not the default.
- Leave a short why-comment for non-obvious crate choices, platform workarounds, or behavior constraints.
- Use `cargo deny` or `cargo audit` when the project already runs them to keep licenses and advisories in check.
- Prefer expression-level `cfg!(...)` for platform behavior (`cfg!` is a compile-time constant, but both branches must compile on every platform); reserve item-level `#[cfg(...)]` for items that genuinely cannot compile on the other platform.
- On Windows, use `dunce::canonicalize` for path normalization and `which::which_in` for executable lookup when those crates are already acceptable in the project.
- If output differs by OS, split integration coverage into common tests and platform-gated (`#[cfg(windows)]` / `#[cfg(unix)]`) variants.

## Performance And Observability

- Optimize algorithms, allocation count, syscalls, and data layout before syntax-level tuning.
- Allocate only when ownership is required; preallocate `Vec`, `String`, and maps when size is known or cheaply estimated.
- Use `format!` for readable string assembly; use preallocated `String` plus `push`/`push_str` in hot paths.
- Avoid collecting intermediate containers unless the materialized collection is needed.
- Use `BufWriter` for high-throughput stdout or file output.
- Use `rayon` for CPU-bound data parallelism; do not mix it into async I/O paths without a reason.
- Benchmark representative inputs (`criterion`, `divan`) before adding `#[inline]`, specialized containers, arenas, or custom allocation strategies.
- Prefer `tracing` in async or service code. For CLI tools use `log` plus `env_logger` (or `tracing-subscriber`), with `clap-verbosity-flag` for `-v`/`-q` handling, unless nearby code already has a convention.
- Structure spans around operations such as requests, batches, retries, and background jobs. Never log secrets, tokens, credentials, or PII.
- No emojis in CLI output, log messages, or snapshot expectations.

## Macros, Unsafe, And FFI

- Use derive macros when the generated impl is the obvious implementation. Keep procedural macros rare, span-aware, and inspectable with `cargo expand`.
- Add pass and compile-fail tests for procedural macros or intentional compile-time diagnostics with `trybuild`.
- Avoid `unsafe`. If needed, isolate it in the smallest module, expose a safe API, and document every `unsafe fn` with `# Safety`.
- In `unsafe fn`, keep each `unsafe {}` block locally justified with a `// SAFETY:` comment; do not let the whole function become an unchecked region (enable `unsafe_op_in_unsafe_fn`).
- Prefer `NonNull<T>` for non-null raw pointers and `MaybeUninit<T>` for uninitialized values. Never create references to invalid, uninitialized, aliased-mutable, or misaligned memory.
- Run Miri (`cargo +nightly miri test`) for unsafe/interior-mutability-heavy code and Loom or ThreadSanitizer for custom concurrency.
- Keep FFI boundaries thin: convert foreign inputs once, call safe Rust, convert outputs once.
- Use explicit ABIs and do not unwind across FFI boundaries unless the ABI supports it (`extern "C-unwind"`).
- Pair every ownership transfer across FFI with an explicit allocation/free convention.
- Wrap opaque foreign types in distinct Rust types and avoid exporting Rust lifetimes directly; use opaque handles with explicit create/use/destroy functions.

## Final Checklist

- Ran `cargo fmt`, `cargo check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, or `cargo expand` as the task warrants.
- Kept `Cargo.toml` tidy: alphabetized dependencies, workspace inheritance where the project uses it, additive features, no unused dependencies.
- Kept public APIs typed, borrowed where practical, and explicit about errors.
- Made side effects injectable and covered changed behavior, including error paths.
- Kept CLIs sync-first, with correct stdout/stderr, exit codes, colors, broken-pipe behavior, and integration coverage for user-visible behavior.
- Justified new dependencies and avoided broad utility crates unless they clearly pay for themselves.
- Documented unsafe/FFI invariants and covered them with targeted tests when touched.
- Left formatting, linting, tests, and relevant benchmarks either run or explicitly noted.
