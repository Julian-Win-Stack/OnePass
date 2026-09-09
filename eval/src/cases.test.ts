// Which turns become cases, and which never may.
//
// The selection rule is spelled out rather than inferred because getting it wrong is silently
// destructive: a compaction summary or an injected meta entry selected as a case would send a
// system-written message to the fork as though the user had typed it, and the run would look
// perfectly normal while measuring nothing. So most of these tests are about what is *not* a case.

import test from "node:test";
import assert from "node:assert/strict";
import { extractCases, selectCases, type PlanningCase } from "./cases.js";
import type { Branch } from "./transcript.js";
import {
  branchOf,
  compactBoundary,
  compactSummary,
  model,
  synthetic,
  toolResult,
  typed,
} from "./transcriptFixture.js";

/** One turn under the threshold and two over it, each sized by what its answer reported. */
function deepBranch(): Branch {
  return branchOf(
    [
      typed("u1", null, "shallow one"),
      model("a1", "u1", { textOnly: true, contextTokens: 40_000 }),
      typed("u2", "a1", "deep one"),
      model("a2", "u2", { textOnly: false, contextTokens: 150_000 }),
      toolResult("t2", "a2"),
      model("a3", "t2", { textOnly: true, contextTokens: 160_000 }),
      typed("u3", "a3", "deep two"),
      model("a4", "u3", { textOnly: true, contextTokens: 200_000 }),
    ],
    "a4",
  );
}

test("only turns past the trip threshold are cases; below it both arms would send the same bytes", () => {
  const list = extractCases(deepBranch());

  assert.deepEqual(
    list.cases.map((planningCase) => planningCase.text),
    ["deep one", "deep two"],
  );
  assert.equal(list.typedTurns, 3);
  assert.equal(list.belowThreshold, 1);
  // Written out rather than imported: comparing the constant with itself would hold for any value
  // it was ever changed to. It is the proxy's own trip threshold, which the eval can use directly
  // now that a case's size is what the API reported rather than a rebuild that came out short.
  assert.equal(list.thresholdTokens, 110_000);
});

test("a case's size is what the turn that answered it reported being shown", () => {
  const list = extractCases(deepBranch());

  // 150,000 for `deep one` — the first model turn after it — not the 160,000 of the turn after
  // that, which was shown the tool result the answer itself produced.
  assert.deepEqual(
    list.cases.map((planningCase) => planningCase.prefixTokens),
    [150_000, 200_000],
  );
});

