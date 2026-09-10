#!/bin/sh
# One grader call: shows two prepared repos and their two diffs to a non-interactive Claude Code
# and asks the one comparative question.
#
#   run.sh <call-dir> <plan> <A-repo> <A-diff> <B-repo> <B-diff>
#
# The call runs *in* <call-dir>, which holds nothing but plan.md, A.diff, B.diff and QUESTION.md,
# so no .mcp.json, settings file or CLAUDE.md from any project above it is in scope. --safe-mode
# takes out the rest: the user's own CLAUDE.md, skills, plugins, hooks and MCP servers, none of
# which the grader should be reading. Auth is untouched, so this is the subscription Claude Code
# is logged into, as required.
#
# --setting-sources "" is there because --safe-mode is not enough on 2.1.265: measured, a first
# call under --safe-mode alone still carried the user's `outputStyle` from ~/.claude/settings.json
# into the session as an output_style_instructions attachment — "keep your responses short and
# direct", to a grader asked for reasons at length. With no setting sources the attachment is
# gone and auth still works.
#
# Read, Grep and Glob and nothing else — --tools removes every other built-in from the session,
# --allowedTools lets those three run without a prompt, and --permission-prompts none denies
# anything that would have asked instead of hanging. The grader cannot run tests and is told not
# to want to; correctness is measured elsewhere.
#
# Every call goes through cleanenv.sh, or it inherits the launching session's ANTHROPIC_BASE_URL
# and grades through the very proxy under test.
set -u

DIR=${1:?usage: run.sh <call-dir> <plan> <A-repo> <A-diff> <B-repo> <B-diff>}
PLAN=${2:?}
AREPO=${3:?}
ADIFF=${4:?}
BREPO=${5:?}
BDIFF=${6:?}

HERE=$(cd "$(dirname "$0")" && pwd)
CLEAN=${GRADE_CLEANENV:-$HOME/onepass-corpus/ab/cleanenv.sh}
MODEL=${GRADE_MODEL:-opus}
EFFORT=${GRADE_EFFORT:-max}
LIMIT=${GRADE_TIMEOUT:-3600}

mkdir -p "$DIR" || exit 61
cp "$PLAN"  "$DIR/plan.md" || exit 62
cp "$ADIFF" "$DIR/A.diff"  || exit 63
cp "$BDIFF" "$DIR/B.diff"  || exit 64
sed -e "s|@A_PATH@|$AREPO|" -e "s|@B_PATH@|$BREPO|" "$HERE/QUESTION.md" > "$DIR/QUESTION.md" || exit 65

# The one thing that can silently unblind the grader: a name in what it is shown. The paths are
# opaque by construction, so this is a check on the diffs and the plan.
if grep -q -i -E 'onepass|mastra-(head|control)|/Users/' "$DIR/A.diff" "$DIR/B.diff"; then
  echo "refusing: A.diff or B.diff names the harness" >&2; exit 66
fi

SID=$(uuidgen | tr 'A-Z' 'a-z')
echo "$SID" > "$DIR/sid"
date -u +%Y-%m-%dT%H:%M:%SZ > "$DIR/start"

( cd "$DIR" && "$CLEAN" claude -p \
    --model "$MODEL" --effort "$EFFORT" \
    --safe-mode \
    --setting-sources "" \
    --tools "Read" "Grep" "Glob" \
    --allowedTools "Read" "Grep" "Glob" \
    --permission-prompts none \
    --add-dir "$AREPO" --add-dir "$BREPO" \
    --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    --session-id "$SID" \
    --output-format json \
    < "$DIR/QUESTION.md" > "$DIR/call.out" 2> "$DIR/call.err" ) &
CHILD=$!

# No `timeout(1)` on macOS. A watchdog that goes away with the call it was watching.
( sleep "$LIMIT"; kill -0 "$CHILD" 2>/dev/null && { echo "timed out after ${LIMIT}s" >> "$DIR/call.err"; kill -TERM "$CHILD" 2>/dev/null; } ) &
WATCH=$!
wait "$CHILD"; RC=$?
kill "$WATCH" 2>/dev/null

date -u +%Y-%m-%dT%H:%M:%SZ > "$DIR/end"
echo "$RC" > "$DIR/rc"
echo "$(basename "$(dirname "$DIR")")/$(basename "$DIR") exit=$RC $(sed -n 's/.*"total_cost_usd":\([0-9.]*\).*/$\1/p' "$DIR/call.out" 2>/dev/null | head -1)"
exit "$RC"
