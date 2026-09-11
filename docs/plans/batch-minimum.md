# Plan: stop paying for tiny evictions — the batch minimum

Written 2026-09-11. Hand this file to one Claude session in this repo; it implements the whole
thing. Every decision is made. Do not ask the user to choose; where a step depends on a
measurement, the rule for deciding is written next to it.

Read first: `CLAUDE.md`, `CONTEXT.md`, `docs/findings.md` §7 and §19, `docs/lessons.md`,
`proxy/README.md` (env table), `eval/decision.md` (the "bar file" rule: write the pass bar
before the run, never move it — the bars below are that file for this work).

## 0. Setup

- Branch from `origin/main` in a new worktree; the root checkout is behind and may be in use:
  `git fetch && git worktree add .claude/worktrees/batch-minimum -b batch-minimum origin/main`
- Copy `docs/lessons.md` and this file from the root checkout into the worktree and commit them
  first. Add one line to `CLAUDE.md` under the docs section pointing at `docs/lessons.md`, so
  every future session sees it.
- `export ONEPASS_EVAL_CORPUS=~/onepass-corpus` for every eval command.
- Commit before each replay run: the run label carries `-dirty` otherwise.
- Never bill `ANTHROPIC_API_KEY`. Replay makes no model calls. The one live run uses the
  Harbor rig on the subscription; see `~/onepass-corpus/harbor/STATUS.md` before touching it.

## 1. The problem, measured (do not re-derive)

- Proxied Harbor runs cost 4× control: $201.91 vs $47.91 (`eval/harbor/RESULT.md`).
- The extra is cache rewrites, not more work. Prices (Opus 5, per MTok): input $5, 1h cache
  write $10, cache read $0.5, output $25. Verified to the cent against Claude Code's own
  `total_cost_usd` on all five mastra arms (`~/onepass-corpus/ab/*.out`):

  | | control2 | head1 (6 trips) | head3 (18 trips) |
  |---|---|---|---|
  | cache reads | $18.34 | $12.46 | $14.22 |
  | cache writes | $2.84 | $7.08 | $19.62 |
  | total | $23.75 | $22.58 | $36.92 |

- A trip changes the middle of the message array, so the API rewrites everything after the
  fixed prefix: ~80% `cache_creation` on every after-trip request; <8% on quiet ones.
- The bug: `proxy/src/evict.ts` trips on `estimate > T` with no minimum, and the pressure pass
  then evicts whatever just aged past K, however small. Once the un-evictable floor (system
  prompt, user text, assistant replies, last K turns) is above T, that is every request.
  Harbor make-mips at T=30k: 112 trips in 119 requests, cache-write share 72%, 108 requests
  still over T after the trip. Healthy head3 at T=110k: 18 trips in 342, share 6.5%. Control: 3%.
- Payback: one trip rewrites ~100k tokens ≈ $1. Removing 1k tokens saves $0.0005 per later
  request. A trip pays for itself only if it removes ≥ ~13k tokens with ~150 requests to go.
- The judge is off in every rig. `count_tokens` is ~0–1% of requests. Both out of scope.
- Even healthy proxied runs only match control cost. The product is a smaller, stable context
  (113k peak vs 285k, same test score, §19), not a cheaper session. Say so in the docs.

## 2. The change

### 2.1 Batch minimum (`proxy/src/evict.ts`)

**Rule.** A trip may only happen when the content it would newly evict is worth at least
`batchMinTokens`. Otherwise evict nothing new on this request; existing stubs stay applied.

- Env knob `ONEPASS_BATCH_MIN_TOKENS`, default `20000`. `0` = off = today's behaviour exactly.
  Add to `EvictionConfig`, `proxy/src/main.ts`, and the README env table.
- What counts: only segments evicted for the *first time* on this request (re-stubbing an
  already-evicted id changes nothing and costs nothing). Size = Σ (`contentChars` −
  `stubbedChars(segment)`) over the batch, ÷ `config.charsPerToken`. Both are already computed
  before any stub is applied (the candidate filter at ~line 496 does the subtraction).
- Pressure candidates count toward the batch. Keep today's order: normal targets (aged ≥ N);
  if the request is still over T after them, add pressure targets (aged ≥ K). Then apply the
  minimum to the *combined* batch: under it → hold everything back; at or over it → apply all.
  This evicts the same content as today, in fewer and larger trips.
- Held-back ids are not added to the evicted set. They are candidates again next request.
- `tripped` stays true in the outcome when over T (it feeds `evictionMeta` on the request log
  entry). Add `heldBackTokens?: number` to the outcome and the request log entry so a reader
  can see "over T, batch of 9k held back".

