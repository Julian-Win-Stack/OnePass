# Baseline measurements

Everything here was measured from local Claude Code transcripts under `~/.claude/projects/`.
No published source has these numbers. They are the starting evidence for Onepass.

Sample: 335 transcript files. 132 sessions contained at least one compaction, 205 compactions total.
§§9-10 are different: they come from a controlled harness run, not from mined sessions.

## 1. Compaction is recursive

For compaction #2 and later, **85%** preserve a message window that begins *after* the previous
summary (n=73). Everything older is represented only by the prior summary.

So compaction #2 summarizes summary #1. Loss compounds.

This is the core claim behind Onepass and it is now measured, not assumed.

## 2. Compaction is slow and extremely lossy

| | median | p90 | max |
|---|---|---|---|
| duration | 129s | 152s | 377s |
| tokens before | 188,491 | 321,732 | 453,242 |
| tokens after | 10,221 | 13,834 | 19,417 |

Average reclaim: **95%**. Worst observed session ran 14 compactions — roughly 30 minutes of
pure waiting.

The post-compaction context is not small-and-clean, it is **starved**. ~10k is far below the
working set a real task needs.

## 3. Claude Code's own tool-result clearing effectively never fires

Microcompact is documented as on-by-default and clears old tool results without a model call.
Searching every transcript for its placeholder string:

```
"Old tool result content cleared"  →  2 occurrences, in 1 of 335 sessions
```

Whatever the intended behavior, it is not preventing context growth in practice.

## 4. Where the tokens actually go

Across the 12 largest transcripts (~9.5M estimated tokens):

| block type | share |
|---|---|
| tool_result | 43.5% |
| thinking | 23.2% |
| image | 15.7% |
| tool_use | 8.2% |
| text (conversation) | 9.3% |

The conversation — the part compaction summarizes — is under a tenth of the volume.

## 5. Repeated file reads dominate file traffic

152 distinct file paths, **77%** read more than once. Keeping only the most recent read per
path reclaims **89%** of file-addressed tool-result tokens.

## 6. Trash removal alone does not prevent compaction

Composition of context at the moment of the first compaction in one long session:

| | share |
|---|---|
| superseded tool results | 15.3% |
| **tool results still valid** | **55.4%** |
| thinking | 13.5% |
| conversation | 15.7% |
| images | 0% (no browser use in this session) |

Removing only provable trash reclaims **29%** — 430k becomes ~306k. Compaction still fires.

The majority of context is data that is still valid. It cannot be dropped safely *unless it can
be retrieved again*. This is why recall has to come before aggressive eviction, not after.

## 7. Prompt caching carries almost everything

Across the 6 largest sessions:

| | tokens |
|---|---|
| cache read | 577,405,678 |
| cache creation | 23,389,193 |

**25:1.** Any client-side edit to the middle of the message array invalidates the cache from
that point on. Eviction and caching are in direct tension; eviction must happen in batches at
boundaries, not continuously.

Anthropic's server-side context editing does **not** avoid this, and an earlier version of this
section said it did. Their own documentation is explicit — tool-result clearing invalidates the
cached prompt prefix — and the `clear_at_least` parameter exists for exactly that reason: it holds
an edit back until it would remove enough to be worth the rewrite it forces. Server-side or
client-side, editing the middle of the message array costs a cache rewrite. The only defence is to
edit rarely and remove a lot each time, which is what §21's batch minimum does.

## 8. The agent never reaches for its own transcript

Across 334 transcripts, zero instances of an agent spontaneously reading its own session
`.jsonl` after compaction. The originals are on disk and complete; nothing tells the agent they
exist or where they are.

## 9. Keyword recall vs. librarian subagent

The first head-to-head between the two retrieval shapes. Rig: [spike/harness](../spike/harness)
— a 4-turn session that reads a 40-module build manifest, has the manifest deleted underneath it,
reads ~110k tokens of trace logs to blow past the 100k autocompact threshold, then is asked for
one module's build hash. Both arms were told which mechanism to use.

| | keyword MCP | librarian subagent |
|---|---|---|
| lookups | 3 | 1 |
| empty lookups | 0 | 0 |
| tokens returned into main context | 2,009 | **110** |
| wall clock for the lookup | <1s | **41s** |
| answer correct | yes | yes |

The librarian's 110 tokens were a single verbatim line with its location, exactly to spec. But
producing them cost **13,957 tokens across 8 tool calls** inside the subagent. The trade is
18x less context pollution for ~40x the latency and ~7x the total tokens.

On tokens evicted / tokens recalled against a 40,000-token eviction: **~364:1** librarian,
**~20:1** keyword.

Structural limit found while building the librarian arm: **a subagent cannot use a tool the
session's own allowlist excludes.** So the caller can always do by hand whatever the librarian
does — the librarian buys context hygiene, never capability. An unforced comparison is not
possible in this rig for that reason; both arms were told which mechanism to use.

The librarian prompt was corrected after this race: it now tells the subagent to undo JSON string
escaping when copying an excerpt out. The numbers above stand — the retrieved value was a build
hash, which escaping leaves untouched — but an excerpt containing quotes, backslashes, or newlines
would have come back escaped.

## 10. Claude Code aborts the turn when compaction thrashes

Filling context fast enough triggers a circuit breaker, not a slow compaction:

> Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous
> compact, 3 times in a row.

The turn exits `rc=1` with `terminal_reason: "rapid_refill_breaker"` and the user is told to
`/clear`. It fired on both fill turns, in both arms, in every run. Each run logged 14
compactions.

This is the sharpest statement of the problem Onepass exists to solve: under real pressure
compaction does not merely degrade the session, it ends the turn.

## 11. The eviction proxy against the real API: 1.49M raw tokens, zero compactions

Verified in a cloud container with real authenticated `claude` (2.1.241) sessions routed
through the proxy to `api.anthropic.com`. Four results, in increasing order of weight:

