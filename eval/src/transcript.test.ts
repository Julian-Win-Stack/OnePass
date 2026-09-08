// What the reader has to get right is the order it resolves three things in: duplicates, then the
// walk, then the filter. Each test below is one way the order can be got wrong, and what it costs.

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvalError } from "./errors.js";
import { readTranscript, type ModelTurn } from "./transcript.js";
import {
  attachment,
  compactBoundary,
  compactSummary,
  linkless,
  model,
  synthetic,
  systemEntry,
  toolResult,
  typed,
  writeTranscript,
  type Line,
} from "./transcriptFixture.js";

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "onepass-transcript-")));
}

function write(lines: readonly Line[]): string {
  return writeTranscript(scratch(), "session.jsonl", lines);
}

function textOf(path: string, tip?: string): string[] {
  return readTranscript(path, { tip: tip ?? null })
    .turns.filter((turn) => turn.kind === "typed")
    .map((turn) => (turn as { text: string }).text);
}

test("keeps the last copy of a uuid that was written more than once", () => {
  const path = write([
    typed("u1", null, "first draft"),
    model("a1", "u1"),
    typed("u1", null, "rewritten in place"),
  ]);

  const branch = readTranscript(path, { tip: "a1" });
  assert.deepEqual(textOf(path, "a1"), ["rewritten in place"]);
  assert.equal(branch.file.duplicateWrites, 1);
  assert.equal(branch.file.entries, 2, "a rewrite is not a second entry");
});

test("walks one branch: a rewind's abandoned path is left out and counted", () => {
  // u1 → a1 → u2a → a2a is abandoned; u1 → a1 → u2b → a2b is the branch that was kept.
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1"),
    typed("u2a", "a1", "abandoned"),
    model("a2a", "u2a"),
    typed("u2b", "a1", "kept"),
    model("a2b", "u2b"),
  ]);

  const branch = readTranscript(path, { tip: "a2b" });
  assert.deepEqual(textOf(path, "a2b"), ["start", "kept"]);
  assert.equal(branch.file.branches, 2, "the file holds two tips");
  assert.equal(branch.file.entriesOffPath, 2);
  assert.equal(branch.file.entries, 6);
});

test("every entry type links the chain, and the filter runs only after the walk", () => {
  // The spine runs user → assistant → system → attachment → user. Filtering to conversation
  // entries before walking would break the chain at the system entry and lose everything above it.
  const path = write([
    typed("u1", null, "before the gap"),
    model("a1", "u1"),
    systemEntry("s1", "a1"),
    attachment("t1", "s1"),
    typed("u2", "t1", "after the gap"),
    model("a2", "u2"),
  ]);

  const branch = readTranscript(path, { tip: "a2" });
  assert.deepEqual(
    branch.turns.map((turn) => turn.uuid),
    ["u1", "a1", "u2", "a2"],
    "the conversation turns either side of the non-conversation entries",
  );
  assert.equal(branch.file.pathLength, 6, "the walked path is every entry, whatever its type");
  assert.deepEqual(
    branch.file.pathTypes.map((entry) => `${entry.name} ${entry.count}`).sort(),
    ["assistant 2", "attachment 1", "system 1", "user 2"],
  );
});

test("the tip defaults to the last entry written and can be named", () => {
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1"),
    typed("u2a", "a1", "the branch that was kept"),
    model("a2a", "u2a"),
    typed("u2b", "a1", "the branch written last"),
    model("a2b", "u2b"),
  ]);

  const byDefault = readTranscript(path);
  assert.equal(byDefault.tipUuid, "a2b");
  assert.equal(byDefault.tipChosen, "default");

  const named = readTranscript(path, { tip: "a2a" });
  assert.equal(named.tipUuid, "a2a");
  assert.equal(named.tipChosen, "named");
  assert.deepEqual(textOf(path, "a2a"), ["start", "the branch that was kept"]);
});

