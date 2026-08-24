# Onepass

## What this is

Onepass is a context-management layer for coding agents. The goal is to let a user work a single long task from start to finish in one session — no session hopping, no waiting on compaction, no degradation as the session runs long.

Two halves:
- **Runtime** — keeps what the agent sees small and useful.
- **Eval** — measures whether a context strategy actually works, since there is currently no accepted way to compare them.

The runtime approach is **not yet decided**. Do not encode a strategy here until it is.

## Stack

- TypeScript (strict), Node
- Both halves are TypeScript. No Python.

## Structure

Greenfield — nothing committed yet. Update this section as directories land.

## Commands

Not yet defined. Add here as `package.json` scripts land (`dev`, `build`, `test`, `lint`).

## Data

Claude Code writes a structured append-only session log per session:

```
~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
```

One JSON object per line. Relevant shape:
- `type`: `user` | `assistant` | `system` | `file-history-snapshot` | `attachment` | `mode`
- `message.content[]`: typed blocks — `text`, `thinking`, `tool_use`, `tool_result`, `image`
- `parentUuid` links entries into a chain
- `isCompactSummary` / `compactMetadata` mark compaction boundaries
- `timestamp`, `cwd`, `gitBranch`, `sessionId`

This is the primary input for both halves. Treat it as read-only — never write to or mutate a transcript.

## Code style

- **Never `any`.** Use the real type, `unknown` at boundaries, a union, or a generic. `catch (err: unknown)` and narrow.
- **Simplest thing that works.** A function over a class, an inline `if` over a dispatch table, a direct call over an indirection layer. Abstract on the third real duplicate, not the first.
- **Comment on the code only when necessary.** Default to none. Write one only when a competent reader would otherwise get it wrong.
- **Obvious names over short ones.** `compactionBoundaryIndex`, not `cbi`.

## Rules

- Transcripts under `~/.claude/projects/` are read-only. Never mutate them.
- No commit or push without explicit instruction.
- No code changes without explicit instruction — investigate and report first.
- Business-logic decisions get a clarifying question, never a default.
- Keep this file current: new module, dependency, command, or project-wide rule → edit it in the same change.
