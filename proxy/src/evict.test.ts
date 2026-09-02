import { test } from "node:test";
import assert from "node:assert/strict";
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
  minSegmentChars: 100,
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

  const stub = blockAt(outcome.body, 2).content;
  assert.equal(
    stub,
    '[onepass: evicted Read result for /tmp/big.ts (5,000 chars). Re-read the file for current content, or recall_search("/tmp/big.ts") for the output as it was.]',
  );
  assert.equal(outcome.charsRemoved, 5000 - (stub as string).length);
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

test("results smaller than minSegmentChars are never stubbed", () => {
  const body = requestBody([
    assistantToolUse("toolu_1", "Read", { file_path: "/small.ts" }),
    userToolResult("toolu_1", "tiny"),
    ...filler(5),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(outcome.bodyChanged, false);
});

test("block-array tool_result content is measured and stubbed", () => {
  const originalContent = [{ type: "text", text: "y".repeat(300) }];
  const body = requestBody([
    assistantToolUse("toolu_1", "Read", { file_path: "/blocks.ts" }),
    userToolResult("toolu_1", originalContent),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  const stub = blockAt(outcome.body, 1).content;
  assert.equal(typeof stub, "string");
  assert.ok((stub as string).startsWith("[onepass: evicted Read result for /blocks.ts"));
  assert.ok((stub as string).includes(`(${measureContentChars(originalContent)} chars)`));
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
  assert.ok(typeof block.content === "string" && block.content.startsWith("[onepass: evicted Bash result for `npm test`"));
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

test("command targets are truncated to 80 chars in the stub", () => {
  const longCommand = `npm run ${"x".repeat(120)}`;
  const body = requestBody([
    assistantToolUse("toolu_1", "Bash", { command: longCommand }),
    userToolResult("toolu_1", "out".repeat(2000)),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  const stub = blockAt(outcome.body, 1).content as string;
  assert.ok(stub.includes(`\`${longCommand.slice(0, 80)}…\``));
  assert.ok(!stub.includes(longCommand));
});

test("a tool_use input with no path or command gets the generic stub", () => {
  const body = requestBody([
    assistantToolUse("toolu_1", "WebFetch", { url: "https://example.com" }),
    userToolResult("toolu_1", "w".repeat(3000)),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(
    blockAt(outcome.body, 1).content,
    '[onepass: evicted WebFetch result (3,000 chars). Use recall_search("WebFetch") for the output as it was.]',
  );
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
  const stub = blockAt(outcome.body, 1).content;
  assert.ok(typeof stub === "string" && stub.startsWith("[onepass: evicted Read result for /burst.ts"));
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

test("evicts old attached file content and names the paired file path in the stub", () => {
  const attachment = ATTACHED_FILE_TEXT("1\tconst x = 1;\n".repeat(400));
  const body = requestBody([
    { role: "user", content: READ_INPUT_TEXT("/repo/src/big.ts") },
    userTextBlocks(attachment, "do the thing"),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);

  assert.equal(outcome.newlyEvictedIds.length, 1);
  assert.ok(outcome.newlyEvictedIds[0]?.startsWith("sha1:"));
  const stub = (blockAt(outcome.body, 1) as { text?: unknown }).text;
  assert.equal(
    stub,
    `[onepass: evicted attached file /repo/src/big.ts (${attachment.length.toLocaleString("en-US")} chars). ` +
      `Read the file for current content, or recall_search("/repo/src/big.ts") for the content as it was.]`,
  );
  // The small input-mention message and the user's own text block survive untouched.
  const messages = (outcome.body as { messages: { content: unknown }[] }).messages;
  assert.equal(messages[0]?.content, READ_INPUT_TEXT("/repo/src/big.ts"));
  assert.equal((blockAt(outcome.body, 1, 1) as { text?: unknown }).text, "do the thing");
});

test("attached file content with no pairable input mention gets the pathless stub", () => {
  const attachment = ATTACHED_FILE_TEXT("x".repeat(4000));
  const body = requestBody([userTextBlocks(attachment), ...filler(3)]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  const stub = (blockAt(outcome.body, 0) as { text?: unknown }).text;
  assert.ok(typeof stub === "string" && stub.startsWith("[onepass: evicted attached file content ("));
});

test("each input mention is claimed once, nearest attachment first", () => {
  const attachmentA = ATTACHED_FILE_TEXT("a".repeat(3000));
  const attachmentB = ATTACHED_FILE_TEXT("b".repeat(3000));
  const body = requestBody([
    { role: "user", content: READ_INPUT_TEXT("/a.ts") },
    userTextBlocks(attachmentA),
    { role: "user", content: READ_INPUT_TEXT("/b.ts") },
    userTextBlocks(attachmentB),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.ok(String((blockAt(outcome.body, 1) as { text?: unknown }).text).includes("/a.ts"));
  assert.ok(String((blockAt(outcome.body, 3) as { text?: unknown }).text).includes("/b.ts"));
});

test("an attachment whose file content mentions the Read-input phrase is still evicted", () => {
  const trickyFileContent = `Called the Read tool with the following input: {"file_path":"/decoy.ts"} ${"x".repeat(3000)}`;
  const attachment = ATTACHED_FILE_TEXT(trickyFileContent);
  const body = requestBody([userTextBlocks(attachment), ...filler(3)]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  const stub = (blockAt(outcome.body, 0) as { text?: unknown }).text;
  assert.ok(typeof stub === "string" && stub.startsWith(STUB_PREFIX), `not evicted: ${String(stub).slice(0, 60)}`);
  assert.ok(!String(stub).includes("/decoy.ts"));
});

test("evicts an old task notification and points at its task id and output file", () => {
  const notification =
    `<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n` +
    `<output-file>/tmp/out/task.log</output-file>\n${"log line\n".repeat(500)}</task-notification>`;
  const body = requestBody([{ role: "user", content: notification }, ...filler(3)]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);

  const messages = (outcome.body as { messages: { content: unknown }[] }).messages;
  const stub = messages[0]?.content;
  assert.equal(
    stub,
    `[onepass: evicted task notification for task abc123 (${notification.length.toLocaleString("en-US")} chars). ` +
      `Read the full output on disk at /tmp/out/task.log, or recall_search("abc123") for it as it was.]`,
  );
});

test("a task notification without id or output file still gets a recall hint", () => {
  const notification = `<task-notification>\n${"noise ".repeat(600)}</task-notification>`;
  const body = requestBody([{ role: "user", content: notification }, ...filler(3)]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  const stub = (outcome.body as { messages: { content: unknown }[] }).messages[0]?.content;
  assert.ok(typeof stub === "string" && stub.includes('recall_search("task-notification")'));
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
    evicted:
      '[onepass: evicted Edit input for /repo/src/x.ts (1,000 chars). Read the file for current content, or recall_search("/repo/src/x.ts") for the call as it was.]',
  });

  // Everything the API validates the block by must survive the input swap.
  const block = blockAt(outcome.body, 0) as { type?: unknown; id?: unknown; name?: unknown };
  assert.deepEqual([block.type, block.id, block.name], ["tool_use", "toolu_edit", "Edit"]);
});

test("calls smaller than minSegmentChars are never stubbed", () => {
  const body = requestBody([
    assistantToolUse("toolu_read", "Read", { file_path: "/a.ts" }),
    userToolResult("toolu_read", "r".repeat(5000)),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.deepEqual(outcome.newlyEvictedIds, ["toolu_read"]);
  assert.deepEqual(inputAt(outcome.body, 0), { file_path: "/a.ts" });
});

test("a call whose stub would be bigger than the input it replaces is left alone", () => {
  // The call stub writes the path three times — the kept `file_path`, the prose, and the
  // recall_search query — so a modest input under a deep path stubs to 761 chars from 550.
  const body = requestBody([
    assistantToolUse("toolu_deep", "Edit", {
      file_path: `/repo/${"d".repeat(190)}/x.ts`,
      old_string: "a",
      new_string: "x".repeat(300),
    }),
    ...filler(3),
  ]);

  // Pin the scenario: the input is well over minSegmentChars, so the floor is not what skips
  // it. Without this the fixture could drift under the floor and the test would pass blind.
  assert.ok(measureContentChars(inputAt(body, 0)) > ALWAYS_TRIP.minSegmentChars);

  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.equal(outcome.bodyChanged, false);
  assert.deepEqual(outcome.newlyEvictedIds, []);

  // The re-stub pass has no size check of its own, so the guard has to sit ahead of it —
  // otherwise one oversized stub is re-paid on every later request for the rest of the session.
  const later = evictContextSegments(body, new Set(["call:toolu_deep"]), NEVER_TRIP);
  assert.equal(later.bodyChanged, false);
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
  const stubbed = {
    file_path: "/repo/src/x.ts",
    evicted: `${STUB_PREFIX} Edit input for /repo/src/x.ts (1,000 chars). Read the file for current content.]`,
  };
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
  assert.equal(
    input.evicted,
    `[onepass: evicted Bash input for \`${longCommand.slice(0, 80)}…\` (653 chars). ` +
      `Re-run it for current output, or recall_search("${longCommand.slice(0, 80)}…") for the call as it was.]`,
  );
  assert.ok(!JSON.stringify(outcome.body).includes(longCommand));
});

test("a call with neither path nor command gets the generic stub and a bare input", () => {
  const body = requestBody([
    assistantToolUse("toolu_web", "WebFetch", { url: "https://example.com", prompt: "p".repeat(500) }),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.deepEqual(inputAt(outcome.body, 0), {
    evicted:
      '[onepass: evicted WebFetch input (541 chars). Use recall_search("WebFetch") for the call as it was.]',
  });
});

test("a call and its result are both charged to charsRemoved, each by its own size", () => {
  const body = requestBody([
    assistantToolUse("toolu_edit", "Edit", editInput()),
    userToolResult("toolu_edit", "R".repeat(4000)),
    ...filler(3),
  ]);
  const outcome = evictContextSegments(body, NO_EVICTED_IDS, ALWAYS_TRIP);
  assert.deepEqual(outcome.newlyEvictedIds, ["call:toolu_edit", "toolu_edit"]);

  // A call is charged the JSON length of its replacement input (1,000 → 202), a result the
  // length of its stub string (4,000 → 163). Both stubs are pinned byte-exact above.
  assert.equal(outcome.charsRemoved, 1000 - 202 + (4000 - 163));
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