test("a rewrite on the last line of the file is the last entry written", () => {
  // The default tip is the last entry *written*, not the last entry first written. A rewrite is
  // the newest thing in the file even though its uuid appeared earlier, so it is the tip.
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1"),
    typed("u2", "a1", "first draft"),
    model("a2", "u2"),
    typed("u2", "a1", "rewritten after the model answered"),
  ]);

  const branch = readTranscript(path);
  assert.equal(branch.tipUuid, "u2");
  assert.equal(branch.tipChosen, "default");
  assert.deepEqual(textOf(path), ["start", "rewritten after the model answered"]);
});

test("refuses a tip that is not in the file, and a file with nothing to walk", () => {
  const path = write([typed("u1", null, "start")]);
  assert.throws(
    () => readTranscript(path, { tip: "nowhere" }),
    (err: unknown) => err instanceof EvalError && /no entry nowhere/.test(err.message),
  );
  assert.throws(() => readTranscript(join(scratch(), "missing.jsonl")), EvalError);

  const empty = writeTranscript(scratch(), "meta-only.jsonl", [linkless("custom-title")]);
  assert.throws(
    () => readTranscript(empty),
    (err: unknown) => err instanceof EvalError && /no entries that link/.test(err.message),
  );
});

test("a typed turn is only a typed turn: meta, summaries, sidechains and tool results are not", () => {
  const path = write([
    typed("u1", null, "a real turn"),
    typed("m1", "u1", "<local-command-caveat>", { isMeta: true }),
    typed("c1", "m1", "This session is being continued", { isCompactSummary: true }),
    typed("s1", "c1", "a subagent's turn", { isSidechain: true }),
    toolResult("r1", "s1"),
    model("a1", "r1", { textOnly: false }),
    model("a2", "a1"),
    synthetic("y1", "a2"),
  ]);

  const branch = readTranscript(path, { tip: "y1" });
  assert.deepEqual(branch.counts, {
    typed: 1,
    toolResult: 1,
    meta: 1,
    compactSummary: 1,
    sidechain: 1,
    model: 2,
    modelTextOnly: 1,
    modelToolUse: 1,
    synthetic: 1,
  });
  assert.deepEqual(
    branch.turns.map((turn) => turn.kind),
    ["typed", "meta", "compact-summary", "sidechain", "tool-result", "model", "model", "model"],
  );
});

test("a synthetic model turn contributes no usage to the token trajectory", () => {
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1", { contextTokens: 50_000 }),
    synthetic("y1", "a1"),
    model("a2", "y1", { contextTokens: 60_000 }),
  ]);

  const branch = readTranscript(path, { tip: "a2" });
  assert.deepEqual(
    branch.trajectory.map((point) => point.contextTokens),
    [50_000, 60_000],
    "the synthetic turn's zeroes would read as the context collapsing",
  );
  assert.equal(branch.peakContextTokens, 60_000);
  assert.deepEqual(branch.unexplainedDrops, [], "a synthetic turn must not look like a compaction");
  const turn = branch.turns.find((candidate) => candidate.uuid === "y1") as ModelTurn;
  assert.equal(turn.synthetic, true);
  assert.equal(turn.usage, null);
});

test("an unrecognised entry type is passed over, and two Claude Code versions read the same way", () => {
  const path = write([
    linkless("bridge-session", { bridgeSessionId: "b1" }),
    typed("u1", null, "recorded on the old version", { version: "2.1.222" }),
    model("a1", "u1", { version: "2.1.222" }),
    linkless("atis-latch", { atis: {} }),
    typed("u2", "a1", "recorded on the new one", { version: "2.1.260" }),
    model("a2", "u2", { version: "2.1.260" }),
    linkless("ai-title", { aiTitle: "a title" }),
  ]);

  const branch = readTranscript(path, { tip: "a2" });
  assert.equal(branch.counts.typed, 2);
  assert.deepEqual(
    branch.file.linkless.map((entry) => entry.name).sort(),
    ["ai-title", "atis-latch", "bridge-session"],
  );
  assert.deepEqual(new Set(branch.turns.map((turn) => turn.version)), new Set(["2.1.222", "2.1.260"]));
});

