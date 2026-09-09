#!/bin/bash
# Records a real Claude Code session through the eviction proxy, and keeps every request body it
# sent. That recording is what replay reads.
#
# Why this exists. Replay used to rebuild each request from the session transcript, and the
# transcript does not hold what was sent: Claude Code writes attached files, task notifications and
# its other injections as records of its own, not as the text it renders them into. Three of the
# proxy's rules are keyed on that text, so no rebuilt body ever carried it — all three could be
# deleted and replay would still report every case identical. A session recorded through the proxy
# is missing nothing, because the proxy writes down exactly what it was handed.
#
# What it does: takes the prompts of the imported planning session, feeds them one at a time to a
# fresh session in the repo that session was about, with the proxy in front and its dump directory
# pointed at the corpus. The session is left to run naturally — if it compacts, it compacts, and
# the proxy sees the real requests on the other side of that.
#
# ============================ BILLING — READ THIS BEFORE EDITING ============================
# This session runs on the user's Claude subscription. It must never run on ANTHROPIC_API_KEY.
#
# The trap is silent: ANTHROPIC_API_KEY lives in this repository's .env, the documented way to run
# the eval is `set -a && . ./.env && set +a`, and any shell that has done that — or any process
# inheriting from one — makes Claude Code bill the key instead of the subscription, with no warning
# and no visible difference until the invoice. So the key is unset here and then *checked*, and the
# script refuses to start if either variable survived. Assert it; do not assume it.
# ===========================================================================================
set -uo pipefail

unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX

for billing in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX; do
  if [ -n "${!billing:-}" ]; then
    echo "record.sh: $billing survived being unset." >&2
    echo "           This session must bill the Claude subscription, never a key or another cloud." >&2
    exit 1
  fi
done

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

