# Smoke check: fork and snapshot mechanics

The eval in [spec.md](../spec.md) rests on three mechanisms that had never been exercised on
the current Claude Code:

1. **Resolving a stored session from a foreign worktree.** Planning cases fork a copy of the
   chp99 transcript from a worktree of a *different* repo. If a copy does not resolve there,
   every planning case is dead.
2. **Forking at a point mid-session without disturbing the parent.** Implementation tails fork
   one recording at a message uuid and run to the end. If a fork writes back to its parent, the
   corpus corrupts itself on the first run.
3. **Hiding a worktree snapshot.** The fork point is only known after the recording ends, so the
   files are saved after every tool call as a commit the agent cannot see. If those commits show
   up in the agent's `git status` or `git diff`, the recording stops looking like a real
   session.

This package proves all three before any eval code is written
([issue #4](https://github.com/Julian-Win-Stack/OnePass/issues/4)). It is not the eval: it is the
step the eval's own test suite cannot take, because forking a real session needs a live `claude`.

## Running

```
cd eval/smoke
npm install
npm test          # criteria 4 and 5, plus the transcript reader — no model, free
npm run smoke     # all five mechanical criteria, live: ~4 short model turns
```

`npm run smoke` recreates `$ONEPASS_SMOKE_DIR` (default `/tmp/onepass-smoke`) from scratch, so
every run starts clean. It records its fixture session on `$ONEPASS_SMOKE_MODEL` (default
`haiku`) — the fork mechanics do not depend on the model, and a cheap one keeps the bill at
cents. It exits non-zero if any check fails, and writes `smoke-report.json` beside the corpus.

The sessions it creates stay in `~/.claude/projects/-private-tmp-onepass-smoke-*`; the script
prints those paths and never deletes anything under `~/.claude`. Remove them by hand when you
are done. Nothing here writes to an existing transcript.

## What is where

- [`src/snapshot.ts`](src/snapshot.ts) — the hidden snapshot: stage into a temporary index,
  `write-tree`, `commit-tree`, `update-ref` under `refs/onepass/snapshots/<tool-use id>`, and
  materialise one afterwards as a detached worktree. The eval will use this as it stands.
- [`src/transcript.ts`](src/transcript.ts) — where Claude Code files a working directory's
  sessions, and the turn cut that gives a fork point and the dropped turn's prompt.
- [`src/git.ts`](src/git.ts) — running git, and the one definition of what the agent can see of
  its own git state. Both the live check and the test assert invisibility through it, so they
  cannot drift into asserting different things.
- [`src/smoke.ts`](src/smoke.ts) — the live runner.

---

# What was observed

Run on **2026-09-05**, macOS 25.5.0 (darwin arm64).

| | |
| --- | --- |
| Claude Code, host CLI | `2.1.261` (`claude --version`) |
| Claude Code, stamped into the transcript it wrote | `2.1.261` (the entries' `version` field) |
| Claude Agent SDK | `0.3.261` |
| node | `v24.11.1` |
| git | `2.50.1 (Apple Git-155)` |
| model for the fixture turns | `haiku` |

Commands run: `npm test` (17 of 17 passed), then `npm run smoke`. All five mechanical criteria
passed; nothing failed. Verbatim output of the run:

```
onepass smoke check — issue #4
  host claude:  2.1.261 (Claude Code)
  model:        haiku
  corpus dir:   /tmp/onepass-smoke

recording a two-turn session 5f37e3fc-f3ec-4228-a4d1-cac4dc69615b in /tmp/onepass-smoke/repo
  recorded answer to turn 2: "RELEASE-CAD7816A"

  transcript:   /Users/phyonyanwinn/.claude/projects/-private-tmp-onepass-smoke-repo/5f37e3fc-f3ec-4228-a4d1-cac4dc69615b.jsonl
  written by:   Claude Code 2.1.261
  turns:        2

  check 1: PASS  a transcript copied into a different worktree's project directory resumes by session id
      copied 5f37e3fc-f3ec-4228-a4d1-cac4dc69615b.jsonl -> /Users/phyonyanwinn/.claude/projects/-private-tmp-onepass-smoke-case-worktree/687f154a-09fd-46e3-8e5e-552143307071.jsonl
      its entries still carry sessionId 5f37e3fc-f3ec-4228-a4d1-cac4dc69615b; only the filename is new
      resumed 687f154a-09fd-46e3-8e5e-552143307071 with cwd /tmp/onepass-smoke/case-worktree
      answer: "RELEASE-CAD7816A"
      release tag RELEASE-CAD7816A recalled
  check 2: PASS  a resume-at fork at a model turn, given the recorded user turn, produces exactly one turn
      resumeSessionAt a46b9eac-d804-4e23-9ac2-d71afe7a5af3 (last chain entry of turn 1)
      resumeDropsTurn c85adf54-2ae3-488a-b500-56b8ed2fbf9c (the discarded turn's prompt)
      prompt sent verbatim: "What release tag did I give you? Reply with the tag and nothing else."
      fork session c2cc11d8-c0ac-45bb-9b46-3e15c5ef6165 -> /Users/phyonyanwinn/.claude/projects/-private-tmp-onepass-smoke-case-worktree/c2cc11d8-c0ac-45bb-9b46-3e15c5ef6165.jsonl
      fork transcript holds 2 turns: 1 past the fork point
      kept prefix matches the parent's turn 1
      in the fork's raw bytes: fork point present, dropped prompt uuid absent
      result: is_error=false num_turns=1
      answer: "RELEASE-CAD7816A"
  check 3: PASS  after that fork the parent transcript is byte-identical to what it was before
      resumed copy   unchanged  sha256 c6bb9657d73d198a -> c6bb9657d73d198a
      source session unchanged  sha256 c6bb9657d73d198a -> c6bb9657d73d198a
      two forks ran against the copy; neither appended to it
  check 4: PASS  a hidden snapshot leaves the agent's git status, git diff, git log and index showing nothing
      two snapshots written under refs/onepass/snapshots/
      commands compared across each snapshot: git status --porcelain, git diff, git log --oneline, git ls-files --stage, git branch --list, git stash list, git reflog, git rev-parse HEAD
      all identical before and after each
      git log --oneline still shows 1 commit(s)
      note: git log --all --oneline shows 3 commit(s)
Preparing worktree (detached HEAD 12abbfc)
  check 5: PASS  that snapshot materialises afterwards as a worktree carrying the recorded file state
      git worktree add --detach /tmp/onepass-smoke/tail 12abbfc3c6
      tracked.txt   = "edited by the agent\n"  (the agent's edit, not the later state)
      untracked.txt = "written by the agent\n"  (never committed by the agent)
      the tail's own git status is clean

5/5 checks passed (criterion 6 is this output)
```

## What this changed about the design

**The project-directory slug comes from the *resolved* path.** The first attempt failed
outright: a session run in `/tmp/onepass-smoke/repo` is filed under
`-private-tmp-onepass-smoke-repo`, because `/tmp` is a symlink on macOS. The rule is every
character outside `[A-Za-z0-9]` replaced by a dash, applied to the realpath. The eval must
resolve a case worktree's path before placing a copy, or the copies land where nothing looks for
them. `projectDirFor` now does.

**A copy resolves by filename, not by what is inside it.** The copy is byte-for-byte the
original, so its entries still carry the *original* session id — only the `.jsonl` filename is
new. Claude Code resumed it anyway and answered from the recorded history. This is what lets
both arms fork one untouched copy with no derived transcript.

**A fork keeps the parent's uuids for the entries it kept, and mints fresh ones past the fork
point.** That is what criterion 2's raw-bytes check reads: the fork point's own uuid is in the
fork's file and the dropped turn's prompt uuid is not, with no turn parser involved on either
side. It also means a fork's kept prefix can be matched to its parent's by uuid, which the eval
can rely on.

**The `resumeDropsTurn` guard did not refuse.** Fork point was the kept turn's last chain entry
and the declared dropped prompt was the next turn's, per the SDK's fork-point guidance. The fork
reported `num_turns=1` and its transcript held exactly one turn past the fork point, whose
prompt was the recorded one byte-for-byte.

**Snapshots hang off the recording's HEAD, not off each other.** Chaining each snapshot to the
one before it would put the whole run's snapshot history into every tail's `git log` once the
snapshot is checked out. Hanging each off HEAD leaves a tail's history as the repository's own
plus exactly one commit.

**`git add -A` into the temporary index obeys `.gitignore`** — an installed `node_modules` is
never recorded, which is what keeps a few hundred snapshots at megabytes.

## Limits of this check — what it does not prove

- **`git log --all` still shows the snapshots.** `--all` means every ref under `refs/`, this
  namespace included, so the run above sees 3 commits instead of 1. Plain `git status`,
  `git diff`, `git log`, `git ls-files`, `git branch`, `git stash list`, `git reflog` and
  `git rev-parse HEAD` are all untouched, which is what the criterion asked for — but an agent
  that runs `git log --all` would see them. Not worth defending against; recorded so it is not a
  surprise later.
- **A tail's `git log` shows one snapshot commit** on top of the repository's real history,
  because the tail is a worktree checked out *at* the snapshot. Making a tail's history look
  untouched would mean restoring the tree into a worktree left at the base commit, so the files
  arrive as uncommitted changes. That is a design choice for the eval, not something #4 asked
  for; `spec.md` says a tail gets "a fresh worktree at the fork snapshot", which is what this is.
- **Every resume here forks.** Criteria 1 and 3 were both run with `forkSession`, because that
  is what the eval does and a non-forking resume would append to the copy the arms share. A
  plain resume by id was therefore never exercised.
- **Tools were off in the fixture turns.** The criterion is about turn count and truncation,
  neither of which involves tools. A planning fork that calls tools before answering, which is
  what the eval will actually run, is not covered here.
- **The fixture is a two-turn session of a few hundred tokens.** Nothing about behaviour at the
  110k–160k contexts the eval forks at was measured.
- **One fork point shape.** A text turn followed by a text turn. A fork at a turn that ended on
  a tool result, or one carrying a trailing attachment, is only covered by `readTurns`' unit
  tests against a fixture, not against a live resume.
- **The snapshot hook is not wired.** `snapshot.ts` was exercised directly against a throwaway
  repository. Calling it from the SDK's post-tool-use hook during a real recording is the
  eval's job and is still unproven.
- **One machine, one OS, one Claude Code version.** Re-run this when 2.1.261 stops being what is
  installed; the whole point is that these are undocumented internals.
