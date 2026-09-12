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

# one session has to be in the corpus before a run has anything to read
node dist/main.js import <transcript.jsonl> --tip <uuid> --name planning

# and one recording, before replay has anything to send. ./record.sh drives a real session
# through the proxy and imports what it captured.
./record.sh

node dist/main.js replay                      # the whole recording, no model calls, no key, free
node dist/main.js quick                       # three proxied tails, every second planning case
node dist/main.js full --compare a001c2b-20260906T101112Z
```

**No arm is measured by this package yet.** (The proxy itself has been measured live — see
`docs/findings.md` §19–§22 — through `run.sh`, `eval/harbor/` and `eval/grade/`, not through this
command.) What exists is the spine the arms are written into — the command and
its modes, the corpus directory, the control baseline, the proxy child, and the result document
every later ticket writes into — the corpus import that gives them a session to read, the case
list every mode covers, the replay that checks a build's eviction on those cases for nothing, and
the grader runtime the arms will call once they have pairs to grade. A run today builds the proxy,
lists its cases, replays them if asked, and writes a result document with no scores in it.

- **The corpus.** `ONEPASS_EVAL_CORPUS` names one directory holding every byte of session
  content: transcript copies, recorded request bodies, fork and grader outputs, hand labels, the
  control baseline and the case worktrees. It has to resolve outside this repository, and the command refuses to start
  otherwise — none of that material may ever be committed. (The old shell rig's
  `ONEPASS_EVAL_DIR`, which defaulted to `/tmp/onepass-eval`, is a different variable and still
  belongs to `run.sh`.)
- **The proxy under test.** The command compiles `proxy/` itself and starts a child on a port the
  operating system picks, and tears it down after. The globally running
  `onepass-proxy` is never used, and a build you forgot to make cannot be what gets measured.
- **The control baseline.** Control answers are recorded once under a model, effort and Claude
  Code version key, and reused by every later run, so an iteration pays for the proxied arm
  alone. Change any of the three and the next run records afresh rather than comparing against
  answers from another world. `claude --version` supplies the version;
  `ONEPASS_EVAL_CLAUDE_CODE_VERSION` pins it.
- **The result.** Each run is labelled by the repository's git short SHA and the time it started —
  a working tree with uncommitted changes *anywhere*, eval included, says `-dirty` in its own
  label — and writes `results/<label>.json` with `results/<label>.md` beside it. The eval decides
  what is replayed as surely as the proxy decides what is evicted, so a label that watched only
  `proxy/` was a claim about what ran that was not true.
- **The seam.** Every model call the eval makes crosses one HTTP boundary, so the whole command
  can be driven with no model calls and no money. Replay mode serves its own fake upstream to the
  proxy child; the tests point a scored run at one through `ONEPASS_EVAL_UPSTREAM`. Replay is a
  cold start: it makes no call of its own at all and needs no key.

## Cases

A case is a prompt I typed whose request was past the proxy's trip threshold of 80k tokens.
Below that the proxy evicts nothing, both arms send byte-identical requests, and the model call
buys no information — so those turns are listed and left alone.

Cases are for the scored arms. Replay does not use them: it sends a recording (below).

Every mode lists them by rule at run time, in session order, and records the list in the result
document with each turn's index, prefix size and answer label. **There is no case manifest.**
Eligibility is recomputed each run, so a change to the rule shows up as a run whose case list
differs from the last one's rather than as a stale file nobody re-reads. Quick mode takes every
second case; full and replay take all of them.

- **A turn I typed** is a `user` entry that is not sidechain, not `isMeta`, not a compaction
  summary, and carries no `tool_result` block. The rule is spelled out because getting it wrong
  is silently destructive: a compaction summary selected as a case would be typed at the fork as
  though I had written it, and the run would look normal while measuring nothing.
- **Three shapes sit in the user slot that nobody typed.** `[Request interrupted by user]`, a
  slash command's `<command-name>` echo, and its `<local-command-stdout>`. The typed-turn rule
  admits all three; seven of the corpus branch's 57 are one of them. They are never cases and are
  never fed to a recording session — forking a session to type `[Request interrupted by user]`
  buys a paid call and no information — and the run reports how many it held back.
- **Size is read, not rebuilt and not estimated.** A case's size is what the model turn that
  *answered* it reported being shown: the whole request the API counted, messages, system prompt,
  tool definitions and every injected attachment. It is already in the transcript, so listing the
  cases costs nothing and needs no key. A prompt nothing answered has no size to read and is not a
  case, which is also the right answer for a second reason — there is nothing to compare a fork's
  answer against.

  This replaced rebuilding the request from the transcript and measuring it with count-tokens. The
  transcript does not hold what was sent, so the rebuild came out 17k short on the shallowest
  corpus case and 54k on the deepest, and the threshold had been cut to 80k to stop that silently
  dropping turns. Reading the answer's own usage has no shortfall to work around, so the eval cuts
  at the proxy's own threshold again — which has since moved to 80k itself (§21).
- **Whether the recorded answer used tools does not decide eligibility.** It is a label, and the
  result document reports the groups apart.

## Recording a session

```
./record.sh
```

Replay needs real request bodies, and the only place they exist is a proxy that saw them. So
`record.sh` drives a **real Claude Code session** through the proxy with `ONEPASS_DUMP_DIR`
pointed at the corpus: it takes the prompts of the imported planning session, feeds them one at a
time to a fresh session in the repo that session was about, and lets it run naturally — if it
compacts, it compacts, and the proxy sees the real requests on the far side of that. The proxy
writes every body it is handed to disk, untouched, before it evicts anything.

**Why not rebuild the bodies from the transcript?** Because the transcript does not hold what was
sent. Claude Code writes attached files, task notifications and its other injections as records of
its own, not as the text it renders them into: 66 such entries on the corpus branch, about 200k
characters, none of which is a turn. Three of the proxy's rules are keyed on exactly that text —
`<system-reminder>\nResult of calling the Read tool:`, `<task-notification>`, and the
`<system-reminder>\nCalled the Read tool with the following input:` marker that is *protected* from
eviction — and not one of them appeared in a single one of the 37 rebuilt bodies. All three could
have been deleted with replay still reporting every case identical.

**What one recording is worth.** The first real recording — 419 requests reaching 333k tokens —
carries `<task-notification>` in 277 of its bodies, so that rule is exercised where it never was
before. The two Read-tool markers are in none of them, and in none of the corpus transcript either:
they were measured from a different captured session, and this one's attachments are task reminders,
files and queued commands, which render as something else. Covering those two needs a recording of a
session that attaches files. A green replay is evidence about the rules the recording contains.

**It bills the Claude subscription, never `ANTHROPIC_API_KEY`.** The script unsets
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` and then refuses to start if either survived. The
trap is silent: the key lives in this repository's `.env`, the documented way to run the eval
sources it, and any shell that has — or any process inheriting from one — makes Claude Code bill
the key with no warning and no visible difference until the invoice. Unsetting reaches only the
script's own shell, so it also reads the Claude Code settings files that would put a key back
*inside* the session — an `env` block or an `apiKeyHelper` — and refuses on those too, along with
`CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX`, which bill somewhere else again.