test("a compaction summary, a meta entry, a sidechain entry and a tool result are never cases", () => {
  const branch = branchOf(
    [
      typed("u1", null, "typed by me"),
      model("a1", "u1", { textOnly: false, contextTokens: 170_000 }),
      toolResult("t1", "a1"),
      model("a2", "t1", { textOnly: true, contextTokens: 172_000 }),
      // The boundary itself is off the branch — it carries no parentUuid, only a logical one — but
      // the summary it introduces is a plain user entry sitting *on* the chain, which is the whole
      // reason it is dangerous. A fixture that hung it off the boundary would leave it unreachable
      // from the tip, and this test would pass while the exclusion did nothing.
      compactBoundary("c1", "a2"),
      compactSummary("cs1", "a2"),
      typed("m1", "cs1", "injected by the harness", { isMeta: true }),
      typed("s1", "m1", "a subagent's prompt", { isSidechain: true }),
      typed("u2", "s1", "typed by me again"),
      model("a3", "u2", { contextTokens: 190_000 }),
    ],
    "a3",
  );

  // Each excluded kind has to be reachable from the tip, or the exclusion is never exercised.
  const { typed: typedTurns, meta, compactSummary: summaries, sidechain, toolResult: results } = branch.counts;
  assert.deepEqual(
    { typedTurns, meta, summaries, sidechain, results },
    { typedTurns: 2, meta: 1, summaries: 1, sidechain: 1, results: 1 },
  );

  const list = extractCases(branch);

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

test("a case past a compaction says its history opened with the summary, not the session start", () => {
  const branch = branchOf(
    [
      typed("u1", null, "before"),
      model("a1", "u1", { textOnly: true, contextTokens: 170_000 }),
      compactBoundary("c1", "a1"),
      // The summary hangs off the boundary's own root, which is where Claude Code writes it: it is
      // never on the branch, and is found through the boundary rather than by walking the chain.
      compactSummary("cs1", "c1"),
      typed("u2", "a1", "after"),
      model("a2", "u2", { textOnly: true, contextTokens: 190_000 }),
    ],
    "a2",
  );

  assert.deepEqual(
    extractCases(branch).cases.map((one) => [one.text, one.opensWithCompactionSummary]),
    [
      ["before", false],
      ["after", true],
    ],
  );
});

test("an entry Claude Code wrote in the user slot is never a case, however deep it sits", () => {
  const branch = branchOf(
    [
      typed("u1", null, "typed by me"),
      model("a1", "u1", { textOnly: true, contextTokens: 200_000 }),
      typed("u2", "a1", "[Request interrupted by user]"),
      model("a2", "u2", { textOnly: true, contextTokens: 210_000 }),
      typed("u3", "a2", "<local-command-stdout>Compacted </local-command-stdout>"),
      model("a3", "u3", { textOnly: true, contextTokens: 220_000 }),
    ],
    "a3",
  );

  const list = extractCases(branch);

  assert.deepEqual(
    list.cases.map((planningCase) => planningCase.text),
    ["typed by me"],
  );
  assert.equal(list.typedTurns, 3);
  assert.equal(list.notPrompts, 2, "the two are counted, not quietly dropped");
});

test("each case says whether its recorded answer used tools, and the groups are counted", () => {
  // The text-answered turn comes first on purpose. A label is what *this* turn's answer did, and
  // the answer ends at the next turn I typed; with the tool turn first, a rule that read on past
  // that boundary would still label every turn correctly and the fixture would prove nothing.
  const branch = branchOf(
    [
      typed("u1", null, "answered in text"),
      model("a1", "u1", { textOnly: true, contextTokens: 200_000 }),
      typed("u2", "a1", "answered with a tool"),
      model("a2", "u2", { textOnly: false, contextTokens: 210_000 }),
      toolResult("t1", "a2"),
      model("a3", "t1", { textOnly: true, contextTokens: 220_000 }),
      typed("u3", "a3", "interrupted before an answer"),
      synthetic("x1", "u3"),
      typed("u4", "x1", "the last thing typed"),
    ],
    "u4",
  );

  const list = extractCases(branch);

  assert.deepEqual(
    list.cases.map((planningCase) => [planningCase.text, planningCase.answer]),
    [
      ["answered in text", "text"],
      ["answered with a tool", "tools"],
    ],
  );
  assert.deepEqual(list.answers, { tools: 1, text: 1 });
  // Nothing answered the last two, so there is no depth to read and nothing to compare a fork's
  // answer against. A synthetic entry is an interrupt Claude Code wrote for itself, not an answer.
  assert.equal(list.unanswered, 2);
});

test("cases are listed in session order, with the turn index they were cut at", () => {
  const branch = branchOf(
    [
      typed("u1", null, "one"),
      model("a1", "u1", { textOnly: true, contextTokens: 200_000 }),
      typed("u2", "a1", "two"),
      model("a2", "u2", { textOnly: false, contextTokens: 210_000 }),
      toolResult("t2", "a2"),
      model("a3", "t2", { textOnly: true, contextTokens: 215_000 }),
      typed("u3", "a3", "three"),
      model("a4", "u3", { textOnly: true, contextTokens: 220_000 }),
    ],
    "a4",
  );
  const list = extractCases(branch);

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
  // The prompt index counts the prompts, so it is what a driver feeding them would count by.
  assert.deepEqual(
    list.cases.map((planningCase) => planningCase.promptIndex),
    [1, 2, 3],
  );
});

/** Three eligible cases, so a mode that takes half of them takes a different set from all of them. */
function eligibleCases(): readonly PlanningCase[] {
  const { cases } = extractCases(
    branchOf(
      [
        typed("u1", null, "one"),
        model("a1", "u1", { textOnly: true, contextTokens: 200_000 }),
        typed("u2", "a1", "two"),
        model("a2", "u2", { textOnly: true, contextTokens: 210_000 }),
        typed("u3", "a2", "three"),
        model("a3", "u3", { textOnly: true, contextTokens: 220_000 }),
      ],
      "a3",
    ),
  );
  assert.equal(cases.length, 3, "every prompt of the fixture is over the threshold");
  return cases;
}

test("quick mode takes every second eligible case", () => {
  assert.deepEqual(
    selectCases(eligibleCases(), "quick").map((planningCase) => planningCase.promptIndex),
    [1, 3],
  );
});

test("full mode takes every eligible case", () => {
  assert.deepEqual(
    selectCases(eligibleCases(), "full").map((planningCase) => planningCase.promptIndex),
    [1, 2, 3],
  );
});

test("a branch whose model turns report no usage yields no case rather than a guessed one", () => {
  const branch = branchOf([typed("u1", null, "start"), synthetic("x1", "u1")], "x1");

  const list = extractCases(branch);
  assert.deepEqual(list.cases, []);
  assert.equal(list.unanswered, 1);
});
