# Eval decisions

One line each. Newest at the bottom.

- The grader is trusted only after it agrees with the user on 30 hand-labelled pairs, answering the same yes/no questions; below about 90% agreement the grader prompt is fixed, not the labels.
- Two gates: a build may replace the daily one, and the result must convince a stranger; so confidence intervals, never single runs.
- Two comparisons in one table: control says whether the proxy is safe, previous build says whether a fix helped.
- Corpus is a fixed stored set of sessions, not daily use.
- Planning arm runs Opus 5 at xhigh; implementation arm runs Opus 5 at high; runs 3–6 in findings.md are not comparable.
- Session content stays outside the repo; scripts, case manifest, and result tables are committed.
- Manual, one command, no CI.
- Replay is fresh: a build evicts a stored prefix from an empty state, because the eval compares builds, not history.
- Names live in CONTEXT.md; "judge" is the proxy's, "grader" is the eval's.
- This file is one sentence per decision; ADRs are not used.
- The proxy's judge stays off in every eval arm; the eval measures the rules alone.
- Planning cases are text turns only; tool behaviour is not graded there, though a proxied tool call where control answered in text is counted as cost.
- Implementation tails always fork from one recorded control run at the last turn under 110k, never from scratch, because the proxy is inert before its first trip so the prefix is identical either way.
- Verified 2026-09-04 on Claude Code 2.1.261: `claude -p --resume <id> --fork-session` continues a recorded session under a new id and leaves the parent transcript unmodified.
- The implementation prefix is recorded fresh by run.sh on Opus 5; the planning corpus reuses an old transcript (see below).
- Planning replay reuses the recorded human turns and regenerates one model turn per case; nothing simulates the user.
- The corpus is two sessions, the most complex implementation session and the biggest planning session.
- Proxied arms never compact; a control's compaction is whatever Claude Code does on its own at that window.
- Implementation arms never compact: control runs at the 1M window straight through, because no engineer lets auto-compaction interrupt an implementation.
- The planning session is recorded at the 200k window with the 1M flag off, so Claude Code auto-compacts between turns on its own; no manual /compact.
- Planning recordings go through the proxy with eviction disabled and dumps on, so every exact request body is captured.
- The grader runs on Sonnet first; a question moves to Opus only when Sonnet disagrees with the hand labels on it; Fable is never used.
- The implementation task is mastra #18877 from the stored plan, scored by the PR's two test files, which the user wrote and which are unmerged as of 2026-09-04.
- Cost is reported as four token classes per arm, fresh input, cache write, cache read, output, plus notional dollars at API list price, because the proxy's rebuilds move tokens between classes.
- The planning corpus is the user's existing biggest planning session, not a new recording; its typed turns and manual compaction points are reused, and only the model turns are regenerated on Opus 5 xhigh.
- Planning request bodies are rebuilt from the transcript with the current Claude Code system prompt and tools, which is approximate and stated as such.
- Implementation has two arms, proxied and control at 1M; three tails per arm while fixing, five per arm for a published number.
- A tail restores both halves of state: the forked conversation and a fresh worktree at a snapshot commit taken at the fork point.
- No pass threshold before the first run; the bar is written down after the first result and before the second run, then never moved.
