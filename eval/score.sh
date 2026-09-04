#!/bin/sh
# Scores one arm against ground truth: overwrites whatever tests the agent wrote with the two
# test files from the real human fix, then runs them. The agent cannot game a test it never saw.
#
# Its own tests are saved to $EVAL_DIR/<arm>-tests/ first, since staging destroys them.
set -u

ARM=${1:?usage: score.sh <arm>   e.g. score.sh run5}

MASTRA=${MASTRA_REPO:?set MASTRA_REPO to a mastra clone, e.g. ~/Project/mastra}
EVAL_DIR=${ONEPASS_EVAL_DIR:-/tmp/onepass-eval}

# The human fix for #18877. Its tests are the ground truth; 65 assertions across the two files.
GROUND_TRUTH=faee052a3c
CORE=packages/core/src/channels/__tests__/state-adapter.test.ts
CONVEX=stores/convex/src/server/index-map.test.ts

WT=$EVAL_DIR/mastra-$ARM
SAVED=$EVAL_DIR/$ARM-tests

mkdir -p "$SAVED/core" "$SAVED/convex"
[ -f "$WT/$CORE" ]   && cp "$WT/$CORE"   "$SAVED/core/"   || echo "agent wrote no $CORE"
[ -f "$WT/$CONVEX" ] && cp "$WT/$CONVEX" "$SAVED/convex/" || echo "agent wrote no $CONVEX"

git -C "$MASTRA" show "$GROUND_TRUTH:$CORE"   > "$WT/$CORE"   || exit 21
git -C "$MASTRA" show "$GROUND_TRUTH:$CONVEX" > "$WT/$CONVEX" || exit 22
echo "ground-truth tests staged"

cd "$WT/packages/core" && pnpm vitest run src/channels/__tests__/state-adapter.test.ts 2>&1 | tail -25
echo "===== convex ====="
cd "$WT/stores/convex" && pnpm vitest run src/server/index-map.test.ts 2>&1 | tail -25
