// One grader call, driven through the fake upstream with canned verdicts.
//
// The paths worth the most here are the ones that do not produce a verdict. An eval whose
// grader quietly answers Unknown when it ran out of turns reports a number that is partly the
// grader giving up, so every test below that ends in Unknown also checks that the run is told
// why, in the warning and in the problems list alike.

import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeUpstream, type CannedTurn, type FakeUpstreamOptions, type RecordedRequest } from "./fakeUpstream.js";
import {
  CACHE_EXPECTED_ABOVE,
  GRADER_TURN_CAP,
  cachingProblem,
  gradePair,
  type GraderCall,
  type Pair,
  type GraderQuestion,
} from "./grader.js";
import type { Problem } from "./result.js";

/** The repository the answers were written against. */
function aRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "onepass-eval-repo-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "evict.ts"), "export function evict(): void {}\n");
  return dir;
}

function aQuestion(): GraderQuestion {
  return { id: "as-good-a-next-turn", ask: "Is answer A at least as good a next turn as answer B?" };
}

function aPair(): Pair {
  return {
    case: "planning-42",
    id: "proxied-vs-control-1",
    answers: [
      { id: "proxied", text: "Read the eviction rules first, then write the test." },
      { id: "control-1", text: "Write the test first, then read the eviction rules." },
    ],
  };
}

interface Graded {
  call: GraderCall;
  warnings: string[];
  requests: RecordedRequest[];
}

interface GradeRun {
  random?: () => number;
  maxTurns?: number;
  contextLimit?: number;
  /** Point the client somewhere other than the fake, which is how a failed call is tested. */
  baseUrl?: string;
}

/** Grades one pair against a fake upstream running `answer`. */
async function grade(answer: FakeUpstreamOptions["answer"], options: GradeRun = {}): Promise<Graded> {
  const upstream = await startFakeUpstream({ answer });
  const warnings: string[] = [];
  try {
    const call = await gradePair({
      client: new Anthropic({ apiKey: "not-a-key", baseURL: options.baseUrl ?? upstream.url, maxRetries: 0 }),
      model: "claude-sonnet-5",
      effort: "high",
      question: aQuestion(),
      pair: aPair(),
      repoPath: aRepo(),
      maxTurns: options.maxTurns,
      contextLimit: options.contextLimit,
      random: options.random,
      warn: (line) => warnings.push(line),
    });
    return { call, warnings, requests: upstream.requests };
  } finally {
    await upstream.close();
  }
}

/** What the grader was sent on its `turn`th call. */
function sent(requests: RecordedRequest[], turn: number): any {
  return JSON.parse((requests[turn] as RecordedRequest).body);
}

/** A finished call, with the usage the test is about. Built whole: a partial fake would read
 * `undefined` where the check compares numbers, and `undefined > 2000` is false, so a broken
 * threshold would look like a quiet run. */
function aCall(usage: Pick<GraderCall, "promptTokens" | "cacheReadTokens" | "cacheCreationTokens">): GraderCall {
  return {
    case: "planning-42",
    pair: "proxied-vs-control-1",
    question: "as-good-a-next-turn",
    verdict: "Yes",
    shownAs: { A: "proxied", B: "control-1" },
    turns: 4,
    reason: null,
    waitingOn: null,
    problems: [],
    ...usage,
  };
}

const says = (text: string): CannedTurn => ({ say: text });

/** Where a request carries cache breakpoints, as `message:block type`, in the order sent. */
function marked(body: any): string[] {
  const found: string[] = [];
  body.messages.forEach((message: any, m: number) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block: any, b: number) => {
      if (block.cache_control !== undefined) found.push(`${m}:${b} ${block.type}`);
    });
  });
  return found;
}

test("a finished call answers the question, and leaves nothing behind to explain", async () => {
  const { call, warnings } = await grade(() => says("A reads before it writes.\n\nVerdict: Yes"));

  assert.equal(call.verdict, "Yes");
  assert.equal(call.reason, null);
  assert.deepEqual(call.problems, []);
  assert.equal(call.waitingOn, null);
  assert.equal(call.turns, 1);
  assert.equal(call.case, "planning-42");
  assert.equal(call.pair, "proxied-vs-control-1");
  assert.equal(call.question, "as-good-a-next-turn");
  assert.deepEqual(warnings, []);
});

test("No is a verdict", async () => {
  const { call } = await grade(() => says("Verdict: No"));
  assert.equal(call.verdict, "No");
  assert.deepEqual(call.problems, []);
});

