# Onepass eviction proxy

A local HTTP proxy between Claude Code and the Anthropic API. Claude Code resends the entire
conversation on every turn; the proxy replaces old, large, recoverable context segments with
short deterministic stubs before forwarding, so the context the model sees — and the `usage`
numbers Claude Code bases its auto-compact decision on — stop growing. Three segment kinds,
a fixed whitelist (measured against real sessions in docs/findings.md §13 — tool results
alone are only ~6% of a real request body):

- `tool_result` blocks
- **attached file content** Claude Code injects as `<system-reminder>` user text after a Read
  — the biggest single mass in real sessions (~20%)
- **task notifications** (`<task-notification>` user messages carrying background-task output)

Everything else is protected by omission: CLAUDE.md instructions, skill/agent listings,
compaction summaries, thinking blocks (the client already manages those via the API's
`context_management` thinking-clearing), and anything the user typed. Evicted content is
never lost: the original transcript on disk is untouched, and the recall MCP server in
`spike/` can fetch any of it back verbatim.

Stubs are pointers, never summaries. The stub names the file, command, or task and says how
to get the content back (`Read the file …, or recall_search("…")`).

Everything runs 100% locally: the proxy forwards requests to `api.anthropic.com` (or your
`ONEPASS_UPSTREAM`) and nowhere else. Your API key or OAuth token passes through untouched,
and request/response bodies are never logged.

## Run it

From a clone of this repo (not published to npm):

```
cd proxy
npm install
npm run build
npm start
```

Or install the bins globally (`npm i -g .` from `proxy/`, which symlinks them to the
working tree) and run `onepass-proxy` in a terminal for as long as you want it.

Then point Claude Code at it — per session, so an ordinary `claude` run is unaffected.
Auth passes straight through: `ANTHROPIC_API_KEY` and subscription OAuth both work
(verified live on CLI 2.1.243 — the CLI does send OAuth credentials to a custom
`ANTHROPIC_BASE_URL`, whatever the docs say):

```
ANTHROPIC_BASE_URL=http://localhost:3777 _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 claude
```

The second variable is load-bearing. Claude Code decides the context window client-side, and
a base URL whose host is not `api.anthropic.com` makes it cap native-1M models (`opus`,
`fable`) at 200k unless the model name ends in `[1m]`. The flag says the upstream really is
first-party — it is, the proxy forwards to `api.anthropic.com`. Details under "Known Claude
Code interactions".

## Configuration (env vars — this is all of it)

| Variable | Default | Meaning |
|---|---|---|
| `ONEPASS_PORT` | `3777` | Port the proxy listens on |
| `ONEPASS_UPSTREAM` | `https://api.anthropic.com` | Where requests are forwarded |
| `ONEPASS_EVICT_AFTER_TURNS` | `8` | N: a tool result is eligible once ≥ N assistant messages follow it |
| `ONEPASS_PROTECT_LAST_TURNS` | `4` | K: results inside the last K assistant turns are never touched |
| `ONEPASS_TRIP_TOKENS` | `110000` | T: new ids are evicted only when the projected request size, in **real tokens**, exceeds this (measured after re-applying existing stubs). Mid-session, peaks run ~15–20k over T; over hundreds of turns the un-evictable floor (system + last-K turns + small results) adds more — measured peak 146,947 at 289 heavy turns. Size T so `T + 40k` clears your effective compact line (`window − 13k`; the window is 1M with `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` in the launch command, 200k without it) |
| `ONEPASS_MIN_SEGMENT_CHARS` | `500` | Segments smaller than this are never stubbed — stubbing them saves nothing |
| `ONEPASS_DUMP_DIR` | unset | Debug only: when set, every request body is written to this directory before eviction. Bodies contain the full conversation — never leave it on |

## How eviction behaves

- `POST /v1/messages` and `POST /v1/messages/count_tokens` bodies get the same transform —
  the client's context bookkeeping may consume the count, so it must describe the evicted
  request that will actually be sent, not the raw conversation. Everything else is forwarded
  verbatim. Responses stream straight through (SSE included), never buffered.
- Eviction replaces only the content of whitelisted segments: a `tool_result` block's
  `content`, an attached-file text block's `text`, or a task-notification user message's
  string content. Block structure, `tool_use_id`, `is_error`, assistant text, thinking
  blocks, system prompt, and tool definitions are never touched — and injected text is
  matched by exact prefix, so CLAUDE.md/skill-listing `<system-reminder>` blocks (same
  envelope, different prefix) are never candidates. `is_error` results are evicted like any
  other. Attached-file stubs name the original file path, recovered from the paired
  `Called the Read tool` reminder; task-notification stubs name the task id and output file.
