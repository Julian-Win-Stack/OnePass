#!/bin/sh
# Prepares one side of a pair: a readable copy of a finished repo, and that repo's change as a
# unified diff. Both go in the corpus, never in this repository.
#
#   prepare.sh <finished-repo> <dest-repo> <dest-diff>
#
# The copy exists because the grader must not see the source path: a directory called
# `mastra-head1` beside one called `mastra-control2` says which side is which before a line has
# been read. The caller gives the copy an opaque name.
#
# The copy holds what git can see — tracked files, plus untracked files git does not ignore —
# and nothing else. Ignored content is `node_modules`, build output (`dist`, `.turbo`, generated
# `.d.ts`) and the harness's own leftovers, none of which is the arm's change, all of which
# differs between arms for reasons no reviewer should be reading. `.git` goes too: a worktree's
# `.git` file names the worktree it came from.
#
# GRADE_DIFF_CMD names a script printing the change on stdout, given the finished repo and the
# copy. The default is plain `git diff $GRADE_BASE`; a set of repos that needs corrections
# supplies its own (see step1-diff.sh, and the README on why Step 1 needs one).
set -u

SRC=${1:?usage: prepare.sh <finished-repo> <dest-repo> <dest-diff>}
DEST=${2:?}
DIFF=${3:?}
BASE=${GRADE_BASE:-a14c2436bc}
DIFF_CMD=${GRADE_DIFF_CMD:-}

[ -d "$SRC" ] || { echo "no such repo: $SRC" >&2; exit 41; }

mkdir -p "$(dirname "$DEST")" "$(dirname "$DIFF")" || exit 42
rm -rf "$DEST"
mkdir -p "$DEST" || exit 42
{ git -C "$SRC" ls-files; git -C "$SRC" ls-files --others --exclude-standard; } |
  rsync -a --files-from=- "$SRC/" "$DEST/" || exit 43

if [ -n "$DIFF_CMD" ]; then
  $DIFF_CMD "$SRC" "$DEST" > "$DIFF" || exit 44
else
  git -C "$SRC" diff "$BASE" > "$DIFF" || exit 44
fi

# The grader is told the copy is the base commit plus the diff. Make that true rather than hope
# it is: lay the base tree down, apply the diff to it, and compare against the copy.
CHECK=$(mktemp -d) || exit 45
git -C "$SRC" archive "$BASE" | ( cd "$CHECK" && tar x ) || { rm -rf "$CHECK"; exit 46; }
( cd "$CHECK" && git apply --whitespace=nowarn "$DIFF" ) || { rm -rf "$CHECK"; exit 47; }
if diff -r -q "$CHECK" "$DEST" > "$DIFF.mismatch" 2>&1; then
  rm -f "$DIFF.mismatch"
  rm -rf "$CHECK"
  echo "prepared $DEST ($(grep -c '^diff --git' "$DIFF") files) — copy == base + diff"
else
  rm -rf "$CHECK"
  echo "prepared $DEST — MISMATCH, see $DIFF.mismatch" >&2
  exit 48
fi