test("an Unknown the grader chose after looking is a verdict, not a problem", async () => {
  // Only a call that stopped early is a problem, and conflating the two is what would let
  // stopping early hide inside the count of Unknowns the grader meant.
  const { call, warnings } = await grade(() => says("I read both and cannot separate them.\n\nVerdict: Unknown"));
  assert.equal(call.verdict, "Unknown");
  assert.equal(call.reason, null);
  assert.deepEqual(call.problems, []);
  assert.deepEqual(warnings, []);
});

test("the verdict is the last one the grader wrote, not the first it weighed", async () => {
  // A grader reasons before it answers, and reasoning about a verdict is written the same way
  // the verdict is. Reading the first line as the answer would count the case it argued against.
  const { call } = await grade(() =>
    says("Verdict: Yes would be right if A had read the rules first.\nIt did not.\n\nVerdict: No"),
  );
  assert.equal(call.verdict, "No");
});

test("a verdict mentioned in passing mid-line is not the grader's answer", async () => {
  // "Verdict:" has to open a line. Reading prose as an answer would count a verdict the grader
  // never gave, and it would count it silently, because a parsed verdict raises no problem.
  const { call } = await grade(() => says("They asked for a verdict: yes or no. I cannot give one."));
  assert.equal(call.verdict, "Unknown");
  assert.equal(call.problems.length, 1, "a verdict was read out of prose that gave none");
});

test("the grader is given read file, search and list, and nothing else", async () => {
  const { requests } = await grade(() => says("Verdict: Yes"));
  assert.deepEqual(
    sent(requests, 0).tools.map((tool: { name: string }) => tool.name),
    ["read_file", "search", "list"],
  );
});

test("it reads the repository through those tools, and what it read reaches the model", async () => {
  const { call, requests } = await grade((turn) =>
    turn === 0 ? { call: "read_file", input: { path: "src/evict.ts" } } : says("Verdict: No"),
  );

  assert.equal(call.verdict, "No");
  assert.equal(call.turns, 2);
  const second = sent(requests, 1);
  const result = JSON.stringify(second.messages.at(-1));
  assert.match(result, /tool_result/);
  assert.match(result, /export function evict/, "the file the grader asked for never reached it");
});

test("the pair is shown in an order chosen at random, and the order is recorded", async () => {
  const kept = await grade(() => says("Verdict: Yes"), { random: () => 0.1 });
  assert.deepEqual(kept.call.shownAs, { A: "proxied", B: "control-1" });

  const swapped = await grade(() => says("Verdict: Yes"), { random: () => 0.9 });
  assert.deepEqual(swapped.call.shownAs, { A: "control-1", B: "proxied" });

  // The recorded order is the order the model saw, not a label written beside an unchanged prompt.
  // Both positions are checked before they are compared: indexOf answers -1 for an answer that
  // never reached the model at all, and -1 sorts first, so comparing alone would call a prompt
  // missing half the pair correctly ordered.
  const shown = JSON.stringify(sent(swapped.requests, 0).messages);
  const asA = shown.indexOf("Write the test first");
  const asB = shown.indexOf("Read the eviction rules first");
  assert.notEqual(asA, -1, "the answer recorded as A never reached the model");
  assert.notEqual(asB, -1, "the answer recorded as B never reached the model");
  assert.ok(asA < asB, "the answers were recorded as swapped but sent in the original order");
});

test("with nothing pinning it, the order is drawn afresh for each pair", async () => {
  // Every other test here injects `random` to pin the order, which leaves the default free to
  // become a constant without one of them going red. A grader that always sees the same arm as A
  // is the position bias the noise floor exists to detect, so the signal would be gone while the
  // run still looked healthy. Nothing is injected below: this is the default drawing the order.
  const draws = 40;
  const shownAsA = new Set<string>();
  for (let draw = 0; draw < draws; draw += 1) {
    const { call } = await grade(() => says("Verdict: Yes"));
    shownAsA.add(call.shownAs.A);
  }

  // Forty draws landing the same way is about one run in 5e11, so a red here is the default
  // having stopped varying rather than a coin that kept coming up heads.
  assert.deepEqual([...shownAsA].sort(), ["control-1", "proxied"]);
});