**The client's compaction decision is exactly the number the proxy shrinks.** From the
shipped binary: auto-compact fires when `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens + output_tokens` from the last assistant message crosses
`effective_window − 13,000` (a `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and a ~10% precompute
buffer can lower it). Nothing re-measures the original conversation. `usage` in, decision
out — the proxy owns the input.

**A real debugging session survives eviction.** A session given a repo with two planted
bugs fixed both correctly (character-exact fixes, 22/22 tests) while the proxy stubbed its
early context mid-task. It re-read files and re-ran commands instead of trusting stubs —
disk first, exactly as §8 predicted — and never confabulated. The same session shape under
an artificially low compact threshold (30%) reproduced §10's `rapid_refill_breaker` abort
when run *without* headroom for eviction: the un-evictable floor (system + tools + last-K
turns) sat above the threshold, so compaction refilled instantly, three times, and the
client killed the turn. Eviction cannot rescue a threshold set below the floor.

**Chars ÷ 4 is not a safe unit.** Measured chars-per-token on real traffic: 2.1–2.7 for
`.d.ts`-heavy content, ~3.2 for mixed code — a fixed ÷ 4 under-counts by 25–40%. The proxy
now calibrates the ratio from each response's `usage` and denominates its threshold in real
tokens. Two client behaviors force sibling fixes: responses arrive compressed unless
`accept-encoding` is stripped, and `count_tokens` requests must be evicted identically or
they describe a conversation that will never be sent. One more: pointing the client at a
base URL whose host is not `api.anthropic.com` silently drops native-1M models to 200k.
Read out of the 2.1.252 binary and confirmed live: the window is decided client-side — 1M
if the model name ends in `[1m]`, else 1M only for a native-1M model on a first-party host,
else 200k. `opus` through `localhost:3777` reports 200,000; `opus[1m]` reports 1,000,000;
`opus` plus `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` reports 1,000,000. The Aug 25–26
dogfood sessions ran plain `opus` (a `/model` pick of "Opus 5" on Aug 25 persisted it), so
their compactions were this 200k window at work; unproxied they would have had 1M and never
compacted. The flag now lives in the `claudep` alias.

**The long run.** A 3.3MB / four-file audit sweep (68,617 lines of TypeScript lib
definitions), default proxy config, clean environment, one session:

- raw conversation grew to **~1.49M tokens**; requests actually sent peaked at **146,947**
- **289 assistant turns, zero compactions, zero turns above 150k** (goal line)
- 75 tool results evicted along the way; the task finished correctly (324 accurate audit
  bullets + summary, exit 0)

An unproxied 200k-window session hard-stops near 187k — this session processed **~8×** that
in one sitting with the context gauge flat. The remaining structural limit: the un-evictable
skeleton (assistant text, sub-2,000-char results) grows ~130–150 tokens per turn, which
lifted the sent-size floor from ~90k to ~137k over 289 turns. At this workload shape the
150k line survives to roughly turn 330; past that needs aged-small-result eviction or a
lower K. That, not summarization quality, is the next lever.

## 12. Recall closes the loop: an unannounced probe is answered from evicted content

One 5-turn synthetic session (opus, CLI 2.1.243, subscription OAuth, autocompact window
160k, aggressive `T=50000-est N=2 K=1`): read a 16 KB build manifest, delete it from disk,
read six ~220 KB trace logs, then ask for one manifest row's hash — with no hint that
anything was evicted or that recall exists. The stub in context is the only announcement.

- **0 compactions.** Raw request size grew to **365k estimated tokens** (2.3× the armed
  window); sent stayed in a **33k–50k est sawtooth** (~60–90k API-reported). 49 requests,
  20 trips, 29 results evicted, 6.87M tokens kept out of requests cumulatively.
- **Evicted : recalled = 99 : 1** — ~3,227 tokens recalled to answer the probe against
  ~318k evicted.
- **The unannounced probe passed.** Sequence: Grep cwd (nothing) → Read the manifest (gone)
  → Glob (traces only) → `recall_search` → `recall_get` → exact hash, correctly attributed
  to session history. Disk first, recall second, no confabulation — same pattern as the
  spike, now without any announcement. This resolves the open question behind §8.
- **Auto-compact is driven by API-reported `usage`, confirmed from both directions.** A
  mis-calibrated attempt let full bodies through: compaction fired at
  `compactMetadata.preTokens: 140831` against the 160k window (fire margin ≈ 88%). The
  rerun held raw history at 2.3× the window while reported usage stayed ~90k: no
  compaction. Matches the binary-derived formula in §11.
- chars÷4 underestimated API tokens **~1.79×** on this digit-heavy noise (est 78,742 when
  the API counted 140,831) — the worst ratio observed, past §11's 25–40% on real code.
  This run is part of why the trip threshold is now denominated in calibrated real tokens.

## 13. The proxy fails in the wild: tool results are 6% of a real request body

First real-workload deployment (mastra repo, session `32ac31eb`, 1.37 MB / 625 entries,
proxied end to end) compacted twice — `preTokens` 165,358 (manual) and 174,211 (auto) —
while the proxy ran correctly the whole time: 8 trips, every one removing only 1.2–10.5%
of the body. Mechanically sound, aimed at the wrong mass.

**Tool results were never the payload.** The session's 73 tool results total 95,930 chars
— median 845, 57/73 under the old 2,000-char floor, 91% small Bash output. Composition of
the peak request (466,219-byte body ↔ 165,200 API-reported tokens, 2.82 chars/token):

| segment kind                        | chars   | share |
|-------------------------------------|---------|-------|
| attached files (Read `<system-reminder>` injections) | 94,110 | 20% |
| thinking blocks                     | 87,930  | 19%   |
| user-role strings (task notifications, queue echoes) | 52,957 | 11% |
| tool_results                        | 29,102  | 6%    |
| tool_use inputs                     | 20,375  | 4%    |
| other `<system-reminder>` text (claudeMd, listings)  | 18,388 | 4%   |

Plus a fixed prefix no proxy can touch: on this session's Claude Code build, a 162,269-char
tools array (~50k tokens after caching) and ~30k chars of system prompt. **Stale as of
2.1.258:** MCP tool schemas are now deferred behind ToolSearch and the whole fixed prefix
measures 42,284 tokens exact — see §15.

**Wire formats, measured from captured request bodies** (a `ONEPASS_DUMP_DIR` mode now
records them): an attached file is a user text block starting `<system-reminder>\nResult
of calling the Read tool:`, its path recoverable from a preceding block starting
`<system-reminder>\nCalled the Read tool with the following input:`. Task notifications
are whole-string user messages starting `<task-notification>`, carrying `<task-id>` and
`<output-file>` tags. Crucially, CLAUDE.md instructions, skill/agent listings, and MCP
instructions are *also* `<system-reminder>` user text — indistinguishable by envelope, so
eviction must be a prefix whitelist, never "evict big injected text."

**Thinking is off-limits and already handled.** Every request carries
`context_management: {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` — the
client manages thinking blocks through API-native context editing (and signatures make
them untouchable anyway). That 19% is not the proxy's to take.

The fix this measured: eviction now targets the whitelist of three segment kinds — tool
results, attached-file injections, task notifications — identified by `tool_use_id` or
sha1 content hash (the client resends originals every request, so hashes re-match for
re-stubbing), with the size floor dropped 2,000 → 500 chars. On this session's shape that
is ~55k reclaimable tokens at peak: 174k → ~119k, under the compaction line.

**Live validation of the fix** (haiku, CLI local, 10-turn attachment-heavy session in the
mastra repo, dev proxy, `T=80000`): raw request size grew to an estimated **184,676 tokens**
— past the size at which the failing session compacted — while sent stayed at 77–126k.
**0 compactions; peak API-reported usage 147,575; 0 turns above 150k.** 6 trips evicted 6
segments (5 attachments by content hash, 1 tool result; 381,137 chars), all via the
pressure pass — an attachment burst is always younger than N, exactly the §11 prediction.
Both recovery paths fired unprompted: a probe about the first (evicted) file was answered
correctly via `recall_search`, and re-attaching that file showed live content, not an
instant re-stub — the protected-window guard on hash re-matching doing its job.

## 14. A single paste is unevictable and can outweigh the whole session

Onepass dogfood session `c5fe03c4` (this repo, 2026-09-01): context per API call held at
65–83k across eleven turns of file reads and jq, then jumped to **338k in one turn** and
stayed there. The turn was a user message containing a pasted session transcript.

| source                                    | chars   |
|-------------------------------------------|---------|
| that one pasted user message              | 482,247 |
| every tool result in the session combined | 16,190  |
| every other user message                  | < 2,000 each |

The paste is a `user` text block. It is not a tool result, not an attached-file injection,
not a task notification — none of the §13 whitelist matches it, so the proxy will resend
it on every request for the life of the session. ~250k tokens, permanent. The 65k floor
before any turn is the system prompt (CLAUDE.md files, skill listing, tool schemas) and
is likewise untouchable.

Open question, not decided: whether large user-authored text blocks belong on the
whitelist. They are not "still-valid data that can be re-fetched" in the §6 sense — the
user typed them — but they are recoverable from the transcript via recall like anything
else.

**The transcript format is ~4× its readable content.** The pasted session
(`60c36691`, 483,181 bytes) contains 125,666 chars of user/assistant text and tool-result
content — 26%. Of the rest, thinking-block `signature` fields alone are 72,471 bytes
(15%), `toolUseResult` duplicates each tool output once more (13,321), and the remainder
is envelope: uuids, `usage` objects, hook summaries, listing attachments. Two
consequences: `recall_get` must return extracted text, never a raw line, or one recall
costs 4× what it should; and any chars÷4 estimate over raw transcript bytes overstates
readable content by the same factor.

## 15. The peak request, measured exactly: half of it is the model's own replies

The proxied arm of the A/B run (mastra#18877, session `0865d8fc`, claude-opus-5, Claude Code
2.1.258, 2026-09-02, 263 requests) peaked at **196,163 tokens** per API `usage` (input +
cache read + cache creation). Transcript char counts ÷ 2.95 explained ~71k of it and left
~125k (64%) as an unmeasured residual. This section replaces the residual.

Method, cheap-first. (a) The fixed prefix is identical on every request, so a one-turn `-p`
session in the same cwd with the same flags ("reply OK, call no tools") measures it exactly
from `usage`; the body was dumped with `ONEPASS_DUMP_DIR` for the char breakdown. (b) Every
assistant reply is resent on every later request, and the transcript records each reply's
exact `output_tokens`, so the replayed-output row is a sum, not an estimate. (c) Tool-result
tokens use a rate measured from `usage` deltas between consecutive requests that had no
trip and nothing but tool results in between (184 such steps: 446,830 bytes → 198,403 tokens,
**2.252 bytes/token**; 71 results under 300 bytes cost a mean 64 tokens each — the
per-`tool_result` envelope floor). Total probe cost ≈ $0.80.

| part of the 196,163-token peak                          | tokens  | how known |
|---------------------------------------------------------|---------|-----------|
| fixed prefix (tool schemas, system prompt, CLAUDE.md reminder, skills/agents listing) | 42,284 | exact, probe `usage` |
| model output replayed (thinking + text + tool_use, 248 replies) | 99,141 | exact, Σ `output_tokens` |
| — of which thinking (76 replies)                        | ~25,000 | estimate: remainder after 2.243 bytes/token calibrated on the 172 no-thinking replies |
| — of which text + tool_use (166,194 bytes)              | ~74,000 | same calibration |
| tool_result kept (156 results, 51,538 bytes)            | ~22,900 | bytes ÷ 2.252 |
| eviction stubs (134, ~180 tokens each incl. ~64 envelope) | ~24,000 | estimate ±3k |
| user prompt                                             | ~100    | — |
| unexplained                                             | ~7,500 (3.8%) | prefix drift between run and probe; request-time `<system-reminder>` text the transcript does not record |

Three corrections to the old table. The `tool_use` + `text` rows were ~42k; they are ~74k.
Thinking is ~25k, not the 55k predicted beforehand. And the prefix is 42k, not 60k.

**Replayed thinking is billed at its generated count; signatures are free.** Two-turn probe:
a reply with thinking, then one more request. Predicted input growth ≈ 260 (that reply's
`output_tokens` + envelope); measured +262. The 115,764 bytes of signatures in the peak body
cannot be billed — at any plausible rate they would push the sum past the peak. Since
Claude Code sends `thinking: {type: "adaptive", display: "omitted"}`, the request body never
contains thinking text at all, only signatures; the transcript's empty `thinking` fields
are not stripping, the text was never sent back.

**The prefix, char by char** (121,448-byte body): tools 68,357 (15 schemas), system-role
message 27,711 (deferred-tool names + skills/agents listing), system 13,307 (4 blocks, cache
breakpoints on the last two), CLAUDE.md `<system-reminder>` 11,638. Three configuration facts
fall out of it:

- **MCP servers are not a lever.** With `--strict-mcp-config` and an empty config the prefix
  is 41,703 — every connected MCP server together costs **581 tokens**. Claude Code 2.1.x
  sends one 214-char `DeferredToolPlaceholder` schema plus a names list and loads real
  schemas through ToolSearch on demand. "Trim MCP servers" saves nothing.
- **`--allowedTools` does not shrink the schema list.** It is a permission list. 10 of the 15
  schemas sent (57,902 chars) were for tools the run could not call; Artifact alone is 37,365
  chars.
- **`--tools "Read,Edit,Write,Glob,Grep,Bash"` cuts the prefix to 19,834 tokens** (exact,
  −22,450 per request, no code). Side effects: Skill, Agent, ToolSearch and the skills listing
  go with it, and without ToolSearch the MCP schemas are inlined (21 schemas, 30,610 chars,
  already inside the 19,834).

**Stubs are 12% of the peak.** 134 stubs at ~180 tokens each, ~64 of which is the
unavoidable `tool_result` envelope. The stub text is the proxy's own and can be shortened.

Cross-check on the control arm (same task, no proxy): the same method gives thinking ≈ 30k
and tool results of 473,755 bytes dominating — consistent with §4's raw-content picture and
with §13's claim that after eviction, tool results are a small share.

## 16. Evicting the calls too: 196k -> 144k peak on the same task, quality unchanged

The proxy evicted three segment kinds and stalled about 15 minutes into a real task, having
consumed ~87% of what it was allowed to touch. `tool_use` inputs — the calls themselves —
were the largest untapped pool: an `Edit` carries the whole text it wrote, a `Bash` call the
whole command, and both are recoverable exactly as results are (the edit landed on disk, the
command ran). Adding them as a fourth kind is the change measured here.

**The A/B.** Same mastra task (#18877), same `opus[1m]` / `--effort xhigh` /
`--permission-mode acceptEdits`, same `--allowedTools`, same base commit `a14c2436bc`, same
byte-identical prompt. Run 2 is the three-kind proxy; run 3 the four-kind proxy on defaults
(N=8, K=4, T=110,000, floor 500). Only the proxy code differs.

| | Run 2 (3 kinds) | Run 3 (4 kinds) |
|---|---|---|
| Peak context (API `usage`) | 196,163 | **143,882** |
| Assistant turns above 150k | 112 | **0** |
| Median context | 114,983 | 105,101 |
| p90 context | 182,189 | 133,520 |
| Compactions | 0 | 0 |
| Assistant turns | 425 | 424 |
| Ground-truth tests | 63 / 65 | 63 / 65 |
| Trips / segments / chars removed | 64 / 134 / 474,021 | 74 / 197 / 608,528 |
| Unexpected rebuilds | 2 | 0 |
| Proxy time per request | 9ms median, 65ms max | 8ms median, 28ms max |

**The written-down prediction was 34k too conservative, and the reason is the finding.**
Predicted peak ~178,200, from a static calculation over run 2's own transcript: 48 of its 290
calls clear the 500-char floor, 77,278 chars of input stubbing to 19,804, net 57,474 chars
(~17,961 tokens at 3.2 chars/token). Measured peak was 143,882. The gap is compounding —
run 3 evicted 197 segments to run 2's 134, of which only **50 were the new kind**; the other
147 were results and text, 13 more than run 2 managed. Freeing headroom lets the proxy do
more of what it already did. A static per-segment sum is a floor on the win, not an estimate
of it.

**Smaller, not flat.** The goal is small *and* flat, and this delivers only the first half.
Early-quarter to late-quarter median went 96,428 -> 162,483 in run 2 (1.69x) and
82,874 -> 132,269 in run 3 (1.60x). The curve moved down, it did not lie down. Context still
roughly doubles across a 28-minute session, and the un-evictable skeleton named in §11
(assistant text, thinking signatures, sub-floor results) is what remains under it — §15
measures that skeleton exactly.

**No sign of quality cost, at n=1 per arm.** Both runs score 63/65 against the ground-truth
tests from the human fix `faee052a3c`, and both fail the *same* two: the `supportsChannelState`
capability fallback (35/36 core, also failed by the unproxied control) and the composite
`by_owner_key` index shape (28/29 convex). Two identical scores are a tie, not evidence of
safety; §9's variance note applies.

**The stub can cost more than it saves, and the log used to hide it.** A call stub names the
file path three times — the kept `file_path`, the prose, and the `recall_search` query — so a
modest input under a deep path stubs to *more* chars than it replaces, and monotonic eviction
re-pays that on every later request. The proxy now applies a stub only when the finished stub
is smaller than what it replaces, across all four kinds, and reports the difference honestly
rather than clamping it to zero. It costs nothing on real traffic: 0 of run 2's 48 over-floor
calls are skipped by the guard. Break-even depends on how big the input is, and for an input
near the floor (~540 chars) it needs a path of ~121 chars, where the longest path among run 2's
48 over-floor calls is 97.

**The API accepts an off-schema `input`.** This was the one place the design could have
failed. A stubbed `tool_use` keeps `id`, `name` and `type` and carries
`{ file_path | command, evicted }` — not the tool's own schema. Across a scripted probe (8
requests) and run 3 (279 requests) there were no 4xx. In the probe the agent answered a
question about a file whose `Write` and `Edit` calls had both been stubbed out of its
context, reading the still-present `cat` output instead of confabulating — §8 and §12's
disk-first behaviour again, this time with the call gone rather than the result.

## 17. Cheap stubs: 195k -> 140k peak, a flatter curve, and the judge's first accepted pick

§15 measured the proxy's own stubs at 12% of the peak request — 134 of them at ~180 tokens
each, the largest single thing in the request they exist to shrink. Each named its target
three times: the kept `file_path`, the prose, and a `recall_search` query repeating the path.
The change measured here removes all three. A result stubs to `[onepass: evicted 2,000 chars]`
(~30 chars), the recovery instructions move once into the recall tool's own description where
prompt caching pays for them, and — because the stub is now cheap — the fixed 500-char size
floor becomes wrong rather than blunt. `ONEPASS_MIN_SEGMENT_CHARS` (500) is replaced by
`ONEPASS_MIN_SAVED_CHARS` (50), measured on what the finished stub actually saves.

**The A/B.** Same mastra task (#18877), same base commit `a14c2436bc`, same plan, same
`opus[1m]` / `--effort xhigh` / `--permission-mode acceptEdits`, same `--allowedTools`, same
byte-identical prompt. Run 4 is the verbose-stub build, run 5 the cheap-stub build. Both ran
with the judge on. Only the proxy code differs.

| | Run 4 (named stubs, floor 500) | Run 5 (cheap stubs, floor 50) |
|---|---|---|
| Peak context (API `usage`) | 194,659 | **140,253** |
| Assistant turns above 150k | 96 | **0** |
| Median context | 110,000 | 103,725 |
| p90 context | 177,312 | **118,633** |
| Early-quarter -> late-quarter median | 86,883 -> 171,452 (1.97x) | 80,146 -> 118,003 (**1.47x**) |
| Compactions | 0 | 0 |
| Assistant turns | 556 | 588 |
| Wall clock | 38.0 min | 35.0 min |
| Trips / segments / chars removed | 93 / 221 / 523,475 | 79 / **560** / **706,790** |
| Ground-truth tests | 63 / 65 | 63 / 65 |
| Unexpected rebuilds | 4 | **0** |
| Proxy time per request | 9ms median, 25ms max | 9ms median, 17ms max |

**The floor, not the stub text, is where the volume came from.** 560 segments evicted against
221 — 2.5x — on a run that did *more* work, not less. A cheap stub is what makes a 50-char
floor safe: under the old floor a 300-char result was not worth a 300-char stub, and under the
new one it is worth a 30-char one. The stub text saving is real but second-order; the floor it
unlocks is the finding, and it is the same compounding effect §16 named — freeing headroom
lets the proxy do more of what it already did.

**It moved the tail, not just the peak.** §16 reported the curve moving down without lying
down (1.60x early-to-late). This is the first build where the tail collapses too: p90 falls
177,312 -> 118,633 and no turn crosses 150k, against 96 turns in run 4. Peak and p90 converge
to within 22k of each other, which is what "flat" looks like when it starts to arrive.

**Quality is unchanged, at 63/65 for the third proxied run running.** Runs 3, 4 and 5 all
score 63/65 against the ground-truth tests from the human fix `faee052a3c`, all failing the
same two: the `supportsChannelState` capability fallback (35/36 core — also failed by the
unproxied control) and the composite index shape (28/29 convex). The control scored 64/65.
Three identical scores across three different stub designs is a tie, not proof of safety.

**The anonymous stub told the agent enough.** This was the bet the change rested on, and the
three ways it could have failed did not. (a) Of 398 tool calls, 397 keep a `file_path` or a
`command` in the stub — only one `Skill` call stubs to its name alone. (b) No attachment goes
anonymous: the `Called the Read tool` marker is excluded from `collectSegments` by
construction, so the path always survives beside the stub. (c) The agent never once mentioned
eviction, missing context, or recall in 588 turns — no confusion, and no confabulation. It
also re-read *less*: 18 redundant reads against run 4's 50 and run 3's 25.

**The one real cost: the agent copies the stub's shape into its own calls.** A stubbed
`tool_use` carries `{ file_path, evicted }` — deliberately off the tool's schema (§16). The
model sometimes imitates that shape when writing its *next* call, sending `evicted` in place of
`old_string`/`new_string`, and the harness rejects it with an `InputValidationError`. This is
caused by evicting calls at all, not by the stub text:

| | Imitations | `InputValidationError`s | Assistant turns |
|---|---|---|---|
| Control (no proxy) | **0** | **0** | 387 |
| Run 3 (call eviction, named stubs) | 3 | 3 | 424 |
| Run 4 (named stubs) | 9 | 10 | 556 |
| Run 5 (cheap stubs) | 11 | 11 | 588 |

Zero in the control is what makes it causal. The cost is about one turn each — 9 of run 5's 11
were followed immediately by a valid call — so 11 wasted turns in 588 (1.9%). Per *stubbed
call* the rate improved (2.0% against run 4's 4.1%); per turn it did not. Nothing here is
fatal, and it is the only measured way the proxy has made the agent worse.

**Recall was never called — in any run, including the control's zero-stub baseline.** Runs 3,
4 and 5 all show 0 `recall_search`/`recall_get` calls, so evicted:recalled stays at
178,594 : 0. Run 4's stubs contained an explicit `recall_search("<path>")` hint in every stub
and were still never followed. Moving the instructions into the tool description therefore
gave up nothing that was working — but it also means the recovery path remains unexercised on
this workload, and §12 (a probe that deliberately asked for evicted content) is still the only
evidence that it works. This is the weakest part of the picture.

### The judge, measured live for the first time

`proxy/README.md` called the judge unmeasured. Two runs now measure it, and it is the same
answer twice.

| | Run 4 (floor 500) | Run 5 (floor 50) |
|---|---|---|
| Trips that could have fired it | 93 | 79 |
| Calls answered / failed / skipped (one already running) | 12 / 1 / 158 | 18 / 0 / 65 |
| Picks proposed | 533 | 18 |
| Picks **accepted** | **0** | **1** |
| Chars it removed | 0 | **7,585** |
| Judge tokens (in / out) | 1,107,712 / 95,773 | 1,142,391 / 90,496 |
| Cost on the user's key (Sonnet 5, $2/$10 per MTok) | ~$3.17 | ~$3.19 |

The old failure was the floor: 326 of run 4's 533 picks bounced as `tooSmall` against a
500-char rule the judge was never told about. That is fixed — run 5 records zero `tooSmall`.
What replaced it is not a bug but an absence. With the menu corrected to offer only what the
guards could accept, the judge was offered so little that it proposed **18 picks across 18
answered calls** and got one through, worth 7,585 chars — **1.1% of the 706,790 the rules
removed on the same run**. Of the 17 rejections, 12 were `keepOnNonUserBlock` (a quote or note
attached to a tool block, which is the judge misusing its own contract) and 5 were
`unknownId` — a pick the request no longer contained, because the conversation moved on during
the 26–132s the call took (median 70s).

**The judge costs money, not time.** It is never in the request path; the 65 skipped trips and
the 70s median cost the session nothing in wall clock (run 5 was the *fastest* proxied run at
35 min). The whole bill is ~$3.19 per session on the operator's own key, for 1.1% of the
eviction. On this evidence the rules do essentially all the work and the judge is not worth
turning on.

**The 456s outlier from run 4 was not a timeout failure.** `JUDGE_TIMEOUT_MS` (300,000) is
enforced per *attempt*, and `callJudge` retries once; the logged `durationMs` covers both. The
455,941ms entry carries `error: "judge response was not a verdict"`, i.e. two ~228s attempts
that each parsed as garbage. The timeout works; there is no overall deadline, so the true worst
case is 2 x 300s. Node's `request.setTimeout` is also an idle-socket timer rather than a
wall-clock one, so a slow trickle of bytes would not trip it at all.

## 18. The agent was copying the stub: 11 imitations -> 3, at 1.7x the dose

§17 measured the proxy's one cost — 11 tool calls in 588 turns where the model sent the stub's
own shape instead of real arguments, each rejected with `InputValidationError`, each worth about
one wasted turn. It recorded the count and left the cause open. This section closes it, and
measures the fix.

**The agent was not misusing an unknown parameter. It was reproducing the proxy's own
transformation on a call it intended to make.** Four pieces of evidence, all from run 5's
transcript:

- **The 80-char cut.** Every one of the 7 Bash imitations truncated its command at exactly 80
  characters and appended the same ellipsis. `COMMAND_TRUNCATE_CHARS = 80` existed only inside
  `proxy/src/evict.ts`. Nothing in the model's training or the harness's schemas names it.
- **The command was new.** At turn 524 the rejected call declared "234 chars" and cut at 80; the
  retry two turns later carried the real command at ~236 chars. That command appears exactly
  twice in the whole transcript — the rejected call and its retry. It was not copied from
  earlier context; the model wrote it, then rendered it the way the proxy renders one.
- **The wording is irrelevant.** Run 4 ran verbose stubs and produced verbose imitations; run 5
  ran cheap stubs and produced cheap ones. The imitation tracks the *shape*, not the text.
- **Recency does not explain it.** Controlled for how far into the run a turn was (turn >= 427),
  the median time since the last eviction trip was 3.6s before an imitation and 4.7s before a
  non-imitation. Imitations do not cluster after trips.

**What predicts it is dose — the share of the agent's own visible tool calls that have been
blanked.** Run 5 produced none in its first 400 turns and 8 per 100 turns by its last quarter,
rising monotonically with that share.

**The asymmetry names the mechanism.** On run 5 the proxy stubbed 371 tool *results* and 189
tool *calls*, with the identical `[onepass: evicted N chars]` marker in both. Every one of the
11 imitations came from the call side; the results were copied zero times. A `tool_result` is
written by the harness, a `tool_use` by the agent — so the marker was copyable precisely because
it sat in the agent's own turn. (The model cannot emit a `tool_result` at all, so this is partly
guaranteed by the wire protocol rather than by voice alone. The practical implication is the
same: nothing the rules put in an assistant block is inert.)

**The fix.** A stubbed `tool_use` input becomes `{}`. The path the call named moves into the stub
of its paired `tool_result` (`[onepass: evicted 4,000 chars; call evicted, /repo/x.ts]`), a block
the model never authors. A command is not carried over at all — a truncated one is no better a
recall key than the paths and error text already in the request, and it is the artifact being
copied. Because `{}` is far cheaper than the shape it replaces, the `ONEPASS_MIN_SAVED_CHARS`
floor now admits many more calls, so the dose rises as a side effect.

**The A/B.** Same mastra task (#18877), same base commit `a14c2436bc`, same plan, same
`opus[1m]` / `--effort xhigh` / `--permission-mode acceptEdits`, same `--allowedTools`, same
byte-identical prompt. Only the stub shape differs.

| | Run 5 (`{ path \| command, evicted }`) | Run 6 (`{}`) |
|---|---|---|
| Imitations / `InputValidationError`s | 11 / 11 | **3 / 3** |
| Imitations per 100 assistant turns | 1.87 | **0.54** |
| Tool calls stubbed, of all tool calls | 189 / 398 (47.5%) | **312 / 396 (78.8%)** |
| Imitation shapes | 7 truncated Bash commands, 4 `evicted` keys | 3 empty `Bash {}` |
| Peak context (API `usage`) | 140,253 | **113,157** |
| Assistant turns above 150k | 0 | 0 |
| Compactions | 0 | 0 |
| Assistant turns | 588 | 557 |
| Wall clock | 35.0 min | **32.3 min** |
| Trips / segments / chars removed | 79 / 560 / 706,790 | 13 / **651** / **808,414** |
| Ground-truth tests | 63 / 65 | **64 / 65** |
| Unexpected rebuilds | 0 | 1 |
| Proxy time per request | 9ms median, 17ms max | 9ms median, 20ms max |
| `recall_search` / `recall_get` calls | 0 | 0 |
| Judge | on | off |

**Emptiness is copied too.** The prediction that `{}` leaves nothing to imitate was wrong: all
three run 6 incidents are a literal `Bash {}`, emitted immediately before the same real command
the model then issued correctly. Turn 512 announces a verification pass, 513 sends `Bash {}`,
514 sends `pnpm turbo build --filter ...`. Whatever occupies that slot gets copied, including
nothing.

**What did hold is that the copy can no longer be valid.** Every tool the agent uses has a
required parameter, so an imitated `{}` is rejected on the spot: 3 turns of 557, ~0.5% of wall
clock, against 1.7% on run 5. Run 5's 7 truncated Bash commands were the dangerous class — a
syntactically valid command with its tail silently removed, which the harness would have run.
Run 6 has none. The remaining defect is loud, self-correcting, and costs one turn.

**Read against dose, the reduction is larger than the raw counts show.** Run 6 blanked 78.8% of
the agent's own calls against run 5's 47.5% — past the point where run 5 was already producing 8
imitations per 100 turns — and produced 0.54 per 100. Per unit of dose that is a 5.8x reduction.

**Two caveats.** Run 5 ran with the judge on and run 6 with it off, because the operator's key
was removed between them; §17 measured the judge at 1.1% of eviction, and its absence removes
eviction rather than adding it, so it cuts against run 6. And n=1 per arm: at a ~2% per-turn
event rate, separating 0.54 from 1.87 with confidence needs roughly 100 sessions per arm, which
is not what this is. The dose-adjusted direction is the claim; the exact ratio is not.

**Nothing stubbed in an assistant block is inert.** That is the transferable result. The stub is
not passive annotation the model reads around — it is text in the model's own voice, and the
model writes in the voice it has been shown. The design rule that follows: put everything
recoverable in the harness's blocks, and leave the agent's own blocks empty rather than
decorated.

## 19. The convex failure was noise: 3 controls and 2 of 3 proxied runs pass `by_owner_key`

**Verdict: not a regression.** All three controls pass the `by_owner_key` ground-truth assertion
and so do two of the three proxied runs, so §16–§17's "every proxied run fails it" does not
survive n=3 — and the one proxied run that fails it never opened the file the assertion is about,
with nothing about that file ever evicted from its context.

§16 and §17 reported runs 3, 4 and 5 all scoring 63/65, all failing the same composite index
assertion, against a single unproxied control at 64/65. One control is not a baseline. This step
adds two more controls and two more proxied runs on the same HEAD, all five launched in parallel,
with `run.sh` and `score.sh` untouched: same base commit `a14c2436bc`, same plan, same `opus[1m]`
/ `--effort xhigh` / `--permission-mode acceptEdits`, same `--allowedTools`, same byte-identical
prompt. Proxy build under test: `0d06b60`, clean.

| | control2 | control3 | head1 | head2 | head3 |
|---|---|---|---|---|---|
| proxy | none | none | :3781 | :3782 | :3783 |
| **Ground-truth tests** | **64 / 65** | **64 / 65** | **64 / 65** | **62 / 65** | **64 / 65** |
| core / 36 | 35 | 35 | 35 | 35 | 35 |
| convex / 29 | 29 | 29 | 29 | **27** | 29 |
| `by_owner_key` | pass | pass | pass | **fail** | pass |
| Peak context (API `usage`) | 284,494 | 284,938 | **112,947** | **112,633** | **114,353** |
| Median context | 195,687 | 192,184 | 89,981 | 88,628 | 95,024 |
| p90 context | 273,132 | 270,597 | 105,796 | 107,281 | 110,414 |
| Assistant turns above 150k | 142 | 118 | **0** | **0** | **0** |
| Early-quarter -> late-quarter median | 122,504 -> 271,437 (2.22x) | 65,147 -> 268,836 (4.13x) | 59,146 -> 99,970 (1.69x) | 69,711 -> 94,308 (1.35x) | 68,507 -> 105,126 (1.53x) |
| Compactions | 0 | 0 | 0 | 0 | 0 |
| Assistant turns | 317 | 381 | 460 | 481 | 527 |
| Wall clock | 26.3 min | 30.5 min | 33.5 min | 30.1 min | 34.3 min |
| Requests | — | — | 308 | 298 | 347 |
| Trips / segments / chars removed | — | — | 6 / 516 / 580,595 | 7 / 505 / 740,034 | 18 / 596 / 788,104 |
| Unexpected rebuilds | — | — | 1 | 1 | 1 |
| Proxy time per request | — | — | 5ms median, 68ms max | 6ms median, 18ms max | 6ms median, 65ms max |
| `recall_search` / `recall_get` calls | 0 | 0 | 0 | 0 | 0 |
| `InputValidationError`s | 1 | 0 | 2 | 0 | 0 |
| Redundant reads | 15 | 4 | 46 | 67 | 67 |

**The failing arm never looked at the file.** head2's convex score is not the 28/29 §16–§17
describe — a `mastra_channel_state` entry present with the wrong index shape. It is 27/29: head2
never added the table to `TABLE_INDEX_MAP` at all, so both `should have entries for all typed
tables` and `composite indexes should list fields in correct order` fail. `git status` in the five
mastra worktrees settles it: the other four all modified
`stores/convex/src/server/index-map.ts`; head2 did not touch it. It did the rest of the convex
work — `schema.ts`, `storage.ts`, the channels domain — and skipped that one registration.

Eviction cannot be the cause, because nothing about that file was ever in head2's context to
evict. Its transcript names `index-map` three times: once in an `ls` of the convex server
directory at 19:23:19, and twice inside the `import { findBestIndex } from './index-map'` line of
`storage.ts` that it read for other reasons. It never opened the file. head2's first eviction trip
was at 19:23:52, *after* the only sighting, and a join of the proxy log's trip entries against the
transcript finds zero evicted segments matching `index-map` — against 53 evicted segments matching
`convex/src/server` generally, so the join is not simply blind. What head2 lost was thoroughness,
not context.

**The score does move, and only just.** The second question this step asked was whether the tests
can see any difference at all between runs. They can: 62 and 64 both occur. But four of the five
land on the same 64/65, all five fail the *same* core assertion — the `supportsChannelState`
capability fallback, which §16–§18 report for every arm including the unproxied control — and the
only separation comes from one arm omitting a piece of work. Across all eight runs now on record
(§17's control at 64, runs 3–5 at 63, run 6 at 64, and these five) the suite resolves whole
missing features, not degradation. It is a completeness check, not a quality gradient, and a
future step wanting to detect quality loss needs a different instrument.

**What the parallel controls did buy is the size result, at n=3 per arm.** The controls peak at
284,494 and 284,938 tokens with 142 and 118 turns above 150k; the proxied runs peak at 112,947,
112,633 and 114,353 with none. That is a 2.5x reduction with the score unchanged in two arms of
three, and it is the first time either side of this comparison has more than one sample. Neither
side compacted: `opus[1m]` has a 1M window, so on this task the proxy is not preventing
compaction — it is holding context to 40% of what the task would otherwise cost, per request, for
the whole session.

**Eviction with no recovery path available still matched the controls.** The recall tools were not
registered in any of these five runs — `recall_search` does not appear anywhere in their
transcripts, where run 6's transcript carries `mcp__onepass__recall_get` and
`mcp__onepass__recall_search` in its tool list. `.mcp.json` is scoped to the Onepass repository and
the runs' working directory is a mastra worktree, so the `--allowedTools` entries named nothing.
This is a deviation from §16–§18's setup and is reported as such, but it cuts *for* the result
rather than against it: head1 and head3 had 580,595 and 788,104 chars removed from their context
with no way at all to get any of it back, and still scored what the controls scored. It also means
the recovery path remains as unexercised as §17 said it was, and §12 is still the only evidence it
works.

**One stub-shape imitation in 1,468 proxied assistant turns.** §18 measured the `{}` stub at 3
imitations in 557 turns (0.54 per 100). Here there is one: head1 sent a literal `Bash {}` and was
rejected with `InputValidationError`, then issued the real command — 0.07 per 100 proxied turns.
control2's single `InputValidationError` is a genuine long Bash command, not an imitation, which
is a reminder that the error tally is an upper bound on imitations rather than a synonym for them.
The direction agrees with §18; the counts are far too small to compare.

**Caveats.**
- n=3 per arm. Three passes and one failure do not measure a failure *rate*; they rule out the
  3-of-3 pattern §16–§17 rested on.
- All five ran in parallel on one machine against one subscription. **No 429s and no rate-limit
  retries:** every arm's `.err` is empty, no arm's result JSON mentions `429`, `rate_limit` or
  `overloaded`, and all five exited `subtype: success`. The proxied arms did record 12 upstream
  TLS failures (`ssl3_read_bytes: bad record mac`), surfaced to Claude Code as 502 and retried
  transparently: 2 on :3781, 5 on :3782, 5 on :3783. The control arms have no equivalent
  instrumentation, so this is "the proxy saw 12" rather than "the proxy caused 12" — but three
  proxies sharing a machine is the obvious suspect and a single-arm run should be checked against
  it before the number is read as a property of the proxy.
- The recall tools were absent (above). The tool list is part of the cached prefix, so these five
  runs differ from §16–§18 by more than the proxy alone.
- Wall clock is not comparable across arms here: five sessions shared one machine, and they
  started 60s apart.
- head3's list-price cost ($36.92) is well above the other four ($22.57–$23.75) on similar work.
  Unexplained; noted rather than used.
- The controls' peaks are not reporter-validated, because the reporter needs a proxy log. They
  come from the same script whose max matched the reporter's peak exactly on all three proxied
  arms (112,947 / 112,633 / 114,353).

## 20. A blind code-review grader on the same five repos: it reads, and it ranks both controls above every proxied arm

**No verdict on the proxy.** The rule agreed before the run gives one only when the four clean
real pairs show no preferred arm; they show *control preferred* on all four, so what follows is
reported as it came out. The grader itself passed every check that could be put to it without a
human reading mastra source — a positive control, a self-pair, and a sampled citation check —
after the check the handoff asked for turned out to test the wrong thing. That is the finding
about the instrument. The finding about the arms is a ranking, not a verdict: **control3 >
control2 > {head1, head3} > head2**, consistent across ten graded pairs with no cycle, and both
controls above all three proxied arms is what one would see one time in ten if the proxy made no
difference at all. One task cannot separate "the proxy hurts" from "runs vary and these five
sorted this way"; two controls of the same task already differ by as much as the arms differ from
them. That is Step 2's job, and why the plan puts breadth there.

§19 settled completeness: the ground-truth suite resolves whole missing features, not degradation,
and it says a future step wanting to detect quality loss needs a different instrument. This is that
instrument's first run, on the same five finished repos, so nothing new was paid for on the arms'
side. The grader is Claude Code itself — `claude -p` on Opus at effort max, Read/Grep/Glob and no
other tool, started in a scratch directory holding only the plan, the two diffs and the question,
with both finished repositories attached read-only and no test score anywhere in the prompt.
Proxy build the arms ran: `0d06b60`. Grader: Claude Code 2.1.265. Driver: [eval/grade/](../eval/grade/).

**The pairs.** Each is graded in both orderings, and one outcome is derived from the two verdicts:
Yes/Yes is *same*, Yes/No and No/Yes name a preferred side, No/No and any Unknown are *no clear
answer*. The eight pairs the handoff asked for are p1–p8; p9–p11 were added when the trust check
was replaced (below) and are checks on the grader, not on the arms.

| pair | kind | call 1 (A / B) | verdict | call 2 (A / B) | verdict | outcome |
|---|---|---|---|---|---|---|
| p1 | proxied vs control | head1 / control2 | No | control2 / head1 | Yes | **control preferred** |
| p2 | proxied vs control | head1 / control3 | No | control3 / head1 | Yes | **control preferred** |
| p3 | proxied vs control | control2 / head2 | Yes | head2 / control2 | No | **control preferred** |
| p4 | proxied vs control | head2 / control3 | No | control3 / head2 | Yes | **control preferred** |
| p5 | proxied vs control | control2 / head3 | Yes | head3 / control2 | No | **control preferred** |
| p6 | proxied vs control | control3 / head3 | Yes | head3 / control3 | No | **control preferred** |
| p7 | noise floor (two controls) | control3 / control2 | Yes | control2 / control3 | No | **control3 preferred** |
| p8 | same-condition, proxied | head1 / head3 | No | head3 / head1 | No | **no clear answer (contradiction)** |
| p9 | positive control (head2) | head2 / head1 | No | head1 / head2 | Yes | **head1 preferred** |
| p10 | positive control (head2) | head2 / head3 | No | head3 / head2 | Yes | **head3 preferred** |
| p11 | self-pair | control2 / control2b | Yes | control2b / control2 | Yes | **same** |

head2's two real pairs (p3, p4) are on their own line: it skipped
`stores/convex/src/server/index-map.ts` entirely and §19's tests already say so, so a control
preferred there is the completeness finding §19 has, not a quality one. Twenty-two calls, no
Unknowns, no `is_error`, and every transcript shows `Read`, `Grep` and `Glob` and no other tool.

**The trust check as agreed, and why it was replaced.** The rule was: pairs 7 and 8 come out
*same*, and five reasons picked by the user hold when the files are opened; otherwise the grader is
picking winners out of luck and nothing it says can be read. Neither pair came out *same*. Pair 8's
No/No is two calls citing the same facts in the same files — one arm adds the ClickHouse and
Cloudflare table-name entries and claims in MySQL with one statement, the other guards the
Postgres `jsonb` read and wires the shutdown hook — and each concluding the side shown as A is not
at least as good; two changes each worse in a way the other is not is a real state the Yes/No
shape cannot express. Pair 7 is the one that matters: two controls, same task, no proxy in either,
and both calls say control3 is the better change, citing the Cloudflare `mastra_channel_state` key
control2 omits from a `Record<TABLE_NAMES, …>` and the three changesets control2 does not ship.
Those citations were opened (R147, R148, R155, R156, R158 in the corpus) and hold. So two runs of one
condition are two different changes, of visibly different quality, and *same* was never the right
requirement: it counted real between-run variance as grader noise, and no honest grader could
have passed it. The user could not do the five-reason check — "I have no context about the repo"
— which is a fair statement about a 25-file diff against an unfamiliar monorepo, and is the second
reason the check was replaced rather than the rule bent.

**What replaced it: three checks that need no one to read mastra.** All three pass.

- *Positive control.* The tests already rank head2 last of the five — 62/65, one required file
  never opened — and that ranking owes nothing to the grader. head2 against each other proxied
  arm is therefore a question with a known answer. p9 and p10: head2 loses both, in both orderings,
  and the grader's stated reason is the same omission the tests found — `stores/convex/README.md`
  and the Convex schema work untouched.
- *Self-pair.* control2 against a byte-identical copy of itself under another token. p11: Yes/Yes,
  both calls listing the same locations on both sides and one noting the two diffs touch the same
  24 files with no adds, deletes or renames. This is the only test that the grader can say *same*
  at all — none of the eight real pairs did — and it can.
- *Citations.* Every reason names a file and a line. A machine pass over all 183 reasons from the
  first sixteen calls resolved 409 citations: none names a file that does not exist; five give a
  line number that is a line in that side's diff rather than in the file, and the diff at that
  line is the code the sentence describes. Twenty-three reasons drawn at random (seed 20260910,
  every pair covered) were then opened and read — by Claude in the grading session, not by the
  user, and that is the weaker of the two — and all twenty-three hold; one (R169) is a diff-line
  citation. The record is `VERIFY.md` in the corpus; `eval/grade/cite.mjs` is what resolves a
  citation to its lines so the check is reading two short things rather than navigating a repo.

Position is also ruled out directly: in nine of the eleven pairs the verdict reverses when the
sides swap, and the two that do not reverse are the contradiction and the self-pair, which should
not. A grader answering by slot would read No/No or Yes/Yes throughout; one answering by coin
would reverse about half the time.

**What the six real pairs say, and what they cannot.** All six come out *control preferred*, and
with p7, p9 and p10 the ten graded pairs form one order — control3 > control2 > head1, head3 >
head2, with head1 against head3 unresolved — and no cycle. Both controls above all three proxied
arms is the ranking "the proxy costs quality" predicts, and it is also what a lottery over five
runs produces one time in ten: under "condition makes no difference", the two control labels land
on the top two of five ranks with probability 1/C(5,2). One in ten is suggestive and is not a
finding, and there is no reading of the reasons that makes it one, because pair 7 shows the
between-run spread inside one condition is of the same size as the spread between conditions. What
the reasons do show is the *kind* of shortfall the grader saw on the proxied side: entries missing
from total records that the plan named as expected fallout (ClickHouse `TABLE_ENGINES`, Cloudflare
`RecordTypes`), the named doc line and the "in-memory fallback" comment left unedited, the Convex
"fail loudly" behaviour absent, changesets folded or mis-bumped — omissions of plan-mandated items
rather than wrong code. That is the shape a shortened context would produce. It is also the shape
control2 produced on changesets, so it is not a signature. Whether it recurs across tasks is
exactly what Step 2 measures.

**Grading cost.** $108.68 for twenty-two calls, 35 to 87 turns each, 2.7 to 12.8 minutes each;
the self-pair's two calls were the cheapest at $2.38 and $2.60.

**Cost, per arm.** From each arm's own `claude -p` result JSON and its start/end stamps — the
arms' cost, not the grader's. `turns` here is the result JSON's `num_turns`, which is not §19's
count of assistant entries in the transcript.

| | control2 | control3 | head1 | head2 | head3 |
|---|---|---|---|---|---|
| List price | $23.75 | $22.99 | $22.57 | $22.60 | **$36.92** |
| Total tokens | 37,075,406 | 35,374,597 | 25,755,125 | 24,760,926 | 30,527,675 |
| Fresh input | 386 | 412 | 610 | 584 | 682 |
| Cache write | 284,492 | 275,787 | 708,182 | 789,912 | 1,962,422 |
| Cache read | 36,688,363 | 34,989,120 | 24,925,424 | 23,859,615 | 28,441,732 |
| Output | 102,165 | 109,278 | 120,909 | 110,815 | 122,839 |
| Turns (`num_turns`) | 221 | 267 | 329 | 324 | 375 |
| Wall clock | 26.3 min | 30.5 min | 33.5 min | 30.1 min | 34.3 min |

Cache reads are 97–99% of every arm's tokens, which is why the dollar figures move so little
against a 25% swing in total tokens.

**Paired differences, proxied minus control, over the six real pairs.**

| pair | dollars | total tokens | turns | wall clock |
|---|---|---|---|---|
| head1 − control2 | −$1.17 | −11,320,281 | +108 | +7.3 min |
| head1 − control3 | −$0.42 | −9,619,472 | +62 | +3.0 min |
| head2 − control2 | −$1.14 | −12,314,480 | +103 | +3.8 min |
| head2 − control3 | −$0.38 | −10,613,671 | +57 | −0.4 min |
| head3 − control2 | +$13.17 | −6,547,731 | +154 | +8.1 min |
| head3 − control3 | +$13.93 | −4,846,922 | +108 | +3.9 min |
| **mean of 6** | **+$4.00** | **−9,210,426** | **+98.7** | **+4.3 min** |

§19 said to expect about the same dollars from 40% more turns at 40% of the context, with head3
an outlier. Measured: 45% more turns, 25% fewer total tokens, and dollars within $1.17 either way
on four of the six pairs. The mean of +$4.00 is head3 alone — drop it and the mean is −$0.78. The
40%-of-context figure was per request at peak (§19: 112k against 284k); the 25% here is the whole
session's token total, which the proxy's rebuilds move between classes rather than remove, and
the two are not the same measurement.

**What the diffs shown to the grader are.** Not plain `git diff a14c2436bc`, and the corrections
are worth stating because a reader will otherwise reproduce something else. `score.sh` staged the
human's ground-truth test files over each arm's own to score it, so both those paths come out of
every diff; the arm's own `state-adapter.test.ts` is spliced back from `score.sh`'s saved copies,
which were checked by hash and are genuine for all five, while `index-map.test.ts` is dropped for
all five because one control's saved copy is byte-identical to the ground truth and is therefore
unrecoverable there. The changesets the plan's Step 8 asks for are untracked files `git diff` does
not show, and are appended as new-file hunks. Each prepared copy is then asserted to equal the
base commit plus its own diff before any call runs.

**Blinding.** The grader is never told which side is proxied and never told a test score. The
source paths name the arms, so each finished repo is copied to an opaque name and the copy is
what gets attached; the driver refuses to start a call whose diffs mention the harness. On 2.1.265
`--safe-mode` alone was not enough to keep the operator's own configuration out: a first call
under it still carried the user's `outputStyle` in as an attachment telling the grader to keep
answers short. `--setting-sources ""` removes it.

**Caveats.**
- n=1 task. One plan, one repository, one base commit; every pair here is a different pair of
  answers to the same question, and the one-in-ten above is the whole of what five runs of one
  task can say.
- Eight real-or-floor pairs, six of them real, and two of those six are head2, whose omission §19
  already measured. Four independent proxied-versus-control pairs is the width of the real
  comparison.
- The grader is the same model family as the arms, prompted the same way, reading the same repo.
  It is not an independent judge of that repository's conventions; it is another instance of the
  thing being measured.
- The citation check was done by Claude, not by the user, on a random sample. It is evidence the
  reasons are not invented; it is not the human check the handoff asked for, and the positive
  control and self-pair are the checks that carry the weight.
- The positive control is coarse: head2's shortfall is a completeness gap the grader could see for
  the same reason the tests did. That it can also tell two complete changes apart rests on pair 7,
  whose reasons were opened and hold.
- The five repos differ in more than the proxy: §19 records that these runs had no recall tools
  registered, so an evicted arm had no recovery path at all.

## 21. The cost was a swarm of tiny trips, and a batch minimum removes it

**Verdict, from replay only.** A trip costs a prompt-cache rewrite whatever it removes, so the
number that decides the bill is how *often* the proxy trips, not how much it evicts. Once a session's un-evictable floor passes T, every request is over the
line, and the build that ran the $200 Harbor pass (§20's era, proxied runs at ~4× control) tripped
on almost every one of them to remove a few hundred tokens each: **112 trips in 120 requests** on
one recording and, on another, **34 in 68** at that build's own 110k threshold — 50 in 68 at the
80k now shipped. Requiring a trip to newly evict at least 20,000 tokens —
`ONEPASS_BATCH_MIN_TOKENS`, default 20,000, `0` restores the old behaviour — takes those to **5**
and **1**. The same content still leaves the request; the peak rises by 5.6k–9.2k tokens, which is
the cost of holding a batch back. On the same evidence the default trip threshold moves **110k →
80k**.

Three recordings, each every `/v1/messages` body one real proxied Harbor run sent, replayed in
order through one proxy child against a fake upstream. No model is called and nothing is billed.
Build `e2fc221`. Trips = requests with `newlyEvicted > 0`; peak = max `estimatedTokensSent`.

**`harbor-make-mips`, 120 requests** (the recording the thresholds were tuned on):

| T | minimum | trips | per 100 | peak sent | newly evicted | requests held back | over the alarm line |
|---|---|---|---|---|---|---|---|
| 110k | off | 2 | 1.7 | 100,614 | 100,974 | 0 | 0 |
| 110k | 15k | 2 | 1.7 | 100,614 | 100,974 | 0 | 0 |
| 110k | 20k | 2 | 1.7 | 100,614 | 100,974 | 0 | 0 |
| 110k | 30k | 2 | 1.7 | 100,614 | 100,974 | 0 | 0 |
| 80k | off | 5 | 4.2 | 79,878 | 119,984 | 0 | 0 |
| 80k | 20k | 4 | 3.3 | 88,993 | 116,304 | 1 | 0 |
| 30k | off | **112** | 93.3 | 70,044 | 123,598 | 0 | 1 |
| 30k | 15k | 6 | 5.0 | 77,644 | 111,148 | 108 | 19 |
| 30k | 20k | **5** | 4.2 | 77,542 | 118,461 | 108 | 22 |
| 30k | 30k | 3 | 2.5 | 91,635 | 101,506 | 111 | 54 |

**`harbor-corewars`, 68 requests** (a session whose floor is far above any T tried):

| T | minimum | trips | per 100 | peak sent | newly evicted | requests held back | over the alarm line |
|---|---|---|---|---|---|---|---|
| 110k | off | 34 | 50.0 | 150,811 | 27,297 | 0 | 5 |
| 110k | 20k | **1** | 1.5 | 156,419 | 20,229 | 40 | 10 |
| 80k | off | **50** | 73.5 | 150,811 | 27,421 | 0 | 22 |
| 80k | 20k | **1** | 1.5 | 156,419 | 20,229 | 49 | 39 |

**`harbor-sam-cell-seg`, 117 requests:**

| T | minimum | trips | per 100 | peak sent | newly evicted | requests held back | over the alarm line |
|---|---|---|---|---|---|---|---|
| 110k | off | 8 | 6.8 | 141,882 | 494,102 | 0 | 0 |
| 110k | 20k | 4 | 3.4 | 158,046 | 494,506 | 4 | 1 |

**Against the bars, agreed before the numbers** — at each T, the minimum against the same
recording with the minimum off: trips ≤ 0.2×, peak ≤ +20k, newly evicted ≥ −20k.

| recording | T | trips | peak | evicted |
|---|---|---|---|---|
| make-mips | 110k | **not evaluable** (baseline 2) | pass (equal) | pass |
| make-mips | 30k | pass (5 ≤ 22.4) | pass (77,542 ≤ 90,044) | pass (118,461 ≥ 103,598) |
| corewars | 110k | pass (1 ≤ 6.8) | pass (156,419 ≤ 170,811) | pass (20,229 ≥ 7,297) |
| corewars | 80k | pass (1 ≤ 10.0) | pass (156,419 ≤ 170,811) | pass (20,229 ≥ 7,421) |
| sam-cell-seg | 110k | **fail** (4, needs ≤ 1.6) | pass (158,046 ≤ 161,882) | pass |

The two are not the same thing, and the difference matters. make-mips at 110k trips **twice** in
120 requests, so the bar asks for 0.2 × 2 = 0.4 trips: no run can pass it except one that evicts
nothing at all, which is not the outcome being asked for. That is a degenerate denominator, and it
is reported as **not evaluable** rather than scored — the bar is unchanged, and `replay-bars.mjs`
applies the same rule wherever the baseline trips 4 times or fewer. sam-cell-seg is a genuine
**failure**: it trips 8 times, 0.2 × 8 = 1.6 is a real target, and the minimum only halves it to 4.
Its trips are large ones (494k evicted in total), so there is little small-batch traffic for a
minimum to remove. The bar bites where it was meant to — on the swarms — and there it passes with
room to spare. The bars themselves were not moved.

**The faithfulness check passed exactly.** At T=30k with the minimum off the replay makes 112
trips, which is what the real Harbor run made. That check is what licenses every other number
here; it failed at first, and the fix is below.

**Tuning record.** 15k, 20k and 30k were tried on make-mips at T=30k. The bars already pass there
at 20k; the other two were run to see whether either did better. 15k passes all three; 30k fails
two — peak 91,635 against a 90,044 limit, and 101,506 evicted against a 103,598 floor. 20k passes
and sits between them, so it stays. The two arms where 20k does not pass are the ratio cases
above, which no value of the minimum can fix: one has no passing value and the other has too
little small-batch traffic to remove. Nothing else was tuned; every value tried is a row in the
tables above.

**80k, decided by the rule written before the measurement** (with the minimum on: ≤ 10 trips per
100 requests and peak ≤ 140k). make-mips at T=80k gives 3.3 and 88,993. The default moves to 80k.
Lowering T is close to free here: on corewars the peak is **identical at 110k and 80k** —
150,811 either way — because the peak is set by the un-evictable floor, not by T.

**Which is also what the alarm line is for.** A request sent over `T + 40k` is recorded and
nothing else: 39 of corewars' 68 requests at T=80k, against 22 with the minimum off. That is not
the minimum misbehaving — it is the floor being larger than T + 40k, a condition no amount of
eviction can fix, and the alarm is how it becomes visible instead of being inferred from a bill. A
hard ceiling was rejected for the same reason: it could only fail requests the proxy is unable to
shrink. The `T + 40k` sizing advice in `proxy/README.md` becomes `T + 60k` to match what the peaks
above actually do — **and that is still not a promise.** corewars at the shipped 80k peaks at
156,419, which is T + 76k. Where the floor is already above T, no margin written as `T + x` holds,
because the peak is the floor's and the floor answers to nothing the proxy controls. The honest
rule is: size T by `T + 60k` and then read the alarm line in your own log, which is the only thing
that reports the case where that rule has stopped applying.

**The replay had to be fixed before any of this counted.** The proxy sizes requests in real
tokens, calibrating chars-per-token from each response's `usage`. The fake upstream answered at a
flat 4 chars/token where the real traffic had run at 2.5–3.5, so every replayed request measured
~20% small and crossed the threshold late: T=30k with the minimum off gave **97 trips against the
real run's 112**. All 97 were genuine; 15 were missing. `import-recordings --proxy-log <log>` now
pairs each recorded body with the usage line it produced and stores the ratio (sent bytes ÷
input + cache-creation + cache-read tokens), and the fake answers at it. The stored ratio predicts
the proxy's own next calibration in **117 of 118** requests — the miss is a concurrent
`count_tokens`. A recording imported without a log still replays at the constant, and the result
document says so.

**One deviation from the plan.** The plan asked `--compare` to refuse when the batch minimum
differs between two runs, and then compared a 20k run against a 0 run in its own commands. Since
that comparison is the entire point, a named `--compare` may cross the batch minimum and the
result carries a note saying the diff is what the minimum did rather than what the build did;
T, N and K must still match, and an implicit comparison still requires everything to match.

**Caveats.**
- Replay, not life. No model is in the path, the agent makes no decisions, and nothing here says
  what the API charged. A live run through the Harbor rig was considered and declined: the replay
  reproduces the real run's trip count exactly and its peak to within 0.07%, so what a live run
  would add is the price, not the mechanism. What stays unmeasured is the billed cache-write share
  and a real `cost_usd` — every figure in dollars here is arithmetic over §20's rates, not an
  invoice. If it is ever wanted, `make-mips-interpreter` is the task to spend it on rather than
  `winning-avg-corewars`, which §3.3 of the plan would have picked: it carries the larger real
  swarm (112 trips against 63), it finishes inside half the wall clock instead of timing out, and
  its peak bar can actually pass, where corewars' is failed in advance by a floor above T.
- Three recordings from two Harbor jobs, all one agent on one kind of task. The floor-above-T
  case they demonstrate is the one the mechanism targets; how common it is across real sessions is
  not measured here.
- The minimum makes requests bigger, by 5.6k on corewars and 7.5k on make-mips at T=30k. That is
  the trade being made, and the peak bar is what bounds it.
- corewars evicts only ~27k in total either way: it is a short session with a huge fixed floor, so
  it shows the trip-frequency effect clearly and says nothing about how much can be evicted.
- Every ratio in the fidelity fix is an aggregate over a whole request; the proxy's own clamp
  (2–8 chars/token, ignoring samples under 1,000 tokens) still applies, so a recorded 22.2 on
  sam-cell-seg is clamped exactly as the live proxy clamped it.

## 22. Live re-runs of the 0.3.0 proxy: the 7x cost blow-up is gone, and a session under the trip line costs nothing

Two live runs on 2026-09-11 against the proxy at `main` = `468c43f` (the 0.3.0 line: judge
deleted, batch minimum in, default T=80k). Both through the subscription, no API key. The
question each answers is narrow and is stated with it.

### 22a. The task where the old proxy cost the most, re-run on the new one

§21 found the old proxy's cost was a swarm of tiny trips, each rewriting the prompt cache. The
Terminal-Bench first pass ([eval/harbor/RESULT.md](../eval/harbor/RESULT.md)) is where that
showed up as money: proxied $201.91 against control $47.91 across 20 tasks, with the tokens
*down* 19%. Per task, the worst was `make-mips-interpreter`: **$44.93 proxied vs $6.46
control, 7.0x**, both arms passing. That is the task re-run here, once, with the `main` proxy
and everything else held: same Harbor agent class, same model (`claude-opus-5`), same
`ONEPASS_TRIP_TOKENS=30000` stress dose (not the shipped default — the point was to move only
the proxy code), same Daytona environment. The control is the stored one; it was not re-run.

| | control (2026-09-10) | old proxy `1ddb4fa` (2026-09-09) | new proxy `468c43f` (2026-09-11) |
|---|---|---|---|
| reward | 1.0 | 1.0 | **1.0** |
| Harbor reported cost | $6.46 | $44.93 | **$8.72** |
| input tokens incl. cache | 7,215,551 | 5,848,328 | 6,356,962 |
| of them cache reads | 7,099,384 (98%) | 1,612,015 (**28%**) | 5,977,268 (**94%**) |
| output tokens | 70,143 | 70,592 | 77,511 |
| agent steps | 84 | 120 | 104 |
| peak context (max `prompt_tokens`) | 126,095 | 65,828 | 88,188 |
| proxy trips / segments evicted | — | 112 / 197 | **5 / 164** |
| Claude Code | 2.1.267 | 2.1.267 | 2.1.269 |
| agent wall clock | 18 min | 20 min | 31 min (incl. clone+build) |

Read it as three numbers. The old proxy tripped on 112 of 119 requests and got 28% of its input
from cache; the new one tripped 5 times in 103 requests and got 94% — within four points of
the control's 98%. The cost went from 7.0x control to **1.35x**, a 5.2x drop on the same task,
with the same pass. The batch minimum did that: what used to be a hundred trips of a few
hundred tokens each is now five trips that each evict enough to be worth the cache rewrite.

What it cost in context: the peak is 88k, not 66k. Holding a trip back until a batch is worth
taking means the request sits above T for longer, so at T=30k the ceiling is about a third
higher than the old proxy's — and still 30% under the control's 126k. That is the trade §21
chose on a replay; this is it measured live, on the task where it mattered most.

One run of one task. The old control's own cost varied by 2x between nearby tasks of the same
length, so the $8.72 is a point, not a distribution; the 28% → 94% cache-read rate is the
number that does not move much run to run, and it is the mechanism.

Job: `~/onepass-corpus/harbor/jobs/onepass-rerun-mips-proxied-main468c43f-20260911T230151Z`,
run with `ONEPASS_TASKS_FILE=<one line: make-mips-interpreter> ONEPASS_N_CONCURRENT=1
./eval/harbor/run.sh first-pass proxied` from a checkout at `468c43f`.

### 22b. Two real sessions replayed prompt by prompt, no compaction

Both replays feed every prompt the user typed in a recorded session, in order, to a fresh
`claude -p` session resumed under one id, through one proxy process for the whole run
(`~/onepass-corpus/replay/replay.sh`). Shipped defaults: T=80k, batch minimum 20k. The repo is
an isolated copy at the commit the original session started from. The agent's *answers*
diverge from the original — it is a different run — so what is measured is only the shape of
the context: peak, final, trips, compactions.

**The planning session (chp99 take-home, 11–12 Aug 2026 — the eval corpus's `planning` branch:
57 typed turns, `claude-fable-5` at xhigh).** This is the biggest session on record here, and the
one the eval spec names. Unproxied it peaked at **290,591** tokens and compacted twice (at 173k
and at 291k). Replayed through the proxy — 53 prompts (the two `/compact`s, the interrupt and the
post-compaction "continue" dropped), each fed in order, no compaction allowed:

| | original (no proxy) | replay (proxy at `468c43f`, T=80k) |
|---|---|---|
| model turns | 523 | 489 |
| peak context | **290,591** | **199,457** |
| final context | 155,432 (after 2nd compaction) | 199,457 |
| compactions | 2 | **0** |
| median / p90 context per request | — | 137k / 173k |
| trips / segments evicted / chars removed | — | 12 / 367 / 2.34M |
| raw request size the proxy saw at its largest (est.) | — | ~824k tokens |
| cost (Claude Code's own estimate, subscription) | — | $81.55 |
| wall clock | ~20 h of a real day | 63 min |

The session that had to be compacted twice ran end to end with no compaction, peaking 31% under
the unproxied peak, with its last request at 199k against a 1M window. Twelve trips over 311
requests: the batch minimum is doing what §21 said it would, and every request stayed at or
under the un-evictable floor the proxy's own README warns about — user prose, assistant text,
the last-K window — which is what the 137k median is made of. At prompt 49 the original was at
241k; the replay was at 187k. The ceiling is now the floor, not the tool output.

It is a different run, not a re-execution: the replay's agent could not use the desktop
browser MCP the original leaned on for its front-end work, and it answered every prompt afresh,
so its answers and turn count differ. Peak, final and compaction count are the measurements; the
answers are not compared. Replay dir: `~/onepass-corpus/replay/out-chp99/`; repo copy at
`~/onepass-corpus/replay/chp99-takehome` (commit `261d149`, the session's start state).

**A smaller session that never reaches T (`Downloads/pax-takehome-main`, 5 prompts,
`claude-opus-5` at high).** Original peak 80,235, no compaction. Replayed: 63 model turns,
**peak 58,922, final 58,922, 0 trips, 0 compactions, $1.65**. The proxy forwarded every request
untouched, which is the designed behaviour: a session that fits in the window costs exactly what
it would have cost without the proxy.

## Caveats

- Token counts are estimated as `len(json.dumps(block)) / 4`, not tokenizer-exact.
- §15 is the exception: its prefix and replayed-output rows are API-reported `usage`, and its
  tool-result rows use a bytes/token rate measured from `usage` deltas. Its thinking / text
  split and stub rows are still estimates and are labelled as such.
- §12 is n=1 on synthetic noise content. Its 1.79× estimate ratio is content-dependent
  (digit-heavy logs tokenize badly); real code sits lower (§11 measured 25–40%).
- §6 is a single session. Verify across more before relying on the 55% figure.
- The sampled sessions are browser-heavy, which inflates the image share in §4 relative to a
  pure coding session.
- A transcript records what happened, not precisely what was sent to the API on each request.
  §2 and §7 use server-reported `usage`, which is exact; §4–§6 infer from transcript content.
- §9 is n=1 per arm. The direction is large enough to act on; the magnitudes are not settled.
- §16 is n=1 per arm and the agent is nondeterministic: the two runs did similar but not
  identical work (425 vs 424 assistant turns, 263 vs 279 requests). Peak context is
  arithmetic and survives that; the wall-clock difference (26 vs 28.5 min) does not, and
  is not quoted above.
- §19 is n=3 per arm and the first section with more than one control. It rules out §16–§17's
  3-of-3 pattern; it does not measure a failure rate. Its five runs also lacked the recall tools,
  which §16–§18's runs had — the section says so and says which way that cuts.
- §20 carries no verdict on the proxy. Its grader passed a positive control, a self-pair and a
  sampled citation check, so what it says can be read; what it says is a ranking of five runs of
  one task with both controls on top, which is one-in-ten under no effect at all. It is a
  suggestive number and a checked instrument, not a finding about the proxy.
- §17 is n=1 per arm, with the same nondeterminism: run 5 did more work than run 4 (588 vs
  556 turns) and went further into the task (clickhouse, cloudflare, docs, changesets). Peak,
  p90 and the eviction counts are arithmetic over what was actually sent and survive that;
  the wall-clock ordering (35.0 vs 38.0 min) does not, and neither does the imitation count,
  which scales with how many calls got stubbed. The judge's two runs differ in build as well
  as in luck — treat "1 accepted pick" as the order of magnitude, not the number.
- §21 is replay only: recorded request bodies against a fake upstream, no model and no bill. It
  measures what the eviction code does with real inputs, not what a session costs. Two of its
  seven bar sets fail the trips bar, both on recordings whose baseline trips 2 and 8 times, where
  a 0.2× ratio is unreachable; the section says so rather than restating the bar.

## Reproducing

Scripts are ad-hoc for §§1-8. The A/B rig behind §§15-18 is committed at
[eval/](../eval/) — `run.sh` (one arm), `score.sh` (ground truth), `analyze.mjs` (transcript
scan) and the task plan; its run artifacts stay under `/private/tmp/onepass-eval`. Each figure
in §§1-8 was produced by walking the `.jsonl` files and grouping message content blocks;
`compactMetadata` supplies §2 and the recursion test in §1.

§§9-10 are reproducible: see [spike/harness/README.md](../spike/harness/README.md).

§15: start the proxy with `ONEPASS_DUMP_DIR`, run `claude -p` once in the target cwd with the
run's flags, and read `usage` from the `--output-format json` reply; the replayed-output row
is the sum of `message.usage.output_tokens` over the transcript's assistant entries before the
peak (dedupe by `message.id`).

§17 is reproducible the same way, from `/private/tmp/onepass-eval/run{4,5}.report.txt` and
the two transcripts; the imitation count is a scan for `tool_use` blocks whose `input` carries
an `evicted` key ([eval/analyze.mjs](../eval/analyze.mjs)), and the ground-truth score is the
two test files from mastra `faee052a3c` copied over the agent's own
([eval/score.sh](../eval/score.sh)).

§18 is reproducible the same way, from run 5 and run 6. Both halves of its count must be
shape-agnostic or the comparison is rigged: scanning for an `evicted` key finds run 5's 11 and
run 6's 0 by construction, since the fix deletes that key. Count instead any `tool_use` whose
input is missing a parameter its tool requires, or carries the stub prefix, or ends a value in an
ellipsis — and check the total against `InputValidationError` tool results in the same
transcript, which is the harness's own ground truth and matched exactly (11 and 3) on both runs.
Dose is the count of distinct `call:` ids across the proxy log's `trip` entries, over `tool_use`
blocks in the transcript. Ground-truth score: [eval/score.sh](../eval/score.sh).

§19 is reproducible from `eval/run.sh` and `eval/score.sh` unchanged — five arms, `./run.sh
control2 --no-proxy` and `ONEPASS_BASE_URL=http://localhost:378N ./run.sh headN` — plus the
reporter for each proxied arm. Three things it needs that the earlier sections did not. Each proxy
must start at least a second apart: the log filename is a millisecond timestamp with no env
override, so simultaneous starts share one file and the arms become unattributable. A child
`claude -p` launched from inside another Claude Code session inherits that session's `CLAUDE_*`
and `ANTHROPIC_BASE_URL`, which silently routes a `--no-proxy` control through whatever the parent
was pointed at; strip them. And the `by_owner_key` claim is settled by `git status` in each mastra
worktree — whether the arm modified `stores/convex/src/server/index-map.ts` at all — before any
transcript is read, because an arm that never opened the file cannot have had it evicted. Scoring
the failing assertion by name needs the staged ground-truth tests run without `score.sh`'s own
`tail -25`, which truncates the failure list.

§21 is reproducible from the eval, with no API key and no network. Import a Harbor job's dumped
bodies together with the proxy log that job wrote — the log is what carries the real
chars-per-token ratios, and without it the replay is not faithful:

```
cd eval && npx tsc
node dist/main.js import-recordings <job>/agent/onepass/bodies \
  --name harbor-corewars --proxy-log <job>/agent/onepass/proxy.log.*.jsonl
ONEPASS_TRIP_TOKENS=80000 ONEPASS_BATCH_MIN_TOKENS=0 \
  node dist/main.js replay --recording harbor-corewars
ONEPASS_TRIP_TOKENS=80000 ONEPASS_BATCH_MIN_TOKENS=20000 \
  node dist/main.js replay --recording harbor-corewars --compare <label of the run above>
```

`eval/replay-bars.mjs` runs both arms at each T and checks the bars in one command
(`--min`, `--t`, `--recording`); it exits non-zero when one fails, and is what runs beside
`npm test` on any change to the eviction code.

§16 is reproducible from the two runs' own artifacts, via the tested reporter rather than an
ad-hoc script:

```
cd proxy && npm run report -- <transcript> <proxy log>
```

| | transcript | proxy log |
|---|---|---|
| run 2 | `-private-tmp-onepass-eval-mastra-18877/0865d8fc-….jsonl` | `proxy.log.2026-09-02T05-44-05-988Z.jsonl` |
| run 3 | `-private-tmp-onepass-eval-mastra-toolcall/648d49d5-….jsonl` | `proxy.log.2026-09-02T19-45-10-198Z.jsonl` |
| run 5 | `-private-tmp-onepass-eval-mastra-run5/ad20b9c0-….jsonl` | `proxy.log.2026-09-03T04-10-52-306Z.jsonl` |
| run 6 | `-private-tmp-onepass-eval-mastra-run6/81596f1f-….jsonl` | `proxy.log.2026-09-03T05-53-43-658Z.jsonl` |

Median/p90 and the quarter-medians are not reporter output; they sum `input_tokens +
cache_read_input_tokens + cache_creation_input_tokens` per assistant entry. Validate any such
script by checking its max equals the reporter's peak before trusting its other percentiles.
