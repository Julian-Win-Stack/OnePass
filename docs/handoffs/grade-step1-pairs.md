# Handoff: grade Step 1's pairs with Claude Code as the grader

Read `CLAUDE.md`, `CONTEXT.md`, `eval/decision.md` and `docs/findings.md` §19 first. Use the
glossary's words: *grader*, *arm*, *control*, *pair*, *noise floor*, *verdict*. The eval's
*Judge* is the proxy's own model and is not involved here.

## Goal

Step 1 (findings §19) showed the proxied arms pass the same ground-truth tests as the controls.
Tests are a completeness check; they cannot see a clumsy or drifting implementation. This step
answers the code-quality question for those same five finished repos, and at the same time proves
the grading method on material that already exists, so the same script can grade Step 2's pairs
later without re-arguing the method.

The grader is **Claude Code itself**, run non-interactively with `claude -p`. Nothing is built for
the reviewing. The grader runtime under `eval/src/grader.ts` is not used for this and stays as is.

Two deliverables: a driver under `eval/grade/`, and findings §20 with the result and the cost
comparison. Plus the two decision-file edits below.

## Where you work

- `git fetch origin`, then `git worktree add -b grade/step1-pairs .claude/worktrees/grade origin/main`.
  Branch from **`origin/main`**, not local `main`: the root checkout is behind and must not be
  pulled, because another session works there. Do not touch `.claude/worktrees/step1` or `step2`.
- Scratch and raw output: `$HOME/onepass-corpus/grade/`. Keep `STATUS.md` there current: what ran,
  what is pending, every number with its source file. It is your memory if the session compacts.
- PR to `main` when done.

## Material