test("the question and the answers are sent behind a cache breakpoint", async () => {
  // System and tools come to 465 tokens, under the ~1024 the API will cache at all, so a
  // breakpoint on the tools would be accepted and silently do nothing. It has to sit after the
  // answers to cover a prefix big enough to cache.
  const { requests } = await grade(() => says("Verdict: Yes"));
  const first = sent(requests, 0);

  assert.deepEqual(first.messages[0].content[0].cache_control, { type: "ephemeral" });
  assert.match(first.messages[0].content[0].text, /Read the eviction rules first/);
});

test("the second breakpoint follows the tool results down, one mark at a time", async () => {
  // A breakpoint that only ever sat on the question would cache the opening line and nothing
  // else, and the tool results below it — most of a long call's prompt — would be re-sent whole
  // on every turn. Marking the newest result instead is what makes each turn read back the ones
  // before it. The old mark has to go: the API allows four and a call may take forty turns, so
  // marks left behind would fail the call outright partway through.
  const { call, requests } = await grade((turn) => (turn < 3 ? { call: "list", input: {} } : says("Verdict: Yes")));

  assert.equal(call.turns, 4);
  assert.deepEqual(marked(sent(requests, 0)), ["0:0 text"]);
  assert.deepEqual(marked(sent(requests, 1)), ["0:0 text", "2:0 tool_result"]);
  assert.deepEqual(marked(sent(requests, 2)), ["0:0 text", "4:0 tool_result"]);
  assert.deepEqual(marked(sent(requests, 3)), ["0:0 text", "6:0 tool_result"]);
});

test("a tool the grader invented is answered, not left to end the call", async () => {
  // The grader is one model turn from a verdict when it misremembers a tool name, and a call that
  // died there would be counted as an Unknown the grader chose. It is told what it may call
  // instead, which is the same bargain the tools make by answering a bad path as text.
  const { call, requests } = await grade((turn) =>
    turn === 0 ? { call: "write_file", input: { path: "x" } } : says("Verdict: No"),
  );

  assert.equal(call.verdict, "No");
  assert.equal(call.turns, 2);
  const answer = sent(requests, 1).messages[2].content[0];
  assert.equal(answer.is_error, true);
  assert.equal(answer.content, "There is no tool called write_file. The tools are: read_file, search, list.");
});

test("a call records how full its context was when it finished", async () => {
  // The last turn's prompt is the high-water mark, and the number a verdict decided at the top of
  // the window would show. Reading input_tokens alone would call this prompt 900 tokens when 7000
  // reached the model, and would read *smaller* the better the cache worked.
  const { call } = await grade((turn) =>
    turn === 0 ?
      { call: "list", input: {}, usage: { input: 4_000, cacheCreation: 5_000 } }
    : { say: "Verdict: Yes", usage: { input: 900, cacheRead: 6_000, cacheCreation: 100 } },
  );

  assert.equal(call.promptTokens, 7_000);
});

test("cache reads are totalled across every turn of a call", async () => {
  // A call reads the cache once per turn after the first, and only the total says what the cache
  // saved. Keeping the last turn's figure alone would under-report a long call by its whole
  // history — exactly the calls where caching matters most.
  const { call } = await grade((turn) =>
    turn < 2 ?
      { call: "list", input: {}, usage: { cacheRead: 1_500, cacheCreation: 400 } }
    : { say: "Verdict: Yes", usage: { cacheRead: 2_000, cacheCreation: 50 } },
  );

  assert.equal(call.turns, 3);
  assert.equal(call.cacheReadTokens, 5_000);
  assert.equal(call.cacheCreationTokens, 850);
});

test("a run whose big calls never read from cache raises one problem", async () => {
  // Caching that never fires is invisible in the verdicts and shows only on the bill, and a cache
  // written but never read costs more than not caching at all.
  const problem = cachingProblem([
    aCall({ promptTokens: 40_000, cacheReadTokens: 0, cacheCreationTokens: 12_000 }),
    aCall({ promptTokens: 55_000, cacheReadTokens: 0, cacheCreationTokens: 18_000 }),
  ]);

  assert.equal(problem?.what, "caching never fired across 2 grader calls");
  assert.match(problem?.detail ?? "", /30000 tokens were written to the cache and none were read back/);
});

test("a run where caching fired anywhere raises nothing", async () => {
  // One read proves the breakpoint is placed right and the prefix is stable. A single call that
  // missed is an expired entry, and warning about it would train the reader to ignore the line.
  const problem = cachingProblem([
    aCall({ promptTokens: 40_000, cacheReadTokens: 0, cacheCreationTokens: 12_000 }),
    aCall({ promptTokens: 55_000, cacheReadTokens: 31_000, cacheCreationTokens: 0 }),
  ]);

  assert.equal(problem, null);
});

