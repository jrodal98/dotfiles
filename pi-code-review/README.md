# pi-code-review

Multi-model, multi-focus code review extension for [pi](https://pi.dev), using
plain **git** for target resolution.

This is a separate stow package from `pi` on purpose: at work I run a
Meta-internal variant of this extension (Sapling/Phabricator-aware), so this
package must **not** be stowed there. Stow it only on machines where pi is used
with git:

```sh
cd ~/dotfiles && stow pi-code-review
```

## Usage

- `/review [target]` — interactive flow: resolve target, auto-suggest focus
  areas, pick reviewer models (cross-family defaults), pick speed, run
  focus×model reviewers in parallel, aggregate, then triage findings (with an
  optional clarifier Q&A agent).
- `review` tool — same pipeline, agent-invoked, no UI.

Targets: empty (uncommitted changes), `this` (session changes), `stack`/`branch`
(local commits on top of upstream/main), `commit`/`HEAD`, file paths, or any git
commit-ish / range (`abc1234`, `main..feature`).

Config: `~/.pi/agent/code-review.json` (see `config.ts` for defaults).
