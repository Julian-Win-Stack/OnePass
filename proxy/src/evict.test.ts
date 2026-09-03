import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  evictContextSegments,
  measureContentChars,
  STUB_PREFIX,
  textSegmentId,
  type EvictionConfig,
} from "./evict.js";

// tripThresholdTokens: 0 makes every request trip — the step-2 "deliberately dumb" behavior.
const ALWAYS_TRIP: EvictionConfig = {
  evictAfterAssistantTurns: 3,
  protectLastAssistantTurns: 2,
  minSavedChars: 50,
  tripThresholdTokens: 0,
  charsPerToken: 4,
};

const NEVER_TRIP: EvictionConfig = { ...ALWAYS_TRIP, tripThresholdTokens: 1_000_000_000 };
const NO_EVICTED_IDS: ReadonlySet<string> = new Set();

function assistantToolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return { role: "assistant", content: [{ type: "tool_use", id, name, input }] };
}

function userToolResult(id: string, content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] };
}

/** `count` assistant/user text exchanges, to age everything before them by `count` assistant turns. */
function filler(count: number): unknown[] {
  const messages: unknown[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `assistant turn ${i}` }] });
    messages.push({ role: "user", content: `user turn ${i}` });
  }
  return messages;
}

function requestBody(messages: unknown[]): Record<string, unknown> {
  return { model: "claude-test", max_tokens: 1000, messages };
}

interface MessageWithBlocks {
  content: { content?: unknown; is_error?: unknown; tool_use_id?: unknown }[];
}

function blockAt(body: unknown, messageIndex: number, blockIndex = 0): { content?: unknown; is_error?: unknown; tool_use_id?: unknown } {
  const messages = (body as { messages: MessageWithBlocks[] }).messages;
  const message = messages[messageIndex];
  assert.ok(message, `no message at index ${messageIndex}`);
  const block = message.content[blockIndex];
  assert.ok(block, `no block at ${messageIndex}/${blockIndex}`);
  return block;
}

test("stubs an old large tool result with the exact deterministic stub text", () => {
  const body = requestBody([
    { role: "user", content: "please read the big file" },
    assistantToolUse("toolu_1", "Read", { file_path: "/tmp/big.ts" }),
    userToolResult("toolu_1", "x".repeat(5000)),
    ...filler(3),
  ]);
  const snapshotBefore = JSON.stringify(body);

  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);

  assert.equal(outcome.bodyChanged, true);
  assert.equal(outcome.tripped, true);
  assert.deepEqual(outcome.newlyEvictedIds, ["toolu_1"]);
  assert.deepEqual(outcome.stubbedIds, ["toolu_1"]);

  assert.equal(blockAt(outcome.body, 2).content, "[onepass: evicted 5,000 chars]");
  assert.equal(outcome.charsRemoved, 5000 - 30);
  assert.equal(outcome.newlyEvictedCharsRemoved, outcome.charsRemoved);
  assert.ok(outcome.estimatedTokensSent < outcome.estimatedTokensBefore);

  // Pure: the input body was not mutated, and untouched messages are the same objects.
  assert.equal(JSON.stringify(body), snapshotBefore);
  const originalMessages = body.messages as unknown[];
  const outcomeMessages = (outcome.body as { messages: unknown[] }).messages;
  assert.equal(outcomeMessages[0], originalMessages[0]);
  assert.equal(outcomeMessages[1], originalMessages[1]);
});

