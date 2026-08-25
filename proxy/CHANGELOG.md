# Changelog

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