: "${ONEPASS_EVAL_CORPUS:?set ONEPASS_EVAL_CORPUS to the corpus directory, outside this repository}"
NAME=${ONEPASS_RECORDING_NAME:-planning}
# The name becomes two paths, one of which is removed with `rm -rf`. A name carrying a slash or a
# leading dot would put that somewhere nobody asked for, so it is checked here as well as in the
# eval — this script deletes things, and a check the deleting side does not make is not a check.
case "$NAME" in
  "" | */* | *\\* | .*)
    echo "record.sh: '$NAME' is not a name a recording can be filed under." >&2
    echo "           No slashes, no backslashes, no leading dot." >&2
    exit 1
    ;;
esac
SESSION=${ONEPASS_RECORDING_SESSION:-planning}
TARGET_REPO=${ONEPASS_RECORDING_REPO:-$HOME/Project/ProJect/chp99-takehome}
MODEL=${ONEPASS_RECORDING_MODEL:-opus}
EFFORT=${ONEPASS_RECORDING_EFFORT:-xhigh}
# Where the proxy writes every body it is handed. Straight into the corpus: these are the user's
# own session in the clear, which is exactly what that directory exists to keep out of git.
DUMP_DIR="$ONEPASS_EVAL_CORPUS/recordings/$NAME"
WORK_DIR="$ONEPASS_EVAL_CORPUS/recordings/$NAME.driver"

if [ ! -d "$TARGET_REPO" ]; then
  echo "record.sh: no repository at $TARGET_REPO." >&2
  echo "           The prompts are about that codebase; run them anywhere else and every file" >&2
  echo "           reference misses. Set ONEPASS_RECORDING_REPO to point at it." >&2
  exit 1
fi

# The session runs with permissions bypassed, because a driver nobody is watching cannot answer a
# prompt and a session that cannot run tools is not the deep session this is recording. That means
# it can change the repository it runs in, so it starts from a clean tree and says what commit it
# started at — `git reset --hard <that commit>` puts it back.
if [ -n "$(git -C "$TARGET_REPO" status --porcelain 2>/dev/null)" ]; then
  echo "record.sh: $TARGET_REPO has uncommitted changes." >&2
  echo "           The recorded session runs with permissions bypassed and can edit files there," >&2
  echo "           so it starts from a clean tree — commit or stash first." >&2
  exit 1
fi
START_COMMIT=$(git -C "$TARGET_REPO" rev-parse HEAD 2>/dev/null || echo "not a git repository")

# The unset above only reaches this shell. Claude Code reads settings files of its own, and an
# `env` block or an `apiKeyHelper` in one of them puts a key back inside the child where nothing
# here would ever see it. So the settings that would do it are read, and any of them refuses the run.
for settings in "$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json" \
                "$TARGET_REPO/.claude/settings.json" "$TARGET_REPO/.claude/settings.local.json"; do
  [ -f "$settings" ] || continue
  found=$(node -e '
    const settings = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const env = settings.env ?? {};
    const named = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]
      .filter((name) => env[name] !== undefined);
    if (settings.apiKeyHelper !== undefined) named.push("apiKeyHelper");
    console.log(named.join(", "));
  ' "$settings" 2>/dev/null)
  if [ -n "$found" ]; then
    echo "record.sh: $settings would give the session $found." >&2
    echo "           That reaches inside Claude Code, where unsetting a variable here cannot, and it" >&2
    echo "           would bill something other than the subscription. Remove it and run again." >&2
    exit 1
  fi
done


if [ -e "$DUMP_DIR" ] && [ -n "$(ls -A "$DUMP_DIR" 2>/dev/null)" ]; then
  echo "record.sh: $DUMP_DIR already holds a recording." >&2
  echo "           Two sessions dumped into one directory become one ordered sequence that never" >&2
  echo "           happened. Delete it, or set ONEPASS_RECORDING_NAME to another name." >&2
  exit 1
fi
# `set -e` is deliberately off — a single failed turn is not a failed recording — so the steps that
# must succeed say so one at a time.
mkdir -p "$DUMP_DIR" "$WORK_DIR" || { echo "record.sh: could not make $DUMP_DIR." >&2; exit 1; }

echo "[record] building the proxy (it runs dist/, not src/)"
(cd "$REPO_ROOT/proxy" && npm run build) >/dev/null || { echo "record.sh: the proxy did not build." >&2; exit 1; }
echo "[record] building the eval"
(cd "$REPO_ROOT/eval" && npm run build) >/dev/null || { echo "record.sh: the eval did not build." >&2; exit 1; }

PROMPT_DIR="$WORK_DIR/prompts"
rm -rf "$PROMPT_DIR" || { echo "record.sh: could not clear $PROMPT_DIR." >&2; exit 1; }
node "$REPO_ROOT/eval/dist/main.js" prompts "$PROMPT_DIR" --session "$SESSION" || exit 1
PROMPTS=("$PROMPT_DIR"/*.txt)
if [ ! -e "${PROMPTS[0]}" ]; then
  echo "record.sh: no prompts to feed." >&2
  exit 1
fi

# The proxy on a port the operating system picks, so this never collides with one already running.
# ONEPASS_JUDGE_API_KEY is cleared rather than left alone: a judge would put a second model in the
# path of every recorded request and its calls would be recorded too.
PROXY_LOG="$WORK_DIR/proxy.stdout"
env -u ONEPASS_JUDGE_API_KEY -u ANTHROPIC_BASE_URL \
  ONEPASS_PORT=0 ONEPASS_DUMP_DIR="$DUMP_DIR" \
  node "$REPO_ROOT/proxy/dist/main.js" >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null' EXIT INT TERM

# The judge line is the last of the proxy's banner, so waiting for that rather than for the port
# is what makes the check below read a finished banner. Waiting for the port and reading the judge
# line in the same breath would pass a proxy whose judge line had simply not been flushed yet.
for _ in $(seq 1 100); do
  grep -q "judge:" "$PROXY_LOG" && break
  sleep 0.1
done
PORT=$(sed -n 's|.*listening on http://localhost:\([0-9]*\).*|\1|p' "$PROXY_LOG" | head -1)
if [ -z "$PORT" ]; then
  echo "record.sh: the proxy did not report a port. Its output:" >&2
  cat "$PROXY_LOG" >&2
  exit 1
fi
if ! grep -q "judge: off" "$PROXY_LOG"; then
  echo "record.sh: the proxy did not say its judge was off. Refusing: a judge would put a second" >&2
  echo "           model in the path of every recorded request. Its output:" >&2
  cat "$PROXY_LOG" >&2
  exit 1
fi

SID=$(uuidgen | tr 'A-Z' 'a-z')
OUT="$WORK_DIR/session.out"
ERR="$WORK_DIR/session.err"
: > "$OUT" || { echo "record.sh: could not write $OUT." >&2; exit 1; }
: > "$ERR" || { echo "record.sh: could not write $ERR." >&2; exit 1; }

echo "[record] proxy on port $PORT, dumping to $DUMP_DIR"
echo "[record] session $SID in $TARGET_REPO at $START_COMMIT"
echo "[record] ${#PROMPTS[@]} prompts, $MODEL at $EFFORT, billing the Claude subscription"

# The assume-first-party flag is what keeps Claude Code on its subscription login behind a base URL
# that is not api.anthropic.com — and keeps a native-1M model at 1M rather than capped at 200k.
CLAUDE_ENV=(env "ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT" "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1")
COMMON=(--print --output-format json --model "$MODEL" --effort "$EFFORT" --permission-mode bypassPermissions)

position=0
for prompt in "${PROMPTS[@]}"; do
  position=$((position + 1))
  started=$(date +%s)
  echo "=== prompt $position/${#PROMPTS[@]}: $(head -c 70 "$prompt" | tr '\n' ' ')" >> "$OUT"
  if [ "$position" -eq 1 ]; then
    ( cd "$TARGET_REPO" && "${CLAUDE_ENV[@]}" claude "${COMMON[@]}" --session-id "$SID" ) \
      < "$prompt" >> "$OUT" 2>> "$ERR"
  else
    ( cd "$TARGET_REPO" && "${CLAUDE_ENV[@]}" claude "${COMMON[@]}" --resume "$SID" ) \
      < "$prompt" >> "$OUT" 2>> "$ERR"
  fi
  rc=$?
  echo "" >> "$OUT"
  echo "[record] $position/${#PROMPTS[@]} rc=$rc $(( $(date +%s) - started ))s  $(ls -1 "$DUMP_DIR" | wc -l | tr -d ' ') bodies so far"
  # A single failed turn is not a failed recording — an interrupted or refused turn still leaves
  # real requests behind, and the session carries on from where it got to. A run of failures is
  # different, and shows up as a body count that stops moving.
done

kill "$PROXY_PID" 2>/dev/null
wait "$PROXY_PID" 2>/dev/null
trap - EXIT INT TERM

echo "[record] $(ls -1 "$DUMP_DIR" | wc -l | tr -d ' ') bodies in $DUMP_DIR"
echo "[record] session output in $OUT"
echo "[record] $TARGET_REPO started at $START_COMMIT — 'git -C $TARGET_REPO reset --hard $START_COMMIT' undoes what the session changed"
echo
node "$REPO_ROOT/eval/dist/main.js" import-recordings "$DUMP_DIR" --name "$NAME"
