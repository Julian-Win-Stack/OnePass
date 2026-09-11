// Eviction across a whole session, not one request.
//
// Every test in evict.test.ts feeds the proxy one request. The bug these guard against only shows
// across a sequence: once the part of the request the proxy can never evict is over T, every
// request trips, and the pressure pass takes whatever aged past K since the last one — a few
// hundred tokens, each trip forcing the API to rewrite the conversation's cache. Harbor's
// make-mips run did that 112 times in 119 requests and cost 4× control.
//
// The session here is built so that shape is certain: a 15k-token floor against T = 10k from the
// first request, then one assistant turn and one ~2,000-char tool result per request. The evicted
// set is threaded from one request to the next the way server.ts does it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evictContextSegments, type EvictionConfig, type EvictionOutcome } from "./evict.js";

const REQUESTS = 200;

/** Chars in every tool result. Its stub, `[onepass: evicted 2,002 chars]`, is 30. */
const RESULT_CHARS = 2_002;
/** What evicting one result saves, in tokens at 4 chars per token: (2,002 − 30) ÷ 4. */
const TOKENS_SAVED_PER_RESULT = 493;

const BASE: EvictionConfig = {
  evictAfterAssistantTurns: 8,
  protectLastAssistantTurns: 4,
  minSavedChars: 50,
  tripThresholdTokens: 10_000,
  charsPerToken: 4,
  batchMinTokens: 0,
};

/**
 * The floor: a user message the rules may never touch, 60,000 chars — 15,000 tokens against a
 * 10,000-token T, so every request is over the line before any tool result is counted.
 */
const FLOOR_TEXT = `please build the interpreter. ${"spec ".repeat(12_000)}`.slice(0, 60_000);

function resultId(turn: number): string {
  return `toolu_${String(turn).padStart(3, "0")}`;
}

/**
 * Request `count` of the session: the floor, then `count` turns. Each turn is an assistant reply
 * — its text never evictable — with a Bash call too small to be worth stubbing, and the call's
 * 2,002-char result. The newest result has no assistant turn after it; result `j` has `count − j`.
 */
function requestAt(count: number): Record<string, unknown> {
  const messages: unknown[] = [{ role: "user", content: FLOOR_TEXT }];
  for (let turn = 1; turn <= count; turn += 1) {
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `step ${turn}: ${"reasoning about the next move ".repeat(13)}` },
        { type: "tool_use", id: resultId(turn), name: "Bash", input: { command: `make step${turn}` } },
      ],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: resultId(turn), content: `${turn}:`.padEnd(RESULT_CHARS, "o") }],
    });
  }
  return { model: "claude-test", max_tokens: 1_000, messages };
}

interface Step {
  outcome: EvictionOutcome;
  /** The evicted set as the request found it, before its own ids were added. */
  evictedBefore: ReadonlySet<string>;
}

/** The whole session through one evicted set, as server.ts threads it. */
function runSession(config: EvictionConfig, requests = REQUESTS): Step[] {
  const evicted = new Set<string>();
  const steps: Step[] = [];
  for (let count = 1; count <= requests; count += 1) {
    const evictedBefore = new Set(evicted);
    const outcome = evictContextSegments(requestAt(count), evicted, config);
    for (const id of outcome.newlyEvictedIds) evicted.add(id);
    steps.push({ outcome, evictedBefore });
  }
  return steps;
}

function trips(steps: readonly Step[]): number {
  return steps.filter((step) => step.outcome.newlyEvictedIds.length > 0).length;
}

test("with the batch minimum off, every request stubs every result at least K turns old — today's behaviour", () => {
  const steps = runSession({ ...BASE, batchMinTokens: 0 });

  // The floor is over T on every request, so the normal pass takes what aged past N and the
  // pressure pass then takes everything down to K. Result j has `count − j` turns after it, so
  // request `count` stubs results 1 through count − 4, and each request from the 5th on takes one
  // new one: a trip on 196 of 200 requests.
  for (const [index, step] of steps.entries()) {
    const count = index + 1;
    const expected = Array.from({ length: Math.max(0, count - 4) }, (_, j) => resultId(j + 1));
    assert.deepEqual([...step.outcome.stubbedIds].sort(), expected, `request ${count}`);
  }
  assert.equal(trips(steps), 196);
});

