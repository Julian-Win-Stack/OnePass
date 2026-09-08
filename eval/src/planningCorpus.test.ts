// The planning corpus branch, read from the real transcript.
//
// Every other test here runs against a fixture, which proves the reader does what it was told and
// nothing about whether it was told the right thing. These numbers were measured by hand from the
// session the eval's planning corpus comes from — file `62d8de7e-c2f3-448d-829f-9d25b23123eb.jsonl`
// under the chp99 project, tip `b7881712-2e5c-4b77-a409-02ceb65f496f` — and they are what the
// decisions in eval/decision.md rest on. If the reader stops reproducing them, either the reader
// or those decisions is wrong.
//
// The transcript is one person's session on one machine, so this is skipped where it is not
// present rather than made a dependency of the suite. It is not a fixture and must never be
// copied into the repository.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildMessages, historyStart } from "./messages.js";
import { isRealModelTurn, isTypedTurn, readTranscript } from "./transcript.js";

const TRANSCRIPT = join(
  homedir(),
  ".claude/projects/-Users-phyonyanwinn-Project-ProJect-chp99-takehome/62d8de7e-c2f3-448d-829f-9d25b23123eb.jsonl",
);
const TIP = "b7881712-2e5c-4b77-a409-02ceb65f496f";

test("the deep Fable branch reads as the corpus decisions describe it", (t) => {
  if (!existsSync(TRANSCRIPT)) {
    t.skip(`no transcript at ${TRANSCRIPT}; this check runs where the planning corpus lives`);
    return;
  }

  const branch = readTranscript(TRANSCRIPT, { tip: TIP });

  // 57 typed turns on the branch, against the 95 the same file shows when it is read flat.
  assert.equal(branch.counts.typed, 57);
  // 918 entries are reachable by parent links alone. The other 4 are results of parallel tool
  // calls, which Claude Code hangs off the call entry they answer rather than off the chain — so
  // the walk passes them by and they have to be adopted back. The API saw all 922: every
  // `tool_use` on the path is answered in the message after it. The two numbers partition the
  // file, so adopting 4 takes 4 off the other side.
  assert.equal(branch.file.pathLength, 918 + 4);
  assert.equal(branch.file.entriesOffPath, 961 - 4);
  assert.equal(branch.file.pathLength + branch.file.entriesOffPath, branch.file.entries);
  assert.equal(branch.file.branches, 25);
  assert.equal(branch.file.duplicateWrites, 294);

  // Single-model, single-version: Fable 5 at xhigh throughout, on Claude Code 2.1.222.
  assert.deepEqual(new Set(branch.turns.map((turn) => turn.version)), new Set(["2.1.222"]));
  assert.deepEqual(
    branch.stretches.map((stretch) => stretch.models.map((entry) => entry.name)),
    [["claude-fable-5"], ["claude-fable-5"], ["claude-fable-5"]],
  );
  // Effort is read from the top level of an `assistant` entry, which only a real transcript can
  // confirm: xhigh throughout, bar the four turns the session opened on at high.
  assert.deepEqual(
    branch.stretches.map((stretch) => stretch.efforts),
    [
      [
        { name: "xhigh", count: 136 },
        { name: "high", count: 4 },
      ],
      [{ name: "xhigh", count: 315 }],
      [{ name: "xhigh", count: 68 }],
    ],
  );

  // A resumed session copied its ancestor in, so one file holds entries from two session ids.
  assert.deepEqual(branch.sessionIds, ["a1497d5e-32a0-4cf6-bf36-ed6cd73e3504", "62d8de7e-c2f3-448d-829f-9d25b23123eb"]);

  // Two compactions, both manual, and both explain a fall in reported usage: 172,630 → 57,284 and
  // 290,591 → 77,986. Neither compaction summary is on this branch — each hangs off its own root —
  // so both were found through `logicalParentUuid` and nothing else.
  assert.equal(branch.counts.compactSummary, 0);
  assert.deepEqual(
    branch.compactions.map((compaction) => [compaction.trigger, compaction.drop?.fromTokens, compaction.drop?.toTokens]),
    [
      ["manual", 172_630, 57_284],
      ["manual", 290_591, 77_986],
    ],
  );
  assert.deepEqual(branch.unexplainedDrops, [], "every fall on this branch is accounted for");

  // Two synthetic entries, which hold no real usage and are kept out of the trajectory.
  assert.equal(branch.counts.synthetic, 2);
  assert.equal(branch.trajectory.length, branch.counts.model);
  assert.equal(branch.peakContextTokens, 290_591);
});

test("the branch carries the 37 eligible turns the corpus decision was made on", (t) => {
  if (!existsSync(TRANSCRIPT)) {
    t.skip(`no transcript at ${TRANSCRIPT}; this check runs where the planning corpus lives`);
    return;
  }

  const branch = readTranscript(TRANSCRIPT, { tip: TIP });

  // The figure in eval/decision.md was measured against recorded usage: a turn's depth is what the
  // last model turn before it reported it was shown. A run measures the same prefixes with
  // count-tokens instead, which needs a key — this is the check that the branch itself still holds
  // the turns that measurement found. If it stops holding them, the decision is wrong, not the run.
  const depthAt = (index: number): number => {
    const before = [...branch.turns.slice(0, index)].reverse().find(isRealModelTurn);
    return before?.usage?.contextTokens ?? 0;
  };
  const deep = branch.turns.filter(isTypedTurn).filter((turn) => depthAt(turn.index) > 110_000);
  assert.equal(deep.length, 37, "57 typed turns, 37 of them past the trip threshold");
  const depths = deep.map((turn) => depthAt(turn.index));
  assert.equal(Math.min(...depths), 131_411);
  assert.equal(Math.max(...depths), 290_591);
});

test("a case's request is rebuilt as the session sent it: merged turns, and history from the compaction", (t) => {
  if (!existsSync(TRANSCRIPT)) {
    t.skip(`no transcript at ${TRANSCRIPT}; this check runs where the planning corpus lives`);
    return;
  }

  const branch = readTranscript(TRANSCRIPT, { tip: TIP });
  const typedTurns = branch.turns.filter(isTypedTurn);

  // Both compaction summaries hang off their boundary's own root, so neither is on the branch and
  // neither can be found by walking it. They are what a request made after the compaction opened
  // with, so a rebuild that could not find them would carry history the model never saw.
  assert.deepEqual(
    branch.compactions.map((compaction) => compaction.summary?.chars),
    [14_215, 19_024],
  );

  const first = typedTurns[1] as { index: number };
  const last = typedTurns[typedTurns.length - 1] as { index: number };
  assert.equal(historyStart(branch, first.index).opensWithCompactionSummary, false, "the session's own start");
  assert.equal(historyStart(branch, last.index).opensWithCompactionSummary, true, "the second compaction's summary");

  // Claude Code writes one entry per content block, so a rebuild that did not merge them would
  // count several assistant messages where the API saw one — and the proxy's age gate counts
  // assistant messages.
  for (const turn of [first, last]) {
    const messages = buildMessages(branch, turn.index);
    assert.ok(messages.length > 0);
    assert.ok(
      messages.every((message, index) => index === 0 || messages[index - 1]?.role !== message.role),
      "two messages of the same role in a row are one message the rebuild failed to merge",
    );
    assert.equal(messages[messages.length - 1]?.role, "user", "a case ends on the turn it was cut at");
  }
});