It also refuses if the target repository has uncommitted changes, because the recorded session runs
with permissions bypassed and can edit files there; it prints the commit it started at, which
`git reset --hard` puts back.

Set `ONEPASS_RECORDING_REPO`, `_MODEL`, `_EFFORT`, `_NAME` or `_SESSION` to change what it drives.
The defaults are the chp99 takehome, Opus at xhigh, filed under `planning`.

```
node dist/main.js prompts <out-dir>            # what it would feed, one file per prompt
node dist/main.js import-recordings <dump-dir> # file bodies captured some other way
```

`import-recordings` files a dump directory into `$ONEPASS_EVAL_CORPUS/recordings/<name>/` and
prints what it found: how many bodies, how deep they got, and which are `/v1/messages` against
`/v1/messages/count_tokens`. The proxy names each dump for the moment it arrived and the count it
wrote it in, so **name order is arrival order**, and that is the order replay sends them in. The
count is there because a millisecond holds more than one request, and a pair read the wrong way
round would hand the proxy a state history the session never had.

## Replay

```
node dist/main.js replay
```

The check to run after every proxy fix. It makes no model calls, needs no key and costs nothing:
it reads the recorded bodies off disk and sends them, byte for byte, through a proxy child that
forwards to a fake upstream. **Nothing is reconstructed.**

