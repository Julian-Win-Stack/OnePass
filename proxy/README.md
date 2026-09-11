# Onepass

Run a long Claude Code session to the end without it compacting.

Claude Code resends the whole conversation on every turn, so a long session grows until the
client summarises it away and you lose the detail. Onepass sits between Claude Code and the
Anthropic API on your own machine and replaces old, large, **recoverable** context — tool
results, the calls that made them, files the agent read, background-task output — with short
stubs, so the conversation stops growing. Nothing is lost: the transcript on disk is untouched,
and a bundled MCP server (`recall`) fetches any of it back verbatim when the agent asks.

Measured on real sessions: **~1.49M tokens of raw conversation in one sitting, 289 turns, zero
compactions**, with the task finished correctly. Numbers and caveats under
[Verification](#verification).

## Install

```bash
npm install -g onepass-proxy
```

Needs Node 20+ and the `claude` CLI already on your PATH (2.1.241 or newer).

## Run

```bash
claudep
```

That is the whole thing. `claudep` starts a proxy for this session on a port the operating
system picks, registers `recall` so the agent can fetch evicted content back, runs `claude`
against it, and shuts the proxy down when you quit. Every argument you pass goes straight to
`claude`, so `claudep --resume`, `claudep -p "..."` and the rest all work.

When the session ends it prints one line saying what happened:

```
onepass: evicted 143 segments (~102,318 tokens), recalled 0, compactions 0 (peak ~96,412 tokens)
```

Run as many sessions as you like at once — each `claudep` gets its own proxy, its own evicted
set and its own log, so two sessions can never see each other's history.

## Turning it off

Run `claude` instead of `claudep`. Nothing is installed into your shell, no background service
is left running, and no Claude Code setting is changed — a plain `claude` run has never been
through the proxy.

## Sharp edges

- **Your credentials pass through untouched and go nowhere else.** The proxy forwards to
  `api.anthropic.com` and talks to nothing on the internet but that. It logs sizes, ids and
  paths — **never request or response bodies**.
- **It listens on `127.0.0.1` only.** Anything that can reach the port can spend your Claude
  subscription, so it is not reachable from your network. `ONEPASS_HOST` can move it; think
  twice before you do.
- **Eviction is not free.** Each trip rewrites Anthropic's prompt cache, and a cache write
  costs 12.5× a cache read. The target is a session that *finishes* at roughly what an
  unproxied session costs — not a cheaper session. See
  [`ONEPASS_BATCH_MIN_TOKENS`](#configuration-env-vars--this-is-all-of-it).
- **`CLAUDE_CODE_GZIP_REQUEST_BODIES` disables it silently.** A compressed body is forwarded
  untouched. `claudep` unsets the variable for you; a hand-started proxy cannot.
- **Not a background service.** Nothing should reach the proxy unless a session opts in.

---

# How it works

Four segment kinds are evictable, a fixed whitelist (measured against real sessions in
docs/findings.md §13 — tool results alone are only ~6% of a real request body):

- `tool_result` blocks
- **`tool_use` inputs** — the calls themselves. `Edit` and `Write` carry the whole text they
  wrote; the edit already landed on disk, so the input is as recoverable as the result
- **attached file content** Claude Code injects as `<system-reminder>` user text after a Read
  — the biggest single mass in real sessions (~20%)
- **task notifications** (`<task-notification>` user messages carrying background-task output)

Everything else is protected by omission: CLAUDE.md instructions, skill/agent listings,
compaction summaries, and thinking blocks (the client already manages those via the API's
`context_management` thinking-clearing). **Text the user typed is never touched** — there is no
file to re-read and no command to re-run, so a stub in its place would be the one loss recall
could not undo. Assistant text has no exception either.

Stubs are pointers, never summaries — and they name the target once, not three times. A tool
block stubs to `[onepass: evicted 1,481 chars]` and nothing else: what the block was is
already beside it in the request. A stubbed `tool_use` keeps its `id`, `name` and `type`, and
its `input` becomes `{}` — the smallest object the API will accept, and the only stub shape
with nothing in it the model can copy. Where its result is stubbed too, that result's stub
gains the path the call named (`[onepass: evicted 4,000 chars; call evicted, /repo/x.ts]`), so
the pair still says which file it was; where the result is still live, it names the file
itself. An attached file stubs to `[onepass: evicted
attached file, N chars]`, its path left in the `Called the Read tool` reminder next to it,
which is never evicted. Only a task notification still names its target (`[onepass: evicted
task notification abc123, N chars; output at /tmp/out/task.log]`), because nothing else in
the request carries the task id or its output path. How to get any of it back is one
paragraph in the recall tool's own description, where it is prompt-cached and costs nothing
per turn — so it is not repeated in every stub. Naming the target in every stub is what made
stubs 12% of the measured peak request (docs/findings.md §15). A result now stubs to about 30
chars whatever it held, and a call to 2 — plus the ~30-char suffix its result's stub gains,
which is charged to the call whether the result takes it or not.

A stub is only applied when it saves at least `ONEPASS_MIN_SAVED_CHARS`. The saving is
measured on the finished stub, not the raw segment, so a segment that stubs to no less than
it holds is left alone and never enters the evicted-id set. A `Read` call is the case that
needs this: emptying its input saves almost nothing, and most of that comes straight back as
the path appended to its result's stub.

## Recall

`recall` is an MCP server over the session transcript, shipped in this package and registered
by `claudep` for the session it starts. Two tools — `recall_search` over the session's own
history and `recall_get` for one entry by id — so anything a stub replaced can be fetched back
character-for-character. Its `recall_search` description is where the agent is told what a stub
is and how to get the content back.

It reads the transcript named by `ONEPASS_SESSION_ID`, which `claudep` sets, and never any
other. Without it — a hand-started proxy — it falls back to the newest transcript for the
current directory, which with two sessions open in one repository can be the other session's
history.

The transcript is read-only to Onepass. Nothing here ever writes to one.

## Running the proxy by hand

You do not need this unless you are working on Onepass itself, or driving Claude Code from
something that cannot go through `claudep`.

```bash
onepass-proxy
```

It runs in the foreground until you stop it, and prints the line to launch a session against
it. Auth passes straight through: `ANTHROPIC_API_KEY` and subscription OAuth both work
(verified live on CLI 2.1.243 — the CLI does send OAuth credentials to a custom
`ANTHROPIC_BASE_URL`, whatever the docs say):

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3777 _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 claude
```

The second variable is load-bearing. Claude Code decides the context window client-side, and
a base URL whose host is not `api.anthropic.com` makes it cap native-1M models (`opus`,
`fable`) at 200k unless the model name ends in `[1m]`. The flag says the upstream really is
first-party — it is, the proxy forwards to `api.anthropic.com`. Details under "Known Claude
Code interactions".

One proxy serves one session. Its evicted-id set, its chars-per-token calibration and its log
are per-process, so two sessions sharing a proxy put one session's stubs into the other's
request. `claudep` exists so you never have to think about this.

To register recall by hand, add it to your MCP config with the session id in its environment:

```json
{
  "mcpServers": {
    "onepass": {
      "command": "onepass-recall",
      "env": { "ONEPASS_SESSION_ID": "<the session uuid>" }
    }
  }
}
```

## Configuration (env vars — this is all of it)

| Variable | Default | Meaning |
|---|---|---|
| `ONEPASS_PORT` | `3777` | Port the proxy listens on. `0` asks the operating system for a free one, and the startup banner reports what it got |
| `ONEPASS_HOST` | `127.0.0.1` | Interface the proxy binds. Every request through it carries your Claude Code credentials upstream, so the default is loopback-only; `0.0.0.0` makes it an open relay for anyone who can reach the port. `claudep` pins this to the loopback for its own child whatever the shell says |
| `ONEPASS_UPSTREAM` | `https://api.anthropic.com` | Where requests are forwarded |
| `ONEPASS_EVICT_AFTER_TURNS` | `8` | N: a tool result is eligible once ≥ N assistant messages follow it |
| `ONEPASS_PROTECT_LAST_TURNS` | `4` | K: results inside the last K assistant turns are never touched |
| `ONEPASS_TRIP_TOKENS` | `80000` | T: new ids are evicted only when the projected request size, in **real tokens**, exceeds this (measured after re-applying existing stubs). Mid-session, peaks run well over T: at T=110k the measured peak was 140,253 across 588 assistant turns, with no turn above 150k (docs/findings.md §17). The default moved 110k → 80k once the batch minimum existed, because a lower T then costs a handful of larger trips instead of a swarm of small ones (§21). The un-evictable floor (system + last-K turns + small results) still grows with the session and is what eventually bounds it — once the floor is above T, no value of T brings the peak down: one recorded session peaked at 150,811 tokens at T=110k and at T=80k alike. Size T so `T + 60k` clears your effective compact line (`window − 13k`; the window is 1M with `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` in the launch command, 200k without it) — then watch the alarm line in your log, because `T + 60k` is a rule of thumb and not a guarantee: once the floor is above T the peak is the floor's, and one recorded session peaked at T + 76k |
| `ONEPASS_BATCH_MIN_TOKENS` | `20000` | The least a trip may newly evict. A smaller batch is held back, and that content waits for a later request where the batch has grown past the minimum; `0` turns it off. Every trip rewrites the prompt cache, and a cache write costs 1.25× base input against a cache read's 0.1×, so trips are the proxy's main running cost. Without a minimum, a session whose floor has passed T trips on nearly every request for a few hundred tokens each: on one recording at T=80k, **50 trips in 68 requests, against 1** with the default minimum (§21) |
| `ONEPASS_MIN_SAVED_CHARS` | `50` | A segment is stubbed only when its finished stub is at least this many chars smaller than the content. The stub's own cost decides, so no fixed size floor is needed |
| `ONEPASS_SESSION_ID` | unset | Which session's transcript `recall` reads. `claudep` sets it; without it recall falls back to the newest transcript for the current directory |
| `ONEPASS_DUMP_DIR` | unset | Debug only: when set, every `/v1/messages` and `/v1/messages/count_tokens` body is written to this directory before eviction — other paths are never dumped. Bodies contain the full conversation — never leave it on |

## How eviction behaves

- `POST /v1/messages` and `POST /v1/messages/count_tokens` bodies get the same transform —
  the client's context bookkeeping may consume the count, so it must describe the evicted
  request that will actually be sent, not the raw conversation. Everything else is forwarded
  verbatim. Responses stream straight through (SSE included), never buffered.
- Eviction replaces only the content of whitelisted segments: a `tool_result` block's
  `content`, a `tool_use` block's `input`, an attached-file text block's `text`, or a
  task-notification user message's string content. Block structure, `tool_use_id`, a call's
  `id`/`name`/`type`, `is_error`, user text, assistant text, thinking blocks, system prompt,
  and tool definitions are never
  touched — and injected text is matched by exact prefix, so CLAUDE.md/skill-listing
  `<system-reminder>` blocks (same envelope, different prefix) are never candidates.
  `is_error` results are evicted like any other. An attached-file stub names no path — the
  `Called the Read tool` reminder beside it does, and that reminder is never a candidate;
  task-notification stubs name the task id and output file, which nothing else carries.
- Eviction is **monotonic and batched** to protect prompt caching: the proxy keeps an
  in-memory set of evicted segment ids (`tool_use_id` for results, `call:<tool_use_id>` for
  calls — a distinct id, so stubbing a big call never drags its small result along — and a
  sha1 content hash for text, which re-matches because the client resends originals), re-stubs those on
  every request (except inside the protected last-K window: content re-attached by a fresh
  Read of an evicted file has the same hash, and stubbing the young copy would break the
  stub's own recovery path), and adds new ids only when the size threshold T trips — all
  currently eligible ids at once. The message prefix therefore changes once per trip, not every turn.
  A proxy restart loses the set; originals reappear and the cache rebuilds once. Nothing
  breaks.
- T is denominated in **real tokens**, not chars ÷ 4. The proxy reads the `usage` object out
  of every API response it forwards (stripping `accept-encoding` on those requests so the
  body is scannable) and calibrates a live chars-per-token ratio. Measured on real traffic:
  2.1–2.7 chars per token for `.d.ts`-heavy content and ~3.2 for mixed code, so a fixed ÷ 4
  under-counts by 25–40% — enough to cross Claude Code's compaction threshold while the
  estimate still looks safe. Until the first sample the fallback is a deliberately
  conservative 3.2.
- **Pressure pass**: a burst of large reads in quick succession is younger than N and
  normally un-evictable. If the normal pass leaves the request over T, the age gate relaxes
  down to K for that trip — only the last K turns are ever untouchable. Without this, a
  chunked file sweep outruns the age gate and the client compacts anyway.
- Malformed or non-JSON bodies are forwarded byte-for-byte untouched. A parse failure never
  fails a request.
- **Why a stubbed call keeps nothing.** The stub used to be `{ file_path | command, evicted }`,
  and the model copied it into calls it meant to make — sending `evicted` where
  `old_string`/`new_string` belong, and truncating its own Bash commands at exactly the 80 chars
  this file used to truncate at, on commands the session had never run. 11 occurrences in 588
  turns against **zero** unproxied; the rate tracked the share of the agent's own visible calls
  that were stubbed, and the identical marker text in 361 tool *results* was copied zero times,
  because a result is not written in the agent's voice (docs/findings.md §17–18). Emptying the
  input removes the thing being copied, and an imitated `{}` cannot become a valid call the way
  a kept `{ command }` could.

## Known Claude Code interactions (measured against 2.1.241–2.1.258)

- **Compaction really does key off API-reported usage.** From the shipped binary: auto-compact
  fires when `input_tokens + cache_creation_input_tokens + cache_read_input_tokens (+ output)`
  from the last assistant message crosses `effective_window − 13,000` (or
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE % × window` when set). Shrinking the request shrinks that
  number; nothing client-side re-measures the original conversation.
- **A non-`api.anthropic.com` base URL downgrades the 1M window** (measured on
  2.1.250–2.1.252). The window is decided client-side: 1M if the model name ends in `[1m]`;
  else 1M only if the model is natively 1M *and* the base URL host is exactly
  `api.anthropic.com` or `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` is set; else 200k. So
  `opus` through `localhost:3777` reports 200,000 while `opus[1m]` reports 1,000,000. `claudep`
  sets the flag for you; set it yourself if you launch by hand, so the window does not depend
  on which `/model` entry was last picked — choosing "Opus 5" there persists plain `opus`.
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` does not help; it is ignored for known model names.
- **Gzipped request bodies bypass eviction.** With `CLAUDE_CODE_GZIP_REQUEST_BODIES=1` the
  client compresses `/v1/messages` bodies and the proxy forwards `content-encoding` bodies
  untouched by design. `claudep` unsets it; unset it yourself for a hand-launched session
  (local desktop sessions don't set it).
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

```bash
onepass-report ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl [proxy-log-path]
```

Reads the session transcript (read-only) plus the proxy log and prints: compaction count
(target zero), tokens evicted, tokens recalled via `recall_search`/`recall_get`, the
evicted:recalled ratio (read it as how much the agent had to pay back for eviction, not as
proof recall is carrying the session — on real workloads it is rarely called at all, see
Verification), a speed summary (rebuilds by cause, median and max `proxyMs`, median first-byte
on cached requests versus rebuilt ones), and a per-request table carrying those numbers next to
the estimated tokens sent over time (flat is good). The proxy log path defaults to the newest
`proxy.log.*.jsonl` under `~/.onepass/`.

## Verification

Automated (`npm test`, no network): unit tests for the eviction transform (including the
pressure pass), plus integration tests that run the proxy against a **recorded stub
upstream** — a local HTTP server that captures exactly what was forwarded. Covered: verbatim
forwarding of non-messages paths, byte-identical `/v1/messages` bodies when nothing is
stubbed, stubbing + monotonic re-stub across requests with a single trip logged,
`count_tokens` evicted identically, chars-per-token calibration from response usage, a user's
paste going upstream untouched however far past the threshold it is,
malformed bodies passed through, SSE streamed without buffering (the test deadlocks if the
proxy buffers), and a 502 API-shaped error when the upstream is unreachable. For `claudep`:
an end-to-end launch against a fake `claude` and a fake upstream, asserting the exit code is
passed through, recall is registered for that session id, and the proxy is dead afterwards.
For recall: a real MCP handshake against the built server, answering out of its own session's
transcript with a newer decoy transcript planted beside it.

### Verified against the real API

Newest evidence first; full numbers in `docs/findings.md`.

**On cost, the target is parity, not a saving.** Each trip rewrites the prompt cache, and a
rewrite is charged at 1.25× base input where a cache read is 0.1× — so the tokens a trip saves on
later turns are paid for up front. What the proxy buys is a session that runs to the end without
compacting, at roughly what an unproxied session costs; it is not a way to spend less. A build
that tripped on nearly every request cost about 4× control, which is what the batch minimum
(`ONEPASS_BATCH_MIN_TOKENS`) exists to prevent — docs/findings.md §21.

- **The A/B run against an unproxied control** (§17, CLI 2.1.258, `opus[1m]`, same task, same
  base commit, byte-identical prompt). The current build peaked at **140,253 tokens** over
  **588 assistant turns** with **zero compactions, zero turns above 150k, and zero unexpected
  rebuilds**; p90 context 118,633, and the median climbed only 1.47× from the session's first
  quarter to its last. The previous stub design, same task: 194,659 peak and 96 turns above
  150k. Proxy overhead 9ms median, 17ms max. **Quality held** — 63/65 against the ground-truth
  tests for the third proxied run running, versus 64/65 for the unproxied control.
- **The long run** (§11, cloud container, CLI 2.1.241, OAuth): a 3.3MB four-file
  TypeScript-declaration audit. Raw conversation reached **~1.49M tokens**; sent requests
  peaked at **146,947**; **289 assistant turns, zero compactions**; the audit completed
  correctly. An unproxied 200k-window session hard-stops near 187k — this is ~8× that in one
  sitting, with the client's own context gauge staying flat. §11 also has the ~130–150
  tokens/turn growth of the un-evictable floor that eventually bounds session length.
- **Real debugging session through the proxy** (§11): two planted bugs in a copy of this
  codebase, fixed character-exact with 22/22 tests green while the proxy evicted the session's
  early context mid-task. The agent re-read files instead of trusting stubs; no confabulation.
  OAuth/subscription auth passes through untouched — an API key is not required after all.

**What is still unproven: the recovery path.** Across the three real proxied runs the agent
called `recall_search`/`recall_get` **zero** times — evicted:recalled is 178,594 : 0. It never
needed to: it re-read from disk instead, and never once mentioned eviction, missing context, or
recall. The earlier build put an explicit `recall_search("<path>")` hint in every stub and it
was still never followed. So the eviction half is measured on real work and the recall half is
not; §12's deliberate probe — an unannounced question answerable only from evicted content,
answered exactly — remains the only direct evidence that recall works.

If the repo (or `~/.claude/settings.json`) pins `autoCompactWindow`, remember the proxy
makes that stopgap unnecessary for proxied sessions — a low window like 160k puts the
compact line at ~144–147k, inside the proxy's own peak range. Drop the setting or lower
`ONEPASS_TRIP_TOKENS` so peaks clear it.

### Verified locally (2026-08-25, CLI 2.1.243, subscription OAuth, macOS)

The local pass-through and recall loop are confirmed too — measurements in `docs/findings.md`
§12, in the repository:

1. **Pass-through parity**: `ANTHROPIC_BASE_URL=http://localhost:3777 claude -p …` behaves
   identically to a direct run, on real subscription OAuth from a local machine.
2. **Recall closes the loop**: a 5-turn session whose raw request size grew to 2.3× the
   armed window ran with **zero compactions**, a flat sent curve, and **evicted:recalled =
   99:1**; an unannounced probe for evicted content was answered exactly, via
   `recall_search`/`recall_get` — disk first, recall second, no confabulation.

## Working on Onepass itself

From a clone of this repo:

```bash
cd proxy
npm install
npm run build
npm test
```

`npm i -g .` symlinks the four bins (`claudep`, `onepass-proxy`, `onepass-recall`,
`onepass-report`) to this
working tree, so a rebuild is all a deploy needs. The proxy runs compiled `dist/`, not `src/`,
and reads no git: uncommitted edits go live once built, and switching branches changes what
runs.

Publishing is a tag push — `.github/workflows/publish.yml` publishes this directory on `v*`.
