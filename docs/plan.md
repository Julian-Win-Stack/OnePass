# Build plan: the Onepass eviction proxy

> **Historical — this brief has shipped. Do not build from it.**
>
> Kept as the record of what the proxy was asked to be. For what it actually is, read
> [proxy/README.md](../proxy/README.md) (behavior, env vars, verification),
> [CLAUDE.md](../CLAUDE.md) (current rules), and [findings.md](findings.md) §11–12 (results).
>
> Where the shipped proxy diverges from this brief:
> - **Auth** — §3 says API key only. Subscription OAuth works too; it passes through
>   untouched, so nothing had to be built for it.
> - **Trip threshold** — step 3 says `T` defaults to 150,000 estimated as chars ÷ 4. It is
>   110,000 **real** tokens, live-calibrated from API `usage`; chars ÷ 4 under-counts by
>   25–79%. A pressure pass, not in this brief, relaxes the age gate when a burst of large
>   reads outruns it.
> - **Scope** — §7 rules out packaging, npm publishing, and changes to `spike/`. Two of the
>   three happened: the proxy ships as the `onepass-proxy` package, installed locally and
>   deliberately **not** published to npm, and `spike/` gained the retrieval harness.

Written for a Claude session with **zero prior context**. Everything you need is in this
file. Read it top to bottom before writing any code.

---

## 1. The problem you are solving

A long Claude Code session fills its context window. When it fills, Claude Code
**compacts**: it throws away the old turns and replaces them with a summary. This has two
costs, both measured on real sessions:

- **Time.** A compaction takes ~2 minutes (measured mean 139s). One real session
  auto-compacted 9 times — 20.8 minutes of pure waiting.
- **Intelligence.** 85% of second-and-later compactions summarize a previous summary.
  Detail loss compounds. After the second compaction the model states wrong things
  confidently.

The goal: a user finishes one long task in one session, compaction **never fires**, and
the model never degrades.

## 2. The approach

Stop letting context fill up.

Most of a session's context volume is not conversation — the conversation is under 10% of
it. The bulk is **tool results**: file reads and command output. Most of that is stale.
So: aggressively remove old tool results from what the model sees, and when the model
needs one back, it looks it up.

Three facts make this safe, all established empirically — do not re-derive them:

1. **The full original history is already on disk.** Claude Code appends every message to
   `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl` automatically. Nothing to build.
2. **77% of file paths are read more than once per session.** A stale file read can just
   be dropped — the agent re-reads the file with its normal `Read` tool if needed.
   No infrastructure required for those.
3. **The agent looks things up on its own.** In headless tests (3/3 runs), an agent whose
   context was wiped noticed a needed fact was gone, searched for it, and answered
   correctly. It never fabricated. A recall MCP server already exists and works (see §4).

The economics: evicting one large file read removes ~40,000 tokens from **every
subsequent turn**. Looking one fact back up costs ~300 tokens, **once**. The product
converts a per-turn cost into an occasional cost. The success metric is the ratio
`tokens evicted ÷ tokens recalled` — 100:1 is a real product, 2:1 is nothing.

One more established fact: **the Anthropic API tolerates conversations with tool results
removed.** Claude Code's own binary contains machinery (`clearToolResultsById`, driven by
server-sent `context_hint`s) that does exactly this. You are not testing whether holes are
allowed; they are.

## 3. What you are building

A **local HTTP proxy** that sits between Claude Code and the Anthropic API.

Claude Code sends the *entire* conversation to the API on every turn. Point Claude Code at
the proxy via `ANTHROPIC_BASE_URL=http://localhost:<port>` (auth is a plain
`ANTHROPIC_API_KEY`; do not build anything for OAuth). The proxy rewrites the outgoing
message array — replacing old tool results with short stubs — and forwards to
`https://api.anthropic.com`. Responses stream straight back.

Why this prevents compaction: Claude Code estimates its context usage from the `usage`
numbers the API returns. Smaller requests → smaller reported usage → the auto-compact
threshold is never reached. (Verify this behavior during real-work measurement, step 4.)

## 4. What already exists in this repo

| Path | What |
|---|---|
| `CLAUDE.md` | project instructions and rules |
| `docs/findings.md` | the measured findings cited above |
| `spike/src/server.ts` | working recall MCP server: `recall_search` (multi-term, ranked) + `recall_get` over the session transcript. **Do not modify it.** |
| `.mcp.json` | registers that server with Claude Code |

