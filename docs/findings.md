# Baseline measurements

Everything here was measured from local Claude Code transcripts under `~/.claude/projects/`.
No published source has these numbers. They are the starting evidence for Onepass.

Sample: 335 transcript files. 132 sessions contained at least one compaction, 205 compactions total.

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

## Caveats

- Token counts are estimated as `len(json.dumps(block)) / 4`, not tokenizer-exact.
- §6 is a single session. Verify across more before relying on the 55% figure.
- The sampled sessions are browser-heavy, which inflates the image share in §4 relative to a
  pure coding session.
- A transcript records what happened, not precisely what was sent to the API on each request.
  §2 and §7 use server-reported `usage`, which is exact; §4–§6 infer from transcript content.

## Reproducing

Scripts are ad-hoc. Each figure above was produced by walking the `.jsonl` files and grouping
message content blocks; `compactMetadata` supplies §2 and the recursion test in §1.