test("a run of calls too small to cache raises nothing", async () => {
  // Under the API's minimum, no cache read is the correct outcome rather than a broken one, and a
  // check that cannot tell those apart cries wolf on every short run.
  const problem = cachingProblem([
    aCall({ promptTokens: CACHE_EXPECTED_ABOVE, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    aCall({ promptTokens: 700, cacheReadTokens: 0, cacheCreationTokens: 0 }),
  ]);

  assert.equal(problem, null);
});

test("the grader is never told which arm wrote which answer", async () => {
  const { requests } = await grade(() => says("Verdict: Yes"));
  const whole = (requests[0] as RecordedRequest).body;
  assert.doesNotMatch(whole, /proxied/, "the prompt names the proxied arm");
  assert.doesNotMatch(whole, /control-1/, "the prompt names the control arm");
});

test("an answer with no verdict line is Unknown, with the reason and a problem", async () => {
  const { call, warnings } = await grade(() => says("Both are fine, honestly."));

  assert.equal(call.verdict, "Unknown");
  assert.match(call.reason ?? "", /no verdict/i);
  assert.equal(call.waitingOn, null);

  assert.equal(warnings.length, 1);
  const warning = warnings[0] as string;
  for (const named of ["planning-42", "proxied-vs-control-1", "as-good-a-next-turn"]) {
    assert.ok(warning.includes(named), `the warning does not name ${named}: ${warning}`);
  }
  assert.equal(call.problems.length, 1, "an Unknown that stopped early is not in the problems list");
  const raised = call.problems[0] as Problem;
  assert.ok(warning.includes(raised.what), "the warning and the problem say different things");
  assert.ok(warning.includes(raised.detail), "the warning and the problem say different things");
});

test("a grader that never stops calling tools is cut off at forty model turns", async () => {
  assert.equal(GRADER_TURN_CAP, 40);
  const { call, warnings, requests } = await grade(() => ({ call: "search", input: { pattern: "evict" } }));

  assert.equal(requests.length, GRADER_TURN_CAP, "the cap is not what stopped it");
  assert.equal(call.turns, GRADER_TURN_CAP);
  assert.equal(call.verdict, "Unknown");
  assert.match(call.reason ?? "", /model turn 40 of its cap of 40/);

  // What it was waiting on is the whole point of the warning: a grader stuck reading the same
  // file forty times and one that was one call from an answer are told apart by this line alone.
  assert.match(call.waitingOn ?? "", /^search\(/);
  assert.match(call.waitingOn ?? "", /evict/);
  assert.equal(warnings.length, 1);
  assert.ok((warnings[0] as string).includes(call.waitingOn as string));
  assert.equal(call.problems.length, 1);
});

test("a call that fails is Unknown with what failed, not a run that throws", async () => {
  // Nothing is listening on port 1, so the client cannot reach an upstream at all.
  const { call, warnings } = await grade(() => says("Verdict: Yes"), { baseUrl: "http://127.0.0.1:1" });

  assert.equal(call.verdict, "Unknown");
  assert.match(call.reason ?? "", /failed/i);
  assert.equal(call.problems.length, 1);
  assert.equal(warnings.length, 1);
});

test("the cap can be lowered, and a lowered cap says its own number", async () => {
  const { call, requests } = await grade(() => ({ call: "list", input: {} }), { maxTurns: 3 });
  assert.equal(requests.length, 3);
  assert.match(call.reason ?? "", /model turn 3 of its cap of 3/);
});

test("a cap below one model turn is refused, because a call that asks nothing is not a call", async () => {
  await assert.rejects(() => grade(() => says("Verdict: Yes"), { maxTurns: 0 }), /capped at one model turn or more/);
});

test("a grader waiting on two tool calls at once is told it was waiting on both", async () => {
  const { call } = await grade(
    () => ({
      calls: [
        { name: "read_file", input: { path: "src/evict.ts" } },
        { name: "search", input: { pattern: "evict" } },
      ],
    }),
    { maxTurns: 2 },
  );

  assert.match(call.waitingOn ?? "", /read_file\(/);
  assert.match(call.waitingOn ?? "", /search\(/);
});

test("a final message with no text at all is Unknown, and says that is what it was", async () => {
  const { call, warnings } = await grade(() => says(""));

  assert.equal(call.verdict, "Unknown");
  assert.match(call.reason ?? "", /no text at all/);
  assert.equal(warnings.length, 1);
  assert.equal(call.problems.length, 1);
});

// --- The context flag -------------------------------------------------------------------------
//
// A call can finish, answer, and still be worth doubting: the model attends worse across a full
// window than an empty one, and nothing about a returned verdict says which it was. These drive
// the size through the fake's usage rather than by building a real 200k prompt, which is why the
// numbers below are exact rather than approximate.

test("a call that finishes at the limit is not flagged", async () => {
  // Exactly at the limit is not over it. The boundary is the whole of the rule, and a check
  // written with >= instead of > would flag a call that was inside its budget.
  const { call, warnings } = await grade(() => ({ say: "Verdict: Yes", usage: { input: 200_000 } }));

  assert.equal(call.promptTokens, 200_000);
  assert.deepEqual(call.problems, []);
  assert.deepEqual(warnings, []);
});

test("a call one token over the limit is flagged", async () => {
  const { call } = await grade(() => ({ say: "Verdict: Yes", usage: { input: 200_001 } }));

  assert.equal(call.promptTokens, 200_001);
  assert.equal(call.problems.length, 1);
});

test("a flagged call keeps the verdict it reached", async () => {
  // The call answered. Turning that into Unknown would throw away a probably-good verdict and
  // count it among the ones where the grader gave up, which is the one number Unknown means.
  const { call } = await grade(() => ({ say: "A reads first.\n\nVerdict: Yes", usage: { input: 250_000 } }));

  assert.equal(call.verdict, "Yes");
  assert.equal(call.reason, null);
  assert.equal(call.waitingOn, null);
});

test("a flagged call tells the report how big it got and what it was measured against", async () => {
  const { call } = await grade(() => ({ say: "Verdict: No", usage: { input: 214_003 } }));

  assert.deepEqual(call.problems, [
    {
      what: "grader context high: case planning-42, pair proxied-vs-control-1, question as-good-a-next-turn",
      detail:
        "the call finished at 214,003 prompt tokens, over the limit of 200,000. " +
        "The verdict (No) stands and may be degraded.",
    },
  ]);
});

test("a flagged call is announced the moment it happens", async () => {
  const { warnings } = await grade(() => ({ say: "Verdict: Yes", usage: { input: 250_000 } }));

  assert.deepEqual(warnings, [
    "[onepass-eval] grader context high: case planning-42, pair proxied-vs-control-1, " +
      "question as-good-a-next-turn — the call finished at 250,000 prompt tokens, over the limit " +
      "of 200,000. The verdict (Yes) stands and may be degraded.",
  ]);
});

test("prompt tokens the cache served count towards the limit", async () => {
  // Caching buys price and latency, never attention: a prompt read back from the cache is exactly
  // as long for the model to attend across as the same prompt sent whole. Thresholding on
  // `input_tokens` alone would leave this call — 25 uncached tokens — looking like a small one.
  const { call } = await grade(() => ({
    say: "Verdict: Yes",
    usage: { input: 25, cacheRead: 240_000, cacheCreation: 10_000 },
  }));

  assert.equal(call.promptTokens, 250_025);
  assert.equal(call.problems.length, 1);
});

test("a stopped call that also ran hot reports both problems", async () => {
  // Two different facts about one call: it never answered, and it was full when it stopped.
  // Keeping only the first would lose the reason it was reading forty times in the first place.
  const { call, warnings } = await grade(
    () => ({ call: "search", input: { pattern: "evict" }, usage: { input: 250_000 } }),
    { maxTurns: 2 },
  );

  assert.equal(call.verdict, "Unknown");
  assert.deepEqual(
    call.problems.map((problem) => problem.what),
    [
      "grader Unknown: case planning-42, pair proxied-vs-control-1, question as-good-a-next-turn",
      "grader context high: case planning-42, pair proxied-vs-control-1, question as-good-a-next-turn",
    ],
  );
  assert.equal(warnings.length, 2, "one of the two problems was never announced");
});

test("a context limit that is not a whole number is refused", async () => {
  // NaN is the one that matters: every `promptTokens > NaN` is false, so a limit that is not a
  // number switches the flag off for the whole run without a word about having done so.
  await assert.rejects(
    () => grade(() => says("Verdict: Yes"), { contextLimit: Number.NaN }),
    /a grader context limit has to be a positive whole number, not NaN\./,
  );
});
