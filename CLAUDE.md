# Onepass

Onepass is a context-management layer for coding agents. The goal is to let a user work a single long task from start to finish in one session — no session hopping, no waiting on compaction, no degradation as the session runs long.

Of those three, **degradation is the pitch**. Readers are on 1M-token windows, where auto-compaction does not fire until around 890k, so avoiding compaction is not on its own a reason to run this. The reason is that models get dumber as the context fills, well before the window is full. Frame docs and results around keeping peak context low, not around compaction counts. The compaction result in the README is a 1M-window session the user compacted twice by hand, at 173k and 291k — auto-compaction never fired. Cite it as evidence of degradation, not of hitting the limit.

Two parts, built in this order:

1. **Recall** — search + fetch over the session transcript, so anything dropped from context can
   be retrieved verbatim.
2. **Eviction** — aggressive removal of superseded *and* still-valid tool results, made safe by (1).

Order is load-bearing. Eviction without recall must be timid, which is why the existing
implementations do not prevent compaction. See [docs/findings.md](docs/findings.md) §6.

`proxy/src/recall.ts` is the recall MCP server, published with the proxy: `.mcp.json` registers it
for work in this repo, and `claudep` registers it per session with that session's id. Its
`recall_search` description carries the legend for the proxy's stubs. `spike/` keeps only the
throwaway parts — the librarian subagent (`librarian.md`) and the harness that raced them.

The proxy runs compiled `dist/`, not `src/`, and it reads no git — uncommitted edits go live once
built, and switching branches changes what runs. It is not a background service — `claudep`
starts one proxy per session and stops it on exit. Running `onepass-proxy` by hand is for working
on the proxy itself, and it needs a restart after a build.

The session transcript is the primary input for both halves, and the source recall reads from.
Treat it as read-only — never write to or mutate a transcript.

Measured properties of this data live in [docs/findings.md](docs/findings.md). Read it before
proposing a context strategy; several obvious approaches are already ruled out there.

What this project learned the hard way lives in [docs/how-i-solved-it.md](docs/how-i-solved-it.md)
— read it before verifying a change, especially one that needs a live run.

## Agent skills

### Issue tracker

GitHub Issues on Julian-Win-Stack/OnePass, via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root, ADRs under `docs/adr/`. See `docs/agents/domain.md`.
