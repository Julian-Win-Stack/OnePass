# Changelog

## 0.1.0

Initial release.

- Local HTTP proxy between Claude Code (`ANTHROPIC_BASE_URL`) and the Anthropic API that
  evicts old, large `tool_result` blocks from outgoing requests, so long sessions never hit
  auto-compact.
- Monotonic, batched eviction that preserves the prompt-cache prefix.
- Trip threshold denominated in real tokens, live-calibrated from API `usage`.
- Pressure pass: relaxes the age gate when a burst of large reads outruns it.
- `count_tokens` requests get the same transform as `messages`.
- `onepass-report`: compaction / eviction / recall report over a session transcript plus the
  proxy log.
- Verified against Claude Code CLI 2.1.241–2.1.243: ~1.49M raw tokens in one session, sent
  peak 146,947, 289 turns, zero compactions.
