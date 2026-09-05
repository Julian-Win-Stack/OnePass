#!/bin/sh
# One arm of the A/B: a mastra worktree at a fixed commit, implemented end to end by a single
# non-interactive `claude -p`, routed through the eviction proxy unless --no-proxy is given.
#
# Everything except that routing is held identical between arms — same base commit, same plan
# file, same model, effort, permission mode, tool allowlist, and a byte-identical prompt — so
# the proxy is the only variable. Changing any of it invalidates comparisons with earlier runs.
set -u

ARM=${1:?usage: run.sh <arm> [--no-proxy]   e.g. run.sh run5, run.sh control --no-proxy}
PROXY_FLAG=${2:-}

MASTRA=${MASTRA_REPO:?set MASTRA_REPO to a mastra clone, e.g. ~/Project/mastra}
EVAL_DIR=${ONEPASS_EVAL_DIR:-/tmp/onepass-eval}
BASE_URL=${ONEPASS_BASE_URL:-http://localhost:3777}

# The commit both arms start from. The human fix they are scored against is faee052a3c;
# score.sh takes the ground-truth tests from there.
BASE_COMMIT=a14c2436bc
PLAN=$(cd "$(dirname "$0")" && pwd)/task/witty-singing-puzzle.md

WT=$EVAL_DIR/mastra-$ARM
mkdir -p "$EVAL_DIR"

rm -rf "$WT"
git -C "$MASTRA" worktree prune
git -C "$MASTRA" worktree add --detach "$WT" "$BASE_COMMIT" >/dev/null 2>&1 || exit 11
mkdir -p "$WT/.claude/plans"
cp "$PLAN" "$WT/.claude/plans/" || exit 12
echo "worktree ready at $(git -C "$WT" rev-parse --short HEAD)"

cd "$WT" || exit 13
pnpm install --silent >/dev/null 2>&1 || echo "pnpm install returned $?"

SID=$(uuidgen | tr 'A-Z' 'a-z')
echo "$SID" > "$EVAL_DIR/$ARM.sid"
date -u +%Y-%m-%dT%H:%M:%SZ > "$EVAL_DIR/$ARM.start"
echo "session: $SID"

# `env` with no assignments is a no-op, so the control arm differs from a proxied one by this
# prefix alone. The assume-first-party flag keeps opus[1m] at its native 1M window: Claude Code
# caps native-1M models at 200k behind a host that is not api.anthropic.com.
if [ "$PROXY_FLAG" = "--no-proxy" ]; then
  set -- env
else
  set -- env "ANTHROPIC_BASE_URL=$BASE_URL" "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1"
fi

"$@" claude -p --model 'opus[1m]' --effort xhigh --output-format json \
  --permission-mode acceptEdits \
  --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash(pnpm:*)" "Bash(git diff:*)" "Bash(git status:*)" "Bash(ls:*)" "Bash(cat:*)" "mcp__onepass__recall_search" "mcp__onepass__recall_get" \
  --session-id "$SID" \
  "Implement the plan in .claude/plans/witty-singing-puzzle.md end to end. Do not ask questions: where the plan leaves a choice, pick the option its rationale supports and list those choices in your final message. Run the affected unit tests with pnpm before you finish. Do not commit." \
  > "$EVAL_DIR/$ARM.out" 2> "$EVAL_DIR/$ARM.err"
echo "EXIT=$?"
date -u +%Y-%m-%dT%H:%M:%SZ > "$EVAL_DIR/$ARM.end"
