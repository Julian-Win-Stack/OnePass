// Which turns become cases, and which never may.
//
// The selection rule is spelled out rather than inferred because getting it wrong is silently
// destructive: a compaction summary or an injected meta entry selected as a case would send a
// system-written message to the fork as though the user had typed it, and the run would look
// perfectly normal while measuring nothing. So most of these tests are about what is *not* a case.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCases, selectCases, TRIP_THRESHOLD_TOKENS } from "./cases.js";
import type { CaseMessage } from "./messages.js";
import { readTranscript, type Branch } from "./transcript.js";
import {
  compactBoundary,
  compactSummary,
  model,
  synthetic,
  toolResult,
  typed,
  writeTranscript,
  type Line,
} from "./transcriptFixture.js";

function branchOf(lines: readonly Line[], tip: string): Branch {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "onepass-cases-")));
  return readTranscript(writeTranscript(dir, "session.jsonl", lines), { tip });
}

/** Four chars a token, which is what the fake upstream's count-tokens answers too. */
const byLength = async (messages: readonly CaseMessage[]): Promise<number> =>
  Math.ceil(JSON.stringify(messages).length / 4);

/** A message list of a size chosen by the caller, so a turn can be pushed over the threshold. */
function counterOf(sizes: ReadonlyMap<string, number>, fallback = 10): (m: readonly CaseMessage[]) => Promise<number> {
  return async (messages) => {
    for (const [needle, tokens] of sizes) if (JSON.stringify(messages).includes(needle)) return tokens;
    return fallback;
  };
}

/** A branch whose turns can be pushed over the threshold one at a time by naming their text. */
function deepBranch(): Branch {
  return branchOf(
    [
      typed("u1", null, "shallow one"),
      model("a1", "u1", { textOnly: true }),
      typed("u2", "a1", "deep one"),
      model("a2", "u2", { textOnly: false }),
      toolResult("t2", "a2"),
      model("a3", "t2", { textOnly: true }),
      typed("u3", "a3", "deep two"),
      model("a4", "u3", { textOnly: true }),
    ],
    "a4",
  );
}

test("only turns past the trip threshold are cases; below it both arms would send the same bytes", async () => {
  const branch = deepBranch();
  const list = await extractCases(branch, counterOf(new Map([["deep two", 400_000]])), { overheadTokens: 0 });

  assert.deepEqual(
    list.cases.map((planningCase) => planningCase.text),
    ["deep two"],
  );
  assert.equal(list.typedTurns, 3);
  assert.equal(list.belowThreshold, 2);
  assert.equal(list.thresholdTokens, TRIP_THRESHOLD_TOKENS);
});

test("the fixed system-and-tools overhead counts towards the threshold", async () => {
  const branch = deepBranch();
  const under = await extractCases(branch, counterOf(new Map([["deep two", 60_000]])), { overheadTokens: 0 });
  const over = await extractCases(branch, counterOf(new Map([["deep two", 60_000]])), { overheadTokens: 54_000 });

  assert.equal(under.cases.length, 0, "60k of messages alone is under the threshold");
  assert.deepEqual(
    over.cases.map((planningCase) => planningCase.prefixTokens),
    [114_000],
    "the same turn is over it once the system and tools are counted",
  );
});

test("a compaction summary, a meta entry, a sidechain entry and a tool result are never cases", async () => {
  const branch = branchOf(
    [
      typed("u1", null, "typed by me"),
      model("a1", "u1", { textOnly: false, contextTokens: 170_000 }),
      toolResult("t1", "a1"),
      model("a2", "t1", { textOnly: true, contextTokens: 172_000 }),
      typed("m1", "a2", "injected by the harness", { isMeta: true }),
      typed("s1", "m1", "a subagent's prompt", { isSidechain: true }),
      typed("u2", "s1", "typed by me again"),
      model("a3", "u2", { contextTokens: 9_000 }),
      compactBoundary("c1", "a2"),
      compactSummary("cs1", "c1"),
    ],
    "a3",
  );

  // Everything is over the threshold, so nothing is left out for being small.
  const list = await extractCases(branch, async () => 200_000, { overheadTokens: 0 });

  assert.deepEqual(
    list.cases.map((planningCase) => planningCase.text),
    ["typed by me", "typed by me again"],
  );
  // A case is cut *at* a turn, so what matters is which uuid it was cut at. The compaction summary
  // does belong inside the second case's history — that is what the request opened with — but a
  // case cut at it would be typed at the fork as though I had written it.
  assert.deepEqual(
    list.cases.map((planningCase) => planningCase.uuid),
    ["u1", "u2"],
  );
});