**One child for the whole sequence, in the order it was recorded.** Eviction is monotonic — what
the proxy does at request 400 depends on everything it took at requests 1 to 399 — so a fresh child
per request, or a run over only the deep ones, would hand the proxy a state history the session
never had, and the answer would be about that history rather than about the build.

**Every request is replayed; the ~30 deepest are reported.** Correctness comes from the full
sequence, a readable table from the subset. Eviction only does anything near the threshold, so the
shallow requests all say the same thing, and a table of several hundred rows is one nobody reads.

What it writes is a diff against the last run that replayed, per request: the threshold decision,
blocks newly evicted, stubs sent, stub text and bytes forwarded. **It is not scored and the bar
rule ignores it** — a diff is read, not passed. A recording that has drifted between the two runs
**refuses the comparison outright** and says which requests moved.

Two things it deliberately does not count. The recorded body is a file on disk, identical for every
build, so it can never disagree — it stays on each outcome to say how deep the request was, and is
never counted as agreement. And the fake upstream reports no cache creation, so no rebuild is ever
classified against it; the field is gone rather than reported as a permanent zero.

**Over the threshold with nothing evicted is counted in its own right.** The proxy writes a `trip`
log entry only when it actually evicted something, so a request that went over the line and found
nothing it was allowed to take used to read as a small quiet request — case `turn-724` of
`3d1bb98-20260908T232351Z.json` reported 121,463 estimated tokens, past the proxy's then-110k threshold, with
`tripped: false`. The proxy now records the threshold decision on every request entry, and replay
reports it as its own total. It is the failure most worth catching.

The forwarded bodies are session content, so they are written under
`$ONEPASS_EVAL_CORPUS/runs/<label>/replay/`, and only for the requests the report covers — a whole
session's worth would be gigabytes. The result document keeps a digest of each request's stub text
and the first few stubs: enough to detect a wording change and to read it, without hundreds of
kilobytes of near-identical text in git.

## The grader

One call answers one yes/no question about one pair of answers, and returns Yes, No or Unknown.
It is a direct API call through the Anthropic SDK's tool runner, not a Claude Code session, so
every model call the eval makes for itself sits behind the same HTTP boundary the tests fake.

- **Three tools, all read-only** — read a file, search, list — over the repository the answers
  were written against: the case worktree for planning, the finished tail worktrees for
  implementation. Every path is resolved through symlinks and refused if it lands outside that
  repository, and there is no tool that writes.
- **One call per pair, in a random order.** The two answers are shown as A and B in an order
  chosen at random for the pair, and the order is recorded. The grader is never told which arm
  wrote which. Position bias, if there is any, shows in the control-versus-control noise floor
  drifting off an even split — that is what pays for grading each pair once instead of twice.
  (The grader that has actually run — §20, `eval/grade/` — is a separate driver, and it grades
  each pair in both orderings.)
- **Nothing that stopped early hides inside an Unknown.** A call is capped at 40 model turns. A
  capped call is told from a finished one by the final message's stop reason and whether a tool
  call was left unanswered; that call, and one whose text carries no `Verdict:` line, are both
  Unknown *with the reason*. Each prints a warning naming the case, the pair, the question and
  the tool call it was waiting on, and hands back the same words as an entry for the run's
  problems list, which the report prints in full rather than counting. An Unknown the grader
  chose after looking is a verdict, not a problem, and the two are never merged.

## Importing a session

```
node dist/main.js import \
  ~/.claude/projects/-Users-...-chp99-takehome/62d8de7e-c2f3-448d-829f-9d25b23123eb.jsonl \
  --tip b7881712-2e5c-4b77-a409-02ceb65f496f --name planning
```

A run takes its cases from the session filed under `planning`, so that is the name to import it
under; without it, a run refuses and says so rather than measuring nothing.

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
an unproxied control's 64/65. §19 later ran three controls against three proxied runs on the
same task: 64/65 for every control, and 64, 62 and 64 for the proxied runs.

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