### 2.2 Alarm line (log only, no eviction behaviour)

- When `estimatedTokensSent > T + 40_000`, set `aboveAlarmLine: true` on the request log
  entry. Nothing else changes. This is how a reader learns the floor has outgrown what
  eviction can hold. There is deliberately **no** line above which the minimum is waived:
  waiving it would bring back tiny trips in exactly the sessions that hurt most.
- Peaks already run ~30k over T; the minimum adds up to 20k. Size T so **T + 60k** clears the
  compaction line (`window − 13k`). README row for T: update the "T + 40k" advice to T + 60k.

### 2.3 Glossary (`CONTEXT.md`, Proxy section)

Add:
- **Batch minimum**: the least a trip must newly evict, in tokens, to be worth the rebuild it
  causes. _Avoid_: gate (the code already uses "age gate" for N/K), floor.
- **Floor**: the part of a request the proxy can never evict: system prompt, user text,
  assistant replies, and everything inside the last K turns. _Avoid_: baseline, fixed part.
- **Alarm line**: T plus 40k. A request sent above it is logged, because the floor has grown
  past what eviction can hold. _Avoid_: hard line, ceiling.

## 3. Tests, in this order. Do not skip down a layer until the one above passes.

### 3.1 Unit: a sequence test (new file `proxy/src/evict.sequence.test.ts`)

Every existing test in `evict.test.ts` feeds one request. The bug only shows across a
sequence. Drive `evictContextSegments` directly, threading `alreadyEvictedIds` between calls
the way `server.ts` does. Fix `charsPerToken` at 4.

Fake session: a floor above T from request 1 (enough assistant text; check `collectSegments`
for what is never a candidate and build the floor from that), then each request appends one
assistant turn and one `tool_use`/`tool_result` pair of ~2,000 chars. 200 requests. N=8, K=4,
T small enough that the floor is over it (e.g. T=10k with a 15k-token floor).

