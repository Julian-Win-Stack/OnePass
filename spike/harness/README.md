# Retrieval harness

Measures whether an agent can still answer a question about a fact that has left its context —
and what that answer costs. Produces §§9-10 of [docs/findings.md](../../docs/findings.md).

## The test

One Claude Code session, four turns:

1. **See the fact.** Read `build-manifest.txt`: 40 modules, each with a random build hash. The
   answer is the hash on the `throttle` row. `setup.sh` saves it as the needle.
2. **Lose the source.** The driver deletes `build-manifest.txt` between turns 1 and 2. From here
   the only surviving copy of the hash is in the session log on disk.
3. **Lose the context.** Read four ~221 KB trace logs of generated noise, ~110k tokens, past the
   100k autocompact threshold. Compaction runs and the manifest goes.
4. **Ask for it back.** "What is the build-hash for `throttle`?"

Passing means reproducing the hash exactly. The interesting number is not whether it passes but
how many tokens and seconds the retrieval cost.

Few large files, not many small ones: filling context is bounded by model round-trips, not
tokens, so 4 reads beat 42.

## Arms

The arm name's first letter picks the mechanism.

- `K*` — keyword: the [recall MCP server](../src/server.ts), `recall_search` + `recall_get`.
  No subagent.
- `L*` — librarian: [`spike/librarian.md`](../librarian.md) installed as a project-local subagent,
  with `__TRANSCRIPT__` replaced by the session's transcript path. No MCP.

Both arms are *told* which mechanism to use. That is a deliberate limit, not an oversight — a
subagent cannot use a tool the session's allowlist excludes, so the caller can always do by hand
whatever the librarian does, and an unforced comparison would just measure which one the model
felt like reaching for.

## Running

```
export ONEPASS_HARNESS_DIR=/tmp/onepass-harness   # optional, this is the default
npm --prefix .. run build                          # K arms need spike/dist/server.js
./setup.sh K1
./drive.sh  K1
node analyze.mjs K1
```

`setup.sh` builds the fixture and picks a session id. `drive.sh` runs the four turns
non-interactively, one `claude --print` call per turn. Expect ~10 minutes per arm; run arms
sequentially, since parallel runs roughly double each other's wall clock.

Progress streams to `$ONEPASS_HARNESS_DIR/arm-<ARM>.progress`, raw output to `.out`/`.err`.

## Reading the result

`analyze.mjs` reads the session transcript and reports, counting only tool calls made after the
final question:

- `lookups` / `emptyLookups` — retrieval calls, and how many came back with nothing
- `totalTokensReturned` — what retrieval pushed back into the main context. The cost being
  measured.
- `totalLookupSeconds` — wall clock spent retrieving
- `correct` — whether the final answer contains the needle verbatim
- `compactions` — compaction events in the run

`totalTokensReturned` counts only what entered the *main* context. A librarian's own internal
tool calls do not appear there; read `.out` for the subagent's token usage.
