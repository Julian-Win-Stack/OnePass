// What a case's request body is made of.
//
// The thing that can go wrong here is subtle and expensive: a request rebuilt from the transcript
// that is not shaped like the request the session sent. Claude Code writes one `assistant` entry
// per content block, so a rebuild that does not merge them counts three assistant messages where
// the API saw one — and the proxy's age gate, which is counted in assistant messages, then fires
// at a depth no real session would have reached. Each test below is one way the shape can drift.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMessages, historyStart } from "./messages.js";
import { readTranscript } from "./transcript.js";
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

function branchOf(lines: readonly Line[], tip: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "onepass-messages-")));
  return readTranscript(writeTranscript(dir, "session.jsonl", lines), { tip });
}

/** The role of each message, which is the shape the merge is really about. */
function roles(messages: readonly { role: string }[]): string[] {
  return messages.map((message) => message.role);
}

test("merges the entries of one model turn back into the one message the API saw", () => {
  // Claude Code writes the text block and the tool_use block of a single answer as two entries.
  const branch = branchOf(
    [
      typed("u1", null, "start"),
      model("a1", "u1", { textOnly: true }),
      model("a2", "a1", { textOnly: false }),
      toolResult("u2", "a2"),
      model("a3", "u2", { textOnly: true }),
      typed("u3", "a3", "and now this"),
    ],
    "u3",
  );

  const messages = buildMessages(branch, branch.turns.length - 1);

  assert.deepEqual(roles(messages), ["user", "assistant", "user", "assistant", "user"]);
  const answer = messages[1] as { content: { type: string }[] };
  assert.deepEqual(
    answer.content.map((block) => block.type),
    ["text", "tool_use"],
    "the two entries of one answer are one message with two blocks",
  );
});

test("ends on the turn the case is cut at, and carries nothing after it", () => {
  const branch = branchOf(
    [
      typed("u1", null, "first"),
      model("a1", "u1"),
      typed("u2", "a1", "the case"),
      model("a2", "u2"),
      typed("u3", "a2", "later, and not in this case"),
    ],
    "u3",
  );
  const cut = branch.turns.find((turn) => turn.uuid === "u2") as { index: number };

  const messages = buildMessages(branch, cut.index) as { role: string; content: { text?: string }[] }[];

  assert.deepEqual(roles(messages), ["user", "assistant", "user"]);
  assert.equal(messages[2]?.content[0]?.text, "the case");
});

test("leaves out a subagent's conversation and the synthetic entries", () => {
  const branch = branchOf(
    [
      typed("u1", null, "start"),
      model("a1", "u1", { textOnly: false }),
      typed("s1", "a1", "a subagent's prompt", { isSidechain: true }),
      model("s2", "s1", { isSidechain: true }),
      toolResult("u2", "s2"),
      synthetic("x1", "u2"),
      typed("u3", "x1", "carry on"),
    ],
    "u3",
  );

  const messages = buildMessages(branch, branch.turns.length - 1);

  assert.deepEqual(roles(messages), ["user", "assistant", "user"]);
  assert.equal(
    JSON.stringify(messages).includes("a subagent's prompt"),
    false,
    "a sidechain turn is another conversation and was never in this request",
  );
});

test("a case after a compaction opens with the summary, not with the history the compaction dropped", () => {
  const branch = branchOf(
    [
      typed("u1", null, "before the compaction"),
      model("a1", "u1", { contextTokens: 170_000 }),
      typed("u2", "a1", "after the compaction"),
      model("a2", "u2", { contextTokens: 9_000 }),
      compactBoundary("c1", "a1"),
      compactSummary("cs1", "c1"),
    ],
    "a2",
  );
  assert.equal(branch.compactions.length, 1, "the boundary was matched to the branch");
  const cut = branch.turns.find((turn) => turn.uuid === "u2") as { index: number };

  const messages = buildMessages(branch, cut.index) as { role: string; content: { text?: string }[] }[];

  // The summary and the turn typed after it are both `user`, so they are one message, exactly as
  // two tool results handed back together are.
  assert.deepEqual(roles(messages), ["user"]);
  assert.match(messages[0]?.content[0]?.text ?? "", /^This session is being continued/);
  assert.equal(messages[0]?.content[1]?.text, "after the compaction");
  assert.equal(
    JSON.stringify(messages).includes("before the compaction"),
    false,
    "the compaction dropped that history, so a request made after it never carried it",
  );
});

test("history starts at the branch root when nothing was compacted before the case", () => {
  const branch = branchOf([typed("u1", null, "start"), model("a1", "u1"), typed("u2", "a1", "next")], "u2");

  const start = historyStart(branch, branch.turns.length - 1);

  assert.equal(start.fromIndex, 0);
  assert.equal(start.compaction, null);
  assert.equal(start.opensWithCompactionSummary, false);
});

