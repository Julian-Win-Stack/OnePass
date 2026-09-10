# Handoff — Step 3: one line to install, one line to run, one line to turn off

You are one of three sessions running at once. Read CLAUDE.md,
proxy/README.md and proxy/CHANGELOG.md first. This step touches `proxy/` only.

## Where you work

- You run in the main checkout (`/Users/phyonyanwinn/Project/ProJect/Onepass`), which is on
  `main`. Do **not** create a worktree. Step 1 is running in its own worktree at
  `.claude/worktrees/step1` on `step1/mastra-3v3`; that folder has its own checked-out branch, so
  nothing you check out here can affect it, and git will refuse to let you check out its branch.
  Leave that folder alone.
- Create branch `step3/npm-claudep` from `main` and commit there. Do not commit to `main`
  directly: the work reaches `main` through a PR the user reviews, and `npm publish` happens
  from this folder once that PR is merged.
- Manual testing may use port 3777 or `ONEPASS_PORT=0`. Do not use 3781–3783 (Step 1 owns them).
- The global `onepass-proxy` bin is symlinked to this folder's `proxy/dist`, so a build here
  changes what the user's own `claudep` alias runs. That is fine while you test; say so in the
  final message so the user knows to rebuild after the merge.

## Why this step exists

Friction kills adoption before distrust does. Install today is clone → build → link → start a
terminal → remember two env vars, one of which (`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`)
silently caps the window at 200k when forgotten, and the user blames the proxy. The proxy is
also unpublished (`npm view onepass-proxy` is a 404). Engineers should get: `npm i -g
onepass-proxy`, then `claudep` instead of `claude`, and plain `claude` untouched when they
want it off.

## Build

1. **`claudep` bin** in `proxy/` (add to `package.json` `bin`). Behaviour:
   - Start the proxy as a child with `ONEPASS_PORT=0`; read the bound port from the banner
     (the Unreleased CHANGELOG entry says the banner reports it). Judge stays unset unless the
     user's env sets it.
   - Generate a session id, exec `claude --session-id <id> "$@"` with `ANTHROPIC_BASE_URL` and
     `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` set; pass every other argument through
     unchanged, including `-p`.
   - On exit: stop the child, then print one line from the existing reporter
     (`proxy/src/report.ts`, `npm run report`) over that session's transcript and the child's
     log: `onepass: evicted N segments (~X tokens), recalled M, compactions C`. The transcript
     path follows Claude Code's project-slug rule (eval/README.md, "Importing a session"). If
     the reporter cannot find the transcript, print the log-only numbers and say so — never
     crash after the user's session ended cleanly.
   - Keep the exit line quiet when nothing tripped: `onepass: no eviction (peak ~X tokens)`.
2. **Tests** under the proxy's conventions: port parsing from the banner, env passthrough,
   argument passthrough, and an end-to-end run against the eval's fake upstream pattern if
   practical.
3. **Version** `0.3.0`, CHANGELOG entry, `files` in `package.json` includes the new bin and dist.
4. **Install proof without publishing:** `npm pack`, then in a temp prefix
   `npm i -g ./onepass-proxy-0.3.0.tgz` and run `claudep --version` and one real turn through it.
5. **README (proxy/README.md) top, in this order:** install (one line) · run (`claudep`) · turn
   off (use `claude`) · a results section with two clearly marked placeholders for Step 1
   (mastra 3-vs-3) and Step 2 (Terminal-Bench) tables · sharp edges in three lines (§13: tool
   results can be a small share of a real body; §14: a large paste is unevictable; §18: the
   agent can imitate the stub shape) · then the existing content, unchanged, below a
   "How it works" heading. Keep the env-var table.
6. Add `claudep` to CONTEXT.md's vocabulary if the domain doc lists commands.

## Publishing

`npm publish` is an outward-facing, irreversible action. Prepare everything, verify with the
tarball install above, and **stop and ask the user** before publishing. If `npm whoami` fails,
say so and stop there.

## Deliverables

- A PR from `step3/npm-claudep`: bin, tests, README, CHANGELOG, version bump.
- Final message: the exact install/run/off lines as they now appear in the README, the tarball
  test output, and whether publish is ready pending the user's go.

## Do not

- Publish without an explicit yes from the user in this session.
- Change eviction behaviour in `proxy/src`.
- Edit any GitHub issue.
- Alter the semantics of the manual `onepass-proxy` bin; `claudep` is an addition.