test("each case says whether its recorded answer used tools, and the groups are counted", async () => {
  // The text-answered turn comes first on purpose. A label is what *this* turn's answer did, and
  // the answer ends at the next turn I typed; with the tool turn first, a rule that read on past
  // that boundary would still label every turn correctly and the fixture would prove nothing.
  const branch = branchOf(
    [
      typed("u1", null, "answered in text"),
      model("a1", "u1", { textOnly: true }),
      typed("u2", "a1", "answered with a tool"),
      model("a2", "u2", { textOnly: false }),
      toolResult("t1", "a2"),
      model("a3", "t1", { textOnly: true }),
      typed("u3", "a3", "interrupted before an answer"),
      synthetic("x1", "u3"),
      typed("u4", "x1", "the last thing typed"),
    ],
    "u4",
  );

  const list = await extractCases(branch, async () => 200_000, { overheadTokens: 0 });

  assert.deepEqual(
    list.cases.map((planningCase) => [planningCase.text, planningCase.answer]),
    [
      ["answered in text", "text"],
      ["answered with a tool", "tools"],
      ["interrupted before an answer", "none"],
      ["the last thing typed", "none"],
    ],
  );
  assert.deepEqual(list.answers, { tools: 1, text: 1, none: 2 });
});

test("cases are listed in session order, with the turn index they were cut at", async () => {
  const branch = deepBranch();
  const list = await extractCases(branch, async () => 200_000, { overheadTokens: 0 });

  // A turn index is an index into the branch's turns, not a count of the ones I typed: the model
  // turns and the tool result between them are turns of the branch too. The three typed turns of
  // the fixture are its 1st, 3rd and 7th entries, so they are turns 0, 2 and 6 — and the index has
  // to be that, because it is what finds the turn again in the transcript.
  assert.deepEqual(
    list.cases.map((planningCase) => planningCase.turnIndex),
    [0, 2, 6],
  );
  assert.deepEqual(
    list.cases.map((planningCase) => planningCase.id),
    ["turn-0", "turn-2", "turn-6"],
  );
  assert.deepEqual(
    list.cases.map((planningCase) => planningCase.typedIndex),
    [0, 1, 2],
  );
});

test("quick mode takes every second eligible case; full mode takes all of them", async () => {
  const branch = deepBranch();
  const { cases } = await extractCases(branch, async () => 200_000, { overheadTokens: 0 });
  assert.equal(cases.length, 3, "every typed turn of the fixture is over the threshold");

  assert.deepEqual(
    selectCases(cases, "quick").map((planningCase) => planningCase.typedIndex),
    [0, 2],
  );
  assert.equal(selectCases(cases, "full").length, 3);
  assert.equal(selectCases(cases, "replay").length, 3, "replay is free, so it covers every case");
});

test("the overhead is read from the first model turn's usage when it is not given", async () => {
  // Two model turns at different depths, because reading the wrong one is the mistake worth
  // catching: the overhead is a property of the system prompt and the tools, which do not grow,
  // and a later turn's usage is mostly the conversation by then.
  const branch = branchOf(
    [
      typed("u1", null, "start"),
      model("a1", "u1", { contextTokens: 54_000 }),
      typed("u2", "a1", "next"),
      model("a2", "u2", { contextTokens: 120_000 }),
    ],
    "a2",
  );

  const list = await extractCases(branch, byLength);

  // What the first model turn was shown, less the messages it was shown: 54,000 tokens reported,
  // against a message list of one 60-character user message, which `byLength` prices at 15.
  assert.equal(list.overheadTokens, 53_985);
});

test("a branch whose model turns report no usage cannot be sized, and says so", async () => {
  const branch = branchOf([typed("u1", null, "start"), synthetic("x1", "u1")], "x1");

  await assert.rejects(extractCases(branch, byLength), /overhead/);
});
