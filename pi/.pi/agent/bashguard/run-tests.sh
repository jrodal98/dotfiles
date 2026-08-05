#!/bin/bash
# run-tests.sh — golden regression suite for the bashguard engine + generic
# rules. Site-independent: pins BASHGUARD_RULES to the sibling rules.json
# (plus temp layers for layering/fail-safe cases), so it passes with or
# without a site-local extension installed.
set -u

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
RULES="$DIR/rules.json"
CHECK="$DIR/check.sh"
FAILURES=0

t() {
  BASHGUARD_RULES="${LAYERS:-$RULES}" "$CHECK" "$@" || FAILURES=$((FAILURES + 1))
}

echo "== baseline matching & precision =="
t BLOCK 'git commit'
t ALLOW 'git commit -m "x"'
t ALLOW 'git commit -am "x"'
t ALLOW 'git commit --no-edit'
t ALLOW 'echo "git commit"'
t BLOCK 'git rebase -i HEAD~3'
t ALLOW 'git rebase --onto main dev'
t BLOCK 'git add -p'
t ALLOW 'git add .'
t BLOCK 'visudo'
t BLOCK 'crontab -e'
t ALLOW 'crontab -l'
t BLOCK 'less /etc/hosts'
t ALLOW 'echo less'
t BLOCK 'emacs file.txt'
t ALLOW 'emacs --batch -l script.el'
t BLOCK 'nvim file.txt'
t ALLOW 'nvim --headless +q'

echo "== modifier peeling, env vars, cd tracking, pipes =="
t BLOCK 'sudo git commit'
t BLOCK 'sudo nohup timeout 5 git commit'
t BLOCK 'FOO=bar vim x'
t BLOCK 'cd /etc && vim hosts'
t BLOCK 'find . | less'

echo "== parser: quoted newlines (formerly failed open) =="
t BLOCK $'echo "hello\nworld" && git commit'
t BLOCK $'python3 -c \'print("""\nmulti\n""")\' ; git commit'

echo "== parser: heredocs are data (formerly false-blocked) =="
t ALLOW $'cat <<EOF > /tmp/tp-test-x\ngit commit\nvim /etc/hosts\nEOF'
t ALLOW $'cat <<-\'EOF\'\n\tless /etc/hosts\n\tEOF'
t ALLOW 'cat <<< "git commit"'
t BLOCK $'cat <<EOF\ndata\nEOF\ngit commit'

echo "== wrapper shells & eval (formerly an evasion) =="
t BLOCK "bash -c 'git commit'"
t BLOCK "bash -lc 'git commit'"
t BLOCK "sh -c 'vim /etc/hosts'"
t BLOCK 'eval git commit'
t BLOCK "bash -c 'while pgrep -f x; do sleep 1; done'"

echo "== command & process substitution =="
t BLOCK 'echo $(git commit)'
t BLOCK 'echo "result: $(git commit)"'
t ALLOW "echo '\$(git commit)'"
t BLOCK 'diff <(git commit) /dev/null'
t ALLOW 'echo $((1 + 2))'

echo "== unbounded pgrep polls =="
t BLOCK 'while pgrep -f myjob; do sleep 5; done'
t BLOCK 'until pgrep -f myjob; do sleep 5; done'
t BLOCK 'while ! pgrep -f myjob; do sleep 5; done'
t ALLOW 'while pgrep -x worker; do sleep 5; done'
t ALLOW 'pgrep -f myjob'

echo "== sensitive file reads =="
t BLOCK 'cat .env'
t BLOCK 'cat ./.env'
t BLOCK 'head -5 /app/config/.env.production'
t BLOCK 'grep API_KEY .env'
t BLOCK 'base64 .env'
t BLOCK "bash -c 'cat .env'"
t ALLOW 'cat .env.example'
t ALLOW 'cat .env.sample'
t ALLOW 'cat .envrc'
t ALLOW 'cat foo.envy'
t ALLOW 'rm .env'
t ALLOW 'ls -la .env'
t BLOCK 'cat ~/.ssh/id_rsa'
t BLOCK 'cat id_ed25519'
t ALLOW 'cat ~/.ssh/id_rsa.pub'
t BLOCK 'cat server.pem'
t BLOCK 'awk 1 ~/.aws/credentials'
t BLOCK 'cat ~/.netrc'
t BLOCK 'cat ~/.pi/agent/auth.json'
t ALLOW 'cat README.md'
t ALLOW 'echo .env'

echo "== layering: fail-safe, disable, override =="
TMP_UNKNOWN="$(mktemp /tmp/tp-layer-unknown.XXXXXX.json)"
TMP_DISABLE="$(mktemp /tmp/tp-layer-disable.XXXXXX.json)"
TMP_OVERRIDE="$(mktemp /tmp/tp-layer-override.XXXXXX.json)"
trap 'rm -f "$TMP_UNKNOWN" "$TMP_DISABLE" "$TMP_OVERRIDE"' EXIT
cat > "$TMP_UNKNOWN" <<'EOF'
{"rules": [{"id": "needs-site-matcher", "command": "rg", "targets_frobnicator": true, "reason": "must never fire on the bare engine"}]}
EOF
cat > "$TMP_DISABLE" <<'EOF'
{"rules": [], "disable_rules": ["no-interactive-pager-less"]}
EOF
cat > "$TMP_OVERRIDE" <<'EOF'
{"rules": [{"id": "no-interactive-editor-vim", "command": "vim", "severity": "warn", "reason": "downgraded to warn by override layer"}]}
EOF
LAYERS="$RULES:$TMP_UNKNOWN" t ALLOW 'rg foo /tmp'
LAYERS="$RULES:$TMP_DISABLE" t ALLOW 'less /etc/hosts'
LAYERS="$RULES:$TMP_DISABLE" t BLOCK 'vim x'
LAYERS="$RULES:$TMP_OVERRIDE" t ALLOW 'vim x'

echo "== lint =="
if BASHGUARD_RULES="$RULES" "$DIR/cc-hook.sh" --lint | grep -q '^OK$'; then
  echo "PASS [lint] $RULES"
else
  echo "FAIL [lint] $RULES"
  FAILURES=$((FAILURES + 1))
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "all tests passed"
else
  echo "$FAILURES test(s) FAILED"
  exit 1
fi
