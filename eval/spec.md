# Spec: the Onepass eval

Synthesised from the grilling session of 2026-09-04. Every decision it relies on is a bullet in
[decision.md](decision.md); vocabulary is [CONTEXT.md](../CONTEXT.md). Where this spec goes
beyond a recorded decision it says so, under "Proposed" in Further Notes.

## Problem Statement

I run long Claude Code sessions through the eviction proxy so that a single task fits in one
session without compaction. I cannot tell whether the proxy makes the model dumber at the
sizes where it starts evicting, roughly 110k tokens and up, and I cannot tell what it costs in
tokens, dollars and time compared with running without it. Finding out by hand takes hours of
my attention per proxy fix, so fixes go unmeasured and the findings so far are single runs on
a model and effort I no longer use.

Two people have to be convinced by the answer: me, deciding whether a build may replace the
`claudep` I use daily, and a stranger reading the result on a job application.

## Solution

One command runs a fixed corpus of two stored sessions through the current proxy build and
through an unproxied control, grades the outputs, and writes a result table with confidence
intervals, a cost table, and a time table. The same table shows the current build against
control (is the proxy safe) and against the previous build (did the fix help).

Control is a stored baseline. The control samples and control tails are recorded once and reused
until the model, effort or Claude Code version changes, so an iteration pays for the proxied arm
only. A replay mode with no model calls, run after every fix, checks the proxy's behaviour on the
stored prefixes before any model is paid for.

The corpus is one planning session and one implementation session:

- **Planning.** My existing biggest planning session is replayed one turn at a time, in
  Claude Code itself. Each case is one of my typed turns whose full prefix is past 110k
  tokens, whether or not its recorded answer used tools. The session is forked just before
  that turn and my recorded turn is sent again, so Claude Code builds the request, runs any
  tools, and answers as it would live. The cases are drawn from the three stretches of the
  session that carry them, spanning 110k to 290k, and both arms run at the 1M window so the
  deepest cases fit and neither arm compacts. The answer is regenerated on Opus 5 at xhigh,
  once behind the proxy per build and twice without it, once ever. A grader on Sonnet
  answers yes/no questions about each pair, seeing the full history including everything
  the proxy evicted. The two control answers to the same case give the noise floor.
- **Implementation.** The mastra #18877 task is recorded once as a control on Opus 5 at high,
  with a worktree snapshot taken after every edit. Every arm forks that recording at the last
  turn under 110k, restores the matching worktree snapshot, and runs to the end as a tail:
  three proxied tails while fixing, five for a published number, against stored control tails. Tails are scored by the
  ground-truth tests, deterministic checks, and an Opus 5 grader at effort xhigh that compares a proxied
  tail's diff with a control tail's diff, with control-versus-control pairs as the noise floor.

Cost is four token classes per arm plus notional dollars at list price. Time is request
count, cached versus rebuilt first-byte latency, rebuild count and total API time; wall clock
is shown but never decides.

## User Stories

