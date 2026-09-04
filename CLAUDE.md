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
docs/agents/       per-repo config the mattpocock engineering skills read
                   (issue tracker, triage labels, domain-doc layout)
eval/              the A/B rig behind findings §§15-18: run.sh (one arm, proxied or control),
                   score.sh (scores it on the real human fix's tests), analyze.mjs (stub-shape
                   imitations, redundant reads, recall calls), and the task plan the agent
                   implements. Needs a mastra clone at $MASTRA_REPO; run artifacts land in
                   $ONEPASS_EVAL_DIR (default /tmp/onepass-eval), never in the repo.
                   See eval/README.md.
spike/             src/ is the recall MCP server — live, not throwaway: .mcp.json registers it
                   in every session, and it is the half that makes eviction safe. Its
                   recall_search description carries the legend for the proxy's stubs.
                   The throwaway parts are the librarian subagent (librarian.md) and the
                   harness that raced them (harness/). See spike/README.md.
proxy/             eviction proxy: sits between Claude Code and the API, stubs old
                   whitelisted segments (tool results, tool_use inputs, attached-file
                   injections, task notifications) out of /v1/messages requests. Installed locally
                   (bins: onepass-proxy, onepass-report), not published to npm.
                   proxy/src/judge.ts adds an optional second layer on top of those rules: at
                   each /v1/messages trip a second model reads the conversation as it went
                   upstream (stubs included) in the background and names blocks that are
                   superseded or belong to a finished sub-task. Off unless
                   ONEPASS_JUDGE_API_KEY is set. Measured in findings.md §17: one accepted
                   pick across two live runs, ~1% of the rules' eviction. Off is the default
                   for a reason.
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
- `npm run report -- <session-jsonl> [proxy-log]` — compaction / eviction / recall / speed report

Deploy (local): `npm i -g .` from `proxy/` symlinks the global bins to the working
tree's `dist/`, so the whole deploy is `npm test` (build + tests) then restarting the
proxy. It runs compiled `dist/`, not `src/`, and it reads no git — uncommitted edits go
live once built, and switching branches changes what runs. The proxy is not a background
service — start `onepass-proxy` in a terminal when you want it, and restart it after a
build. Nothing routes through it by default; opt in per session with the `claudep` shell alias
(`ANTHROPIC_BASE_URL=http://localhost:3777 _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 claude`).
The flag is load-bearing: without it Claude Code caps native-1M models at 200k behind a
non-`api.anthropic.com` host (proxy/README.md). Not published to npm. Proxy logs live at
`~/.onepass/proxy.log.<start-time>.jsonl`, one file per run.

The judge is opt-in per proxy run: set `ONEPASS_JUDGE_API_KEY` (the user's own API key —
never `ANTHROPIC_API_KEY`, which would bill Claude Code to it) in the proxy's terminal, and
optionally `ONEPASS_JUDGE_MODEL` (default `claude-sonnet-5`). Judge calls cost money on that
key. No key is configured on this machine — the `~/.zshrc` export was removed, so the judge is off
everywhere until the operator exports one deliberately in the proxy's terminal. Never print or
copy the value. On §17's evidence (1.1% of the rules' eviction) leaving it off costs almost
nothing.
It may evict user text, but only the block it names and only down to what it leaves
behind — a quote it copies verbatim, a one-line note in its own words (attributed in the stub,
capped at 200 chars), or both; naming a block with neither leaves it untouched. Harness-injected
user text and already-stubbed blocks are never offered to it. Assistant text and thinking are
never touched.

In `eval/`: `./run.sh <arm> [--no-proxy]` runs one A/B arm, `./score.sh <arm>` scores it against
the human fix's tests, `node analyze.mjs <transcript>[=<label>]` counts stub-shape imitations and
redundant reads. Needs `MASTRA_REPO` exported. See [eval/README.md](eval/README.md).

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
- A change under `proxy/src/` is not live until it is deployed. Finish every such change by
  running `npm test` in `proxy/` and restarting `onepass-proxy`.
- Keep this file current: new module, dependency, command, or project-wide rule → edit it in the same change.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on Julian-Win-Stack/OnePass, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. Neither exists yet; skills create them lazily. See `docs/agents/domain.md`.