The proxy is new. Put it in `proxy/` at the repo root: own `package.json` (mirror
`spike/`'s: TypeScript strict, `build` + `start` scripts, minimal deps). Update the
Structure section of `CLAUDE.md` in the same change.

## 5. Build steps

Do them in order. Each has its own verification. Do not start a step until the previous
one's verification passes.

### Step 1 — pass-through proxy (zero behavior change)

A Node HTTP server that forwards **every** request verbatim to `https://api.anthropic.com`:
same method, path, query, headers (drop hop-by-hop headers: `host`, `connection`,
`content-length` — recompute as needed), same body. Stream the response back **without
buffering** — Claude Code uses SSE streaming, and added latency is the one thing the user
will not accept. Forward all paths, not just `/v1/messages` (token counting at
`/v1/messages/count_tokens` and anything else must work untouched).

Log per request: timestamp, path, request body size, response status. **Never log request
or response bodies** — they contain the user's code and conversation.

Verify: `ANTHROPIC_BASE_URL=http://localhost:<port> claude -p "say hi"` with a real API
key behaves identically to a direct run. If no API key is available in your environment,
verify with a stub upstream (a local server that records what it received) and document
the real-key check as a pending local step in `proxy/README.md`.

### Step 2 — eviction v1 (deliberately dumb)

Only for `POST /v1/messages` bodies. Parse the `messages` array. Structure you will find:
alternating user/assistant messages; assistant content includes `tool_use` blocks (with
`id`, `name`, `input`); the *next user message* carries matching `tool_result` blocks
(with `tool_use_id`, `content` as a string or block array).

Policy:
- A tool result is **eligible** for eviction when it is older than `N` assistant turns
  (default 8) — count assistant messages after it — and larger than a minimum size
  (default 2,000 chars; stubbing tiny results saves nothing).
- The last `K` assistant turns (default 4) are never touched regardless of size.
- Eviction means **replacing the `content` of the `tool_result` block** with a stub.
  Never delete the block (every `tool_use` must keep a matching `tool_result` — removing
  one breaks the API's structural validation), never touch `tool_use_id` or `is_error`,
  never touch user text, assistant text, thinking blocks, system prompt, or tool
  definitions.

The stub must be **deterministic** — no timestamps, no randomness — or it will break
prompt caching (§ step 3). Format, including the original size and how to get the content
back:

```
[onepass: evicted Read result for /path/to/file.ts (41,200 chars). Re-read the file for
current content, or recall_search("...") for the output as it was.]
```

Include the file path when the originating `tool_use` input had one (`file_path`,
`path`, `command` — truncate a command to its first 80 chars).

**Implement the transform as a pure function** `(body: unknown) => {body, evictedIds,
charsRemoved}` with no I/O, so it is unit-testable without a server. Test it on
synthetic message arrays covering: nothing eligible, mixed eligible/protected, block-array
`tool_result` content, `is_error` results (evict them like any other), and malformed
bodies (pass through untouched — never crash a request; on any parse failure, forward the
original body unchanged).

### Step 3 — batch eviction (protect the prompt cache)

Prompt caching works on an unchanged message prefix. If eligibility alone decides, every
new turn pushes another result over the age threshold, the prefix changes every turn, and
the cache breaks every turn — making things slower, the one unacceptable outcome.

So eviction is **monotonic and batched**:

- The proxy keeps an in-memory `Set` of evicted `tool_use_id`s. A stubbed id is stubbed on
  every subsequent request, forever. (Ids are globally unique `toolu_…` strings; one set
  is fine.)
- New ids are added only when a **threshold trips**: estimated request size
  (total chars ÷ 4) exceeds `T` tokens (default 150,000). On a trip, add *all* currently
  eligible ids at once. Between trips, stub exactly the ids already in the set and nothing
  else.

Result: the prefix changes once per trip (one cache rebuild), then stays stable for many
turns. Proxy restart loses the set — that's acceptable (originals reappear, cache rebuilds
once, nothing breaks).

Log per trip: ids added, chars removed, estimated tokens before/after. Log per request:
estimated tokens sent. This log is the numerator of the product metric.

### Step 4 — measurement (build the script; the user runs the real test locally)

A script `proxy/src/report.ts` (runnable via `npm run report -- <session-jsonl-path>`)
that reads a session transcript plus the proxy log and prints:

- compaction count (transcript entries with `isCompactSummary` or `compactMetadata`) —
  target **zero**
- total tokens evicted (from the proxy log)
- total tokens recalled (`tool_result`s of `recall_search`/`recall_get` calls in the
  transcript, chars ÷ 4) — together these give the product metric
- request size per turn over time, so a flat line is visible where an unproxied session
  would climb

## 6. Hard rules

- TypeScript strict. **Never `any`** — the real type, `unknown` at boundaries, unions, or
  generics. `catch (err: unknown)` and narrow.
- Simplest thing that works. Functions over classes. No config system — `N`, `K`, `T`,
  port, and upstream URL as env vars with the defaults above, nothing more.
- Comments only where a competent reader would otherwise get it wrong.
- Obvious names (`evictedToolUseIds`, not `ids`).
- Transcripts under `~/.claude/projects/` are **read-only**. Never write to them.
- No commit, no push, unless the user explicitly says so in that turn.
- If you hit a genuine product decision this plan doesn't cover, stop and ask — don't
  pick a default silently.

## 7. Out of scope — do not build

- **No summarization anywhere.** A stub is a pointer, never a summary. Summarizing inside
  eviction rebuilds the exact bug this project exists to remove.
- No embeddings, no semantic search. Keyword recall is proven sufficient.
- No OAuth/subscription auth work. API key only.
- No UI, no packaging, no npm publishing.
- No changes to `spike/`.
- No eviction of user/assistant text or thinking blocks — tool results only.

## 8. Done means

1. `proxy/` builds clean (`npm run build`) with zero type errors.
2. Unit tests for the eviction transform pass (`npm test`).
3. Pass-through verified (real key if available, recorded-stub otherwise, per step 1).
4. `proxy/README.md` documents: how to start it, the env vars, and the exact local
   verification steps the user runs on their machine (steps 1 and 4 checks).
5. `CLAUDE.md` Structure/Commands sections updated for `proxy/`.
