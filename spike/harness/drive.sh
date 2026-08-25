#!/bin/bash
set -uo pipefail
H="${ONEPASS_HARNESS_DIR:-/tmp/onepass-harness}"
mkdir -p "$H"
ARM="$1"; KIND="${ARM:0:1}"
WORK="$H/arm-$ARM"; SID=$(cat "$H/arm-$ARM.sid")
OUT="$H/arm-$ARM.out"; : > "$OUT"
ERR="$H/arm-$ARM.err"; : > "$ERR"
PROG="$H/arm-$ARM.progress"; : > "$PROG"

COMMON=(--print --output-format json --model opus --autocompact 100000
        --add-dir "$HOME/.claude/projects")
if [ "$KIND" = "K" ]; then
  COMMON+=(--mcp-config "$H/mcp-keyword.json" --strict-mcp-config
           --tools "Read,Glob,Grep"
           --allowedTools "Read" "Glob" "Grep" "mcp__onepass__recall_search" "mcp__onepass__recall_get")
  PROBE="Use the recall_search and recall_get tools to find the build-hash for the 'throttle' module in that manifest. I need the exact value."
else
  COMMON+=(--mcp-config "$H/mcp-none.json" --strict-mcp-config
           --tools "Read,Glob,Grep,Agent"
           --allowedTools "Read" "Glob" "Grep" "Agent")
  PROBE="Use the librarian subagent to find the build-hash for the 'throttle' module in that manifest. I need the exact value."
fi

turn() {
  local prompt="$1" first="$2" started ended rc
  echo "=== TURN: ${prompt:0:70}" >> "$OUT"
  started=$(date +%s)
  if [ "$first" = first ]; then
    ( cd "$WORK" && claude "${COMMON[@]}" --session-id "$SID" "$prompt" ) >> "$OUT" 2>>"$ERR" < /dev/null
  else
    ( cd "$WORK" && claude "${COMMON[@]}" --resume "$SID" "$prompt" ) >> "$OUT" 2>>"$ERR" < /dev/null
  fi
  rc=$?; ended=$(date +%s)
  echo "[$ARM] rc=$rc $((ended - started))s :: ${prompt:0:55}" >> "$PROG"
  echo "" >> "$OUT"
}

turn "Read build-manifest.txt and tell me how many modules built ok." first
rm -f "$WORK/build-manifest.txt"
turn "Use the Read tool to read all of trace-1.log and trace-2.log in full — do not grep, do not sample. When both are read, reply with just the word DONE." resume
turn "Use the Read tool to read all of trace-3.log and trace-4.log in full — do not grep, do not sample. When both are read, reply with just the word DONE." resume
turn "$PROBE" resume
echo "[$ARM] DONE" >> "$PROG"
