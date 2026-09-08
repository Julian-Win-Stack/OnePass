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
import { GRADER_TURN_CAP, gradePair, type GraderCall, type Pair, type GraderQuestion } from "./grader.js";

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

interface GradeOptions {
  random?: () => number;
  maxTurns?: number;
  /** Point the client somewhere other than the fake, which is how a failed call is tested. */
  baseUrl?: string;
}

/** Grades one pair against a fake upstream running `answer`. */
async function grade(answer: FakeUpstreamOptions["answer"], options: GradeOptions = {}): Promise<Graded> {
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

const says = (text: string): CannedTurn => ({ say: text });

test("a finished call answers the question, and leaves nothing behind to explain", async () => {
  const { call, warnings } = await grade(() => says("A reads before it writes.\n\nVerdict: Yes"));

  assert.equal(call.verdict, "Yes");
  assert.equal(call.reason, null);
  assert.equal(call.problem, null);
  assert.equal(call.waitingOn, null);
  assert.equal(call.turns, 1);
  assert.equal(call.case, "planning-42");
  assert.equal(call.pair, "proxied-vs-control-1");
  assert.equal(call.question, "as-good-a-next-turn");
  assert.deepEqual(warnings, []);
});

test("No is a verdict, and so is a grader that says Unknown having looked", async () => {
  const no = await grade(() => says("Verdict: No"));
  assert.equal(no.call.verdict, "No");
  assert.equal(no.call.problem, null);

  // An Unknown the grader chose is an answer to the question. Only a call that stopped early is
  // a problem, and conflating the two is what would let stopping early hide inside the count.
  const unknown = await grade(() => says("I read both and cannot separate them.\n\nVerdict: Unknown"));
  assert.equal(unknown.call.verdict, "Unknown");
  assert.equal(unknown.call.reason, null);
  assert.equal(unknown.call.problem, null);
  assert.deepEqual(unknown.warnings, []);
});

test("the verdict is the last one the grader wrote, not the first it weighed", async () => {
  // A grader reasons before it answers, and reasoning about a verdict is written the same way
  // the verdict is. Reading the first line as the answer would count the case it argued against.
  const { call } = await grade(() =>
    says("Verdict: Yes would be right if A had read the rules first.\nIt did not.\n\nVerdict: No"),
  );
  assert.equal(call.verdict, "No");
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
  const shown = JSON.stringify(sent(swapped.requests, 0).messages);
  assert.ok(
    shown.indexOf("Write the test first") < shown.indexOf("Read the eviction rules first"),
    "the answers were recorded as swapped but sent in the original order",
  );
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
  assert.ok(call.problem !== null, "an Unknown that stopped early is not in the problems list");
  assert.ok(warning.includes(call.problem.what), "the warning and the problem say different things");
  assert.ok(warning.includes(call.problem.detail), "the warning and the problem say different things");
});

test("a grader that never stops calling tools is cut off at forty model turns", async () => {
  assert.equal(GRADER_TURN_CAP, 40);
  const { call, warnings, requests } = await grade(() => ({ call: "search", input: { pattern: "evict" } }));

  assert.equal(requests.length, GRADER_TURN_CAP, "the cap is not what stopped it");
  assert.equal(call.turns, GRADER_TURN_CAP);
  assert.equal(call.verdict, "Unknown");
  assert.match(call.reason ?? "", /40 model turns/);

  // What it was waiting on is the whole point of the warning: a grader stuck reading the same
  // file forty times and one that was one call from an answer are told apart by this line alone.
  assert.match(call.waitingOn ?? "", /^search\(/);
  assert.match(call.waitingOn ?? "", /evict/);
  assert.equal(warnings.length, 1);
  assert.ok((warnings[0] as string).includes(call.waitingOn as string));
  assert.ok(call.problem !== null);
});

test("a call that fails is Unknown with what failed, not a run that throws", async () => {
  // Nothing is listening on port 1, so the client cannot reach an upstream at all.
  const { call, warnings } = await grade(() => says("Verdict: Yes"), { baseUrl: "http://127.0.0.1:1" });

  assert.equal(call.verdict, "Unknown");
  assert.match(call.reason ?? "", /failed/i);
  assert.ok(call.problem !== null);
  assert.equal(warnings.length, 1);
});

test("the cap can be lowered, and a lowered cap says its own number", async () => {
  const { call, requests } = await grade(() => ({ call: "list", input: {} }), { maxTurns: 3 });
  assert.equal(requests.length, 3);
  assert.match(call.reason ?? "", /3 model turns/);
});
