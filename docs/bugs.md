# The biggest bugs

Bugs only: what broke, how I found it, what fixed it. An open one says so.

## 1. A "turn" is one tool call, and eight of them is two minutes (open)

**What broke.** The proxy ages content in assistant turns, and an assistant turn is one
assistant message, which is roughly one tool call. With N=8, a file the agent read is fair
game eight tool calls later. On a large repo that is two minutes into a planning pass that
reads thirty files across ninety commands. The file is gone while the agent is still using it,
so it reads it again, and the pass becomes a loop. In the agent's words: "Each read was removed
from my view before I could use it, so I read it again."

**How I found it.** Not with the evals. Every eval passed. I found it planning a feature on a
real repo (adforge, 2026-09-21) and waiting an hour for a plan that never came. The proxy log
and the transcript agree:

- Nothing evicted was younger than 8 turns (min 8, median 46 and 89 at the two trips). The
  rule held. The rule was wrong.
- `tasks.py` was read 11 times. 19 re-reads across 9 files. 0 recall calls.
- A Bash call stub is `{}`, so the agent could not see which command it had run. Evicting
  the call saved about 60 chars and cost it that.

**Fixing it.** In progress, in this order: run the same task at N=30, K=15 (env vars, no
code); keep the command text in Bash call stubs; count age in user prompts instead of
messages, so "recent" means "since you last spoke"; evict oldest first and stop once under T,
instead of taking everything eligible at once.

Found alongside: the chars-per-token ratio sat at 2.67 for two hours while the real ratio was
about 3.8, so the proxy believed it was 45% over T when the API said it was under. Tracked
separately.
