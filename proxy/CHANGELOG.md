# Changelog

## Unreleased

- `ONEPASS_PORT=0` now works end to end: the startup banner reports the port the operating
  system bound instead of the 0 that was asked for. The eval starts a proxy child per planning
  case and per tail, several at once, and reads each child's port out of that line.

## 0.2.0

Fixes the first real-workload failure (docs/findings.md §13): a proxied session in a large
repo compacted twice because `tool_result` blocks — the only thing 0.1.0 evicted — were ~6%
of the request body.

- Eviction now targets a whitelist of three segment kinds: tool results, **attached file
  content** (`<system-reminder>` Read injections, ~20% of a real body — stubs name the
  original file path from the paired input reminder), and **task notifications**
  (`<task-notification>` user messages — stubs name the task id and output file). Everything
  else — CLAUDE.md reminders, skill/agent listings, compaction summaries, user prose,
  thinking — is protected by omission.
- Text segments are identified by sha1 content hash, so the monotonic evicted set re-stubs
  them across requests exactly like `tool_use_id`s — except inside the protected last-K
  window, so re-reading an evicted file shows live content instead of an instant re-stub.
- Size floor is now configurable and lower: `ONEPASS_MIN_SEGMENT_CHARS` (default 500,
  was a fixed 2,000).
- Thinking blocks are never touched: the client already clears them via API-native
  `context_management`, and signatures forbid edits anyway.
- Debug: `ONEPASS_DUMP_DIR` writes each request body to disk before eviction.

## 0.1.0

Initial release.

- Local HTTP proxy between Claude Code (`ANTHROPIC_BASE_URL`) and the Anthropic API that
  evicts old, large `tool_result` blocks from outgoing requests, keeping long sessions clear
  of auto-compact. Needs uncompressed request bodies (leave `CLAUDE_CODE_GZIP_REQUEST_BODIES`
  unset) and `ONEPASS_TRIP_TOKENS` sized under the window's compact line. The un-evictable
  floor — system prompt, last K turns, small results — still grows ~130–150 tokens/turn, so
  this raises the ceiling on session length rather than removing it.
- Monotonic, batched eviction that preserves the prompt-cache prefix.
- Trip threshold denominated in real tokens, live-calibrated from API `usage`.
- Pressure pass: relaxes the age gate when a burst of large reads outruns it.
- `count_tokens` requests get the same transform as `messages`.
- `onepass-report`: compaction / eviction / recall report over a session transcript plus the
  proxy log. Logs are written one file per proxy run under `~/.onepass/`; the report defaults
  to the newest.
- Verified against Claude Code CLI 2.1.241–2.1.243: ~1.49M raw tokens in one session, sent
  peak 146,947, 289 turns, zero compactions.
