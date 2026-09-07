# Onepass

A context-management layer for coding agents: evict aggressively, recall verbatim. This glossary
covers the proxy, recall, and the eval that measures them.

## Language

### Proxy

**Evict**:
Replace a block of the conversation with a stub before the request goes upstream.
_Avoid_: prune, clear, compact, drop

**Stub**:
The short pointer left in place of an evicted block, naming what was removed and how to recall it.
_Avoid_: placeholder, tombstone, summary

**Trip**:
A request whose projected size crossed the threshold, causing new blocks to be evicted.
_Avoid_: compaction, threshold event

**Recall**:
Fetching evicted content verbatim from the session transcript, by search or by id.
_Avoid_: retrieval, memory lookup

**Judge**:
The proxy's own second model that names blocks the rules cannot recognise as dead.
_Avoid_: grader, evaluator (those belong to the eval)

**Rebuild**:
A request the API could not serve from cache because the prefix changed.
_Avoid_: cache miss, cold request

**Imitation**:
A tool call in which the agent copied the stub's shape instead of issuing a real call.
_Avoid_: stub echo, hallucinated call

### Eval

**Arm**:
One run of a task under one condition, proxied or control.
_Avoid_: variant, treatment, branch

**Control**:
The arm with no proxy in the path. Control answers are recorded once and reused across runs;
that stored set is the **control baseline** — the one place "baseline" is the right word.
_Avoid_: raw, unproxied arm

**Corpus**:
Every byte of stored session content the eval reads and writes — transcript copies, fork and
grader outputs, hand labels, the control baseline, case and tail worktrees — under one directory
outside the repository.
_Avoid_: dataset, fixtures, eval dir

**Planning session**:
A session whose artifact is a plan or spec for a repo, produced by discussion with the user.
_Avoid_: discussion session, brainstorming session

**Implementation session**:
A session whose artifact is a diff implementing a plan.
_Avoid_: coding session, task run

**Case**:
One stored request prefix cut at one turn of a session, replayed to produce one model turn.
_Avoid_: example, cut point; and *sample*, which is an answer to a case, not the case itself

**Sample**:
One generated answer to one case. Each case is answered three times: once proxied per build,
twice control.
_Avoid_: run, attempt, generation

**Pair**:
One case scored proxied against control by the grader.
_Avoid_: comparison, matchup

**Noise floor**:
Pairs of two control answers to the same case, showing how much answers differ by luck alone.
_Avoid_: A/A, baseline variance

**Grader**:
The model that scores a pair, seeing the full history including evicted content.
_Avoid_: judge, LLM-as-judge, evaluator

**Tail**:
A forked continuation of a recorded implementation session from its trip point to the end.
_Avoid_: suffix, resume run

**Ground-truth tests**:
Test files from the real human fix, which the agent never sees, run against its implementation.
_Avoid_: hidden tests, reference tests

**Replay**:
A run that pushes the stored prefixes through a fresh proxy child with no model calls, to check
what a build evicts before anything is paid for. Not scored.
_Avoid_: dry run, offline mode, smoke run

**Run label**:
What names one run: the proxy's git short SHA and the time the run started. Every result
document and every run's corpus content is filed under it.
_Avoid_: run id, tag, version

**Result document**:
The JSON one run writes inside the repository, with the rendered table beside it. It is the
whole record of a run: a stranger reads it without reading the code.
_Avoid_: report file, output, results json

### Transcript

A session transcript is a JSONL file under Claude Code's projects directory. These words are for
reading one; both the proxy and the eval read them, and neither ever writes one.

**Branch**:
One path through a transcript file, from a tip back to a root, following each entry's parent. A
session is one branch; a file holds many, because a rewind leaves the path it abandoned in the
file with nothing marking it. Every measurement over a session is made along one branch.
_Avoid_: thread, timeline, chain, history

**Tip**:
The last entry of a branch, which the reader walks back from. Naming one is how a particular
branch is chosen; unnamed, it is the last entry written to the file.
_Avoid_: head, leaf, latest entry

**Typed turn**:
A turn the user typed: a `user` entry that is not sidechain, not `isMeta`, not a compaction
summary, and carries no tool result. The other four are turns too, and are never counted as this
one.
_Avoid_: user turn, prompt, human turn

**Compaction boundary**:
Where a compaction cut the conversation. It is written as a root of its own, off the branch, and
is tied back to it only by the entry it names as the last one it preserved.
_Avoid_: compact point, summary point

**Stretch**:
The run of turns between two compaction boundaries, or between one and an end of the branch.
Each is recorded on some model at some effort.
_Avoid_: segment, phase, era, era of the session

**Usage drop**:
A fall in the context a model turn reports against the turn before it. On the branch this is all
a compaction looks like, so drops and boundaries are matched; a drop with no boundary is reported
unexplained, never assumed to be one.
_Avoid_: context reset, token cliff

**Import**:
Copying one session transcript into the corpus and reading the branch it holds. The copy is what
later stages fork; the original is only ever read.
_Avoid_: ingest, load, snapshot