Write these red first, then make them green:
1. `batchMinTokens: 0` reproduces today's outcome on the whole sequence: same stubbed ids on
   every request. (Passes on today's code once the knob exists — it is the off-switch guard.)
2. `batchMinTokens: 20_000`: trips ≤ ⌈total evictable tokens ÷ 20k⌉ + 1. (Today's code: ~190.)
3. Every request's `estimatedTokensSent` ≤ (what min=0 would have sent) + 20k tokens.
4. A batch one token under the minimum is held back; at the minimum it is taken.
5. Content held back on request i is evicted on a later request once the batch reaches the
   minimum, and its id is in the evicted set only from that request on.
6. Pressure candidates count: normal batch under the minimum + pressure batch ≥ minimum → all
   taken in one trip, `pressure: true`.
7. `aboveAlarmLine` is set exactly when sent > T + 40k.

Also the `speed.ts`/`log.ts` types for the two new fields, and a `server.ts` integration test
that the fields reach the log line.

### 3.2 Replay: real recorded traffic, no model, no cost

Two small eval changes first (`eval/src/args.ts`, `run.ts`, `result.ts`, `replay.ts`):
- `replay --recording <name>` (default stays `planning`). Today the name is hard-coded to
  `PLANNING_RECORDING`.
- Record the child proxy's T, N, K and batch minimum in the result document (read them from
  the env you set, or from the proxy's startup banner), and make `--compare` refuse when any of
  them differs between the two runs. Today two replays at different T are indistinguishable.
- Make sure the per-request outcome carries `newlyEvicted` (it does), `estimatedTokensSent`
  and `aboveAlarmLine` (add them from the child's request log entry).

Then:
```
node dist/main.js import-recordings \
  ~/onepass-corpus/harbor/jobs/onepass-first-pass-proxied-20260909T220608Z/make-mips-interpreter__XKM8iF4/agent/onepass/bodies \
  --name harbor-make-mips
```
Four runs, same recording. The proxy child inherits T and the minimum from the shell:
```
ONEPASS_TRIP_TOKENS=110000 ONEPASS_BATCH_MIN_TOKENS=0     node dist/main.js replay --recording harbor-make-mips
ONEPASS_TRIP_TOKENS=110000 ONEPASS_BATCH_MIN_TOKENS=20000 node dist/main.js replay --recording harbor-make-mips --compare <label of the run above>
ONEPASS_TRIP_TOKENS=30000  ONEPASS_BATCH_MIN_TOKENS=0     node dist/main.js replay --recording harbor-make-mips
ONEPASS_TRIP_TOKENS=30000  ONEPASS_BATCH_MIN_TOKENS=20000 node dist/main.js replay --recording harbor-make-mips --compare <label of the run above>
```
Trips = requests with `newlyEvicted > 0`. Peak = max `estimatedTokensSent`.

**Bars, at each T, min=20k against min=0 on the same recording:**
- trips(20k) ≤ 0.2 × trips(0)
- peak(20k) ≤ peak(0) + 20k tokens
- total newly-evicted tokens(20k) ≥ total(0) − 20k (same content, batched; at most one
  held-back batch never taken)
- At T=30k the min=0 run must reproduce Harbor's 112 trips within ±5, or the replay is not
  faithful and nothing below it counts.

If a bar fails, tune `ONEPASS_BATCH_MIN_TOKENS` in replay only (try 15k, 30k), re-run, and
record every value tried and its numbers. Do not change the bars.

### 3.3 One live run. Last, once, after 3.1 and 3.2 pass.

Purpose: confirm the API and the agent behave as the offline layers predict. It is the only
layer that can see cache-write share and compaction.

Task choice, by rule: the saved Harbor recording whose min=0 replay at T=110k shows the most
trips, provided that is ≥ 20 (make-mips first; if under 20, replay corewars and sam-cell-seg
the same way and pick the highest). If no recording reaches 20 trips at 110k, run the live at
T=30k and say so in the report; a live run at a T where nothing trips tests nothing.

Run it proxied through the Harbor rig (`eval/harbor/HANDOFF-LOCAL.md`, `run.sh` takes
`ONEPASS_TRIP_TOKENS`; the container clones a pushed ref, so push the branch first). About
15 minutes and a few dollars. Read the proxy log with:
```
node -e '
const fs=require("fs");const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const r=L.filter(e=>e.kind==="request"&&e.inputTokens!==undefined);
let cw=0,cr=0,inp=0,peak=0;for(const e of r){cw+=e.cacheCreationInputTokens||0;cr+=e.cacheReadInputTokens||0;inp+=e.inputTokens||0;peak=Math.max(peak,(e.inputTokens||0)+(e.cacheCreationInputTokens||0)+(e.cacheReadInputTokens||0));}
const trips=L.filter(e=>e.kind==="trip").length;
console.log({requests:r.length,trips,tripsPer100:(100*trips/r.length).toFixed(1),cacheWriteShare:(100*cw/(cw+cr+inp)).toFixed(1)+"%",peakContext:peak});
' <proxy log>
```
Compactions: count usage drops in the transcript, per `CONTEXT.md` "usage drop".

**Bars:** cache-write share ≤ 10% · trips per 100 requests ≤ 10 · compactions = 0 ·
peak context ≤ T + 60k. Also report `cost_usd` from the trial's `result.json` beside the task's
control cost from `eval/harbor/RESULT.md`; that number is noisy at n=1 and is reported, not
judged.

## 4. The 80k default — decided by measurement, after 3.2 passes

Two more replays on the same recording: `ONEPASS_TRIP_TOKENS=80000` with min=0 and min=20k.
**Switch the default to 80k** (`proxy/src/main.ts`, README row, one line in
`eval/decision.md`) only if, with min=20k: trips per 100 requests ≤ 10 and peak sent ≤ 140k.
Otherwise keep 110k and write down why. Whichever way, the live run in 3.3 uses the default
that is shipped at that point.

## 5. Write it down where the next session will look

- `docs/findings.md`: new section "§21. The 4× cost was cache rewrites; a batch minimum
  removes it" with the tables from 3.2 and 3.3 and the tuning record. Follow the house style:
  verdict first, numbers, caveats. Also fix §7: Anthropic's server-side context editing does
  **not** avoid cache invalidation (their docs: "Tool result clearing: invalidates cached
  prompt prefixes"; `clear_at_least` exists for exactly this reason).
- `eval/decision.md`: one line for the batch minimum, one for the alarm line replacing any
  hard line, one for the 80k decision.
- `CONTEXT.md`: the three terms in 2.3.
- `docs/lessons.md`: already holds the three-layer lesson; add a line if the run teaches a
  new one.
- `proxy/README.md`: env row, the T sizing advice, and one sentence that the proxy matches
  control cost rather than beating it.
- Open a PR from `batch-minimum` to `main` with the numbers in the body.

## 6. Out of scope, deliberately

- Evicting to a lower line, touching cache TTLs, server-side clearing, a fourth
  `cache_control` breakpoint. All discussed; the last is a possible later step and needs a
  cents-level API probe first.
- The judge, `count_tokens`, and the `charsPerToken: 6.54` oddity seen on one Harbor entry.
- Quality grading. It needs re-running only if peak context moves materially, which a 20k
  minimum does not do.
