# Spike: will the agent actually call recall?

Throwaway. Answers one question, then gets deleted.

**Question:** after its context is trimmed, does the agent choose to fetch the original — or does it answer from the summary and sound confident?

Everything else about Onepass depends on the answer. If the agent won't call recall when it should, offering recall is the wrong product shape and we need to force retrieval instead.

## What's here

| | |
|---|---|
| `src/server.ts` | MCP server exposing `recall_search` / `recall_get` over this session's transcript |
| `nudge.sh` | UserPromptSubmit hook — states that context may be trimmed and originals exist |
| `recall-calls.log` | Every call the agent makes, appended. This is the evidence. |

The nudge states a fact rather than giving an order, on purpose. Ordering the agent to always recall would guarantee a pass and prove nothing.

## Protocol

1. `cd` here, start a **fresh** Claude Code session, approve the `onepass` MCP server.
2. Do real work — enough file reading to build up genuine context.
3. `/compact`.
4. Ask something that **requires detail a summary would not retain**. Good probes:
   - "What was the exact error message when that first build failed?"
   - "What did `src/server.ts` look like before we changed the search function?"
   - Anything needing a literal quote from before the boundary.
5. Read `recall-calls.log`.

## Reading the result

| Outcome | Meaning |
|---|---|
| Called recall, answered correctly | Offering recall works. Build it. |
| Answered confidently without calling | **The core assumption is false.** Retrieval has to be forced, not offered. |
| Called recall but couldn't find it | Search is too weak. Fixable — not a product problem. |
| Said it didn't know | Safe but unhelpful. Better than confabulating; still not the goal. |

## Caveats

- The nudge fires every turn. A real product cannot lean this hard — treat a pass here as the **optimistic** bound.
- N=1 proves nothing. Run it three or four times, on different work.
- Worth also running once with the hook disabled, to see whether the tool description alone is enough.