1. As the proxy's author, I want one command that evaluates the current build end to end, so that a fix costs me no attention beyond starting it.
2. As the proxy's author, I want the result to show the current build beside control, so that I can see whether the proxy is safe to use daily.
3. As the proxy's author, I want the result to show the current build beside the previous build, so that I can see whether a fix helped or hurt.
4. As the proxy's author, I want every quality number to carry a confidence interval, so that I never act on a single lucky or unlucky run.
5. As the proxy's author, I want a noise floor from control-versus-control pairs, so that I can tell a real difference from luck.
6. As the proxy's author, I want the planning replay to reuse my real typed turns, so that the eval measures the sessions I actually have and nothing simulates me.
7. As the proxy's author, I want each planning case replayed as a real Claude Code turn forked from the stored session, so that the harness, tools and request are the real ones and nothing has to be rebuilt or defended.
8. As the proxy's author, I want every turn past the threshold replayed whether or not its recorded answer used tools, with the two kinds reported as separate groups, so that the corpus looks like a real session and I can see whether the proxy hurts one kind more than the other.
9. As the proxy's author, I want a proxied tool call where control answered in text to be counted as cost, so that a build that makes the model re-read things is charged for it.
10. As the proxy's author, I want the grader to see the full history including evicted content, so that it judges each answer against everything the session actually contained.
11. As the proxy's author, I want both graders to read the repo the answer was written against, so that a judgment about code is checked against real code and not guessed.
12. As the proxy's author, I want every grader question to be yes/no with an "Unknown" exit, so that verdicts are countable and the grader is never forced to guess.
13. As the proxy's author, I want each pair shown to the grader in a random order, and the noise floor to expose any position bias, so that bias is detected without doubling the grader calls.
14. As the proxy's author, I want to hand-label 30 pairs with the same question, so that I know how far to trust the grader before I trust a number.
15. As the proxy's author, I want the calibration to report agreement on the deciding question, so that I fix the grader prompt where it disagrees with me and move only that question to Opus.
16. As the proxy's author, I want the implementation tails to fork from a single recorded control prefix, so that every arm starts from an identical 110k state and the run is shorter than 35 minutes.
17. As the proxy's author, I want each tail to get its own worktree at the snapshot taken at the fork point, so that the code state matches the conversation state.
18. As the proxy's author, I want the snapshots to be invisible to the agent, so that its `git status` and `git diff` behave as they would in a real session.
19. As the proxy's author, I want tails to run in parallel, so that five per arm finish in one sitting.
20. As the proxy's author, I want tails scored by the ground-truth tests the agent never sees, so that it cannot flatter its own implementation.
21. As the proxy's author, I want deterministic checks on each tail's diff, so that type errors, lint failures and diff size are counted without a model.
22. As the proxy's author, I want an Opus 5 grader at effort xhigh that compares a proxied tail's diff with a control tail's diff and judges which is the better change, so that simplicity and reuse of existing code are measured and not just test counts.
23. As the proxy's author, I want implementation arms to run without compaction, so that the control is what an engineer would actually do at 1M.
24. As the proxy's author, I want planning cases drawn from the session's three deep stretches, spanning 110k to 290k, so that the corpus reaches the sizes where the proxy evicts most.
25. As the proxy's author, I want the proxied planning arm to see that history with the proxy's stubs and the control arm to see it whole, so that the only difference between the arms is the proxy.
26. As the proxy's author, I want cost broken into fresh input, cache write, cache read and output, so that a rebuild that moves tokens between classes is visible.
27. As the proxy's author, I want notional dollars at list price beside the token counts, so that a stranger can read the cost in one number.
28. As the proxy's author, I want time reported as request count, cached and rebuilt first-byte latency, rebuild count and total API time, so that the proxy's own overhead is separated from the model's.
29. As the proxy's author, I want path metrics such as turns, tool calls, recall calls, redundant reads and imitations shown as diagnostics, so that I can see how a build changed behaviour without them deciding the result.
30. As the proxy's author, I want the eval to launch the proxy build under test itself, so that I never forget to restart it after a build.
31. As the proxy's author, I want the proxy's judge held off in every arm, so that the eval measures the rules alone.
32. As the proxy's author, I want session content kept outside the repo, so that my transcripts and request dumps are never committed.
33. As the proxy's author, I want the scripts, price table and result documents committed, with each result carrying the case list it ran, so that a stranger can see exactly what was run and rerun it.
34. As the proxy's author, I want the bar written down after the first result and before the second run, so that I cannot move it to fit a result.
35. As the proxy's author, I want the eval to refuse a second run while the bar is unwritten, so that the rule is enforced and not remembered.
36. As the proxy's author, I want a quick mode while fixing and a full mode for a published number, so that iteration is cheap and the final number is solid.
37. As the proxy's author, I want the control samples and control tails recorded once and reused, so that a build under test pays only for its own arm.
38. As the proxy's author, I want a replay mode that pushes the stored prefixes through the proxy with no model calls, listing each case and its prefix size as it goes, and diffs the eviction outcome against the previous build, so that most fixes are checked in seconds for free and I can see what a scored run would cover before starting one.
39. As the proxy's author, I want the eval to never write to a transcript in my projects directory, so that a bug cannot corrupt the sessions it reads.
40. As a stranger reading the result, I want one table with control, previous build and current build, so that I can judge the claim without reading the code.
41. As a stranger reading the result, I want the grader's agreement with hand labels stated beside the result, so that I know how much to trust the grader.
42. As a stranger reading the result, I want the approximations named, so that I know the planning forks ran under today's Claude Code, the repo commit per case is approximate, and every planning case sits on history that opens with a compaction summary.

