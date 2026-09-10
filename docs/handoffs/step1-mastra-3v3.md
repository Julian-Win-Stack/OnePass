# Handoff — Step 1: mastra, 3 proxied vs 3 control, in parallel

You are one of three sessions running at once. Stay inside your own worktree, ports and
scratch dir so you never collide with the other two. Read CLAUDE.md, eval/README.md and
docs/findings.md §16–§18 first; this file only says what is new.

## Isolation

- Worktree: `.claude/worktrees/step1` on branch `step1/mastra-3v3` (create it first; it is
  gitignored). Everything you build and run comes from this worktree.
- Proxy ports: 3781, 3782, 3783. Never 3777 — another session may be using it.
- Scratch: `ONEPASS_EVAL_DIR=$HOME/onepass-corpus/ab` (not /tmp — the last set of run
  artifacts was lost to a /tmp clean). `MASTRA_REPO=$HOME/Project/mastra`.
- Run the proxy as `node <this worktree>/proxy/dist/main.js`, not the global `onepass-proxy`
  — that bin is symlinked to the main checkout, not to this branch.

## The question this step answers

Findings §16–§17: every proxied run (3, 4, 5) fails the convex `by_owner_key` ground-truth
test; the single control run passed it. Either the proxy evicts something the agent needs for
that index, or control got lucky once. Two more controls decide it. A second question rides
along: does the score move at all between runs? If six runs all land on the same number, the
tests cannot see differences and that changes what the eval should be.

## Runs

Five arms, all launched in parallel, `run.sh` config untouched (`opus[1m]`, xhigh — keep it
comparable with §16–§18; do not switch to the decision.md model/effort):

| arm | command | proxy |
|---|---|---|
| control2 | `./run.sh control2 --no-proxy` | none |
| control3 | `./run.sh control3 --no-proxy` | none |
| head1 | `ONEPASS_BASE_URL=http://localhost:3781 ./run.sh head1` | port 3781 |
| head2 | `ONEPASS_BASE_URL=http://localhost:3782 ./run.sh head2` | port 3782 |
| head3 | `ONEPASS_BASE_URL=http://localhost:3783 ./run.sh head3` | port 3783 |

Together with the §17 control (64/65) that is 3 control vs 3 proxied on HEAD.

Order of operations:
1. Clone mastra if absent. Pre-warm the pnpm store once (a throwaway worktree at the base
   commit, `pnpm install`, delete it) so the five real installs are link-only and fast.
2. Build the proxy in this worktree, start three proxies (one per port, `ONEPASS_JUDGE_API_KEY`
   unset), each with stdout to `$ONEPASS_EVAL_DIR/proxy-<port>.out` so the banner's log path is
   captured. Note which `~/.onepass/proxy.log.<time>.jsonl` belongs to which arm.
3. Launch the five `run.sh` invocations staggered ~60s apart (`git worktree add` on the same
   repo can trip over its own lock when truly simultaneous), each backgrounded with its own log.
4. While they run (~35–45 min), draft the §19 skeleton.
5. `score.sh` each arm. Record per arm: passing assertions /65, **which** assertions failed
   (name them — `supportsChannelState`, `by_owner_key`, or others), session id, transcript
   path, proxy log path, peak/median/p90 context, `analyze.mjs` output, wall clock, and the
   proxy short SHA.

## Decision rule — write the verdict in one sentence at the top of §19

- Controls pass `by_owner_key` ≥ 2 of 3 and proxied fail it 3 of 3 → **real regression**.
  Find what was evicted: diff a proxied transcript's stubs around the convex index work against
  a control's; the proxy log says which segments were stubbed and when. Report the mechanism;
  do not fix the proxy in this session.
- Any control fails it → noise; the claim "same score with or without" holds at n=3.
- All six identical → the tests have no resolution; say so explicitly.

## Deliverables

- `docs/findings.md` §19 in the style of §16–§18: the table, the verdict, caveats (n=3,
  parallel runs shared one machine and one subscription's rate limit — say whether any run
  saw 429s or retries, from `.err` and the proxy log).
- `eval/results/<label>.md` per arm may be written but note `eval/results/` is currently
  gitignored — the committed record is §19.
- A PR from `step1/mastra-3v3`. Final message: the verdict, the 3-vs-3 table, anything odd.

## Do not

- Edit any GitHub issue. Propose changes in the PR description instead.
- Write to any transcript under `~/.claude/projects`.
- Commit anything under `$ONEPASS_EVAL_DIR`, `~/.onepass`, or `.env`.
- Change `run.sh` / `score.sh` behaviour. Wrapping them is fine; altering the pinned config is not.
