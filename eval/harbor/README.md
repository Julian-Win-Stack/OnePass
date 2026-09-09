# Onepass on Terminal-Bench 2.0, through Harbor

Step 1 of the eval (`eval/run.sh`, `eval/score.sh`, `eval/src`) is one task, scored against one
human fix. It answers "did quality hold on this task" and nothing about range. This directory is
the other half: the same proxy, twenty tasks, an existing public benchmark, and a test-based
score a stranger can check without reading our code.

The shape is the one every shipped peer used — OpenHands' condenser, Anthropic's context editing,
SWE-Pruner, TokenPilot: run a published benchmark twice, once with the mechanism and once without,
and report **success unchanged, tokens down**. [Harbor](https://harborframework.com) already does
the container-per-trial, install-the-real-CLI, run-it-N-times and score-it work, so none of that is
hand-built here.

**Picking this up to run it?** Start with [`HANDOFF-LOCAL.md`](HANDOFF-LOCAL.md) — the run plan,
the credentials, the smoke gate, and what is still unverified. This file is the reference for what
each knob is and why.

Nothing in `proxy/src` changes for this. Everything under `eval/harbor/` is packaging: how the
proxy gets into a trial container, how it is started, and how the two arms are read back.

## What runs

| | proxied arm | control arm |
|---|---|---|
| Harbor agent | `onepass_agent:OnepassClaudeCode` (subclass of Harbor's own `ClaudeCode`) | stock `claude-code` |
| CLI | the real Claude Code, installed by Harbor's own installer | the same |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:3777` — a proxy inside that one container | unset; the CLI's default |
| `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` | `1` | unset (not needed) |
| `ANTHROPIC_MODEL` | `claude-opus-5` | `claude-opus-5` |
| everything else | identical | identical |

**Model:** `claude-opus-5`, for both arms, via `--model claude-opus-5`. Deliberately without the
`anthropic/` prefix: Harbor's `_resolved_model_name()` returns the *prefixed* name whenever a base
URL is configured, so `--model anthropic/claude-opus-5` would put `anthropic/claude-opus-5` in the
proxied arm's `ANTHROPIC_MODEL` and a bare `claude-opus-5` in the control's. A bare name resolves
identically in both.

**Claude Code version:** whatever Harbor's installer resolves on the day of the run (2.1.266 at the
time of writing). Both arms install through the same code path in the same job window, and the
version each trial actually got is recorded in `results.json` under `agent_info.version` — the
report prints it. Pin it with `ONEPASS_CLAUDE_VERSION=2.1.266` to remove even that.

**Context window:** 1M in both arms. Claude Code decides the window client-side and caps a
natively-1M model at 200k behind a host that is not `api.anthropic.com`, so without
`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` the proxied arm would silently be running a different
benchmark from the control (`docs/findings.md` §11).

**Trip threshold: `ONEPASS_TRIP_TOKENS=30000` — a stress dose, not the shipped default.** The
proxy ships at 110,000 and Terminal-Bench tasks mostly stay under that, where the proxy never trips
and the two arms are identical by construction. 30k makes eviction fire on a normal task, which is
what this run is for. It is not the configuration anyone should use in a real session, and any
number quoted from this run has to carry that sentence with it.

**Judge: off.** `ONEPASS_JUDGE_API_KEY` is explicitly unset in the container. `docs/findings.md`
§17 measures it at 1.1% of what the rules remove, for ~$3.19 a session on a second key; leaving it
on would put another model's spend inside a benchmark number for a rounding error of eviction.

**Model routing is equalised across arms.** Harbor's stock `run()` pins the Sonnet/Opus/Haiku tier
aliases and the subagent model to the run's model *whenever `ANTHROPIC_BASE_URL` is set* — which is
true of the proxied arm and not of the control. `run.sh` therefore passes those four variables to
**both** arms with `--ae`, so the control cannot quietly reach for a different tier on a side call.

## The tasks

The 20 longest of the 89 tasks in `terminal-bench@2.0`, by the dataset's own metadata. Ranked by
`[agent] timeout_sec` (the binding constraint: a task capped at 900s cannot produce a long session
however hard it is), tie-broken by `[metadata] expert_time_estimate_min`, then by name. Committed
as [`tasks.txt`](tasks.txt); regenerate with:

```
python3 select_tasks.py --n 20 --out tasks.txt
```

Dataset commit at the time of selection: `terminal-bench@2.0` →
`laude-institute/terminal-bench-2` @ `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`.

| # | task | agent timeout | expert estimate | difficulty |
|---|---|---|---|---|
| 1 | build-pov-ray | 12000s | 60 min | medium |
| 2 | sam-cell-seg | 7200s | 600 min | hard |
| 3 | fix-ocaml-gc | 3600s | 1440 min | hard |
| 4 | regex-chess | 3600s | 1440 min | hard |
| 5 | circuit-fibsqrt | 3600s | 960 min | hard |
| 6 | bn-fit-modify | 3600s | 480 min | hard |
| 7 | video-processing | 3600s | 400 min | hard |
| 8 | install-windows-3.11 | 3600s | 300 min | hard |
| 9 | distribution-search | 3600s | 120 min | medium |
| 10 | portfolio-optimization | 3600s | 120 min | medium |
| 11 | winning-avg-corewars | 3600s | 60 min | medium |
| 12 | reshard-c4-data | 3600s | 30 min | medium |
| 13 | train-fasttext | 3600s | 30 min | hard |
| 14 | mteb-leaderboard | 3600s | 5 min | medium |
| 15 | schemelike-metacircular-eval | 2400s | 300 min | medium |
| 16 | compile-compcert | 2400s | 60 min | medium |
| 17 | feal-linear-cryptanalysis | 1800s | 960 min | hard |
| 18 | feal-differential-cryptanalysis | 1800s | 480 min | hard |
| 19 | make-mips-interpreter | 1800s | 480 min | hard |
| 20 | path-tracing | 1800s | 360 min | hard |

Worst case, if every task ran to its own timeout: **20.7 h of agent wall clock per arm per trial**.
Tasks normally finish well inside their cap, and `--n-concurrent` divides it, but that is the
budget shape to size a sitting against.

## Setup

Harbor needs Python ≥ 3.12. Pinned version, in a scratch venv outside the repo:

```
uv venv --python 3.12 ~/onepass-corpus/harbor/.venv
uv pip install --python ~/onepass-corpus/harbor/.venv/bin/python 'harbor==0.22.0' scipy numpy
export PATH="$HOME/onepass-corpus/harbor/.venv/bin:$PATH"
```

Credentials go in `eval/harbor/.env`, which is gitignored and must never be committed:

```
CLAUDE_CODE_OAUTH_TOKEN=...    # from `claude setup-token` on your own machine
DAYTONA_API_KEY=...            # or the key for whatever ONEPASS_HARBOR_ENV names
```

The OAuth token is never passed on a command line — `run.sh` exports it and Harbor's agent reads it
from its own environment — so it stays out of `ps` and out of every log. `run.sh` also unsets
`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_GZIP_REQUEST_BODIES` before calling Harbor: all four are read from the launching shell
and forwarded into the container, and the last one would make the client gzip its request bodies,
which the proxy forwards untouched — eviction would do nothing at all, silently.

## Running it

```
# 1. smoke: one task, proxied only. Does the proxy trip, and does context stay under the line?
./run.sh smoke

# 2. first pass: 20 tasks x 1 trial x 2 arms
./run.sh first-pass proxied
./run.sh first-pass control

# 3. full: the same 20 tasks x 3 trials x 2 arms, if the rate limit allows it in one sitting
./run.sh full proxied
./run.sh full control

# 4. the table
python3 report.py --proxied <job-dir> --control <job-dir> --out RESULT.md
```

Every knob is an environment variable with a default, listed at the top of `run.sh`:
`ONEPASS_MODEL`, `ONEPASS_HARBOR_ENV` (default `daytona`; `docker` runs on the local daemon),
`ONEPASS_N_CONCURRENT`, `ONEPASS_TRIP_TOKENS`, `ONEPASS_CLAUDE_VERSION`, `ONEPASS_REF`,
`ONEPASS_JOBS_DIR`, `ONEPASS_TASKS_FILE`.

### Running it in batches, and why you have to

A subscription meters two rolling windows, and the account this was run on has **no overage**
(`overageStatus: "rejected"`, `overageDisabledReason: "org_level_disabled"`). Reaching 100% is a
hard refusal, not a slowdown. That is worse than it sounds: Claude Code retries a refusal with
backoff, the backoff burns the *task's* own timer, the task times out and scores **0**, and the
table then reads "the proxy failed these tasks" when it means "we ran out of allowance". The two
are indistinguishable afterwards, so a truncated run is a discarded run.

The measured rate is the problem. `path-tracing` — the **shortest** of the twenty, 13 minutes,
$6.02 — moved the five-hour window by about **3 percentage points**. `build-pov-ray` is capped at
12000s and `sam-cell-seg` at 7200s. Forty trials do not fit in one window, and the original
"~2 h per arm" estimate was wall clock, which is not the binding constraint.

There are two ways to spend that, and which one is right is the operator's call, not this file's.

**One shot, both arms at once** — what the recorded run did. Accepts that a window may be
exhausted mid-run, in exchange for finishing in one sitting. Running the two arms *simultaneously*
rather than back to back halves the wall clock and has a real methodological benefit: both arms
meet the service at the same instant under the same conditions, which sequential arms never do.
Wall clock then floors out at the longest single task (`build-pov-ray`, 12000s) instead of the sum.

```
ONEPASS_N_CONCURRENT=10 ./run.sh first-pass proxied &
ONEPASS_N_CONCURRENT=10 ./run.sh first-pass control &
```

Pair it with `python3 triage.py`, which separates trials that failed because the window ran out
from trials that genuinely failed. Without that separation a truncated run is indistinguishable
from a bad result, and the whole thing has to be thrown away.

**In batches, one per window** — slower by a day, but no trial can be truncated. The lists live in
`batches/`, cover `tasks.txt` exactly, and are ordered cheapest-first so the early batches
calibrate the cost of the later ones. Both arms of a batch go inside one window:

```
ONEPASS_TASKS_FILE=batches/batch1.txt ./run.sh first-pass proxied
ONEPASS_TASKS_FILE=batches/batch1.txt ./run.sh first-pass control
python3 usage.py          # gate: check headroom before starting the next batch
```

`usage.py` reads the `rate_limit_event` lines Claude Code writes into `agent/claude-code.txt`.
That is the only readout available — there is no endpoint to poll — so it reports the state as of
the last request a trial made, not as of now.

Batch job names carry the batch tag (`onepass-first-pass-batch1-proxied-<ts>`), and `report.py`
takes every batch directory for an arm at once:

```
python3 report.py --proxied <b1-proxied> <b2-proxied> ... \
                  --control <b1-control> <b2-control> ... --out RESULT.md
```

The smoke run passes only if the proxy log shows **at least one trip with segments evicted**, and
the sent context stays under the trip line afterwards. If nothing trips, either the base URL is not
taking or the threshold is not reaching the agent — fix that before spending anything else on this.
Read it in the collected logs:

```
<job>/<trial>/agent/onepass-build.txt            # commit, node, proxy version actually built
<job>/<trial>/agent/onepass-proxy.stdout.log     # one line per request: est N -> M tok, K stubbed
<job>/<trial>/agent/onepass/proxy.log.*.jsonl    # the machine-readable record
```

## How the proxy gets into a container

`onepass_agent.py` subclasses Harbor's `ClaudeCode` and adds two hooks. It overrides nothing about
how the CLI is installed or invoked.

* **`install()`** runs the stock install first (so the CLI is byte-identical to the control's), then
  clones this repo at a pinned commit into `/opt/onepass/repo`, downloads a pinned Node 22 into
  `/opt/onepass/node`, and runs `npm ci && npm run build` in `proxy/`. Neither is put on the
  container's `PATH`: a task's own toolchain must not move between arms. For the same reason the
  system-package list is only `curl bash git tar` — all presence-checked, so a container that
  already has them runs no package manager at all.
* **`run()`** starts `onepass-proxy` on `127.0.0.1:3777` in the background, waits for its
  "listening" line, then calls the stock `run()` — which launches `claude -p` with exactly the
  command line the control arm uses.

The base URL is injected through `_resolve_auth_env()` rather than `--ae`, because `--ae
ANTHROPIC_BASE_URL=...` is also visible to `_resolved_model_name()` and would change the model
string. `--ae` *does* forward arbitrary variables into the container — Harbor's `Trial` overlays
`agent.extra_env` onto every `exec` during the setup and run phases — it is simply the wrong tool
for this one variable.

**One proxy per container, and that is load-bearing.** `proxy/src/server.ts` keeps a single
evicted-id set and a single chars-per-token calibration per process. Two sessions sharing one proxy
would cross-contaminate both. A container-local proxy solves that, the concurrency problem, and
cloud reachability at once — and nothing is ever exposed off the container's loopback interface,
which matters because auth tokens pass through it.

**The proxy log is redirected by symlink, not by code.** The proxy writes to `$HOME/.onepass` and
has no environment variable to move it, so `run()` symlinks that directory to `/logs/agent/onepass`,
which Harbor mounts from the trial directory and downloads with the run. Packaging, not a proxy
change.

## What the report measures

`report.py` reads both job directories and writes one markdown file.

* **Reward** — the verifier's own score, `results.json` → `verifier_result.rewards`. This is
  terminal-bench's test-based pass/fail, not our judgement.
* **Input tokens including cache** — `agent_result.n_input_tokens`, which Harbor sums from the
  session's `usage` as `input + cache_read + cache_creation`. That sum is exactly the quantity the
  proxy shrinks and exactly the quantity Claude Code's auto-compact decision reads
  (`docs/findings.md` §11).
* **Peak context** — `max(step.metrics.prompt_tokens)` over `agent/trajectory.json`. The single
  number `docs/findings.md` reports per run, and the one that decides whether a session compacts.
* **Trips, segments evicted, chars removed** — from each trial's own proxy log.
* **`recall_search` / `recall_get` calls** — scanned out of the Claude Code transcript. Expect zero:
  the recall MCP server is not registered in these containers, and it was called zero times in
  every real proxied run so far anyway (`docs/findings.md` §17). The row is there to keep that
  honest rather than to flatter the result.

The headline is the **paired difference**: per task, mean over that task's trials in each arm, then
proxied − control. Trials are averaged within a task first so a task with three completed trials
does not outvote one with two. The interval is a percentile bootstrap over tasks
(`scipy.stats.bootstrap`, 10,000 resamples); each task contributes exactly one difference, so
resampling tasks *is* the paired bootstrap.

## What this cannot show

- **n is small.** 20 tasks × 1–3 trials, one model, one CLI version. A per-task reward difference
  of ±1 on a binary score is one flip of a nondeterministic agent. Read the interval, not the mean.
- **The recovery path stays unexercised.** Recall is not wired into these containers, so this
  measures eviction with re-reading from disk as the only recovery — which is what real proxied
  runs have always done anyway (`docs/findings.md` §17), but it is not evidence that recall works.
- **30k is not a real setting.** See above. The reduction is real; the dose is not the shipped one.
