# Onepass eviction proxy

A local HTTP proxy between Claude Code and the Anthropic API. Claude Code resends the entire
conversation on every turn; the proxy replaces the content of old, large `tool_result` blocks
with short deterministic stubs before forwarding, so the context the model sees — and the
`usage` numbers Claude Code bases its auto-compact decision on — stop growing. Evicted content
is never lost: the original transcript on disk is untouched, and the recall MCP server in
`spike/` can fetch any of it back verbatim.

Stubs are pointers, never summaries. The stub names the file or command and says how to get
the content back (`Re-read the file …, or recall_search("…")`).

## Run it

```
cd proxy
npm install
npm run build
npm start
```

Then point Claude Code at it (auth is your normal `ANTHROPIC_API_KEY`; OAuth/subscription
sessions are not supported):

```
ANTHROPIC_BASE_URL=http://localhost:3777 claude
```

## Configuration (env vars — this is all of it)

| Variable | Default | Meaning |
|---|---|---|
| `ONEPASS_PORT` | `3777` | Port the proxy listens on |
| `ONEPASS_UPSTREAM` | `https://api.anthropic.com` | Where requests are forwarded |
| `ONEPASS_EVICT_AFTER_TURNS` | `8` | N: a tool result is eligible once ≥ N assistant messages follow it |
| `ONEPASS_PROTECT_LAST_TURNS` | `4` | K: results inside the last K assistant turns are never touched |
| `ONEPASS_TRIP_TOKENS` | `110000` | T: new ids are evicted only when the projected request size, in **real tokens**, exceeds this (measured after re-applying existing stubs). Mid-session, peaks run ~15–20k over T; over hundreds of turns the un-evictable floor (system + last-K turns + small results) adds more — measured peak 146,947 at 289 heavy turns. Size T so `T + 40k` clears your effective compact line (`window − 13k`) |

Results smaller than 2,000 chars are never stubbed (fixed constant, not an env var —
stubbing them saves nothing).

## How eviction behaves

- `POST /v1/messages` and `POST /v1/messages/count_tokens` bodies get the same transform —
  the client's context bookkeeping may consume the count, so it must describe the evicted
  request that will actually be sent, not the raw conversation. Everything else is forwarded
  verbatim. Responses stream straight through (SSE included), never buffered.
- Eviction replaces only the `content` of a `tool_result` block. The block itself,
  `tool_use_id`, `is_error`, user text, assistant text, thinking blocks, system prompt, and
  tool definitions are never touched. `is_error` results are evicted like any other.
- Eviction is **monotonic and batched** to protect prompt caching: the proxy keeps an
  in-memory set of evicted `tool_use_id`s, re-stubs those on every request, and adds new ids
  only when the size threshold T trips — all currently eligible ids at once. The message
  prefix therefore changes once per trip, not every turn. A proxy restart loses the set;
  originals reappear and the cache rebuilds once. Nothing breaks.
- T is denominated in **real tokens**, not chars ÷ 4. The proxy reads the `usage` object out
  of every API response it forwards (stripping `accept-encoding` on those requests so the
  body is scannable) and calibrates a live chars-per-token ratio. Real code runs ~2.5–3.5
  chars per token, so a fixed ÷ 4 under-counts by 25–30% — enough to cross Claude Code's
  compaction threshold while the estimate still looks safe. Until the first sample the
  fallback is a deliberately conservative 3.2.
- **Pressure pass**: a burst of large reads in quick succession is younger than N and
  normally un-evictable. If the normal pass leaves the request over T, the age gate relaxes
  down to K for that trip — only the last K turns are ever untouchable. Without this, a
  chunked file sweep outruns the age gate and the client compacts anyway.
- Malformed or non-JSON bodies are forwarded byte-for-byte untouched. A parse failure never
  fails a request.

## Known Claude Code interactions (measured against 2.1.241)