test("a 20k batch minimum takes the same content in a handful of trips instead of one per request", () => {
  const off = runSession({ ...BASE, batchMinTokens: 0 });
  const on = runSession({ ...BASE, batchMinTokens: 20_000 });

  // Everything the session ever made evictable, in tokens: 196 results at 493 each.
  const evictable = off.reduce((sum, step) => sum + step.outcome.newlyEvictedCharsRemoved, 0) / BASE.charsPerToken;
  assert.equal(evictable, 196 * TOKENS_SAVED_PER_RESULT);
  const bound = Math.ceil(evictable / 20_000) + 1;
  assert.ok(trips(on) <= bound, `${trips(on)} trips, bound ${bound}`);
  assert.ok(trips(on) > 0, "the minimum batches trips; it must not stop them");
});

test("holding a batch back never sends more than 20k tokens over what the minimum-off proxy would", () => {
  const off = runSession({ ...BASE, batchMinTokens: 0 });
  const on = runSession({ ...BASE, batchMinTokens: 20_000 });

  for (const [index, step] of on.entries()) {
    const baseline = off[index]?.outcome.estimatedTokensSent ?? Number.NaN;
    assert.ok(
      step.outcome.estimatedTokensSent <= baseline + 20_000,
      `request ${index + 1}: sent ${step.outcome.estimatedTokensSent}, minimum off sent ${baseline}`,
    );
  }
});

test("a batch one token under the minimum is held back and says how big it was; at the minimum it is taken", () => {
  // Request 9 of a fresh session: results 1–5 are at least K turns old, 5 × 493 = 2,465 tokens.
  const under = evictContextSegments(requestAt(9), new Set(), { ...BASE, batchMinTokens: 2_466 });
  assert.equal(under.tripped, true, "over T whatever came of it");
  assert.deepEqual(under.newlyEvictedIds, []);
  assert.deepEqual(under.stubbedIds, []);
  assert.equal(under.heldBackTokens, 2_465);

  const at = evictContextSegments(requestAt(9), new Set(), { ...BASE, batchMinTokens: 2_465 });
  assert.deepEqual([...at.newlyEvictedIds].sort(), [1, 2, 3, 4, 5].map(resultId));
  assert.equal(at.heldBackTokens, undefined, "nothing was held back");
});

test("a result held back is taken on the request its batch reaches the minimum, and is in the evicted set only from then", () => {
  const steps = runSession({ ...BASE, batchMinTokens: 20_000 });
  const first = resultId(1);

  // Result 1 is old enough for the pressure pass at request 5, and one more result ages past K on
  // every request after. 40 results are 19,720 tokens and 41 are 20,213, so the batch first
  // reaches the minimum at request 4 + 41 = 45.
  const takenAt = steps.findIndex((step) => step.outcome.newlyEvictedIds.includes(first)) + 1;
  assert.equal(takenAt, 45);

  const fifth = steps[4]?.outcome;
  assert.equal(fifth?.tripped, true, "request 5 is over T");
  assert.deepEqual(fifth?.newlyEvictedIds, [], "and holds its batch of one result back");

  for (const [index, step] of steps.entries()) {
    const count = index + 1;
    assert.equal(step.evictedBefore.has(first), count > takenAt, `evicted set before request ${count}`);
    assert.equal(step.outcome.stubbedIds.includes(first), count >= takenAt, `stubbed on request ${count}`);
  }
  // Everything aged past K went in the same trip, not only the result that waited longest.
  assert.equal(steps[takenAt - 1]?.outcome.newlyEvictedIds.length, 41);
});

test("pressure candidates count toward the batch: a normal batch under the minimum is taken with them", () => {
  // Request 10 of a fresh session: results 1–2 are aged past N (986 tokens), results 3–6 only past
  // K (1,972 tokens). The floor keeps the request over T after the normal pass, so the pressure
  // pass adds its four, and the batch of six is 2,958 tokens.
  const outcome = evictContextSegments(requestAt(10), new Set(), { ...BASE, batchMinTokens: 2_000 });

  assert.deepEqual([...outcome.newlyEvictedIds].sort(), [1, 2, 3, 4, 5, 6].map(resultId));
  assert.equal(outcome.pressure, true);
});

test("a request is above the alarm line exactly when it is sent more than 40k tokens over T", () => {
  const steps = runSession({ ...BASE, batchMinTokens: 20_000 });
  const alarmLine = BASE.tripThresholdTokens + 40_000;

  for (const [index, step] of steps.entries()) {
    const { estimatedTokensSent, aboveAlarmLine } = step.outcome;
    assert.equal(aboveAlarmLine, estimatedTokensSent > alarmLine, `request ${index + 1}: sent ${estimatedTokensSent}`);
  }
  // The floor grows by a reply per request, and a held-back batch rides on top of it, so the
  // session crosses the line partway through. Both sides are here, or the check above checked one.
  assert.ok(steps.some((step) => step.outcome.aboveAlarmLine));
  assert.ok(steps.some((step) => !step.outcome.aboveAlarmLine));
});
