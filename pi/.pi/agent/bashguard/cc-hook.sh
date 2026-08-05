#!/bin/bash
# bashguard PreToolUse hook shim for Claude Code (or any harness speaking the
# same stdin protocol). Resolves node even when the hook environment doesn't
# source nvm, then runs cli.ts (node >= 23.6 strips TypeScript natively).
#
# Fail-open by design: if node or cli.ts is missing, allow (exit 0) — a
# broken guard must never wedge the agent.
set -u

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
CLI="$DIR/cli.ts"
[ -f "$CLI" ] || exit 0

NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] && NODE="$candidate"
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || exit 0

exec "$NODE" "$CLI" "$@"
