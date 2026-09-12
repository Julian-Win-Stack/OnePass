# Onepass

Keep a long Claude Code session in the part of the context window where the agent is still
sharp and I notice that models get dumber as the context fills. 

Onepass is a small proxy that sits between Claude Code and the Anthropic API on your
machine. Before each request goes out, it removes old tool output and file reads that are
still on disk, so the context stops growing. On a real 30-minute implementation task, peak
context went from 284k to 113k. Anything it removes can be fetched back word for word.

If you know how prompt caching works, the obvious worry is that removing anything from the
middle of the context invalidates the cache, so you pay full price for everything after it.
That is real, and it is why Onepass only evicts when at least 20k tokens can go at once, a
handful of times in a session rather than every turn. Most sessions cost about the same: one
that never crosses the threshold is forwarded untouched, and on a 30-minute implementation task
two of three proxied runs came in at the same price as the unproxied ones. The worst case
measured was 1.35x, on the heaviest task in the set, which still served 94% of its input
from cache.

Building this was the easy part. [How I knew it worked](docs/how-i-solved-it.md) is the part
I'd want a reviewer to read.

## Install and run

```bash
npm install -g onepass-proxy
```

Then use `claudep` wherever you would use `claude`:

```bash
claudep                          # a new session
claudep --resume                 # pick up an old one
claudep -c                       # continue the last one
claudep -p "fix the failing test"
```

Every flag passes straight through to `claude`. Open as many `claudep` sessions as you
like at the same time; each one gets its own proxy.

To turn it off, run `claude`. Nothing else on your machine changes.

Works with the `claude` command in a terminal. The desktop app and IDE extensions are not
supported yet. Needs Node 20 or newer.


## What it does

The largest recoverable part of a request is old tool output, the calls that produced it,
and files the agent has read. All of it is still on disk. Onepass replaces the old ones
with a short marker before the request leaves your machine, and leaves the rest alone.

It never touches what you typed or what the model wrote back. Your plan, your decisions
and the conversation itself stay exactly as they were.

The marker is not just a placeholder. It is a message to the agent. It says something was
removed and roughly how big it was, and the agent knows what it means, so it can go and get
the content back. Usually that means simply reading the file again. For things that are not
on disk, like old command output, Onepass gives the agent a tool called recall that fetches
the exact original from the session transcript. The agent decides when to use it; you never
have to.

The session still grows, because your text and the model's stay. Onepass makes a session
much longer, not endless.

## Results

| | Without Onepass | With Onepass |
|---|---|---|
| **Long planning session**, nearly a full day, 57 prompts ([§22b](docs/findings.md)) | Peak 291k tokens, **compacted twice by hand** | Peak 199k tokens, **no compaction** |
| **Implementation task**, 30 min, three runs each way ([§19](docs/findings.md)) | Peak 284k. Tests 64/65 every run | Peak 113k. Tests 64, 62, 64 of 65. Same cost in two runs of three |
| **Terminal-Bench 2.0**, 20 hardest tasks, one run each ([RESULT.md](eval/harbor/RESULT.md)) | 16 passed | 14 passed, a gap inside the noise. Peak context down 30% |

Those two compactions were `/compact` typed by hand, at 173k and again at 291k on a 1M
window. Auto-compaction never fired and never would have. The session was compacted because
it had got worse, not because it ran out of room. The Terminal-Bench numbers are from an
earlier build, before the cost fix in 0.3.0. Full numbers and every caveat are behind the
links above.

## Sharp edges

- **Your key or login passes through to api.anthropic.com and nowhere else.** The proxy
  listens on your machine only.
- **It is not cheaper.** Removing context rewrites Anthropic's prompt cache, so the aim is
  a session that costs about the same.
- **A huge paste in your own message stays.** Your text is never touched, so one big paste
  can outweigh everything else in the session.
- **The agent usually re-reads a file itself** rather than calling recall. Recall is there
  for what is not on disk.

## Why I built it

Sometimes I take on a really big task, and a big task rarely fits in one session. The agent
gets noticeably dumber somewhere past 150k tokens, and the task was never done by then. So I kept starting new sessions, either by writing a handoff file or by letting
compaction run. Both take minutes, and both drop things. A handoff file only holds what I
remembered to put in it. A compaction summary only holds what the model chose to keep.
Decisions from an hour earlier were gone, and the agent started contradicting them.

I wanted the session to just keep going, and to stay sharp while it did. That meant finding out what actually fills the
context, removing only the parts that can be recovered, and then measuring it hard enough
to trust it.

## How it was tested

Three ways, cheapest first. Unit tests on the eviction code, which is plain deterministic
logic. A replay of recorded real traffic through a changed build, with the API faked, which
answers in seconds and is what caught the one expensive bug. Live runs last, to confirm
what the first two already showed. The details are in
[how I knew it worked](docs/how-i-solved-it.md).

## License

MIT
