# Step 2 handoff — run the Terminal-Bench 2.0 A/B locally

You are picking up Step 2 of the Onepass eval. Everything is **built, committed, pushed and
dry-run tested**. Nothing has been run for real. Your job is to run it on this machine and ship
the result.

The previous session ran in an ephemeral cloud container with no Docker daemon and no access to
the operator's `.env`. That is why this moved local: the credentials live here.

Read this file, then [`README.md`](README.md) in this directory. The README is the reference for
*what every knob is and why*; this file is the reference for *what to do next*.

---

## 0. Ground rules (do not relax these)

- **Do not** edit any GitHub issue.
- **Do not** expose a proxy on the public internet (no tunnels) — auth tokens pass through it.
- **Do not** commit tokens, provider keys, trajectories, or anything under the scratch dir.
- **Do not** change eviction behaviour in `proxy/src`. If the proxy needs a change to run in a
  container, keep it to packaging and say so in the PR.
- **Never** write a token into a tracked file, a Harbor config that gets committed, or a log.
- Do not touch `eval/run.sh`, `eval/score.sh` or `eval/src` — that is Step 1.
- All work goes on branch `step2/harbor-tbench`. Do not push anywhere else.

## 1. Keep a STATUS.md

Maintain `~/onepass-corpus/ab/STATUS.md` as your memory. Create it on your first turn if it does
not exist. Rewrite it **after every milestone and before any long wait**.

Sections, in this order:

- **Done**
- **Running** — command, PID, log path
- **Next**
- **Numbers so far** — each with the file it came from
- **Unverified** — anything you assumed but did not check
- **Decisions** — choices you made that this handoff left open

Assume you could be compacted or restarted at any moment, and the next version of you will have
only that file, this handoff, and the repo. **Under 80 lines. Overwrite, do not append.**

Seed it from sections 6, 7 and 8 below.

---

## 2. Setup on this machine

Branch (already pushed, HEAD `4c6bbe7`):

```
git fetch origin step2/harbor-tbench
git checkout step2/harbor-tbench
cd eval/harbor
```

Harbor needs **Python ≥ 3.12**. Scratch venv, outside the repo:

```
uv venv --python 3.12 ~/onepass-corpus/harbor/.venv
uv pip install --python ~/onepass-corpus/harbor/.venv/bin/python \
    'harbor[daytona]==0.22.0' scipy numpy
export PATH="$HOME/onepass-corpus/harbor/.venv/bin:$PATH"
harbor --version
```

The `[daytona]` extra is required — plain `harbor==0.22.0` raises `MissingExtraError` on
`--env daytona`. `harbor==0.22.0` is pinned deliberately: the resolver walks into yanked 0.1.x
releases without it.

### Credentials

`eval/harbor/.env`, gitignored. **Verify that before writing it:**

```
git check-ignore -v "$(git rev-parse --show-toplevel)/eval/harbor/.env"
# must print a .gitignore rule (currently `.gitignore:7:.env`). If it prints nothing, STOP.
```

Two keys, names only — the operator supplies the values:

```
CLAUDE_CODE_OAUTH_TOKEN=...    # `claude setup-token` on this machine
DAYTONA_API_KEY=...            # app.daytona.io -> Keys
```

`run.sh` sources this file automatically. The OAuth token is never put on a command line, so it
stays out of `ps` and out of every log. Do not change that.

### Environment hygiene