test("nothing eligible passes the body through as the same reference", () => {
  const body = requestBody([
    assistantToolUse("toolu_1", "Read", { file_path: "/tmp/big.ts" }),
    userToolResult("toolu_1", "x".repeat(5000)),
    ...filler(1), // only 1 assistant turn after — younger than N=3
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(outcome.body, body);
  assert.equal(outcome.bodyChanged, false);
  assert.deepEqual(outcome.stubbedIds, []);
  assert.equal(outcome.charsRemoved, 0);
});

test("results inside the last K assistant turns are protected regardless of size", () => {
  const config: EvictionConfig = { ...ALWAYS_TRIP, evictAfterAssistantTurns: 0, protectLastAssistantTurns: 2 };
  const body = requestBody([
    assistantToolUse("toolu_old", "Read", { file_path: "/old.ts" }),
    userToolResult("toolu_old", "x".repeat(50_000)),
    ...filler(2),
    assistantToolUse("toolu_recent", "Read", { file_path: "/recent.ts" }),
    userToolResult("toolu_recent", "y".repeat(50_000)),
    ...filler(1),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, config);
  assert.deepEqual(outcome.newlyEvictedIds, ["toolu_old"]);
  const recent = blockAt(outcome.body, 7);
  assert.equal(recent.content, "y".repeat(50_000));
});

test("what the stub saves decides, not what the block holds", () => {
  // Both stub to 27 chars, so the 70-char result saves 43 — under the 50-char minimum — while
  // the 80-char one saves 53 and is taken.
  const body = requestBody([
    assistantToolUse("toolu_small", "Read", { file_path: "/small.ts" }),
    userToolResult("toolu_small", "y".repeat(70)),
    assistantToolUse("toolu_big", "Read", { file_path: "/big.ts" }),
    userToolResult("toolu_big", "z".repeat(80)),
    ...filler(5),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.deepEqual(outcome.newlyEvictedIds, ["toolu_big"]);
  assert.equal(blockAt(outcome.body, 1).content, "y".repeat(70));
  assert.equal(blockAt(outcome.body, 3).content, "[onepass: evicted 80 chars]");
});

// The point of the whole change. At trip 60 of the control transcript almost every live tool
// block was around this size, and the old 500-char floor refused them all because a stub that
// named its target cost more than the block held.
test("a small Bash result — the size the old floor refused — stubs to 28 chars", () => {
  const gitStatus =
    " M proxy/src/evict.ts\n M proxy/src/evict.test.ts\n M proxy/src/judge.ts\n M proxy/src/main.ts\n" +
    " M proxy/src/server.ts\n M proxy/README.md\n M CLAUDE.md\n?? docs/agents/\n";
  const body = requestBody([
    assistantToolUse("toolu_status", "Bash", { command: "git status --short" }),
    userToolResult("toolu_status", gitStatus),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.deepEqual(outcome.newlyEvictedIds, ["toolu_status"]);
  assert.equal(blockAt(outcome.body, 1).content, "[onepass: evicted 163 chars]");
});

// The attached-file stub names no path, so this marker beside the attachment is the only thing
// left pointing at the file. Neither its size nor a judge naming it may take it away.
test("the marker naming an attachment's path survives even a judge pick", () => {
  const marker = `<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/x.ts"}${"\n".repeat(9000)}`;
  const body = requestBody([{ role: "user", content: [{ type: "text", text: marker }] }, ...filler(9)]);
  const judged = new Map([[textSegmentId(marker), { keep: "", note: "a read marker" }]]);

  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP, judged);

  assert.equal(outcome.bodyChanged, false);
  assert.deepEqual(outcome.newlyEvictedIds, []);
});

// The recall tool's description is where the agent is told what a stub is and how to get the
// content back, and it quotes the format. Nothing else ties the two files together, so a
// reworded stub would leave that legend describing a string the proxy no longer sends.
test("the recall tool's description quotes the prefix the stubs actually carry", () => {
  const recallServer = readFileSync(new URL("../../spike/src/server.ts", import.meta.url), "utf8");

  assert.ok(
    recallServer.includes(`\`${STUB_PREFIX} N chars]\``),
    `spike/src/server.ts no longer quotes "${STUB_PREFIX} N chars]"`,
  );
});

test("block-array tool_result content is measured and stubbed", () => {
  const originalContent = [{ type: "text", text: "y".repeat(300) }];
  const body = requestBody([
    assistantToolUse("toolu_1", "Read", { file_path: "/blocks.ts" }),
    userToolResult("toolu_1", originalContent),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  // 327 = the JSON length of the block array, not the 300 chars of text inside it.
  assert.equal(blockAt(outcome.body, 1).content, "[onepass: evicted 327 chars]");
});

test("is_error results are evicted like any other and keep the flag", () => {
  const body = requestBody([
    assistantToolUse("toolu_1", "Bash", { command: "npm test" }),
    userToolResult("toolu_1", "E".repeat(4000), { is_error: true }),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  const block = blockAt(outcome.body, 1);
  assert.equal(block.is_error, true);
  assert.equal(block.tool_use_id, "toolu_1");
  assert.equal(block.content, "[onepass: evicted 4,000 chars]");
});

test("malformed bodies pass through untouched and never throw", () => {
  const malformed: unknown[] = [
    null,
    42,
    "not a body",
    [],
    {},
    { messages: "not an array" },
    {
      messages: [
        null,
        { role: "user" },
        { role: "user", content: "plain text" },
        { role: "user", content: [{ type: "tool_result" }, null, "stray string"] },
        { role: "assistant", content: [{ type: "tool_use" }] },
      ],
    },
  ];
  for (const body of malformed) {
    const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
    assert.equal(outcome.body, body);
    assert.equal(outcome.bodyChanged, false);
  }
});

test("already-evicted ids stay stubbed between trips; nothing new is added", () => {
  const body = requestBody([
    assistantToolUse("toolu_1", "Read", { file_path: "/a.ts" }),
    userToolResult("toolu_1", "a".repeat(5000)),
    assistantToolUse("toolu_2", "Read", { file_path: "/b.ts" }),
    userToolResult("toolu_2", "b".repeat(5000)),
    ...filler(4),
  ]);
  const outcome = evictContextSegments(body, new Set(["toolu_1"]), NEVER_TRIP);
  assert.equal(outcome.tripped, false);
  assert.deepEqual(outcome.stubbedIds, ["toolu_1"]);
  assert.deepEqual(outcome.newlyEvictedIds, []);
  assert.equal(outcome.newlyEvictedCharsRemoved, 0);
  assert.ok(outcome.charsRemoved > 4000);
  assert.equal(blockAt(outcome.body, 3).content, "b".repeat(5000));
});

test("a trip adds all currently eligible ids at once", () => {
  const body = requestBody([
    assistantToolUse("toolu_1", "Read", { file_path: "/a.ts" }),
    userToolResult("toolu_1", "a".repeat(5000)),
    assistantToolUse("toolu_2", "Read", { file_path: "/b.ts" }),
    userToolResult("toolu_2", "b".repeat(5000)),
    ...filler(4),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.deepEqual(outcome.newlyEvictedIds, ["toolu_1", "toolu_2"]);
});

test("below the size threshold nothing new is evicted", () => {
  const body = requestBody([
    assistantToolUse("toolu_1", "Read", { file_path: "/a.ts" }),
    userToolResult("toolu_1", "a".repeat(5000)),
    ...filler(4),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, NEVER_TRIP);
  assert.equal(outcome.tripped, false);
  assert.equal(outcome.bodyChanged, false);
});

test("the trip threshold is measured after re-applying existing stubs", () => {
  // Original ≈ 100k tokens; once toolu_huge is re-stubbed it is far below T=50k, so
  // toolu_next must not be evicted even though the raw request exceeds T.
  const body = requestBody([
    assistantToolUse("toolu_huge", "Read", { file_path: "/huge.ts" }),
    userToolResult("toolu_huge", "h".repeat(400_000)),
    assistantToolUse("toolu_next", "Read", { file_path: "/next.ts" }),
    userToolResult("toolu_next", "n".repeat(5000)),
    ...filler(4),
  ]);
  const config: EvictionConfig = { ...ALWAYS_TRIP, tripThresholdTokens: 50_000 };
  const outcome = evictContextSegments(body, new Set(["toolu_huge"]), config);
  assert.equal(outcome.tripped, false);
  assert.deepEqual(outcome.stubbedIds, ["toolu_huge"]);
  assert.equal(blockAt(outcome.body, 3).content, "n".repeat(5000));
});

test("pressure: a burst younger than N but older than K is evicted when still over T", () => {
  const config: EvictionConfig = { ...ALWAYS_TRIP, evictAfterAssistantTurns: 8, protectLastAssistantTurns: 2 };
  const body = requestBody([
    assistantToolUse("toolu_burst", "Read", { file_path: "/burst.ts" }),
    userToolResult("toolu_burst", "B".repeat(50_000)),
    ...filler(3), // age 3: younger than N=8, older than K=2
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, config);
  assert.equal(outcome.pressure, true);
  assert.deepEqual(outcome.newlyEvictedIds, ["toolu_burst"]);
  assert.equal(blockAt(outcome.body, 1).content, "[onepass: evicted 50,000 chars]");
});

test("pressure never touches the last K turns", () => {
  const config: EvictionConfig = { ...ALWAYS_TRIP, evictAfterAssistantTurns: 8, protectLastAssistantTurns: 2 };
  const body = requestBody([
    assistantToolUse("toolu_recent", "Read", { file_path: "/recent.ts" }),
    userToolResult("toolu_recent", "R".repeat(50_000)),
    ...filler(1), // age 1: inside the last K=2 turns
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, config);
  assert.equal(outcome.pressure, false);
  assert.equal(outcome.bodyChanged, false);
  assert.equal(blockAt(outcome.body, 1).content, "R".repeat(50_000));
});

test("no pressure pass when the normal pass gets under T", () => {
  const config: EvictionConfig = { ...ALWAYS_TRIP, tripThresholdTokens: 5_000 };
  const body = requestBody([
    assistantToolUse("toolu_old", "Read", { file_path: "/old.ts" }),
    userToolResult("toolu_old", "O".repeat(100_000)), // age 3 ≥ N=3: normal eviction gets under T
    assistantToolUse("toolu_young", "Read", { file_path: "/young.ts" }),
    userToolResult("toolu_young", "Y".repeat(3000)), // age 2: pressure-eligible, but must survive
    ...filler(2),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, config);
  assert.equal(outcome.pressure, false);
  assert.deepEqual(outcome.newlyEvictedIds, ["toolu_old"]);
  assert.equal(blockAt(outcome.body, 3).content, "Y".repeat(3000));
});

test("the transform is deterministic", () => {
  const build = (): Record<string, unknown> =>
    requestBody([
      assistantToolUse("toolu_1", "Read", { file_path: "/tmp/big.ts" }),
      userToolResult("toolu_1", "x".repeat(5000)),
      assistantToolUse("toolu_edit", "Edit", editInput()),
      ...filler(3),
    ]);
  const first = evictContextSegments(build(), NO_EVICTED_IDS, ALWAYS_TRIP);
  const second = evictContextSegments(build(), NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(JSON.stringify(first.body), JSON.stringify(second.body));
});

// --- injected-text segments (attached files, task notifications) ---

const READ_INPUT_TEXT = (path: string): string =>
  `<system-reminder>\nCalled the Read tool with the following input: {"file_path":"${path}"}\n</system-reminder>`;
const ATTACHED_FILE_TEXT = (body: string): string =>
  `<system-reminder>\nResult of calling the Read tool:\n${body}\n</system-reminder>`;

function userTextBlocks(...texts: string[]): unknown {
  return { role: "user", content: texts.map((text) => ({ type: "text", text })) };
}

test("evicts old attached file content and leaves the Read-input marker naming its path", () => {
  const attachment = ATTACHED_FILE_TEXT("1\tconst x = 1;\n".repeat(400));
  const body = requestBody([
    { role: "user", content: READ_INPUT_TEXT("/repo/src/big.ts") },
    userTextBlocks(attachment, "do the thing"),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);

  assert.equal(outcome.newlyEvictedIds.length, 1);
  assert.ok(outcome.newlyEvictedIds[0]?.startsWith("sha1:"));
  assert.equal(
    (blockAt(outcome.body, 1) as { text?: unknown }).text,
    `[onepass: evicted attached file, ${attachment.length.toLocaleString("en-US")} chars]`,
  );
  // The stub names no path, so the marker that does must survive — as must the user's own text.
  const messages = (outcome.body as { messages: { content: unknown }[] }).messages;
  assert.equal(messages[0]?.content, READ_INPUT_TEXT("/repo/src/big.ts"));
  assert.equal((blockAt(outcome.body, 1, 1) as { text?: unknown }).text, "do the thing");
});

test("an attachment whose file content mentions the Read-input phrase is still evicted", () => {
  // Only the start of the text decides the kind, so a file quoting the marker is not mistaken
  // for one.
  const trickyFileContent = `Called the Read tool with the following input: {"file_path":"/decoy.ts"} ${"x".repeat(3000)}`;
  const attachment = ATTACHED_FILE_TEXT(trickyFileContent);
  const body = requestBody([userTextBlocks(attachment), ...filler(3)]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(
    (blockAt(outcome.body, 0) as { text?: unknown }).text,
    `[onepass: evicted attached file, ${attachment.length.toLocaleString("en-US")} chars]`,
  );
});

test("evicts an old task notification and points at its task id and output file", () => {
  const notification =
    `<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n` +
    `<output-file>/tmp/out/task.log</output-file>\n${"log line\n".repeat(500)}</task-notification>`;
  const body = requestBody([{ role: "user", content: notification }, ...filler(3)]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);

  const messages = (outcome.body as { messages: { content: unknown }[] }).messages;
  assert.equal(
    messages[0]?.content,
    `[onepass: evicted task notification abc123, ${notification.length.toLocaleString("en-US")} chars; ` +
      `output at /tmp/out/task.log]`,
  );
});

test("a task notification without id or output file keeps neither in its stub", () => {
  const notification = `<task-notification>\n${"noise ".repeat(600)}</task-notification>`;
  const body = requestBody([{ role: "user", content: notification }, ...filler(3)]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(
    (outcome.body as { messages: { content: unknown }[] }).messages[0]?.content,
    `[onepass: evicted task notification, ${notification.length.toLocaleString("en-US")} chars]`,
  );
});

test("non-whitelisted system-reminder text is never evicted, however old or large", () => {
  const claudeMdReminder =
    `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\n` +
    `${"instruction line\n".repeat(1000)}</system-reminder>`;
  const skillListing = `<system-reminder>\nThe following skills are available:\n${"- skill\n".repeat(800)}</system-reminder>`;
  const compactSummary = `This session is being continued from a previous conversation. Summary:\n${"detail\n".repeat(900)}`;
  const typedUserText = `here is a big error log I pasted myself:\n${"stack frame\n".repeat(700)}`;
  const body = requestBody([
    userTextBlocks(claudeMdReminder, skillListing),
    { role: "user", content: compactSummary },
    { role: "user", content: typedUserText },
    ...filler(5),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(outcome.bodyChanged, false);
  assert.equal(outcome.newlyEvictedIds.length, 0);
});

test("text segments inside the last K assistant turns are protected", () => {
  const attachment = ATTACHED_FILE_TEXT("fresh ".repeat(1000));
  const body = requestBody([userTextBlocks(attachment), ...filler(1)]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(outcome.bodyChanged, false);
});

test("an evicted text segment stays stubbed on later requests via its content hash", () => {
  const attachment = ATTACHED_FILE_TEXT("y".repeat(4000));
  const build = (): Record<string, unknown> => requestBody([userTextBlocks(attachment), ...filler(3)]);
  const first = evictContextSegments(build(), NO_EVICTED_IDS, ALWAYS_TRIP);
  const evictedId = first.newlyEvictedIds[0];
  assert.ok(evictedId !== undefined);

  const second = evictContextSegments(build(), new Set([evictedId]), NEVER_TRIP);
  assert.equal(second.tripped, false);
  assert.deepEqual(second.stubbedIds, [evictedId]);
  assert.deepEqual(second.newlyEvictedIds, []);
  assert.equal(
    (blockAt(second.body, 0) as { text?: unknown }).text,
    (blockAt(first.body, 0) as { text?: unknown }).text,
  );
});

test("re-reading an evicted file leaves the fresh identical copy live until it ages", () => {
  const attachment = ATTACHED_FILE_TEXT("same content ".repeat(300));
  const evictedId = evictContextSegments(
    requestBody([userTextBlocks(attachment), ...filler(3)]),
    NO_EVICTED_IDS,
    ALWAYS_TRIP,
  ).newlyEvictedIds[0];
  assert.ok(evictedId !== undefined);

  // Same content attached twice: the old copy re-stubs, the copy inside the last K
  // assistant turns must stay readable — it is the stub's own recovery path.
  const outcome = evictContextSegments(
    requestBody([userTextBlocks(attachment), ...filler(3), userTextBlocks(attachment), ...filler(1)]),
    new Set([evictedId]),
    NEVER_TRIP,
  );
  assert.equal((blockAt(outcome.body, 0) as { text?: unknown }).text?.toString().startsWith(STUB_PREFIX), true);
  assert.equal((blockAt(outcome.body, 7) as { text?: unknown }).text, attachment);
});

// --- tool_use inputs (the calls themselves) ---

/** An Edit input whose JSON is exactly 1,000 chars, so the stub's char count is a literal. */
function editInput(): Record<string, unknown> {
  return { file_path: "/repo/src/x.ts", old_string: "a", new_string: "x".repeat(937) };
}

function inputAt(body: unknown, messageIndex: number, blockIndex = 0): Record<string, unknown> {
  const block = blockAt(body, messageIndex, blockIndex) as { input?: unknown };
  assert.ok(block.input !== null && typeof block.input === "object", "block has no object input");
  return block.input as Record<string, unknown>;
}

test("stubs an old large tool_use input with the exact deterministic stub text", () => {
  const body = requestBody([
    assistantToolUse("toolu_edit", "Edit", editInput()),
    userToolResult("toolu_edit", "The file /repo/src/x.ts has been updated."),
    ...filler(3),
  ]);

  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);

  assert.deepEqual(outcome.newlyEvictedIds, ["call:toolu_edit"]);
  assert.deepEqual(inputAt(outcome.body, 0), {
    file_path: "/repo/src/x.ts",
    evicted: "[onepass: evicted 1,000 chars]",
  });

  // Everything the API validates the block by must survive the input swap.
  const block = blockAt(outcome.body, 0) as { type?: unknown; id?: unknown; name?: unknown };
  assert.deepEqual([block.type, block.id, block.name], ["tool_use", "toolu_edit", "Edit"]);
});

test("a call whose stub would cost more than its input is left alone, on this request and the next", () => {
  // A Read call is the case the guard exists for: the input is nothing but the path the stub
  // would keep anyway, so the stub costs 61 chars against the 21 it replaces.
  const build = (): Record<string, unknown> =>
    requestBody([
      assistantToolUse("toolu_read", "Read", { file_path: "/a.ts" }),
      userToolResult("toolu_read", "r".repeat(5000)),
      ...filler(3),
    ]);
  assert.equal(measureContentChars(inputAt(build(), 0)), 21);

  const first = evictContextSegments(build(), NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.deepEqual(first.newlyEvictedIds, ["toolu_read"], "its result is still worth stubbing");
  assert.deepEqual(inputAt(first.body, 0), { file_path: "/a.ts" });

  // The re-stub pass has no size check of its own, so the guard has to sit ahead of it —
  // otherwise one oversized stub is re-paid on every later request for the rest of the session.
  const later = evictContextSegments(build(), new Set(["call:toolu_read"]), NEVER_TRIP);
  assert.deepEqual(inputAt(later.body, 0), { file_path: "/a.ts" });
});

test("stubbing a big call leaves its small result alone, on this request and the next", () => {
  const confirmation = "The file /repo/src/x.ts has been updated.";
  const build = (): Record<string, unknown> =>
    requestBody([
      assistantToolUse("toolu_edit", "Edit", editInput()),
      userToolResult("toolu_edit", confirmation),
      ...filler(3),
    ]);

  const first = evictContextSegments(build(), NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.deepEqual(first.newlyEvictedIds, ["call:toolu_edit"]);
  assert.equal(blockAt(first.body, 1).content, confirmation);

  // The re-stub pass has no size check, so a shared id would stub the tiny result forever.
  const second = evictContextSegments(build(), new Set(["call:toolu_edit"]), NEVER_TRIP);
  assert.equal(second.tripped, false);
  assert.deepEqual(second.stubbedIds, ["call:toolu_edit"]);
  assert.deepEqual(second.newlyEvictedIds, []);
  assert.equal(blockAt(second.body, 1).content, confirmation);
  assert.deepEqual(inputAt(second.body, 0), inputAt(first.body, 0));
});

test("calls inside the last K assistant turns are protected regardless of size", () => {
  const config: EvictionConfig = { ...ALWAYS_TRIP, evictAfterAssistantTurns: 0, protectLastAssistantTurns: 2 };
  const body = requestBody([
    assistantToolUse("toolu_old", "Edit", editInput()),
    ...filler(2),
    assistantToolUse("toolu_recent", "Edit", editInput()),
    ...filler(1),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, config);
  assert.deepEqual(outcome.newlyEvictedIds, ["call:toolu_old"]);
  assert.deepEqual(inputAt(outcome.body, 5), editInput());
});

test("an already-stub-shaped call input is left alone rather than re-stubbed", () => {
  const stubbed = { file_path: "/repo/src/x.ts", evicted: `${STUB_PREFIX} 1,000 chars]` };
  const body = requestBody([assistantToolUse("toolu_edit", "Edit", stubbed), ...filler(3)]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(outcome.bodyChanged, false);
  assert.deepEqual(outcome.newlyEvictedIds, []);
});

test("a call whose input is not an object is passed through, however large", () => {
  const body = requestBody([
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_odd", name: "Odd", input: "s".repeat(9000) }] },
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(outcome.bodyChanged, false);
  assert.equal((blockAt(outcome.body, 0) as { input?: unknown }).input, "s".repeat(9000));
});

test("a stubbed Bash call keeps its command, truncated to 80 chars", () => {
  const longCommand = `grep -rn needle ${"z".repeat(600)}`;
  const body = requestBody([
    assistantToolUse("toolu_bash", "Bash", { command: longCommand, description: "search" }),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  const input = inputAt(outcome.body, 0);
  assert.equal(input.command, `${longCommand.slice(0, 80)}…`);
  assert.equal(input.evicted, "[onepass: evicted 653 chars]");
  assert.ok(!JSON.stringify(outcome.body).includes(longCommand));
});

test("a call with neither path nor command keeps nothing but the stub in its input", () => {
  const body = requestBody([
    assistantToolUse("toolu_web", "WebFetch", { url: "https://example.com", prompt: "p".repeat(500) }),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.deepEqual(inputAt(outcome.body, 0), { evicted: "[onepass: evicted 541 chars]" });
});

test("a call and its result are both charged to charsRemoved, each by its own size", () => {
  const body = requestBody([
    assistantToolUse("toolu_edit", "Edit", editInput()),
    userToolResult("toolu_edit", "R".repeat(4000)),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.deepEqual(outcome.newlyEvictedIds, ["call:toolu_edit", "toolu_edit"]);

  // A call is charged the JSON length of its replacement input (1,000 → 73), a result the
  // length of its stub string (4,000 → 30). Both stubs are pinned byte-exact above.
  assert.equal(outcome.charsRemoved, 1000 - 73 + (4000 - 30));
});

// A judge-selected user block: 3,000 chars, an instruction followed by a paste.
const PASTED_USER_TEXT = "Use tabs, not spaces. Here is the log:\n" + "L".repeat(2961);
const PASTED_USER_TEXT_ID = textSegmentId(PASTED_USER_TEXT);

const pointerWith = (summary: string): string =>
  `[onepass: evicted 3,000 chars of user text.${summary} ` +
  `recall_search("Use tabs, not spaces. Here is the log:") for the original]`;

const NOTE = "build log from the failing auth test";
const SUMMARY = ` onepass's summary: ${NOTE}.`;

for (const { name, decision, expected } of [
  {
    name: "the quote above a pointer when only a quote was kept",
    decision: { keep: "Use tabs, not spaces.", note: "" },
    expected: `Use tabs, not spaces.\n${pointerWith("")}`,
  },
  {
    name: "an attributed summary alone when the block was a pure paste",
    decision: { keep: "", note: NOTE },
    expected: pointerWith(SUMMARY),
  },
  {
    name: "the quote above an attributed summary when the judge gave both",
    decision: { keep: "Use tabs, not spaces.", note: NOTE },
    expected: `Use tabs, not spaces.\n${pointerWith(SUMMARY)}`,
  },
]) {
  test(`stubs a judge-selected user block as ${name}, with no trip`, () => {
    const body = requestBody([
      { role: "user", content: [{ type: "text", text: PASTED_USER_TEXT }] },
      ...filler(3),
    ]);

    const outcome = evictContextSegments(
      body,
      new Set([PASTED_USER_TEXT_ID]),
      NEVER_TRIP,
      new Map([[PASTED_USER_TEXT_ID, decision]]),
    );

    assert.equal(outcome.tripped, false, "a verdict applies on the next request whether or not it trips");
    assert.equal((blockAt(outcome.body, 0) as { text?: unknown }).text, expected);
  });
}

// The note is the judge's own words, unverifiable by construction. A cap is the only thing
// standing between a malfunctioning judge and paragraphs of invented text in the context.
test("truncates a judge note that runs past the cap", () => {
  const body = requestBody([
    { role: "user", content: [{ type: "text", text: PASTED_USER_TEXT }] },
    ...filler(3),
  ]);

  const outcome = evictContextSegments(
    body,
    new Set([PASTED_USER_TEXT_ID]),
    NEVER_TRIP,
    new Map([[PASTED_USER_TEXT_ID, { keep: "", note: "N".repeat(500) }]]),
  );

  const stub = String((blockAt(outcome.body, 0) as { text?: unknown }).text);
  assert.ok(stub.includes(`onepass's summary: ${"N".repeat(200)}\u2026.`), stub.slice(0, 120));
});

test("leaves a user block alone when the judge never selected it", () => {
  const body = requestBody([
    { role: "user", content: [{ type: "text", text: PASTED_USER_TEXT }] },
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, new Set([PASTED_USER_TEXT_ID]), ALWAYS_TRIP);
  assert.equal(outcome.bodyChanged, false, "only judge-selected user text is evictable");
});
