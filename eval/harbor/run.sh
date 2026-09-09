#!/usr/bin/env bash
# Run one arm of the Onepass A/B on Terminal-Bench 2.0 through Harbor.
#
#   ./run.sh smoke                    # 1 task, proxied only — does the proxy trip at all?
#   ./run.sh first-pass proxied       # 20 tasks x 1 trial
#   ./run.sh first-pass control
#   ./run.sh full proxied             # the same 20 tasks x 3 trials
#   ./run.sh full control
#
# Everything the two arms share is set once, below, so the only difference between them is which
# agent class runs. See README.md for what each knob is and why.
#
# Credentials come from the environment or from eval/harbor/.env (gitignored, never committed):
#   CLAUDE_CODE_OAUTH_TOKEN   from `claude setup-token` on your own machine
#   DAYTONA_API_KEY           (or the key for whatever ONEPASS_HARBOR_ENV names)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

# ---------------------------------------------------------------------------- shared settings
MODEL="${ONEPASS_MODEL:-claude-opus-5}"
DATASET="${ONEPASS_DATASET:-terminal-bench@2.0}"
# Where trials run. `docker` uses the local daemon; a cloud provider keeps them off this machine.
HARBOR_ENV="${ONEPASS_HARBOR_ENV:-daytona}"
N_CONCURRENT="${ONEPASS_N_CONCURRENT:-4}"
# A stress dose. The shipped default is 110,000, and Terminal-Bench tasks mostly stay under it,
# where the proxy is inert and the two arms would be identical by construction.
TRIP_TOKENS="${ONEPASS_TRIP_TOKENS:-30000}"
# Pin the CLI so both arms run the same Claude Code. Empty means "whatever Harbor installs";
# the run then records the version it got, and both arms still resolve it on the same day.
CLAUDE_VERSION="${ONEPASS_CLAUDE_VERSION:-}"
JOBS_DIR="${ONEPASS_JOBS_DIR:-$HOME/onepass-corpus/harbor/jobs}"
# Which task list a first-pass/full run uses. The default is the full committed set. The run is
# normally done in batches, one batch per rate-limit window (see README, "Running it in batches"),
# and each batch names its own file here. Both arms of a batch must use the same file.
TASKS_FILE="${ONEPASS_TASKS_FILE:-$HERE/tasks.txt}"
# Keep every request body the proxy is handed, for replay (eval/src/replay.ts reads exactly this).
# The proxy writes them pre-eviction and untouched, so a replay sees what the session really sent —
# a body rebuilt from a transcript does not, because Claude Code stores its injected content as
# records of its own rather than as the text it renders them into. Bodies are the session in the
# clear: they land under the scratch dir and must never be committed. Proxied arm only.
CAPTURE_BODIES="${ONEPASS_CAPTURE_BODIES:-0}"
# The proxied arm builds proxy/ from this repo inside each container. Pin the commit so a rerun
# builds the same proxy; the default is this checkout's HEAD.
ONEPASS_REF="${ONEPASS_REF:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
ONEPASS_REPO_URL="${ONEPASS_REPO_URL:-https://github.com/Julian-Win-Stack/OnePass.git}"
# The clone+build adds a couple of minutes to agent setup; the default cap is 360s.
SETUP_MULTIPLIER="${ONEPASS_SETUP_MULTIPLIER:-3}"

if [[ -f "$HERE/.env" ]]; then
  set -a; . "$HERE/.env"; set +a
fi

# Environment hygiene. Harbor's claude-code agent reads these from whatever shell launches it and
# forwards them into the container, so a value inherited from the operator's own Claude Code
# session would silently reconfigure the run:
#   ANTHROPIC_BASE_URL   would become the control arm's base URL, and could point anywhere.
#   ANTHROPIC_API_KEY /
#   ANTHROPIC_AUTH_TOKEN would bill an API key instead of the subscription this run is measured on.
#   CLAUDE_CODE_GZIP_REQUEST_BODIES  makes the client gzip /v1/messages bodies, which the proxy
#                                    forwards untouched by design — eviction would do nothing at
#                                    all, quietly (docs/findings.md, "Known Claude Code
#                                    interactions"). This is the one that fails silently.
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_GZIP_REQUEST_BODIES

if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "run.sh: CLAUDE_CODE_OAUTH_TOKEN is not set (env or $HERE/.env)." >&2
  echo "        Get one with \`claude setup-token\` on the machine you are logged in on." >&2
  exit 2
fi

command -v harbor >/dev/null 2>&1 || {
  echo "run.sh: harbor is not on PATH. See README.md for the pinned install." >&2
  exit 2
}

MODE="${1:-}"
ARM="${2:-proxied}"
case "$MODE" in
  smoke|first-pass|full) ;;
  *) echo "usage: $0 {smoke|first-pass|full} [proxied|control]" >&2; exit 2 ;;
esac
case "$ARM" in proxied|control) ;; *) echo "arm must be proxied or control" >&2; exit 2 ;; esac