`run.sh` unsets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_GZIP_REQUEST_BODIES` before calling Harbor. All four are read from the launching
shell and forwarded into the container. **This matters more on a local machine than it did in the
cloud** — you are launching from a shell that probably has a real Claude Code session's variables
in it. `CLAUDE_CODE_GZIP_REQUEST_BODIES=1` is the dangerous one: it makes the client gzip request
bodies, which the proxy forwards untouched, so eviction silently does nothing and the run looks
fine. Do not remove those `unset` lines.

### Don't let the laptop sleep

Trials run in Daytona's cloud, not here — this machine only runs the orchestrator, which is
network I/O and near-zero CPU. But if it sleeps, the run dies. On macOS:

```
caffeinate -i ./run.sh first-pass proxied
```

Stay plugged in. Closing the lid ends the run.

---

## 3. The run plan

Do these in order. Each is a separate `harbor run`; they do **not** have to be the same day.

| # | Command | Wall clock | Gate |
|---|---|---|---|
| 1 | `./run.sh smoke` | ~30 min | pass criterion below |
| 2 | `./run.sh first-pass proxied` | ~2 h | — |
| 3 | `./run.sh first-pass control` | ~2 h | — |
| 4 | `python3 report.py --proxied <dir> --control <dir> --out RESULT.md` | minutes | — |
| 5 | commit `RESULT.md`, open the PR | — | — |

**Skip `./run.sh full` (3 trials).** It is ~3× the cost for a tighter interval, and the original
handoff permits reporting the first pass instead. Only run it if steps 2–3 finish fast and clean
and the operator asks.

### Smoke pass criterion — this is a gate, not a formality

The smoke run passes only if the proxy log shows **at least one trip with segments evicted**, and
the sent context stays under the trip line afterwards.

```
<job>/<trial>/agent/onepass-build.txt          # commit, node, proxy version actually built
<job>/<trial>/agent/onepass-proxy.stdout.log   # one line per request: est N -> M tok, K stubbed
<job>/<trial>/agent/onepass/proxy.log.*.jsonl  # kind:"trip" lines are the machine-readable record
```

If nothing trips: either the base URL is not taking or the threshold is not reaching the agent.
**Fix it before spending anything else.** Check in this order — was `onepass-build.txt` written at
all (install ran?), does the stdout log say `T=30000`, does `claude-code.txt` show requests going
somewhere, is the task simply too short to reach 30k.

### Concurrency and the rate limit

`--n-concurrent 4` is the default in `run.sh` and the right starting point. Both arms run on one
subscription; more concurrency risks throttling.

Throttling does not just slow the run — **it corrupts the measurement.** Claude Code retries a 429
with backoff, the backoff burns the task's own timer, the task times out and scores 0, and the
table then reads "the proxy failed this task" when it actually means "we got rate-limited." You
cannot separate those after the fact.

So: **watch the first 10 minutes of step 2.** Grep the live job dir for rate-limit errors:

```
grep -rl -i -e 'rate.limit' -e '429' <job-dir>/*/agent/claude-code.txt
```

If they show up, kill the run, drop to `ONEPASS_N_CONCURRENT=2`, and start over. Minutes lost, not
hours. Record the ceiling you found in STATUS.md — **the final report has to state it.**

Do not raise concurrency above 4 to save time. Two tasks (`build-pov-ray` at 12000s and
`sam-cell-seg` at 7200s) set a floor no amount of parallelism beats, so the upside is small and the
downside is a run you have to throw away.

---

## 4. Deliverables

1. `eval/harbor/RESULT.md`, written by `report.py`, committed.
2. A PR from `step2/harbor-tbench`. The PR body must say that the only proxy-side changes are
   packaging, not eviction behaviour.
3. A final message carrying:
   - the table,
   - the rate-limit ceiling you hit,
   - which of the "likely but unverified" facts in section 7 turned out true.

---

## 5. What is already built

Everything under `eval/harbor/`, committed in `637629c` and `4c6bbe7`:

| File | What it is |
|---|---|
| `onepass_agent.py` | the proxied arm — subclasses Harbor's `ClaudeCode`, adds `install()` and `run()` hooks only |
| `run.sh` | one arm per invocation; `{smoke\|first-pass\|full} [proxied\|control]` |
| `select_tasks.py` | regenerates `tasks.txt` from the dataset's own metadata |
| `tasks.txt` | the 20 tasks, committed |
| `report.py` | both job dirs → one markdown table, paired bootstrap |
| `README.md` | the reference: every knob, and why |

`proxy/src` is untouched and must stay that way.

## 6. Already verified

- Harbor 0.22.0 installs and resolves `terminal-bench@2.0` → `laude-institute/terminal-bench-2`
  @ `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`, 89 tasks.
- `tasks.txt` = the 20 longest, by `[agent] timeout_sec` then `expert_time_estimate_min`.
- `report.py` exercised end-to-end on a synthetic two-arm fixture; the scipy bootstrap path works.
- The custom agent instantiates through Harbor's real factory; `--ak` kwargs type-coerce; and
  `ANTHROPIC_MODEL` resolves to `claude-opus-5` in **both** arms.
- The container-side scripts were dry-run in a real Linux container (not a trial container):
  install exits 0 in ~9 s (Node 22.22.2 + clone at the pinned SHA + `npm ci` + build,
  `proxy_version=0.2.0`); the proxy starts reporting `T=30000` with the judge off; a POST to
  `127.0.0.1:3777/v1/messages` reached api.anthropic.com (401, no auth) and wrote a `kind:"request"`
  line into `/logs/agent/onepass/` — the path Harbor collects.

## 7. Unverified — confirm these on the smoke run and report which held

- **`--ae` forwards arbitrary variables into the container.** Read in Harbor's source (`Trial`
  wraps setup and run in `scoped_exec_env(agent.extra_env)`; precedence persistent < per-exec <
  scoped), never observed live.
- **The proxy trips at all** under a real Claude Code session on these tasks. The smoke run's whole
  job.
- **The rate-limit ceiling** for concurrent subscription-auth sessions. Unknown. Find it, report it.
- **Harbor's Daytona env works** — the SDK imports, it has never been called.
- **Daytona snapshot builds.** It creates a snapshot per task image on first use. 20 images means
  20 builds on the first pass, of unknown duration. Budget for it; it may make step 2 longer than
  ~2 h the first time only.
- **`--ak version=` pins the CLI** — reasoned from Harbor's source, not run.
- **All 20 tasks default to `NetworkMode.PUBLIC`** (no `allow_internet` in their `task.toml`, and
  Harbor's default is PUBLIC), so the in-container clone and `npm ci` should work. Not observed.

## 8. Decisions already made (do not silently reverse these)

- **The custom agent is a subclass, not a PATH shim.** Harbor's `--agent module:Class` import path
  works; the shim fallback was not needed.
- **The base URL is injected via `_resolve_auth_env()`, not `--ae`.** `--ae ANTHROPIC_BASE_URL` is
  also read by `_resolved_model_name()`, which then returns the *prefixed* model name — the two
  arms would send different `ANTHROPIC_MODEL` strings.
- **`--model claude-opus-5`, no `anthropic/` prefix**, for the same reason.
- **The tier aliases (`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`)
  go to both arms** via `--ae`. Harbor's stock `run()` sets them whenever a base URL is set, so
  only the proxied arm would otherwise get them.
- **Two jobs, one per arm**, not one job with two agents. `report.py` takes both directories.
- **A pinned private Node 22 under `/opt/onepass`, off `PATH`**, and only presence-checked system
  packages (`curl bash git tar`), so the task's own toolchain cannot move between arms. In
  particular, do not add a package with `always_install=True` (e.g. `ca_certificates`) to that
  list — it would run `apt-get` on every proxied trial and desynchronise the arms.
- **The proxy log is redirected by symlinking `$HOME/.onepass`** to `/logs/agent/onepass`. The
  proxy has no env var for its log directory and `proxy/src` must not change. Packaging.
- **`ONEPASS_TRIP_TOKENS=30000` is a stress dose, not the shipped default** (110,000). Any number
  quoted from this run must carry that sentence.
- **The judge is off.** `ONEPASS_JUDGE_API_KEY` is explicitly unset in the container.
- **Branch `step2/harbor-tbench` is cut from `origin/main`**, not from the session default branch,
  which holds unrelated unmerged work.
