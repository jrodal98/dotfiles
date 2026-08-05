#!/bin/bash
# check.sh — assert a bashguard verdict against the real engine.
#
# Usage: check.sh BLOCK|ALLOW '<bash command>' [cwd]
#
# Runs cli.ts --test with the same rule resolution as the live guard
# (local.ts sources unless BASHGUARD_RULES is set). Exits 0 on PASS,
# 1 on FAIL.
set -u

EXPECT="${1:?usage: check.sh BLOCK|ALLOW '<command>' [cwd]}"
CMD="${2:?usage: check.sh BLOCK|ALLOW '<command>' [cwd]}"
CWD="${3:-/tmp}"

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

OUT="$(BASHGUARD_AUDIT_LOG= "$DIR/cc-hook.sh" --test "$CMD" --cwd "$CWD" 2>&1)"
CODE=$?

GOT=ALLOW
[ "$CODE" -eq 2 ] && GOT=BLOCK

if [ "$GOT" = "$EXPECT" ]; then
    echo "PASS [$GOT] $CMD"
else
    echo "FAIL [want $EXPECT, got $GOT] $CMD"
    [ -n "$OUT" ] && echo "  engine: $OUT"
    exit 1
fi
