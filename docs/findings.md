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

Anthropic's server-side context editing avoids this by editing after cache lookup. A client-side
proxy cannot.

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
- §17 is n=1 per arm, with the same nondeterminism: run 5 did more work than run 4 (588 vs
  556 turns) and went further into the task (clickhouse, cloudflare, docs, changesets). Peak,
  p90 and the eviction counts are arithmetic over what was actually sent and survive that;
  the wall-clock ordering (35.0 vs 38.0 min) does not, and neither does the imitation count,
  which scales with how many calls got stubbed. The judge's two runs differ in build as well
  as in luck — treat "1 accepted pick" as the order of magnitude, not the number.

## Reproducing

Scripts are ad-hoc. Each figure above was produced by walking the `.jsonl` files and grouping
message content blocks; `compactMetadata` supplies §2 and the recursion test in §1.

§§9-10 are reproducible: see [spike/harness/README.md](../spike/harness/README.md).

§15: start the proxy with `ONEPASS_DUMP_DIR`, run `claude -p` once in the target cwd with the
run's flags, and read `usage` from the `--output-format json` reply; the replayed-output row
is the sum of `message.usage.output_tokens` over the transcript's assistant entries before the
peak (dedupe by `message.id`).

§17 is reproducible the same way, from `/private/tmp/onepass-eval/run{4,5}.report.txt` and
the two transcripts; the imitation count is a scan for `tool_use` blocks whose `input` carries
an `evicted` key, and the ground-truth score is the two test files from mastra `faee052a3c`
copied over the agent's own (`/private/tmp/onepass-eval/score5.sh`).

§16 is reproducible from the two runs' own artifacts, via the tested reporter rather than an
ad-hoc script:

```
cd proxy && npm run report -- <transcript> <proxy log>
```

| | transcript | proxy log |
|---|---|---|
| run 2 | `-private-tmp-onepass-eval-mastra-18877/0865d8fc-….jsonl` | `proxy.log.2026-09-02T05-44-05-988Z.jsonl` |
| run 3 | `-private-tmp-onepass-eval-mastra-toolcall/648d49d5-….jsonl` | `proxy.log.2026-09-02T19-45-10-198Z.jsonl` |

Median/p90 and the quarter-medians are not reporter output; they sum `input_tokens +
cache_read_input_tokens + cache_creation_input_tokens` per assistant entry. Validate any such
script by checking its max equals the reporter's peak before trusting its other percentiles.
