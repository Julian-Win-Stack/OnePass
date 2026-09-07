# The Onepass eval

Measures what the proxy costs and what it buys, against a stored control baseline.
[spec.md](spec.md) is the design, [decision.md](decision.md) the decisions it rests on.

The retrieval harness in [spike/harness](../spike/harness) is a different thing: it measures
whether a fact can be recovered after it leaves context. This measures whether a whole task
still gets done correctly with the proxy in the path.

## The command

`onepass-eval` is a TypeScript package beside the proxy, with the proxy's conventions: compiled
before it runs, tests under Node's own runner.

```
export ONEPASS_EVAL_CORPUS=~/onepass-corpus   # required, and outside this repository

cd eval
npm install
npm test
npm run build

node dist/main.js replay                      # no model calls, no score, free
node dist/main.js quick                       # three proxied tails, every second planning case
node dist/main.js full --compare a001c2b-20260906T101112Z

node dist/main.js import <transcript.jsonl> --tip <uuid>   # copy one session into the corpus
```

**No arm is measured yet.** What exists is the spine the arms are written into — the command and
its modes, the corpus directory, the control baseline, the proxy child, and the result document
every later ticket writes into — and the corpus import that gives them a session to read. A run
today builds the proxy, starts a child, and writes a result document with no cases in it.

- **The corpus.** `ONEPASS_EVAL_CORPUS` names one directory holding every byte of session
  content: transcript copies, fork and grader outputs, hand labels, the control baseline and the
  case worktrees. It has to resolve outside this repository, and the command refuses to start
  otherwise — none of that material may ever be committed. (The old shell rig's
  `ONEPASS_EVAL_DIR`, which defaulted to `/tmp/onepass-eval`, is a different variable and still
  belongs to `run.sh`.)
- **The proxy under test.** The command compiles `proxy/` itself and starts a child per case on
  a port the operating system picks, with the judge held off, and tears it down after. The
  globally running `onepass-proxy` is never used, and a build you forgot to make cannot be what
  gets measured.
- **The control baseline.** Control answers are recorded once under a model, effort and Claude
  Code version key, and reused by every later run, so an iteration pays for the proxied arm
  alone. Change any of the three and the next run records afresh rather than comparing against
  answers from another world. `claude --version` supplies the version;
  `ONEPASS_EVAL_CLAUDE_CODE_VERSION` pins it.
- **The result.** Each run is labelled by the proxy's git short SHA and the time it started — a
  build with uncommitted changes under `proxy/` says `-dirty` in its own label — and writes
  `results/<label>.json` with `results/<label>.md` beside it. Those are committed; the corpus
  never is.
- **The seam.** Every model call the eval makes crosses one HTTP boundary, so the whole command
  can be driven with no key and no money. Replay mode serves its own fake upstream to the proxy
  child; the tests point a scored run at one through `ONEPASS_EVAL_UPSTREAM`.

## Importing a session

```
node dist/main.js import \
  ~/.claude/projects/-Users-...-chp99-takehome/62d8de7e-c2f3-448d-829f-9d25b23123eb.jsonl \
  --tip b7881712-2e5c-4b77-a409-02ceb65f496f --name planning
```

That copies the transcript into `$ONEPASS_EVAL_CORPUS/transcripts/` and prints the branch it
holds: turn counts, compaction points and the token trajectory, then what the file held around the
branch. The original under the projects directory is only ever opened for reading.

**A transcript file is a tree, not a list, and a session is one branch of it.** Every entry records
its parent. A rewind leaves the path it abandoned in the file with nothing marking it; entries are
rewritten in place, so the same uuid recurs and the last copy is the authoritative one; and a
resumed session copies its ancestor in, so one file holds entries from more than one session id.
The reader resolves those three before it counts anything, and in that order — duplicates, then the
walk from the tip, then the filter to conversation entries. Filtering first snaps the chain, because
the spine runs through `system` and `attachment` entries that are not conversation.

It matters. The planning corpus file read flat looks like 95 typed turns and 5 compactions; the
branch the corpus is taken from is 57 typed turns and 2 compactions.

`--tip` is what chooses the branch. Without it the branch ending at the last entry written is the
one imported, which for the planning session is *not* the branch the corpus uses — the deep Fable
branch was rewound out of. Being rewound out of does not make a branch less real: the model saw
that context and answered against it.

**Compactions are not on the branch.** Each one writes a root of its own — a `system` entry with a
null parent, with the summary hanging off it — while the conversation spine's parent links run
straight through it unbroken. So the reader never looks for a compaction summary in the chain. It
finds boundaries by scanning the file for `compact_boundary` entries and matching each one's
`logicalParentUuid`, the last entry it preserved, against the walked path. On the spine a compaction
shows only as a fall in reported usage, and the two are matched: a fall with no boundary straddling
it is printed as unexplained rather than called a compaction. Nothing downstream depends on getting
this exactly right — a turn's depth is read from its own recorded usage, which is absolute — so a
boundary in the wrong place mislabels a report line rather than corrupting case selection.

Two smaller things the reader has to know. An `assistant` entry whose model is `<synthetic>` is an
interrupt or an error notice rather than an API turn; it reports zeroes, and letting them into the
trajectory would read as the context collapsing, so it is counted separately and contributes no
usage. And entry types vary by Claude Code version — the corpus branch is 2.1.222, current sessions
are 2.1.260 and carry `bridge-session`, `ai-title` and `atis-latch`, which did not exist then — so an
entry type the reader does not recognise is passed over, never a parse failure.

Beside the copy the import writes `<name>.import.json`: the source, the tip, the counts, the
compactions, the stretches and the full trajectory. The turn model itself is not written out; it is
read from the copy whenever it is wanted.

`planningCorpus.test.ts` holds the numbers above as assertions against the real transcript, and
skips itself where that transcript is not present.

## The A/B rig it is replacing

The shell scripts below still run the implementation arm as they always have. They produce
§§15–18 of [docs/findings.md](../docs/findings.md) and are folded into the package by a later
ticket.

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
