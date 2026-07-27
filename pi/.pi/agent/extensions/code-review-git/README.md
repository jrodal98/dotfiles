# code-review-git

Multi-model, multi-focus code review extension for [pi](https://pi.dev), using
plain **git** for target resolution.

At work I run a Meta-internal variant of this extension
(Sapling/Phabricator-aware) that lives at `extensions/code-review/` in a
separate local repo. This git version is stowed everywhere as part of the `pi`
package but disabled on Meta machines via `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["-extensions/code-review-git/index.ts"]
}
```

On non-Meta machines no configuration is needed — pi auto-discovers
`~/.pi/agent/extensions/code-review-git/index.ts`.

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
