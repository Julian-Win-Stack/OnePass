# Onepass

## What this is

Onepass is a context-management layer for coding agents. The goal is to let a user work a single long task from start to finish in one session — no session hopping, no waiting on compaction, no degradation as the session runs long.

## Approach


Two parts, built in this order:

1. **Recall** — search + fetch over the session transcript, so anything dropped from context can
   be retrieved verbatim. Two shapes exist and are not yet decided between: an MCP server the
   agent queries directly, and a librarian subagent that greps and returns verbatim excerpts.
   Raced once — [docs/findings.md](docs/findings.md) §9.
2. **Eviction** — aggressive removal of superseded *and* still-valid tool results, made safe by (1).

Order is load-bearing. Eviction without recall must be timid, which is why the existing
implementations do not prevent compaction. See [docs/findings.md](docs/findings.md) §6.

An awareness hook was planned as a third part and dropped. Across 3 spike runs the agent called
recall unprompted with no hook installed, and never confabulated. It tries disk first, recall
second.

The load-bearing question — does the agent notice something is missing when the task does not
announce it? — is now verified under the proxy: the stub is the only announcement, and an
unannounced probe was answered exactly via recall (disk first, recall second, no
confabulation). [docs/findings.md](docs/findings.md) §12. Because a chars÷4 estimate
undercounts real tokens by 25–79% depending on content, the trip threshold is denominated
in real tokens, live-calibrated from API `usage` (default `ONEPASS_TRIP_TOKENS=110000` —
see proxy/README.md).

## Stack

- TypeScript (strict), Node

## Structure

```
docs/findings.md   baseline measurements — the evidence base
spike/             throwaway probes, not the product. MCP recall server (src/), the
                   librarian subagent (librarian.md), and the harness that measures
                   them against each other (harness/). See spike/README.md.
proxy/             eviction proxy: sits between Claude Code and the API, stubs old
                   whitelisted segments (tool results, attached-file injections, task
                   notifications) out of /v1/messages requests. Installed locally
                   (bins: onepass-proxy, onepass-report), not published to npm.
                   See proxy/README.md.
.github/           CI (build + tests, Node 20/22/24). A tag-push publish workflow exists
                   but is unused — the package is not published to npm.
```

Otherwise greenfield. Update as directories land.

## Commands

No root package yet. In `proxy/`:

- `npm run build` — compile (strict tsc)
- `npm test` — build, then unit + integration tests (recorded stub upstream, no network)
- `npm start` — run the proxy (build first)
- `npm run report -- <session-jsonl> [proxy-log]` — compaction / eviction / recall report

Deploy (local): `npm i -g .` from `proxy/` symlinks the global bins to the working
tree, so a rebuild is the whole deploy. The proxy is not a background service — start
`onepass-proxy` in a terminal when you want it, and restart it after a rebuild. Nothing
routes through it by default; opt in per session with the `claudep` shell alias
(`ANTHROPIC_BASE_URL=http://localhost:3777 _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 claude`).
The flag is load-bearing: without it Claude Code caps native-1M models at 200k behind a
non-`api.anthropic.com` host (proxy/README.md). Not published to npm. Proxy logs live at
`~/.onepass/proxy.log.<start-time>.jsonl`, one file per run.

In `spike/`: `npm run build` compiles the recall MCP server. The retrieval harness has its own
run instructions in [spike/harness/README.md](spike/harness/README.md).

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

This is the primary input for both halves, and the source recall reads from. Treat it as
read-only — never write to or mutate a transcript.

Measured properties of this data live in [docs/findings.md](docs/findings.md). Read it before
proposing a context strategy; several obvious approaches are already ruled out there.

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