# ---------------------------------------------------------------------------- task / trial set
declare -a TASK_FLAGS=()
case "$MODE" in
  smoke)
    ARM="proxied"
    N_ATTEMPTS=1
    # One task with a long agent budget and no heavyweight image build, so the question the smoke
    # run answers is "does the proxy trip", not "does this image pull".
    TASK_FLAGS+=(-i "${ONEPASS_SMOKE_TASK:-path-tracing}")
    ;;
  first-pass) N_ATTEMPTS=1 ;;
  full)       N_ATTEMPTS=3 ;;
esac
if [[ "$MODE" != "smoke" ]]; then
  [[ -f "$TASKS_FILE" ]] || { echo "run.sh: no such task file: $TASKS_FILE" >&2; exit 2; }
  while read -r task; do
    [[ -z "$task" || "$task" == \#* ]] && continue
    TASK_FLAGS+=(-i "$task")
  done < "$TASKS_FILE"
fi

BATCH_TAG=""
if [[ "$MODE" != "smoke" && "$TASKS_FILE" != "$HERE/tasks.txt" ]]; then
  BATCH_TAG="-$(basename "$TASKS_FILE" .txt)"
fi
JOB_NAME="${ONEPASS_JOB_NAME:-onepass-$MODE$BATCH_TAG-$ARM-$(date -u +%Y%m%dT%H%M%SZ)}"

# ---------------------------------------------------------------------------- the two arms
declare -a AGENT_FLAGS=()
if [[ "$ARM" == "proxied" ]]; then
  export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"
  AGENT_FLAGS+=(--agent "onepass_agent:OnepassClaudeCode")
  AGENT_FLAGS+=(--ak "onepass_repo_url=$ONEPASS_REPO_URL")
  AGENT_FLAGS+=(--ak "onepass_ref=$ONEPASS_REF")
  AGENT_FLAGS+=(--ak "onepass_trip_tokens=$TRIP_TOKENS")
  case "$CAPTURE_BODIES" in
    1|true|yes|on) AGENT_FLAGS+=(--ak "onepass_capture_bodies=true") ;;
    0|false|no|off|"") ;;
    *) echo "run.sh: ONEPASS_CAPTURE_BODIES must be a boolean, got: $CAPTURE_BODIES" >&2; exit 2 ;;
  esac
else
  AGENT_FLAGS+=(--agent claude-code)
fi
if [[ -n "$CLAUDE_VERSION" ]]; then
  AGENT_FLAGS+=(--ak "version=$CLAUDE_VERSION")
fi

# The OAuth token is deliberately NOT passed with --ae: that would put it on the command line,
# where `ps` and this script's own trace can read it. Harbor's claude-code agent already reads
# CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_FORCE_OAUTH from its own environment and forwards them into
# the container itself, so exporting them here is both sufficient and safer.
export CLAUDE_CODE_OAUTH_TOKEN
export CLAUDE_FORCE_OAUTH=1

# Both arms get the same model-routing environment. The proxied arm's `run()` sets these tier
# aliases itself whenever ANTHROPIC_BASE_URL is set (that is Harbor's stock behaviour, not ours);
# passing them to the control too is what keeps the two arms identical on model routing rather
# than leaving the control free to reach for a different tier on side calls.
declare -a SHARED_ENV=(
  --ae "ANTHROPIC_DEFAULT_OPUS_MODEL=$MODEL"
  --ae "ANTHROPIC_DEFAULT_SONNET_MODEL=$MODEL"
  --ae "ANTHROPIC_DEFAULT_HAIKU_MODEL=$MODEL"
  --ae "CLAUDE_CODE_SUBAGENT_MODEL=$MODEL"
)

mkdir -p "$JOBS_DIR"

echo "arm=$ARM  mode=$MODE  model=$MODEL  env=$HARBOR_ENV  trip=$TRIP_TOKENS  job=$JOB_NAME"
if [[ "$ARM" == "proxied" ]]; then
  case "$CAPTURE_BODIES" in
    1|true|yes|on) echo "capture: request bodies -> <trial>/agent/onepass/bodies/ (replay corpus)" ;;
  esac
fi
if [[ "$MODE" != "smoke" ]]; then
  echo "tasks: $TASKS_FILE ($(( ${#TASK_FLAGS[@]} / 2 )) tasks)"
fi
harbor run \
  --dataset "$DATASET" \
  "${TASK_FLAGS[@]}" \
  "${AGENT_FLAGS[@]}" \
  --model "$MODEL" \
  "${SHARED_ENV[@]}" \
  --env "$HARBOR_ENV" \
  --n-concurrent "$N_CONCURRENT" \
  --n-attempts "$N_ATTEMPTS" \
  --agent-setup-timeout-multiplier "$SETUP_MULTIPLIER" \
  --jobs-dir "$JOBS_DIR" \
  --job-name "$JOB_NAME" \
  --yes \
  "${@:3}"

echo
echo "job: $JOBS_DIR/$JOB_NAME"
echo "report both arms with:  python3 $HERE/report.py --proxied <dir> --control <dir>"