test("a line that is not JSON is passed over rather than failing the read", () => {
  const path = write([typed("u1", null, "start"), model("a1", "u1")]);
  appendFileSync(path, "{ this is not json\n");

  const branch = readTranscript(path, { tip: "a1" });
  assert.equal(branch.file.unreadableLines, 1);
  assert.equal(branch.counts.typed, 1);
});

test("a compaction is found through its logical parent, with no summary in the walked chain", () => {
  // The spine runs straight through: a1 → u2 → a2. The boundary is a root of its own, and the
  // summary hangs off it, so neither is on the branch being walked.
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1", { contextTokens: 172_630 }),
    compactBoundary("k1", "a1", { trigger: "manual", preTokens: 173_285, postTokens: 8_031 }),
    compactSummary("cs1", "k1"),
    typed("u2", "a1", "after the compaction"),
    model("a2", "u2", { contextTokens: 57_284 }),
  ]);

  const branch = readTranscript(path, { tip: "a2" });
  assert.equal(branch.counts.compactSummary, 0, "the summary is not on this branch");
  assert.equal(branch.compactions.length, 1);

  const compaction = branch.compactions[0];
  assert.equal(compaction?.trigger, "manual");
  assert.equal(compaction?.preTokens, 173_285);
  assert.equal(compaction?.postTokens, 8_031);
  assert.equal(compaction?.afterIndex, 1, "the boundary sits after the last turn it preserved");
  assert.deepEqual(
    { from: compaction?.drop?.fromTokens, to: compaction?.drop?.toTokens },
    { from: 172_630, to: 57_284 },
    "the fall in reported usage is matched to the boundary that caused it",
  );
  assert.deepEqual(branch.unexplainedDrops, []);
});

test("a compaction on another branch of the same file is not this branch's", () => {
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1", { contextTokens: 100_000 }),
    typed("u2a", "a1", "abandoned"),
    model("a2a", "u2a", { contextTokens: 150_000 }),
    compactBoundary("k1", "a2a"),
    typed("u2b", "a1", "kept"),
    model("a2b", "u2b", { contextTokens: 120_000 }),
  ]);

  assert.deepEqual(readTranscript(path, { tip: "a2b" }).compactions, []);
  assert.equal(readTranscript(path, { tip: "a2a" }).compactions.length, 1);
});

test("a fall in usage no compaction accounts for is reported, not called a compaction", () => {
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1", { contextTokens: 200_000 }),
    typed("u2", "a1", "and then the context fell for some other reason"),
    model("a2", "u2", { contextTokens: 40_000 }),
  ]);

  const branch = readTranscript(path, { tip: "a2" });
  assert.deepEqual(branch.compactions, []);
  assert.equal(branch.unexplainedDrops.length, 1);
  assert.deepEqual(
    { from: branch.unexplainedDrops[0]?.fromTokens, to: branch.unexplainedDrops[0]?.toTokens },
    { from: 200_000, to: 40_000 },
  );
});

test("a compaction with no fall beside it keeps its place and says so", () => {
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1", { contextTokens: 100_000 }),
    compactBoundary("k1", "a1"),
    typed("u2", "a1", "after"),
    model("a2", "u2", { contextTokens: 120_000 }),
  ]);

  const branch = readTranscript(path, { tip: "a2" });
  assert.equal(branch.compactions.length, 1);
  assert.equal(branch.compactions[0]?.drop, null);
  assert.deepEqual(branch.unexplainedDrops, []);
});