test("history starts after the last compaction the case sits past", () => {
  // Two compactions, because the corpus branch has two and one of them cannot tell the last from
  // the first. A case past both opens with the second summary; opening with the first would carry
  // back every turn the second compaction threw away.
  const branch = branchOf(
    [
      typed("u1", null, "first"),
      model("a1", "u1", { contextTokens: 170_000 }),
      typed("u2", "a1", "second"),
      model("a2", "u2", { contextTokens: 9_000 }),
      typed("u3", "a2", "third"),
      model("a3", "u3", { contextTokens: 180_000 }),
      typed("u4", "a3", "fourth"),
      model("a4", "u4", { contextTokens: 11_000 }),
      compactBoundary("c1", "a1"),
      compactSummary("cs1", "c1"),
      compactBoundary("c2", "a3"),
      compactSummary("cs2", "c2"),
    ],
    "a4",
  );
  assert.equal(branch.compactions.length, 2, "both boundaries were matched to the branch");

  const start = historyStart(branch, branch.turns.length - 1);

  assert.equal(start.compaction?.uuid, "c2", "the last compaction the case sits past, not the first");
  assert.equal(start.fromIndex, 6, "the turn straight after the one that compaction preserved");
  assert.equal(start.opensWithCompactionSummary, true);
});

test("a compaction whose summary the file does not hold is reported, not silently skipped", () => {
  const branch = branchOf(
    [
      typed("u1", null, "first"),
      model("a1", "u1", { contextTokens: 170_000 }),
      typed("u2", "a1", "second"),
      model("a2", "u2", { contextTokens: 9_000 }),
      compactBoundary("c1", "a1"),
    ],
    "a2",
  );

  const cut = branch.turns.find((turn) => turn.uuid === "u2") as { index: number };
  const start = historyStart(branch, cut.index);

  assert.equal(start.compaction?.uuid, "c1");
  assert.equal(start.opensWithCompactionSummary, false, "there is no summary to open with");
  const messages = buildMessages(branch, cut.index) as { content: { text?: string }[] }[];
  assert.equal(messages.length, 1, "the turn typed after the compaction, and nothing standing in for it");
});

// A parallel tool call is the one place the transcript is not a line. Claude Code writes the two
// calls as two entries and hangs the first call's result off the first entry as a childless leaf,
// so the walk reaches the second call's result and no other. Every test below is one half of what
// putting the missed result back has to get right: the request carries it, and carrying it does
// not change the message shape the session sent.

/** The `tool_use` ids of a message, in the order it stored them. */
function callIds(message: { content: unknown[] }): string[] {
  return message.content
    .filter((block): block is { type: string; id: string } => (block as { type?: string })?.type === "tool_use")
    .map((block) => block.id);
}

/** The calls a message answers, in the order it stored them. */
function answeredIds(message: { content: unknown[] }): string[] {
  return message.content
    .filter((block): block is { type: string; tool_use_id: string } =>
      (block as { type?: string })?.type === "tool_result")
    .map((block) => block.tool_use_id);
}

/**
 * Two calls in one answer. `call-A` is answered on a childless leaf hanging off `a1`, which the
 * walk to `u2` never visits; `call-B` is answered on the chain the walk follows.
 */
const parallelCall = [
  typed("u1", null, "start"),
  model("a1", "u1", { textOnly: false, toolUseId: "call-A" }),
  model("a2", "a1", { textOnly: false, toolUseId: "call-B" }),
  toolResult("rA", "a1", { toolUseId: "call-A" }),
  toolResult("rB", "a2", { toolUseId: "call-B" }),
  model("a3", "rB", { textOnly: true }),
  typed("u2", "a3", "next"),
];

test("answers both calls of a parallel tool call, including the one off the walked path", () => {
  const branch = branchOf(parallelCall, "u2");

  const messages = buildMessages(branch, branch.turns.length - 1) as { role: string; content: unknown[] }[];

  assert.deepEqual(
    answeredIds(messages[2] as { content: unknown[] }),
    ["call-A", "call-B"],
    "the API requires every call of a message to be answered in the message that follows it",
  );
});

test("keeps a parallel tool call to the one assistant message the API saw", () => {
  const branch = branchOf(parallelCall, "u2");

  const messages = buildMessages(branch, branch.turns.length - 1) as { role: string; content: unknown[] }[];

  assert.deepEqual(roles(messages), ["user", "assistant", "user", "assistant", "user"]);
  assert.deepEqual(
    callIds(messages[1] as { content: unknown[] }),
    ["call-A", "call-B"],
    "both calls are one message; splitting them would double the assistant count the age gate reads",
  );
});

test("leaves the tool result of an abandoned branch out of the request", () => {
  // `call-X` was made on a branch the session rewound out of, so neither it nor its result was in
  // the request. A result is carried because the call it answers is on the branch, not because the
  // result is a dead end — every parallel call's result is a dead end too.
  const branch = branchOf(
    [
      typed("u1", null, "start"),
      model("a1", "u1", { textOnly: true }),
      typed("u2", "a1", "second"),
      model("dead1", "u2", { textOnly: false, toolUseId: "call-X" }),
      toolResult("dead2", "dead1", { toolUseId: "call-X" }),
      model("a2", "u2", { textOnly: true }),
      typed("u3", "a2", "third"),
    ],
    "u3",
  );

  const messages = buildMessages(branch, branch.turns.length - 1) as { role: string; content: unknown[] }[];

  assert.deepEqual(roles(messages), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(
    JSON.stringify(messages).includes("call-X"),
    false,
    "the call was rewound out of, so neither it nor its result was ever sent",
  );
});