## Implementation Decisions

### Shape and location

- The eval becomes a package beside the proxy with the proxy's conventions: TypeScript, compiled before running, tests under Node's built-in runner. The current shell scripts and analyzer are folded into it.
- One entry command with three modes, replay, quick and full. Replay makes no model calls: it builds a request body from each case's message list with a placeholder system prompt, since eviction acts on messages and not on the system prompt, runs it through a fresh proxy child against the eval's fake upstream, and writes a diff of trips, segments evicted, stub text, body sizes and rebuild count against the previous build, listing each case and its prefix size as it goes; it is not scored and the bar rule ignores it. Quick is three proxied tails and every second eligible planning case; full is five proxied tails and every eligible case. Quick and full are run once per behavioural change, replay after every fix.
- The command builds and starts the proxy under test itself, one process per planning case and one per proxied tail, each on an ephemeral port with the judge unset. The globally running proxy is never used. Restarting per case is what makes each replay fresh.
- All session content lives under one corpus directory outside the repo, set by an environment variable: transcript copies, replay-mode bodies, fork outputs, grader outputs, hand labels and case and tail worktrees. Only the scripts, price table, calibration summary and result documents are written inside the repo.
- Every run is labelled by the proxy's git short SHA and the time it started, so two runs of the same build never collide. Results are one JSON document per run plus a rendered Markdown table. The report takes the current run and the label of the previous run to compare against.
- Control is a stored baseline in the corpus directory, keyed by model, effort and Claude Code version. Control planning samples and control tails are recorded on the first run and reused by every later run; the eval re-records them only when the key changes, and the report names the baseline it used.

### Planning corpus

- The planning session is my biggest existing session. The candidate is the chp99-takehome transcript of 11–12 August 2026: 122 turns I typed, 631 text-only model turns, and 6 compactions. Two smaller transcripts share its first timestamp and are earlier forks of it; the biggest is the superset. Counting rule matters here, because an earlier draft of this spec said 140: that number counted the 6 compaction summaries and 12 system-injected meta entries as turns I typed. A case must never be one of those, so the rule is explicit — a `user` entry that is not sidechain, not `isMeta`, not a compaction summary, and carries no `tool_result` block.
- All 6 compactions were `trigger: manual` — I typed `/compact` at 173k, 291k, 159k, 206k, 159k and 237k. None was forced, so no compaction marks a ceiling and "before the first compaction" is not a natural boundary.
- The session changes model partway through. The three stretches before the third compaction were recorded on Fable 5; the four after it on Opus 5, at effort xhigh except two stretches at max. This is measured from the transcript, not assumed.
- Importing copies the transcript into the corpus directory. The original under the projects directory is never opened for writing by any eval code.
- Cases are taken from the three stretches that carry turns past the threshold at useful depth: the two Opus stretches of 21 eligible turns each, reaching 205k and 197k, and the Fable stretch of 8 eligible turns reaching 290k. That is 50 cases spanning 110k to 290k. Both arms fork the same untouched copy of the transcript, placed under a new session id where Claude Code looks for the case worktree's sessions.
- The first stretch of the session is deliberately left out. It was recorded on Fable and its turns sit between 131k and 172k, where the proxy evicts only a sixth to a third of the context — the sizes least likely to show a difference. Its 20 eligible turns are not worth the model calls.
- Every case therefore sits on history that opens with a compaction summary rather than raw turns. That is a change from an earlier draft, which used the uncompacted first stretch to avoid it. It costs nothing the eval depends on: the summary is recorded in the transcript, both arms fork identical bytes, and 205k of context is 205k either way. It is named as an approximation in the report.
- Each case runs in a throwaway worktree of the chp99-takehome checkout at the last commit before the case's timestamp, so the model reads code close to what it read live; this is approximate and the report says so. The transcript copy is placed where Claude Code looks for that worktree's sessions.
- Both arms answer on Opus 5 at effort xhigh, whichever model recorded the stretch the case came from. That is the recording's model and effort for the two Opus stretches; for the deep Fable stretch it means Opus continues a session Fable started. Both arms carry that equally, so it cannot favour either, and it is named as an approximation in the report. Claude Code supplies the system prompt, tools and headers itself, so nothing about the request is reconstructed.

