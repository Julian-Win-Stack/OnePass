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
localhost base URL silently drops sonnet's 1M window to 200k.

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

## Caveats

- Token counts are estimated as `len(json.dumps(block)) / 4`, not tokenizer-exact.
- §12 is n=1 on synthetic noise content. Its 1.79× estimate ratio is content-dependent
  (digit-heavy logs tokenize badly); real code sits lower (§11 measured 25–40%).
- §6 is a single session. Verify across more before relying on the 55% figure.
- The sampled sessions are browser-heavy, which inflates the image share in §4 relative to a
  pure coding session.
- A transcript records what happened, not precisely what was sent to the API on each request.
  §2 and §7 use server-reported `usage`, which is exact; §4–§6 infer from transcript content.
- §9 is n=1 per arm. The direction is large enough to act on; the magnitudes are not settled.

## Reproducing

Scripts are ad-hoc. Each figure above was produced by walking the `.jsonl` files and grouping
message content blocks; `compactMetadata` supplies §2 and the recursion test in §1.

§§9-10 are reproducible: see [spike/harness/README.md](../spike/harness/README.md).