Everything is under `$HOME/onepass-corpus/ab/` (Step 1's corpus; read `STATUS.md` there first).

| Arm | Condition | Finished repo | Ground-truth score |
|---|---|---|---|
| control2 | no proxy | `mastra-control2/` | 64/65 |
| control3 | no proxy | `mastra-control3/` | 64/65 |
| head1 | proxy `0d06b60` | `mastra-head1/` | 64/65 |
| head2 | proxy `0d06b60` | `mastra-head2/` | 62/65, never touched `stores/convex/src/server/index-map.ts` |
| head3 | proxy `0d06b60` | `mastra-head3/` | 64/65 |

- Every repo is a detached mastra worktree at base commit `a14c2436bc`; `git diff a14c2436bc` in
  each is the arm's diff (~25 files, ~1,150 insertions). **Never modify these worktrees**: no
  checkout, no install, no test run, nothing that writes. The scores above were taken with
  `score.sh`, which staged ground-truth test files into them; `git status` will show those two
  files. Leave them.
- The task the arms implemented: `eval/task/witty-singing-puzzle.md` (the plan) for mastra issue
  #18877. `eval/README.md` "The task" has the background.
- Per-arm run records, all in the corpus: `<arm>.out` is `claude -p`'s JSON result and carries
  `total_cost_usd`, `num_turns`, `duration_ms` and `usage` (`input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`). `<arm>.start` and
  `<arm>.end` are wall clock. `<arm>.sid` names the transcript under
  `~/.claude/projects/-Users-phyonyanwinn-onepass-corpus-ab-mastra-<arm>/`. Transcripts are
  read-only, always.
- `cleanenv.sh` in the same directory strips this desktop session's `CLAUDE_*`, `MCP_*` and
  `ANTHROPIC_BASE_URL` from a child's environment. Every grader call goes through it, or the
  grader inherits whatever the launching session was pointed at.

## The pairs

Eight pairs, each graded in both orderings: sixteen grader calls.

| # | A-side | B-side | Kind |
|---|---|---|---|
| 1–6 | head1, head2, head3 | control2, control3 | every proxied arm against every control |
| 7 | control2 | control3 | **noise floor** (glossary sense: two control answers) |
| 8 | head1 | head3 | a second same-condition pair, proxied; call it that, not "noise floor" |

For each pair draw at random which arm is shown as A in the first call; the second call swaps
them. Record the draw. The grader is **never told** which arm is proxied, and never told a test
score.

## One grader call

Build a scratch directory per call holding: `plan.md` (the plan file, verbatim), `A.diff` and
`B.diff` (each arm's `git diff a14c2436bc`, with the arm name scrubbed from the filename and
content: the diffs carry no arm name, but check), and `QUESTION.md`. Start Claude Code **in that
scratch directory** so no `.mcp.json` from anywhere is picked up, and attach the two finished
repos read-only. The shape, to be checked against `claude --help` on this machine (2.1.265):

```
$HOME/onepass-corpus/ab/cleanenv.sh claude -p \
  --model opus --effort max \
  --allowedTools "Read,Grep,Glob" \
  --add-dir <repo shown as A> --add-dir <repo shown as B> \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --output-format json \
  < QUESTION.md > <call>.out 2> <call>.err
```

Read, Grep and Glob only: no Bash, no Edit, no Write. The grader may read anything in either
repo and the plan; it cannot run tests, and it is told not to want to, because correctness is
already measured. If the CLI needs a permission mode to make that allowlist stick without
prompting, use the least permissive one that does; verify on the first call by grepping its
transcript for any tool other than those three.

`QUESTION.md` says, in this order: what the task was (point at `plan.md`); that A and B are two
independent implementations of it in two copies of the same repository at the same base commit,
attached at these two paths, with diffs in `A.diff` and `B.diff`; that tests have already been
run on both and are not its concern; then the one question, verbatim from `eval/decision.md`:

> Is diff A at least as good a change as diff B, where "as good as" means: does what the plan
> asks, breaks nothing, is as simple as the job allows, and reuses existing code?

Answer format it must follow: reasons first, each one a single sentence naming a file and a line
(or line range) in A or B that anyone can open and confirm, then a last line exactly
`Verdict: Yes`, `Verdict: No` or `Verdict: Unknown`. No other final-line shape counts. A call
whose result has no such line, or whose `is_error` is set, is recorded as Unknown with the reason
("no verdict line", the error), and is listed in the report's problems. Do not retry it silently.

Run four calls at once. Give each a generous timeout (Step 1's `run.sh` shows the pattern) and
record per call: pair, ordering, which arm was A, verdict, the reasons verbatim, `num_turns`,
`duration_ms`, `total_cost_usd`, `session_id`. Keep every `.out`/`.err` and the scratch
directory under `$HOME/onepass-corpus/grade/<pair>/<ordering>/`.

## From two verdicts to one outcome

Call 1 asks "X at least as good as Y?"; call 2 asks "Y at least as good as X?".

| Call 1 | Call 2 | Outcome |
|---|---|---|
| Yes | Yes | same |
| Yes | No | X preferred |
| No | Yes | Y preferred |
| No | No | no clear answer (contradiction) |
| any Unknown | | no clear answer |

Use those plain words in the report: *same*, *proxied preferred*, *control preferred*, *no clear
answer*. Do not add glossary terms.

## The trust check: stop here

When all sixteen calls are in, **stop before writing any verdict on the proxy** and hand the user
two things: the outcomes of pairs 7 and 8, and the full list of reasons with their file:line
citations. The user picks five reasons and opens the files.

- Pairs 7 and 8 must come out *same*. A preferred arm on either means the grader picks winners
  out of luck, and nothing else it says can be read.
- If any of the five checked reasons is false, the grader is making things up. Fix
  `QUESTION.md`, rerun all sixteen, and check again. Iterate the prompt, never the labels.

Only after both checks pass does the report carry a result line. Until then it carries the raw
outcomes and the word "unverified".

## The result

Rule agreed with the user: pairs 7 and 8 *same* **and** the four clean real pairs (head1 and
head3 against both controls) show no preferred arm means **"no quality difference the grader can
see"**. Anything else is reported exactly as it came out, with the reasons, and no verdict on the
proxy either way. head2's two pairs are reported on their own line: it skipped a file and the
tests already say so, so a *control preferred* there is a completeness finding §19 already has,
not a quality one.

## Cost, the second table

Per arm, from `<arm>.out` and `<arm>.start`/`.end`: list-price dollars (`total_cost_usd`), total
tokens as the sum of the four `usage` counters, and each counter on its own (cache reads dominate
and the reader should see that), turns, wall clock. Then the paired differences, proxied minus
control, for each of the six real pairs, and the mean. §19 already notes the shape to expect:
about the same dollars from 40% more turns at 40% of the context, with head3 an outlier at $36.92.
State it as measured, whatever it is.

## Deliverables

1. `eval/grade/`: the driver (shell; `run.sh` and `score.sh` are the house style), the
   `QUESTION.md` template, an `outcome` step that turns sixteen `.out` files into the two tables,
   and a README that says what one call is, how to add a pair, and that a pair is *any two
   finished repos plus a task description*, so Step 2's Harbor output plugs in unchanged. Nothing
   under `eval/grade/` may contain session content: the diffs, reasons and transcripts stay in
   the corpus.
2. `docs/findings.md` §20: the pair table (per pair: kind, the two outcomes by ordering, the
   derived outcome), the trust-check record (which five reasons were checked, by whom, result),
   the result line or "unverified", the cost table, and caveats: n=1 task, eight pairs, the grader
   is the same model family as the arms. Match §19's register. Label the proxy build (`0d06b60`)
   and the grader's Claude Code version.
3. `eval/decision.md`, three edits, each a new bullet that names what it supersedes, in the
   file's existing style:
   - The implementation grader is Claude Code (`claude -p`, Read/Grep/Glob only, both repos
     attached) rather than a direct API call; supersedes the tool-runner description for
     implementation only. Model Opus, effort max; supersedes "Opus 5 at effort xhigh".
   - Both orderings always, one outcome derived from two verdicts; supersedes "one call per pair,
     both orderings only if the floor shows position bias".
   - Trust for the implementation grader is the two same-condition pairs coming out *same* plus
     five user-checked reasons; supersedes "30 hand-labelled pairs at 90%" for implementation.
     The planning grader's rule is untouched.
   The spec issue records the superseded decisions too. **Do not edit any issue.** Put the
   proposed issue wording in the PR body for the user to apply.
4. PR to `main`: the tables, the trust-check record, the proposed issue edits, and the
   Step 2 note: "the driver takes a directory pair; grading Step 2's tasks is a later step, not
   this one."

## Do not

- Edit any GitHub issue. Propose in the PR body only.
- Write to or move any transcript.
- Modify the five mastra worktrees or anything under `onepass-corpus/ab/`. Read only.
- Commit anything from the corpus: no diffs, no reasons files, no `.out`, no transcripts.
- Point the grader at the proxy, or leave `ANTHROPIC_BASE_URL` set. Every call goes through
  `cleanenv.sh`.
- Use anything but the subscription. Claude Code on this machine, as it is logged in.
- Run more mastra arms or invent new tasks. Breadth comes from Step 2.
- Pull or switch branches in the root checkout, or touch the other worktrees.