- Eviction is **monotonic and batched** to protect prompt caching: the proxy keeps an
  in-memory set of evicted segment ids (`tool_use_id` for results, a sha1 content hash for
  text — the client resends originals every request, so hashes re-match), re-stubs those on
  every request (except inside the protected last-K window: content re-attached by a fresh
  Read of an evicted file has the same hash, and stubbing the young copy would break the
  stub's own recovery path), and adds new ids only when the size threshold T trips — all
  currently eligible ids at once. The message prefix therefore changes once per trip, not every turn.
  A proxy restart loses the set; originals reappear and the cache rebuilds once. Nothing
  breaks.
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
- **A non-`api.anthropic.com` base URL downgrades the 1M window** (measured on
  2.1.250–2.1.252). The window is decided client-side: 1M if the model name ends in `[1m]`;
  else 1M only if the model is natively 1M *and* the base URL host is exactly
  `api.anthropic.com` or `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` is set; else 200k. So
  `opus` through `localhost:3777` reports 200,000 while `opus[1m]` reports 1,000,000. Keep the
  flag in the launch command so the window does not depend on which `/model` entry was last
  picked — choosing "Opus 5" there persists plain `opus`. `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
  does not help; it is ignored for known model names.
- **Gzipped request bodies bypass eviction.** With `CLAUDE_CODE_GZIP_REQUEST_BODIES=1` the
  client compresses `/v1/messages` bodies and the proxy forwards `content-encoding` bodies
  untouched by design. Unset it for proxied sessions (local desktop sessions don't set it).
- **Compaction thrash is fatal, not just slow.** If context refills within 3 turns of a
  compact 3 times in a row, the client's `rapid_refill_breaker` aborts the session
  (docs/findings.md §10). Each compact also stalls the session ~90–100s. This is what the
  proxy prevents by keeping reported usage far below the threshold.

## Log

`~/.onepass/proxy.log.<start-time>.jsonl` — one file per proxy run, so reports never mix
metrics from unrelated runs. One JSON object per line: per-request entries
(path, status, sizes, timings, estimated tokens before/after eviction) and per-trip entries
(ids added, chars removed). **Request and response bodies are never logged** — sizes, ids,
and URL paths only. Human-readable mirror lines go to stdout.

### The speed gauge

The proxy can only make a session slower in two ways: its own per-request work, and cache
rebuilds it causes. Four numbers per request show both, in the log and on the stdout line:

| field | what it measures |
|---|---|
| `proxyMs` | the proxy's own work — request body fully read to upstream request sent. Parse + evict + serialize. |
| `upstreamFirstByteMs` | upstream request sent to its first response byte: the wait on Anthropic. Not the headers event — for SSE the headers arrive before `message_start`. |
| `cacheReadInputTokens` | context Anthropic served from cache (from the response `usage`). |
| `cacheCreationInputTokens` | context Anthropic had to process fresh (from the response `usage`). |

`durationMs` is request received to upstream response ended — the whole time the client
waited. (It used to be measured from *after* the eviction work to the response *headers*, so
it under-reported both ends.) `inputTokens` is the uncached remainder, usually small.

A **rebuild** is a request where more than 20% of the context was `cache_creation`: Anthropic
re-read the conversation instead of serving it from cache, costing a few seconds on that one
turn. `rebuild` is set only on those, and says why:

| value | expected? |
|---|---|
| `first` | yes — the session's first request; nothing was cached yet |
| `after-trip` | yes — the proxy swapped segments for stubs, so the conversation changed. One rebuild per trip, by design |
| `after-idle` | yes — over 5 minutes since the previous request, so the cache entry expired |
| `unexpected` | **no** — something is changing the request every turn. A bug in the proxy or the client |

Stdout, one line per request — expected rebuilds are noted in lower case, the unexpected one
shouts:

```
[onepass] 12:01:03 POST /v1/messages 200 | proxy 41ms | first-byte 1.8s | total 9.2s | cache read 141.2k / new 2.1k | est 140k -> 96k tok, 12 stubbed (0 new)
[onepass] 12:01:31 POST /v1/messages 200 | proxy 45ms | first-byte 19.2s | total 27.0s | cache read 0 / new 143.0k | est 140k -> 96k tok, 12 stubbed (0 new)  <- REBUILD (unexpected)
```

Only `/v1/messages` requests over **20,000 estimated tokens** are classified. Claude Code
makes several kinds of call on that path — the conversation itself, plus small side calls
(title generation, warm-ups) that carry their own separate cache prefix. Counting those made
the session's real first request look like an unexplained rebuild, and a rebuild that small
costs no measurable time. `count_tokens` is timed but never classified — it carries no cache
numbers worth reading — though a trip on one is still counted as the cause of the
`/v1/messages` rebuild that follows it. Every request is still timed and logged; the floor
only decides what gets a rebuild verdict.

## Report

```
npm run report -- ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl [proxy-log-path]
```

(or `onepass-report …` with the global install)

Reads the session transcript (read-only) plus the proxy log and prints: compaction count
(target zero), tokens evicted, tokens recalled via `recall_search`/`recall_get`, the
evicted:recalled ratio (the product metric — 100:1 is a real product), a speed summary
(rebuilds by cause, median and max `proxyMs`, median first-byte on cached requests versus
rebuilt ones), and a per-request table carrying those numbers next to the estimated tokens
sent over time (flat is good). The proxy log path defaults to the newest `proxy.log.*.jsonl`
under `~/.onepass/`.

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

### Verified locally (2026-08-25, CLI 2.1.243, subscription OAuth, macOS)

The local pass-through and recall loop are confirmed too — measurements in
[docs/findings.md](../docs/findings.md) §12:

1. **Pass-through parity**: `ANTHROPIC_BASE_URL=http://localhost:3777 claude -p …` behaves
   identically to a direct run, on real subscription OAuth from a local machine.
2. **Recall closes the loop**: a 5-turn session whose raw request size grew to 2.3× the
   armed window ran with **zero compactions**, a flat sent curve, and **evicted:recalled =
   99:1**; an unannounced probe for evicted content was answered exactly, via
   `recall_search`/`recall_get` — disk first, recall second, no confabulation.

## Deploying (this machine)

The global bins are a symlink to this working tree (`npm i -g .`), so a rebuild is all a
deploy needs — then restart `onepass-proxy`:

```
npm test
onepass-proxy
```

It runs in the foreground, one process for as long as you want it. There is deliberately
no launchd/systemd unit: nothing should reach the proxy unless a session opts in, so a
run that forgets the alias is a direct run rather than a silently proxied one.

The package is intentionally not published to npm; a tag-push publish workflow exists in
`.github/` should that ever change.
