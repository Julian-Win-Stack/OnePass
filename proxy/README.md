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
| `ONEPASS_TRIP_TOKENS` | `150000` | T: new ids are evicted only when the estimated request size (chars ÷ 4, after re-applying existing stubs) exceeds this |

Results smaller than 2,000 chars are never stubbed (fixed constant, not an env var —
stubbing them saves nothing).

## How eviction behaves

- Only `POST /v1/messages` bodies are touched. Everything else — including
  `/v1/messages/count_tokens` — is forwarded verbatim. Responses stream straight through
  (SSE included), never buffered.
- Eviction replaces only the `content` of a `tool_result` block. The block itself,
  `tool_use_id`, `is_error`, user text, assistant text, thinking blocks, system prompt, and
  tool definitions are never touched. `is_error` results are evicted like any other.
- Eviction is **monotonic and batched** to protect prompt caching: the proxy keeps an
  in-memory set of evicted `tool_use_id`s, re-stubs those on every request, and adds new ids
  only when the size threshold T trips — all currently eligible ids at once. The message
  prefix therefore changes once per trip, not every turn. A proxy restart loses the set;
  originals reappear and the cache rebuilds once. Nothing breaks.
- Malformed or non-JSON bodies are forwarded byte-for-byte untouched. A parse failure never
  fails a request.

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

Automated (`npm test`, no network): unit tests for the eviction transform, plus integration
tests that run the proxy against a **recorded stub upstream** — a local HTTP server that
captures exactly what was forwarded. Covered: verbatim forwarding of non-messages paths,
byte-identical `/v1/messages` bodies when nothing is stubbed, stubbing + monotonic re-stub
across requests with a single trip logged, `count_tokens` untouched, malformed bodies passed
through, SSE streamed without buffering (the test deadlocks if the proxy buffers), and a 502
API-shaped error when the upstream is unreachable.

Also verified in a sandbox: the real `claude` CLI (2.1.243) pointed at the proxy via
`ANTHROPIC_BASE_URL`, with a stub upstream answering canned SSE, completed
`claude -p "say hi"` end-to-end — it sent `POST /v1/messages?beta=true` (the query string is
handled), got the streamed response, and printed it.

### Pending local steps (need a real API key / a real long session)

1. **Pass-through parity** (build plan step 1): with your real key,
   `ANTHROPIC_BASE_URL=http://localhost:3777 claude -p "say hi"` must behave identically to a
   direct run.
2. **Real-work measurement** (build plan step 4): run a long task through the proxy, then
   `npm run report -- <that session's .jsonl>`. Targets: zero compactions, a flat
   tokens-sent curve, and a high evicted:recalled ratio. This is also where to verify the
   assumption that Claude Code derives its auto-compact decision from the API's reported
   `usage`, so smaller requests actually prevent compaction.
