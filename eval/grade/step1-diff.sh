#!/bin/sh
# Step 1's GRADE_DIFF_CMD: prints one arm's change on stdout, and puts the copy prepare.sh made
# into the state that change describes.
#
#   step1-diff.sh <finished-repo> <prepared-copy>
#
# Plain `git diff $BASE` is wrong for these five worktrees, for three reasons. Each correction is
# applied to every arm identically, so no arm is shown more of its own work than another.
#
#  1. score.sh staged the *human's* ground-truth test files over the arm's own to score it. Left
#     in, every diff attributes 28KB of somebody else's tests to the arm and hands the grader the
#     hidden tests. Both paths come out of the mechanical diff.
#  2. score.sh saved the arm's own copies to <arm>-tests/ first — but it copies before it stages,
#     so a second run saves what the first run staged. A saved file equal to the ground truth is
#     the ground truth. state-adapter.test.ts is genuine for all five (five distinct hashes,
#     none equal to base or ground truth) and is spliced back in and restored on disk.
#     index-map.test.ts is not: one control's saved copy is byte-identical to the ground truth,
#     so it is unrecoverable there, and the path is dropped for all five rather than shown for
#     the two arms whose copies survived. On disk it is restored to the base version, which is
#     what "no change here" in the diff means.
#  3. The plan asks for changesets (Step 8) and the arms wrote them as untracked new files, which
#     `git diff` does not show. They are appended as new-file hunks.
#
# Read-only over <finished-repo>: nothing here writes to it or to its index.
set -u

REPO=${1:?usage: step1-diff.sh <finished-repo> <prepared-copy>}
COPY=${2:?}
BASE=${GRADE_BASE:-a14c2436bc}
ARM=$(basename "$REPO" | sed 's/^mastra-//')
TESTS=$(dirname "$REPO")/$ARM-tests

CORE=packages/core/src/channels/__tests__/state-adapter.test.ts
CONVEX=stores/convex/src/server/index-map.test.ts

[ -f "$TESTS/core/$(basename "$CORE")" ] || { echo "no saved core test for $ARM" >&2; exit 51; }

# Reason 2, on disk: the arm's own core test back, the convex test back to base.
cp "$TESTS/core/$(basename "$CORE")" "$COPY/$CORE" || exit 52
git -C "$REPO" show "$BASE:$CONVEX" > "$COPY/$CONVEX" || exit 53

# Reason 1: everything except the two staged paths.
git -C "$REPO" diff "$BASE" -- . ":(exclude)$CORE" ":(exclude)$CONVEX" || exit 54

# Reason 2, in the diff: base -> the arm's own core test.
T=$(mktemp -d) || exit 55
mkdir -p "$T/a/$(dirname "$CORE")" "$T/b/$(dirname "$CORE")"
git -C "$REPO" show "$BASE:$CORE" > "$T/a/$CORE" || { rm -rf "$T"; exit 56; }
cp "$TESTS/core/$(basename "$CORE")" "$T/b/$CORE" || { rm -rf "$T"; exit 57; }
( cd "$T" && git diff --no-index a b ) |
  sed -e 's|^diff --git a/a/|diff --git a/|' -e 's| b/b/| b/|' \
      -e 's|^--- a/a/|--- a/|' -e 's|^+++ b/b/|+++ b/|'
rm -rf "$T"

# Reason 3, sorted so the order is alphabetical rather than the filesystem's.
git -C "$REPO" ls-files --others --exclude-standard | sort | while read -r f; do
  ( cd "$REPO" && git diff --no-index /dev/null "$f" )
done
exit 0
