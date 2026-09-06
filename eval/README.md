# A/B eval rig

Measures what the proxy costs and what it buys on a real task, against an unproxied control.
Produces §§15–18 of [docs/findings.md](../docs/findings.md).

The retrieval harness in [spike/harness](../spike/harness) is a different thing: it measures
whether a fact can be recovered after it leaves context. This measures whether a whole task
still gets done correctly with the proxy in the path.

## The task

mastra issue #18877 — channel dedupe state lived in a per-process `Map`, so two server
instances behind a load balancer both replied to the same Slack message. The fix moves it into
storage, shared across instances, in core plus five database backends.

It is a good eval task for three reasons: it is large enough to blow past a 200k window, it
touches many files, and **a human-written fix with its own tests exists** at mastra commit
`faee052a3c`. That commit is by this repo's author, on
[mastra-ai/mastra#22516](https://github.com/mastra-ai/mastra/pull/22516), which is open and
unmerged as of 2026-09-04; it is not a maintainer's fix. Its two test files are the ground
truth. They were written before any eval run and the agent never sees them, so it cannot write
tests that flatter its own implementation. If the PR merges with changes to those files, re-pin
the ground truth to the merged commit.

- Base commit for every arm: `a14c2436bc`
- The plan the agent implements: [task/witty-singing-puzzle.md](task/witty-singing-puzzle.md)
- Ground-truth tests: `faee052a3c`, 65 assertions across core and convex

## Arms

An arm is one run. The only thing that varies is whether `claude` is pointed at the proxy:

- **proxied** — `./run.sh run7`
- **control** — `./run.sh control --no-proxy`

Everything else is pinned inside `run.sh`: base commit, plan file, `opus[1m]`, `--effort xhigh`,
`--permission-mode acceptEdits`, the tool allowlist, and a byte-identical prompt. Change any of
it and the run is no longer comparable to the earlier ones in findings.md.

To A/B the proxy against *itself* — a stub-design change, say — run two proxied arms with
different proxy builds and leave everything else alone. That is what runs 3–6 were.

## Running

```
export MASTRA_REPO=~/Project/mastra          # required: a mastra clone
export ONEPASS_EVAL_DIR=/tmp/onepass-eval    # optional, this is the default

cd proxy && npm test && onepass-proxy &      # the build under test, in its own terminal
cd eval
./run.sh   run7                              # ~35 min
./score.sh run7
node analyze.mjs ~/.claude/projects/-<slug>-mastra-run7/$(cat /tmp/onepass-eval/run7.sid).jsonl=run7
```

`run.sh` cuts a detached worktree at the base commit, copies the plan in, runs `pnpm install`,
then runs the task in one non-interactive `claude -p` call. It writes `<arm>.sid`, `.start`,
`.end`, `.out` and `.err` into `$ONEPASS_EVAL_DIR`.

Run arms sequentially. Two at once contend for the same pnpm store and roughly double each
other's wall clock.

## Reading the result

Three tools, three kinds of number.

**`score.sh <arm>` — did it do the work?** Saves whatever tests the agent wrote to
`$ONEPASS_EVAL_DIR/<arm>-tests/`, overwrites them with the ground-truth pair, and runs vitest.
The score to compare is passing assertions out of 65. Runs 3, 4 and 5 all scored 63/65 against
an unproxied control's 64/65.

**`npm run report` in `proxy/` — what did the proxy do?** Compactions, tokens evicted,
evicted:recalled, the speed summary and the per-request table:

```
cd proxy && npm run report -- <transcript> <proxy log>
```

**`analyze.mjs <transcript>[=<label>]` — what did it do to the agent?** Assistant turns, tool
mix, recall calls, redundant reads, and stub-shape imitations — the one measured way the proxy
has made the agent worse. Its imitation scan looks for an `evicted` key in a `tool_use` input,
which only counts builds that put that key in the stub; a build that removes the key needs the
shape-agnostic count findings.md §18 describes. The `InputValidationError` tally in the same
output is the ground truth for both, so a scan that disagrees with it is measuring the wrong
thing.

Peak, median and p90 context are not tool output. They come from summing `input_tokens +
cache_read_input_tokens + cache_creation_input_tokens` per assistant entry in the transcript.
Validate any such script by checking its max equals the reporter's peak before trusting the
rest of it.

## Artifacts

Run outputs land in `$ONEPASS_EVAL_DIR` (default `/tmp/onepass-eval`), which is a temp
directory — copy anything you intend to cite before it is cleaned up. The runs behind
findings.md §§15–18 are still there as `run{3..6}.*`, `control.*` and their `mastra-*`
worktrees.

## Before the eval was built

[smoke/](smoke/) recorded the three mechanics the eval rests on — resolving a stored session
from a foreign worktree, forking it mid-session without disturbing the parent, and snapshotting
a worktree the agent cannot see. Its README is the record: the Claude Code version, the commands,
the verbatim output, and what the check does not prove.

The live runner that answered the first two was a one-time instrument and was deleted once it
had answered; recover it from history if the Claude Code version its record is valid for changes.
What remains is `snapshot.ts` — the snapshot implementation the eval uses as it stands — and the
tests that keep it honest.