### Case extraction

- A case is a turn I typed whose full prefix exceeds the trip threshold of 110k tokens. Below that threshold the proxy evicts nothing, both arms send byte-identical requests, and the model call buys no information. Whether the recorded answer used tools does not decide eligibility: it is recorded as a label on the case, and the result document reports the two groups separately. Size is measured with the count-tokens endpoint over the message list plus the fixed system-and-tools overhead read from the transcript's first model turn usage; the margin only affects turns near the threshold.
- The fork point is the model turn before the case's user turn, so the forked history ends there and the case's user turn is the prompt sent to the fork, verbatim. Both forks see the same full history; the proxy evicts it from an empty state for the proxied fork, and the control fork sends it whole at the 1M window. 1M is what keeps the two arms comparable: at 200k the control fork would auto-compact any case past roughly 170k and answer from a model-written summary, so the arms would differ by two lossy transforms instead of one and nothing could be attributed to the proxy. It is also what makes the 10 cases past 200k testable at all, since a 290k history cannot be loaded at 200k. Neither arm compacts.
- The eligible cases are listed by rule at run time, in session order. Quick mode takes every second one, which spreads the subset across the session with no seed. Every result document records the case list it ran, with turn index and prefix size, and the previous-build comparison refuses when the two runs' case lists differ, so a drift in eligibility fails loudly instead of silently comparing different cases. There is no separate manifest file.
- The fork runs one turn: the model may call tools and the turn ends when it answers in text. The text is what is graded; tool calls inside the turn are not graded but are counted per arm as "asked for a tool" and reported as cost with their tokens. A fork that ends without text, or hits the turn cap, is scored Unknown on every question and reported.

### Planning arms

- Three samples per case: one proxied per build, two control from the stored baseline. The proxied sample against each control sample gives two pairs; the two control samples give one noise-floor pair. The noise floor and its grader verdicts are computed once with the baseline and reused.
- Every sample is a Claude Code fork through the Agent SDK at the 1M window, with full tool access inside its throwaway worktree, the same as the tails. The proxied fork's base URL is the proxy child process, with the assume-first-party flag; control forks talk to the API directly. Both run on Claude Code's own login. My API key is used only for count-tokens and the graders; the proxy's judge key is never set.
- Usage from every fork is taken from the SDK's result message in the four token classes, together with request count, API time and the proxy's own log of trips, rebuilds and first-byte latency.

### Implementation corpus and tails

- The recording is one control run of the existing task at Opus 5 with effort high and the 1M window, the tool allowlist and prompt unchanged from the current script. The old runs in the findings are not comparable and the README will say so.
- The fork point is only known after the recording ends, because it is read from the usage numbers, so the files have to be saved at every point the way the transcript already saves the conversation at every point. During the recording, after every edit, write and shell command, the Agent SDK's post-tool-use hook saves the state of the worktree as a hidden git commit: stage into a temporary index file, write a tree, commit it, and store the commit under a private ref named by the tool-use id. That is four git commands per snapshot. The agent's own index and history are untouched, so its `git status` and `git log` show nothing, and because git stores only changed files and the temporary index is reused, a few hundred snapshots cost megabytes and a fraction of a second each. Afterwards the eval picks the snapshot matching the fork point and materialises it as a fresh worktree per tail. The SDK's own file checkpointing is not used: it watches only the edit and write tools, so it misses files changed by shell commands, and it rewinds in place instead of giving each tail its own copy.
- The fork point is the last tool-result turn whose following model response reported a context, input plus cache read plus cache write, under 110k. The matching snapshot is the one taken after the last edit before that turn.
- A tail is created through the Agent SDK by resuming the recording with the fork flag and the resume-at option pointing at the fork-point message uuid, with the same model, effort, allowlist and permission mode. The continuation prompt is one fixed sentence identical across arms. The recorded transcript is never truncated or edited; the SDK writes the fork under a new session id. The fork point is chosen at a turn boundary, since Claude Code refuses a truncating resume that would drop part of a turn.
- Each tail gets a fresh worktree at the fork snapshot. Dependencies are installed for all tails sequentially before any tail starts, then the tails run in parallel; the earlier finding that two concurrent installs double each other's wall clock is avoided that way, and wall clock never decides anyway.
- The proxied tail uses the proxy child process and the assume-first-party flag; the control tail talks to the API directly at 1M. Neither compacts. Control tails belong to the stored baseline and are run once, five of them, so quick and full modes run only proxied tails.
- The existing scoring script's behaviour is kept: the agent's own tests are saved, the ground-truth pair is staged, and the passing assertion count out of 65 is recorded per tail.