- **Compaction really does key off API-reported usage.** From the shipped binary: auto-compact
  fires when `input_tokens + cache_creation_input_tokens + cache_read_input_tokens (+ output)`
  from the last assistant message crosses `effective_window − 13,000` (or
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE % × window` when set). Shrinking the request shrinks that
  number; nothing client-side re-measures the original conversation.
- **A localhost base URL downgrades the 1M window.** Pointed directly at
  `api.anthropic.com`, sonnet-class models get a 1,000,000-token window; pointed at
  `ANTHROPIC_BASE_URL=http://localhost:…` the same session reports 200,000. Through the
  proxy, plan for a 200k window (threshold ≈ 187k). The 125k default keeps clear of it.
- **Gzipped request bodies bypass eviction.** With `CLAUDE_CODE_GZIP_REQUEST_BODIES=1` the
  client compresses `/v1/messages` bodies and the proxy forwards `content-encoding` bodies
  untouched by design. Unset it for proxied sessions (local desktop sessions don't set it).
- **Compaction thrash is fatal, not just slow.** If context refills within 3 turns of a
  compact 3 times in a row, the client's `rapid_refill_breaker` aborts the session
  (docs/findings.md §10). Each compact also stalls the session ~90–100s. This is what the
  proxy prevents by keeping reported usage far below the threshold.

## Log

`proxy/proxy.log.jsonl` (next to this file), one JSON object per line: per-request entries
(path, status, sizes, estimated tokens before/after eviction) and per-trip entries (ids
added, chars removed). **Request and response bodies are never logged** — sizes, ids, and
URL paths only. Human-readable mirror lines go to stdout.

## Report

```
npm run report -- ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl [proxy-log-path]
```

Reads the session transcript (read-only) plus the proxy log and prints: compaction count
(target zero), tokens evicted, tokens recalled via `recall_search`/`recall_get`, the
evicted:recalled ratio (the product metric — 100:1 is a real product), and estimated tokens
sent per request over time (flat is good). The proxy log path defaults to
`proxy/proxy.log.jsonl`.

## Verification

Automated (`npm test`, no network): unit tests for the eviction transform (including the
pressure pass), plus integration tests that run the proxy against a **recorded stub
upstream** — a local HTTP server that captures exactly what was forwarded. Covered: verbatim
forwarding of non-messages paths, byte-identical `/v1/messages` bodies when nothing is
stubbed, stubbing + monotonic re-stub across requests with a single trip logged,
`count_tokens` evicted identically, chars-per-token calibration from response usage,
malformed bodies passed through, SSE streamed without buffering (the test deadlocks if the
proxy buffers), and a 502 API-shaped error when the upstream is unreachable.

### Verified against the real API (cloud container, claude 2.1.241, OAuth auth)

- **Real debugging session through the proxy**: two planted bugs in a copy of this codebase,
  fixed character-exact with 22/22 tests green while the proxy evicted the session's early
  context mid-task. The agent re-read files instead of trusting stubs; no confabulation.
  OAuth/subscription auth passes through untouched — an API key is not required after all.
- **The long run** (default config, one session): a 3.3MB four-file TypeScript-declaration
  audit. Raw conversation reached **~1.49M tokens**; sent requests peaked at **146,947**;
  **289 assistant turns, zero compactions, zero turns above 150k**; 75 results evicted; the
  audit completed correctly. An unproxied 200k-window session hard-stops near 187k — this is
  ~8× that in one sitting, with the client's own context gauge staying flat.
  `docs/findings.md` §11 has the full numbers, including the ~130–150 tokens/turn growth of
  the un-evictable floor that eventually bounds session length.

If the repo (or `~/.claude/settings.json`) pins `autoCompactWindow`, remember the proxy
makes that stopgap unnecessary for proxied sessions — a low window like 160k puts the
compact line at ~144–147k, inside the proxy's own peak range. Drop the setting or lower
`ONEPASS_TRIP_TOKENS` so peaks clear it.

### Remaining local step

Run your own long workload through it, then
`npm run report -- <that session's .jsonl>` — targets: zero compactions, a flat
tokens-sent curve, peak real context under your window's compact line.
