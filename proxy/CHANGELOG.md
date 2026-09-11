# Changelog

## Unreleased

- **Recall ships with the proxy**: `onepass-recall`, the MCP server that reads the original
  history back off disk, moved from `spike/src/server.ts` into this package, and `claudep`
  registers it for the session it starts. Eviction is only safe where what it removes can be
  fetched back verbatim, so an install that had the proxy without recall had the dangerous half.
- **Recall reads its own session's transcript**, named by `ONEPASS_SESSION_ID`, rather than the
  newest file in the project directory — which, with two sessions open in one repository, could
  be the other session's history. Without the variable it still falls back to the newest.
- **`claudep`**: one command to run Claude Code through the proxy. It starts a proxy of its own
  on a port the operating system picks, runs `claude` against it with the first-party flag set,
  kills the proxy afterwards and prints one line saying what the session evicted. Every argument
  is passed through, `claudep mcp …` and `--help` skip the proxy entirely, and a resumed session
  keeps its own id. A session per proxy is what keeps two sessions' evicted-id sets, calibration
  and logs from mixing — one shared proxy put one session's stubs in another session's request.
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