### Graders

- The planning grader runs on Sonnet at effort high, and moves to Opus only when calibration shows Sonnet disagreeing with my labels. The implementation grader runs on Opus 5 at effort xhigh from the start: its one question is a full code review over two worktrees, and it is asked of a few dozen pairs per run, so the stronger model costs little. Fable is never used.
- The grader is a direct API call through the Anthropic SDK's tool runner. Both graders have three read-only tools, read file, search, list, over the repo the answer was written against: the two finished tail worktrees for implementation, the case worktree at the nearest earlier commit for planning. This keeps every model call in the eval behind one HTTP boundary.
- Every question is answered Yes, No or Unknown, one grader call per question per pair. A grader call is capped at 40 model turns. The eval tells a finished call from a capped one by the final message's stop reason: a finished grader ends its turn with a verdict and no pending tool call, a capped one ends with a tool call the runner never answered. Capped calls and calls whose text does not parse as a verdict are both recorded as Unknown with the reason. Each one is printed as a warning the moment it happens, naming the case, the pair, the question and the tool call the grader was waiting on, and the result document carries a problems list with the same entries. The rendered report prints that list in full under the tables, never only a count, and the same goes for forks that hit their turn cap or ended without text, so nothing that stopped early can hide inside an Unknown. The two answers in a pair are shown in an order chosen at random per pair. Position bias would show in the noise floor as control-versus-control drifting from an even split; if the first run shows that, the pair is graded in both orderings from then on.
- The planning grader asks one question of each pair, with the full history in its prompt and the case worktree behind its tools: is answer A at least as good a next turn as answer B. Nothing else is asked.
- The implementation grader asks the same single question of a pair of tails, with the plan in its prompt, both diffs, and both finished worktrees behind its tools: is diff A at least as good a change as diff B. The prompt defines as good as: does what the plan asks, breaks nothing around it, is as simple as the job allows, and reuses what the repo already has rather than re-implementing it. Every proxied tail is paired with every control tail; control tails are paired with each other for the noise floor, computed once with the baseline.
- Deterministic implementation checks: ground-truth assertions passed, type check on touched packages, lint on touched packages, existing tests of touched packages, diff size, files touched, and whether every path and symbol the plan names exists afterwards.
- Calibration: a labelling command shows me a pair and the deciding question and records my answer outside the repo. Agreement is computed against the grader's verdicts on the same pairs and written into the repo as a summary. Below about ninety percent the grader prompt is changed, never the labels. Calibration happens before the first scored run, and its number is printed beside every result.

### Libraries

- Claude Agent SDK for everything that runs Claude Code: the planning forks, the implementation recording, the tails, the snapshot hook, reading session messages, and per-tail token and cost totals from its result message, which already carries the four token classes and API duration per model.
- Anthropic SDK for the eval's own model calls, which are not Claude Code sessions: count-tokens for case selection and the tool runner for the grader.
- The price table is a dated snapshot of LiteLLM's model price file, using the one-hour cache-write rate because Claude Code uses one-hour caching. The SDK's own cost estimate is recorded beside it as a cross-check, never as the number.
- Statistics are written by hand: a Wilson interval and a percentile bootstrap are a few dozen lines, and no maintained npm package covers paired bootstrap. Eval frameworks such as autoevals, promptfoo, evalite and Inspect were considered and rejected: none models forking a stored Claude Code session through a proxy, and adopting one would bend the design to its dataset-and-prompt shape.
- No transcript-parsing library exists and the format is documented as internal and moving; the existing analyzer's parser is kept and extended for compaction boundaries.

