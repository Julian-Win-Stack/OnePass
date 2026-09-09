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
import { extractCases } from "./cases.js";
import { readPrompts } from "./prompts.js";
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

  // The figure in eval/decision.md was measured backwards: a turn's depth is what the last model
  // turn *before* it reported it was shown. This is not the prefix a run measures. A compaction
  // collapses the context, so a turn typed just after one is credited here with the depth reached
  // before the collapse, while `extractCases` sizes the rebuilt prefix, which starts at the
  // compaction. The two disagree on eight turns; the bullet of 2026-09-08 in eval/decision.md has
  // the reconciliation. This test pins the old measure as it was taken, so the branch is still the
  // one that decision was made on — it is not a check that a run would list these turns.
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

test("50 of the branch's 57 typed turns are prompts; the other 7 Claude Code wrote itself", (t) => {
  if (!existsSync(TRANSCRIPT)) {
    t.skip(`no transcript at ${TRANSCRIPT}; this check runs where the planning corpus lives`);
    return;
  }

  const list = readPrompts(readTranscript(TRANSCRIPT, { tip: TIP }));

  assert.equal(list.typedTurns, 57);
  assert.equal(list.prompts.length, 50, "these are what a recording session is driven by");
  // 3 `[Request interrupted by user]`, 2 `<command-name>/compact</command-name>` echoes and 2
  // `<local-command-stdout>`. Feeding any of them to a fresh session buys a paid turn answering
  // Claude Code's own bookkeeping, which is why they are named rather than eyeballed.
  const reasons = new Map<string, number>();
  for (const entry of list.skipped) reasons.set(entry.why, (reasons.get(entry.why) ?? 0) + 1);
  assert.deepEqual([...reasons].sort(), [
    ["command output", 2],
    ["interrupted", 3],
    ["slash command", 2],
  ]);
});

test("the branch carries 27 cases when depth is read from the turn that answered each prompt", (t) => {
  if (!existsSync(TRANSCRIPT)) {
    t.skip(`no transcript at ${TRANSCRIPT}; this check runs where the planning corpus lives`);
    return;
  }

  // Unlike the 37 above, this is the measure a run actually makes, so it is a check on what a run
  // would list rather than a record of how a decision was taken.
  //
  // eval/decision.md's bullet of 2026-09-08 says 28 spanning 110,644 to 248,819. The span is exact
  // — so it was the same measure — but the count is one out: it was arrived at by arithmetic over
  // an earlier figure (37, less 8 that a compaction had collapsed, plus 1 that joined, less 2 of
  // Claude Code's own entries) rather than by counting. Measured directly it is 27, and none of
  // Claude Code's seven entries is over the line at all, so excluding them costs nothing. Corrected
  // in eval/decision.md rather than left as two numbers.
  const list = extractCases(readTranscript(TRANSCRIPT, { tip: TIP }));

  assert.equal(list.cases.length, 27);
  assert.equal(list.notPrompts, 7);
  assert.equal(list.unanswered, 2, "two prompts were never answered, so neither has a depth to read");
  const depths = list.cases.map((one) => one.prefixTokens);
  assert.equal(Math.min(...depths), 110_644);
  assert.equal(Math.max(...depths), 248_819);
});
