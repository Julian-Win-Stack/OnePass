# Onepass

Context management for coding agents. **Work in progress — nothing here is finished.**

## The problem

A long coding session dies of its own context. Claude Code resends the whole conversation every
turn, so the request only grows, and when it hits the limit the session compacts: a model call
that throws away ~95% of the context and takes a couple of minutes, every time. Compaction #2
summarizes summary #1, so the loss compounds — the agent forgets what it decided an hour ago and
starts contradicting itself. Today the way out is to give up on the session and start a new one.

The numbers behind this were measured from 335 real transcripts: see [docs/findings.md](docs/findings.md).

## The idea

Evict aggressively, recall verbatim.

The context does not need to be summarized — it needs to be *addressable*. Most of a request is
old tool results and file contents that are still sitting on disk. Drop them, leave a pointer,
and let the agent fetch the original back word-for-word if it turns out to matter.

## The two pieces

**Recall** (`spike/`) — an MCP server that searches and fetches from the session transcript, so
anything removed from context can be retrieved verbatim. Working.

**The eviction proxy** (`proxy/`) — a local HTTP proxy between Claude Code and the API. Before
each request goes upstream it replaces old tool results, tool inputs, and injected file content
with short stubs, so the context the model sees stops growing and compaction never triggers.
This is what we're building now.

Order matters: recall first, then eviction. Eviction without a way to get content back has to be
timid, which is why it doesn't help.

**The eval** (`eval/`) — replays real recorded sessions with and without the proxy and has a
grader score the answers, to find out whether eviction actually costs the agent anything. This
is how we'll know if it works.

## Status

Not done. The proxy runs and evicts; whether it holds up on real work is the open question the
eval exists to answer. Nothing is published — everything runs locally from a clone.
