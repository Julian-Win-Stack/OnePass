# Grading a pair

The ground-truth tests say whether a change is *complete*. They cannot see a change that is
clumsy, or over-built, or drifting away from what was asked, because a clumsy change passes the
same assertions a clean one does. This is the second column: a code review of the two changes
side by side, by a grader that is not told which is which.

**A pair is any two finished repositories plus the task description they were both given.** It is
not "proxied and control" — that is what Step 1 happens to put in one. Step 2's Harbor tasks are
pairs the moment they finish, and plug in here unchanged.

## One call

One call is one non-interactive Claude Code, started in a scratch directory holding four files
and nothing else:

| file | what it is |
|---|---|
| `plan.md` | the task description, verbatim |
| `A.diff` | one side's change, against the base commit |
| `B.diff` | the other side's change, against the same base commit |
| `QUESTION.md` | the prompt, which is what is piped in on stdin |

Both finished repositories are attached with `--add-dir`, so the grader can open any file on
either side and confirm what the diffs say. It has **Read, Grep and Glob and nothing else** — no
Bash, no Edit, no Write. It cannot run the tests, and `QUESTION.md` tells it not to want to,
because correctness is measured already and is not the question.

It is asked one question:

> Is diff A at least as good a change as diff B, where "as good as" means: does what the plan
> asks, breaks nothing, is as simple as the job allows, and reuses existing code?

and must answer with reasons — one sentence each, every one naming a file and a line anyone can
open — then a last line that is exactly `Verdict: Yes`, `Verdict: No` or `Verdict: Unknown`.
Anything else, or `is_error` set, is recorded as Unknown with the reason and listed under
problems. Nothing is retried silently.

**Every pair is graded in both orderings: two calls.** One call measures a preference plus
whatever position bias the grader has, and only the pair of them separates the two.

| call 1 | call 2 | outcome |
|---|---|---|
| Yes | Yes | same |
| Yes | No | the call-1 A side preferred |
| No | Yes | the call-1 B side preferred |
| No | No | no clear answer (contradiction) |
| any Unknown | | no clear answer |

## Blinding

The grader is never told which side is which, and the two things that would tell it anyway are
both dealt with before a call starts:

- **The path.** `mastra-head1` beside `mastra-control2` gives the condition away before a line is
  read, so `prepare.sh` copies each finished repo to an opaque name and the copy is what gets
  attached. `arms.tsv` holds the mapping; it is config, not a secret, and it is simply never in
  the call.
- **The content.** `run.sh` refuses to start a call whose `A.diff` or `B.diff` mentions the
  harness — `onepass`, `mastra-head`, `mastra-control`, or any absolute path.

The grader is also never told a test score, and `--setting-sources ""` keeps the operator's own
Claude Code configuration out of it. On 2.1.265 `--safe-mode` alone is not enough for that: a
call under `--safe-mode` still carried the user's `outputStyle` in as an attachment telling it to
keep answers short — to a grader asked for reasons at length.

## Running Step 1's pairs

```sh
./step1.sh prepare     # opaque copies of the finished repos, and their diffs
./step1.sh run         # every pair in pairs.tsv, both orderings, four calls at a time
node outcome.mjs --reasons
```

`run` skips any call that already has a `call.out`, so adding a row to `pairs.tsv` and running
again makes only the new calls.

`GRADE_MATERIAL` is where the finished repos live (default `~/onepass-corpus/ab`), `GRADE_DIR`
where everything this writes goes (default `~/onepass-corpus/grade`). **Neither may be inside this
repository**: diffs, reasons, transcripts and `.out` files are session content and are never
committed. `GRADE_MODEL`, `GRADE_EFFORT`, `GRADE_JOBS` and `GRADE_TIMEOUT` are the knobs; the
defaults are `opus`, `max`, 4 and one hour.

## Adding a pair

1. Put each finished repo in `GRADE_MATERIAL` and give it a token in `arms.tsv`.
2. Add a row to `pairs.tsv`: `pair`, `kind`, and the two sides in the order the **first** call
   shows them. Draw that order at random and say in the file how you drew it — the second call
   swaps them, so the draw decides presentation only, never what is compared.
3. `./step1.sh prepare && ./step1.sh run <pair>`.

`kind` is free text and only labels the row. Three kinds are checks on the grader rather than on
the arms, and each answers a different question:

- **A pair from the same condition** (Step 1's p7, two controls; p8, two proxied arms) asks
  whether the grader tracks the code or the slot. If its answer follows the arm across the swap,
  it is reading; if the two orderings disagree the same way every time, it is position-biased.
  It does *not* have to come out *same*: two runs of one condition are two different changes, and
  Step 1's two controls turned out to differ by a margin the grader saw in both orderings.
- **A positive control** (p9, p10) is a pair whose answer is already known from outside the
  grader. Step 1's tests rank head2 last of the five — 62/65, one required file never opened —
  so head2 against each other proxied arm is a question the grader must get right.
- **A self-pair** (p11) shows the grader the same change on both sides, under two tokens. It must
  come out *same*. It is the only test that the grader can say "same" at all, and none of the
  eight real pairs did.

## Checking a reason

Every reason names a file and a line. `cite.mjs` prints the sentence and the lines it points
at, from the prepared copies, so checking one is reading two short things, not navigating a
repository:

```sh
node cite.mjs list                        # every reason, numbered R1..Rn
node cite.mjs show R27 R140               # the claim, then what is at those lines
node cite.mjs draw 5 --seed 20260909      # a reproducible random sample, resolved
node cite.mjs draw 1 --seed 7 --pair p7   # restricted to one pair
```

A block says so in capitals when a cited file does not exist or the line is past its end. When
the number turns out to be a line in that side's diff rather than in the file — the grader does
this occasionally — the block shows the diff at that line and says which it is showing.

## Step 1 needs a diff builder, and yours may not

`prepare.sh` builds each side's diff with plain `git diff $GRADE_BASE` unless `GRADE_DIFF_CMD`
names something else. Step 1 names `step1-diff.sh`, because plain `git diff` is wrong for those
five worktrees in three ways — `score.sh` staged the human's ground-truth tests over the arms'
own, the arms' saved copies are trustworthy only where they differ from those, and the changesets
the plan asks for are untracked files `git diff` does not show. The script says which correction
is which and why each is applied to every arm identically. A pair that has not been scored in
place needs none of it.

Whatever the builder does, `prepare.sh` checks the result: it lays down the base tree, applies
the diff, and compares against the copy the grader will read. `QUESTION.md` tells the grader the
repository is the base commit plus the diff and nothing else, so that had better be true.

## Files

| | |
|---|---|
| `step1.sh` | Step 1's driver: `prepare`, then `run` |
| `prepare.sh` | one side: opaque copy of a finished repo, plus its diff, plus the base+diff check |
| `step1-diff.sh` | Step 1's `GRADE_DIFF_CMD` (see above) |
| `run.sh` | one grader call |
| `QUESTION.md` | the prompt, with `@A_PATH@` and `@B_PATH@` filled in per call |
| `outcome.mjs` | the `.out` files to the pair table, the checks, the cost table and every reason |
| `cite.mjs` | a reason's file:line citation resolved to the lines it names |
| `arms.tsv`, `pairs.tsv` | Step 1's five repos (plus one duplicate for the self-pair) and eleven pairs |