test("the stretches between compactions carry the model and effort they were recorded on", () => {
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1", { contextTokens: 90_000, model: "claude-fable-5", effort: "high" }),
    model("a1b", "a1", { contextTokens: 170_000, model: "claude-fable-5", effort: "xhigh" }),
    compactBoundary("k1", "a1b"),
    typed("u2", "a1b", "after the compaction"),
    model("a2", "u2", { contextTokens: 20_000, model: "claude-opus-5", effort: "xhigh" }),
    model("a3", "a2", { contextTokens: 80_000, model: "claude-opus-5", effort: "xhigh" }),
  ]);

  const branch = readTranscript(path, { tip: "a3" });
  assert.equal(branch.stretches.length, 2);

  const [first, second] = branch.stretches;
  assert.equal(first?.openedBy, null);
  assert.deepEqual(first?.models, [{ name: "claude-fable-5", count: 2 }]);
  assert.deepEqual(first?.efforts, [
    { name: "high", count: 1 },
    { name: "xhigh", count: 1 },
  ]);
  assert.deepEqual(
    { first: first?.firstContextTokens, peak: first?.peakContextTokens, last: first?.lastContextTokens },
    { first: 90_000, peak: 170_000, last: 170_000 },
  );

  assert.equal(second?.openedBy, "k1");
  assert.deepEqual(second?.models, [{ name: "claude-opus-5", count: 2 }]);
  assert.equal(second?.typedTurns, 1);
});

test("a compaction that precedes every turn on the branch is what opened its first stretch", () => {
  // The branch opens on a non-conversation entry, and that is the last entry the compaction
  // preserved — so the boundary sits before every turn there is. It cuts nothing, but the history
  // does open with a compaction, and calling that stretch "from the start" would be a lie.
  const path = write([
    systemEntry("s1", null),
    typed("u1", "s1", "the first turn after the compaction"),
    model("a1", "u1", { contextTokens: 8_000 }),
    compactBoundary("k1", "s1", { trigger: "auto" }),
  ]);

  const branch = readTranscript(path, { tip: "a1" });
  assert.equal(branch.compactions[0]?.afterIndex, -1, "the boundary precedes every turn");
  assert.equal(branch.compactions[0]?.trigger, "auto");
  assert.equal(branch.stretches.length, 1);
  assert.equal(branch.stretches[0]?.openedBy, "k1", "the stretch did not start from the start");
});

test("a subagent's model turn is not the branch's, and never enters the trajectory", () => {
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1", { contextTokens: 150_000 }),
    // A subagent answers inside its own much smaller context. Counted as a model turn, its 9k
    // would read as the conversation collapsing.
    model("sub", "a1", { contextTokens: 9_000, isSidechain: true }),
    model("a2", "sub", { contextTokens: 160_000 }),
  ]);

  const branch = readTranscript(path, { tip: "a2" });
  assert.deepEqual(branch.trajectory.map((point) => point.contextTokens), [150_000, 160_000]);
  assert.deepEqual(branch.unexplainedDrops, [], "a sidechain turn must not manufacture a drop");
  assert.equal(branch.counts.model, 2);
  assert.equal(branch.counts.sidechain, 1);
  assert.equal(branch.stretches[0]?.modelTurns, 2);
});

test("every fall in reported usage is accounted for, however small", () => {
  // No floor under a drop: a size below which a fall is neither matched nor reported would be the
  // one thing that can go unmentioned.
  const path = write([
    typed("u1", null, "start"),
    model("a1", "u1", { contextTokens: 100_000 }),
    model("a2", "a1", { contextTokens: 99_950 }),
  ]);

  const branch = readTranscript(path, { tip: "a2" });
  assert.equal(branch.unexplainedDrops.length, 1);
  assert.equal(branch.unexplainedDrops[0]?.toTokens, 99_950);
});

test("a file that holds more than one session id says which ones the branch runs through", () => {
  const path = write([
    typed("u1", null, "recorded in the ancestor", { sessionId: "ancestor" }),
    model("a1", "u1", { sessionId: "ancestor" }),
    typed("u2", "a1", "recorded after the resume", { sessionId: "resumed" }),
    model("a2", "u2", { sessionId: "resumed" }),
  ]);

  const branch = readTranscript(path, { tip: "a2" });
  assert.deepEqual(branch.sessionIds, ["ancestor", "resumed"]);
  assert.deepEqual(branch.file.sessionIds, ["ancestor", "resumed"]);
});
