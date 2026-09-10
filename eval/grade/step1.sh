#!/bin/sh
# Step 1's driver: turns arms.tsv and pairs.tsv into sixteen grader calls under
# $GRADE_DIR/<pair>/<ordering>. Nothing it writes goes in this repository.
#
#   ./step1.sh prepare          copy the five finished repos to opaque names, build their diffs
#   ./step1.sh run [pair ...]   run the calls, four at a time; default is all eight pairs
#
# Ordering 1 shows the arm pairs.tsv drew as A; ordering 2 swaps them. Both always run: one
# verdict is a preference plus whatever position bias the grader has, and only the pair of them
# separates the two.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
MATERIAL=${GRADE_MATERIAL:-$HOME/onepass-corpus/ab}
DIR=${GRADE_DIR:-$HOME/onepass-corpus/grade}
PLAN=${GRADE_PLAN:-$HERE/../task/witty-singing-puzzle.md}
JOBS=${GRADE_JOBS:-4}
CMD=${1:?usage: step1.sh prepare | run [pair ...]}
shift

token() { awk -F'\t' -v a="$1" '$1==a {print $2}' "$HERE/arms.tsv"; }

case $CMD in
prepare)
  GRADE_DIFF_CMD="sh $HERE/step1-diff.sh"; export GRADE_DIFF_CMD
  grep -v '^#' "$HERE/arms.tsv" | while IFS="$(printf '\t')" read -r arm tok repo; do
    [ -n "${arm:-}" ] || continue
    sh "$HERE/prepare.sh" "$MATERIAL/$repo" "$DIR/repos/$tok" "$DIR/diffs/$tok.diff" || exit 71
  done
  ;;
run)
  WANT=$*
  TMP=$(mktemp) || exit 73
  grep -v '^#' "$HERE/pairs.tsv" | grep -v '^[[:space:]]*$' > "$TMP"
  n=0
  while IFS="$(printf '\t')" read -r pair kind a b; do
    if [ -n "$WANT" ]; then
      case " $WANT " in *" $pair "*) ;; *) continue ;; esac
    fi
    ta=$(token "$a"); tb=$(token "$b")
    [ -n "$ta" ] && [ -n "$tb" ] || { echo "no token for $a/$b" >&2; exit 72; }
    for ord in 1 2; do
      if [ "$ord" = 1 ]; then x=$ta; y=$tb; else x=$tb; y=$ta; fi
      d=$DIR/$pair/$ord
      if [ -f "$d/call.out" ]; then echo "skip $pair/$ord (already run)"; continue; fi
      echo "start $pair/$ord  A=$x B=$y"
      sh "$HERE/run.sh" "$d" "$PLAN" \
         "$DIR/repos/$x" "$DIR/diffs/$x.diff" \
         "$DIR/repos/$y" "$DIR/diffs/$y.diff" >> "$DIR/run.log" 2>&1 &
      n=$((n + 1))
      if [ $((n % JOBS)) -eq 0 ]; then wait; fi
    done
  done < "$TMP"
  wait
  rm -f "$TMP"
  echo "all calls done; see $DIR/run.log"
  ;;
*) echo "usage: step1.sh prepare | run [pair ...]" >&2; exit 70 ;;
esac
