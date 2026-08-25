#!/bin/bash
# Build one arm. ARM is K<n> (keyword MCP) or L<n> (librarian subagent).
set -euo pipefail
H="${ONEPASS_HARNESS_DIR:-/tmp/onepass-harness}"
mkdir -p "$H"
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARM="$1"; KIND="${ARM:0:1}"
WORK="$H/arm-$ARM"
rm -rf "$WORK"; mkdir -p "$WORK/.claude/agents"

MODULES=(auth session codec router cache queue retry backoff tracing metrics logger config
         schema parser encoder decoder stream socket handshake registry resolver dispatch
         throttle limiter buffer pipeline adapter bridge proxy relay shard replica ledger
         digest signer verifier vault rotate audit sweep)
: > "$WORK/build-manifest.txt"
echo "module                build-hash        size    status" >> "$WORK/build-manifest.txt"
for m in "${MODULES[@]}"; do
  HASH=$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n' | tr 'a-f' 'A-F')
  printf "%-20s  %-16s  %5d   ok\n" "$m" "$HASH" $((RANDOM % 9000 + 1000)) >> "$WORK/build-manifest.txt"
  [ "$m" = "throttle" ] && echo "$HASH" > "$H/arm-$ARM.needle"
done

# Bulk to overflow the 100k window. Few large files, not many small ones: the cost of
# filling context is model round-trips, not tokens, so 4 reads beats 42.
python3 - "$WORK" <<'PY'
import random, sys
work = sys.argv[1]
random.seed(hash(work) % 10**8)
verbs = ["accepted","rejected","queued","flushed","retried","expired","promoted","evicted","sealed","rotated"]
nouns = ["connection","segment","checkpoint","envelope","partition","lease","token","batch","frame","digest"]
for f in range(1, 5):
    with open(f"{work}/trace-{f}.log", "w") as out:
        for line in range(1000):
            parts = [f"{random.choice(nouns)}-{random.randint(1000,9999)} {random.choice(verbs)}"
                     for _ in range(9)]
            out.write(f"[trace-{f}:{line:04d}] " + " | ".join(parts) + "\n")
PY

SID=$(uuidgen | tr 'A-Z' 'a-z'); echo "$SID" > "$H/arm-$ARM.sid"
SLUG=$(node -e 'console.log(process.argv[1].replace(/[/.]/g,"-"))' "$WORK")
echo "$HOME/.claude/projects/$SLUG/$SID.jsonl" > "$H/arm-$ARM.transcript"
TRANSCRIPT=$(cat "$H/arm-$ARM.transcript")

if [ "$KIND" = "L" ]; then
  sed "s|__TRANSCRIPT__|$TRANSCRIPT|" "$SPIKE_DIR/librarian.md" \
    > "$WORK/.claude/agents/librarian.md"
fi

echo '{ "mcpServers": {} }' > "$H/mcp-none.json"
echo '{ "mcpServers": { "onepass": { "command": "node", "args": ["'"$SPIKE_DIR"'/dist/server.js"] } } }' > "$H/mcp-keyword.json"
echo "ready: $ARM  $(du -sh "$WORK" | cut -f1)  sid=$SID"