### Statistics and reporting

- Planning: the proxied win rate, how often the proxied answer is judged at least as good as the control answer, with a Wilson interval over the pairs. Beside it the noise floor: how often one control answer is judged at least as good as the other, with its interval. The difference between the two, with a bootstrap interval over cases, is the number that decides.
- Implementation: per arm, mean ground-truth assertions with a bootstrap interval over tails, and the deterministic check counts; the difference between arms with its interval is the number that decides. Beside it the grader's proxied win rate against control with its interval, and the control-versus-control noise floor, in the same form as planning.
- Cost: per arm, the four token classes, dollars at list price from a committed price table with its date, request count, rebuild count, cached and rebuilt first-byte latency, and total API time from first request to last. Wall clock is shown in a separate column.
- Diagnostics, never deciding: turns, tool mix, recall calls, redundant reads, imitations, tokens evicted, tokens recalled.
- The bar file: after the first scored run the pass criteria are written into the repo. The command refuses to start a second scored run while that file is missing, and the file is never edited afterwards.

## Testing Decisions

A good test drives the eval from the outside and reads only what a user of it would read: the result document and the rendered table. Tests do not inspect internal state.

- One seam: the HTTP boundary to the model API. A fake upstream, as in the proxy's existing integration test, serves canned count-tokens answers and canned grader verdicts, and stands in for the model behind the replay mode's proxy children. The eval package is run against it with a small synthetic transcript fixture in a temporary corpus directory.
- Through that seam the tests cover case extraction, the transcript copy placement, the replay diff through a fresh proxy child, grading with random pair order and the Unknown verdict, calibration agreement, cost and time accounting from recorded SDK result messages, the noise floor, the confidence intervals on known inputs, the previous-build comparison, baseline reuse and re-recording when the key changes, and the refusal to run without the bar file.
- Snapshot creation and fork-point selection are tested against a throwaway git repository and a fixture transcript, asserting the worktree and index are unchanged and the source transcript is byte-identical afterwards.
- Anything that forks a real session, planning forks and tails alike, needs a live `claude` and is covered by a documented smoke step, not by the test suite.
- Prior art: the proxy's integration test for the fake upstream, its evict and speed tests for pure computation.

## Out of Scope

- Any new recording of a planning session. Decisions about recording at 200k through a passthrough proxy with dumps apply only if one is ever made.
- Simulating the user, by model or by script.
- Grading tool behaviour in planning cases.
- Continuous integration or scheduled runs.
- A pass threshold before the first result.
- Fable as grader, or as the model answering in any arm. Fable-recorded history is in the corpus, since the deepest cases come from a stretch it recorded; Opus answers both arms there.
- Evaluating the proxy's judge; it is off in every arm.
- Comparing with the findings runs 3–6, which used a different model and effort.

## Further Notes

Still proposed, not yet in decision.md:

- How many planning cases. The chp99 transcript has 50 turns that qualify across the three stretches used: 21 in each Opus stretch and 8 in the deep Fable stretch, all past 110k tokens. Full mode runs all 50. Quick mode runs every second one, 25. For each case Claude Code answers the turn three times, once through the proxy and twice without, and each answer may include tool calls before the text. Replay lists the cases and their sizes before anything is spent.
- What the first run costs is not known in advance. Nothing in the findings records Opus cost for a full run, and a planning turn or a tail costs whatever tool calls the model decides to make. The baseline run, which pays for the control samples and control tails once, is where that number is first measured, and every run after it reports the estimate up front.

Known approximations to state in every report: planning forks run under today's Claude Code, not the version that recorded the session; the planning repo commit per case is the nearest earlier commit; planning measures contexts of 110k to 290k; every planning case sits on history that opens with a compaction summary; and the 8 deepest cases were recorded by Fable and are answered by Opus in both arms.
