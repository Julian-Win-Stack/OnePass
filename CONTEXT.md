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
The arm with no proxy in the path.
_Avoid_: baseline, raw, unproxied arm

**Planning session**:
A session whose artifact is a plan or spec for a repo, produced by discussion with the user.
_Avoid_: discussion session, brainstorming session

**Implementation session**:
A session whose artifact is a diff implementing a plan.
_Avoid_: coding session, task run

**Case**:
One stored request prefix cut at one turn of a session, replayed to produce one model turn.
_Avoid_: sample, example, cut point

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
