# Handoff — Step 2: the proxy on Terminal-Bench 2.0 via Harbor, real Claude Code, many tasks

You are one of three sessions running at once. Stay in your own worktree and scratch dir.
Read CLAUDE.md, proxy/README.md (especially the env-var table and "Known Claude Code
interactions") and docs/findings.md §11–§18 first.

## Isolation

- Worktree: `.claude/worktrees/step2` on branch `step2/harbor-tbench`.
- Scratch: `$HOME/onepass-corpus/harbor`. No local proxy ports — every proxy in this step
  runs inside a task container.
- New code lives under `eval/harbor/`. Do not touch `eval/run.sh`, `eval/score.sh` or `eval/src`.

## Why this step exists

Step 1 is one task. Thirty tasks give a range, and "Terminal-Bench 2.0" is a name a stranger
trusts without reading our code. Every shipped peer (OpenHands condenser, Anthropic context
editing, SWE-Pruner, TokenPilot) was evaluated this way: existing benchmark, test-based score,
"success unchanged, tokens down". Harbor already does the container-per-trial, run-Claude-Code,
repeat-and-score work that issues #10/#12/#9 were going to hand-build.

## Facts already verified (do not re-research)

- Harbor: `harbor run --dataset terminal-bench@2.0 --agent claude-code --model anthropic/<model>
  --n-concurrent N`; `--ae KEY=VAL` passes env vars to the agent; `--env daytona|modal|...`
  runs trials in a cloud sandbox instead of local Docker; `harbor agent schema claude-code`
  prints the agent's options.
- Harbor's built-in claude-code agent installs the real CLI in the container, forwards
  `ANTHROPIC_BASE_URL`, and accepts `CLAUDE_CODE_OAUTH_TOKEN` (subscription) — a token comes from
  `claude setup-token` on the user's machine. Whether `--ae` forwards an arbitrary variable such
  as `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` is likely but unverified: check on the first trial.
- Terminal-Bench tasks mostly stay under 110k tokens, where the proxy is inert. The proxied arm
  therefore runs with `ONEPASS_TRIP_TOKENS=30000` — a stress dose, stated in the result.
- The proxy keeps one `evictedSegmentIds` set and one calibration per process
  (`proxy/src/server.ts`). Sessions must not share a proxy. One proxy per container solves that,
  the concurrency problem and the cloud-reachability problem at once.
- The repo is public, so a container can `git clone` it and build `proxy/` itself.

## Build

1. **Proxied agent.** Define a custom Harbor agent (find the mechanism: `harbor agent --help`,
   the installed `harbor` package source, its cookbook). Install hook: clone the repo at this
   branch's commit, `npm ci && npm run build` in `proxy/`, install the CLI the same way the stock
   agent does. Run hook: start `onepass-proxy` on 127.0.0.1:3777 in the background with
   `ONEPASS_TRIP_TOKENS=30000`, judge unset, log to a path Harbor collects (its `/logs/agent/`
   convention), then run `claude -p` exactly as the stock agent does with
   `ANTHROPIC_BASE_URL=http://127.0.0.1:3777` and `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`.
   If custom agents cannot wrap the run command, a shim named `claude` earlier on PATH that starts
   the proxy and execs the real binary is the fallback.
2. **Control agent.** The stock `--agent claude-code`, same model, same Claude Code version
   (record the version Harbor installs).
3. **Where it runs.** Prefer `--env` with a cloud provider so the user's Mac is not loaded — the
   user must supply that provider's key; ask for it by name and stop until it arrives. Fallback:
   local Docker, `--n-concurrent 2`.
4. **Auth.** `CLAUDE_CODE_OAUTH_TOKEN` via `--ae`, read from the environment or `.env`
   (gitignored). Never write a token into a tracked file, a Harbor config that gets committed, or
   a log. Concurrency is bounded by the subscription's rate limit, not by compute: find the
   ceiling with the smoke run and report it.
5. **Report.** `eval/harbor/report.py`: per task, per arm, per trial reward; paired difference
   (proxied − control per task, averaged over trials) with a bootstrap interval
   (`scipy.stats.bootstrap`, paired); tokens per arm from Harbor's trajectory output plus trips /
   segments evicted / recalls from each proxy log. One markdown table.

## Runs

- **Smoke:** 1 task, proxied only. Pass criterion: the proxy log shows at least one trip and
  evictions, and the transcript's context stays under the trip line after it. If nothing
  trips, the base URL or the trip threshold is not taking — fix before spending anything else.
- **First pass:** 20 tasks × 2 arms × 1 trial. Choose the 20 longest tasks by the dataset's own
  metadata (most turns / longest expected time), so eviction fires most; commit the task list.
- **Full:** the same tasks × 3 trials each, if the smoke run's rate-limit ceiling allows it in
  one sitting. If not, report the first pass and the ceiling.

## Deliverables

- `eval/harbor/`: agent definition, run script, `report.py`, a README stating the exact commands,
  Claude Code version, model, trip setting, task list, and that 30k is a stress dose.
- The result table committed as `eval/harbor/RESULT.md`.
- A PR from `step2/harbor-tbench`. Final message: the table, the rate-limit ceiling you hit, and
  which of the "likely but unverified" facts above turned out true.

## Do not

- Edit any GitHub issue.
- Expose a proxy on the public internet (no tunnels) — auth tokens pass through it.
- Commit tokens, provider keys, trajectories, or anything under the scratch dir.
- Change eviction behaviour in `proxy/src`. If the proxy needs a change to run in a container,
  keep it to packaging and say so in the PR.
