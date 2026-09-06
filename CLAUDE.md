# Onepass

Onepass is a context-management layer for coding agents. The goal is to let a user work a single long task from start to finish in one session — no session hopping, no waiting on compaction, no degradation as the session runs long.

Two parts, built in this order:

1. **Recall** — search + fetch over the session transcript, so anything dropped from context can
   be retrieved verbatim.
2. **Eviction** — aggressive removal of superseded *and* still-valid tool results, made safe by (1).

Order is load-bearing. Eviction without recall must be timid, which is why the existing
implementations do not prevent compaction. See [docs/findings.md](docs/findings.md) §6.

`spike/src/` is the recall MCP server — live, not throwaway: `.mcp.json` registers it in every
session. Its `recall_search` description carries the legend for the proxy's stubs. The throwaway
parts are the librarian subagent (`librarian.md`) and the harness that raced them (`harness/`).

The proxy runs compiled `dist/`, not `src/`, and it reads no git — uncommitted edits go live once
built, and switching branches changes what runs. It is not a background service — start
`onepass-proxy` in a terminal when you want it, and restart it after a build.

The session transcript is the primary input for both halves, and the source recall reads from.
Treat it as read-only — never write to or mutate a transcript.

Measured properties of this data live in [docs/findings.md](docs/findings.md). Read it before
proposing a context strategy; several obvious approaches are already ruled out there.

## Working a ticket

One worktree per issue, branched off `main` as `ticket/<NN>-<slug>` — never a long-lived branch.
Commit there, push, open a PR. The PR diff is the review surface; merging it unblocks what that
issue blocks.

## Keeping the spec and its tickets in sync

A spec is one GitHub issue; the tickets implementing it are issues linked to it. When a spec
decision changes, write it into the spec issue first, then work out which linked tickets that
change invalidates and bring them back in line.

Never edit an issue off your own back — show me the exact edits you propose, spec and tickets
alike, and wait for my go-ahead before touching any of them.

## Agent skills

### Issue tracker

GitHub Issues on Julian-Win-Stack/OnePass, via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root, ADRs under `docs/adr/`. See `docs/agents/domain.md`.
