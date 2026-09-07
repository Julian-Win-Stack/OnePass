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
import { readTranscript } from "./transcript.js";

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
  assert.equal(branch.file.pathLength, 918);
  assert.equal(branch.file.entriesOffPath, 961);
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
