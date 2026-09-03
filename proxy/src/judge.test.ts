import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJudgeRequest,
  JUDGE_BRIEF,
  parseJudgeResponse,
  validateJudgePicks,
  type RenderedMessage,
} from "./judge.js";
import { textSegmentId } from "./evict.js";

function renderedMessages(request: Record<string, unknown>): RenderedMessage[] {
  const messages = request.messages as { role: string; content: string }[];
  const only = messages[0];
  assert.ok(only !== undefined && messages.length === 1, "the judge request should carry one user message");
  return JSON.parse(only.content) as RenderedMessage[];
}

test("renders every evictable block with its eviction id and drops thinking entirely", () => {
  const request = buildJudgeRequest(
    [
      { role: "user", content: [{ type: "text", text: "pasted spec" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning", signature: "sig" },
          { type: "text", text: "reading it now" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Edit",
            input: { file_path: "/a.ts", old_string: "a".repeat(400), new_string: "b".repeat(400) },
          },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x".repeat(600) }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
    "claude-sonnet-5",
    0,
    0,
  );

  assert.equal(request.model, "claude-sonnet-5");
  assert.equal(request.system, JUDGE_BRIEF);
  const rendered = renderedMessages(request);

  const userText = rendered[0]?.content[0];
  assert.equal(userText?.type, "text");
  assert.equal(userText?.text, "pasted spec");
  assert.match(String(userText?.onepass_id), /^sha1:[0-9a-f]{40}$/);

  const assistantBlocks = rendered[1]?.content ?? [];
  assert.deepEqual(
    assistantBlocks.map((block) => block.type),
    ["text", "tool_use"],
    "thinking blocks must never be offered to the judge",
  );
  assert.equal(assistantBlocks[0]?.onepass_id, undefined, "assistant text is not evictable, so it carries no id");
  assert.equal(assistantBlocks[1]?.onepass_id, "call:toolu_1");
  assert.equal(assistantBlocks[1]?.name, "Edit", "the call's input reaches the judge as it was");

  assert.equal(rendered[2]?.content[0]?.onepass_id, "toolu_1");
  assert.ok(!JSON.stringify(request).includes("secret reasoning"), "thinking text reached the judge");
});

const ATTACHED_FILE = "<system-reminder>\nResult of calling the Read tool:\nexport const a = 1;";
const READ_INPUT = '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/a.ts"}';
const EXISTING_STUB = "[onepass: evicted 4,000 chars]";

/**
 * Regression: review found the judge naming these and the proxy counting the pick as accepted
 * while nothing was ever stubbed. The rules own all four shapes — two are stubbed whatever the
 * judge says (dropping its note), one is not evictable at all, one is already a pointer — so
 * the judge is shown no id for any of them.
 */
test("offers no eviction id for harness-injected text or for blocks already stubbed", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: ATTACHED_FILE },
        { type: "text", text: READ_INPUT },
        { type: "text", text: EXISTING_STUB },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { evicted: EXISTING_STUB } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: EXISTING_STUB }] },
    { role: "assistant", content: [{ type: "text", text: "carrying on" }] },
  ];

  const rendered = renderedMessages(buildJudgeRequest(messages, "claude-sonnet-5", 0, 0));
  const ids = rendered.flatMap((message) => message.content.map((block) => block.onepass_id));
  assert.equal(ids.length, 6, "every block is still shown to the judge — it needs them for context");
  assert.deepEqual(ids.filter((id) => id !== undefined), [], "...but none of them may carry an id it can name");

  const verdict = validateJudgePicks(
    [{ id: textSegmentId(ATTACHED_FILE), keep: "", note: "the file I attached" }],
    messages,
    0,
    0,
  );
  assert.deepEqual(verdict.accepted, [], "a pick on rule-owned text must never be counted as accepted");
  assert.equal(verdict.rejected.unknownId, 1);
});

/**
 * The menu and the guards have to agree. A block the guards would refuse is a trap: the judge
 * spends its attention on it and the pick can only bounce, so it is shown without an id.
 */
test("a block whose stub would save too little carries no id the judge can name", () => {
  const messages = [
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/big.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "x".repeat(2000) }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_tiny", content: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "two" }] },
  ];

  const rendered = renderedMessages(buildJudgeRequest(messages, "claude-sonnet-5", 1, 500));

  assert.equal(rendered[1]?.content[0]?.onepass_id, "toolu_read", "2,000 chars for a ~30-char stub is worth naming");
  assert.equal(rendered[2]?.content[0]?.onepass_id, undefined, "a two-char result can never pay for its own stub");
  assert.equal(
    rendered[0]?.content[0]?.onepass_id,
    undefined,
    "a Read call is nothing but the path its stub keeps anyway",
  );
});

test("reads the picks and the judge's own token spend out of one response", () => {
  const response = JSON.stringify({
    type: "message",
    content: [
      {
        type: "text",
        text: '{"evict":[{"id":"toolu_1","keep":"","note":""},{"id":"sha1:abc","keep":"do the thing","note":"a log"}]}',
      },
    ],
    usage: { input_tokens: 120_000, output_tokens: 90 },
  });

  assert.deepEqual(parseJudgeResponse(response), {
    picks: [
      { id: "toolu_1", keep: "", note: "" },
      { id: "sha1:abc", keep: "do the thing", note: "a log" },
    ],
    usage: { inputTokens: 120_000, outputTokens: 90 },
  });
  assert.equal(parseJudgeResponse('{"content":[{"type":"text","text":"sorry, no JSON"}]}'), null);
  assert.equal(parseJudgeResponse("not json at all"), null);
  assert.deepEqual(parseJudgeResponse('{"content":[{"type":"text","text":"{\\"evict\\":[]}"}]}'), {
    picks: [],
    usage: {},
  });
});

/** K=2 here: the toolu_2 result has one assistant turn after it, everything else has three. */
function judgedConversation(): unknown[] {
  return [
    { role: "user", content: [{ type: "text", text: PASTED_TEXT }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "on it" },
        { type: "tool_use", id: "toolu_1", name: "Edit", input: EDIT_INPUT },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: FILE_BODY }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "next" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/b.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "fresh body" }] },
    { role: "assistant", content: [{ type: "text", text: "reading" }] },
  ];
}

const KEEP = "Use tabs, not spaces.";
const PASTED_TEXT = `${KEEP} Here is the dump:\n${"log line\n".repeat(200)}`;
const PASTED_BLOCK_ID = textSegmentId(PASTED_TEXT);
const EDIT_INPUT = { file_path: "/a.ts", old_string: "x".repeat(400), new_string: "y".repeat(400) };
const FILE_BODY = "z".repeat(1000);

test("accepts an aged tool result, its call, and an exactly-quoted user block", () => {
  const verdict = validateJudgePicks(
    [
      { id: "toolu_1", keep: "", note: "" },
      { id: "call:toolu_1", keep: "", note: "" },
      { id: PASTED_BLOCK_ID, keep: KEEP, note: "" },
    ],
    judgedConversation(),
    2,
    0,
  );

  assert.deepEqual(verdict.accepted, [
    { id: "toolu_1", keep: "", note: "", kind: "tool_result" },
    { id: "call:toolu_1", keep: "", note: "", kind: "tool_use" },
    { id: PASTED_BLOCK_ID, keep: KEEP, note: "", kind: "user_text" },
  ]);
  assert.deepEqual(verdict.rejected, {
    unknownId: 0,
    protectedWindow: 0,
    tooSmall: 0,
    keepMismatch: 0,
    noKeepOrNote: 0,
    assistantText: 0,
    keepOnNonUserBlock: 0,
  });
});

test("a user block named with neither a quote nor a note survives", () => {
  const verdict = validateJudgePicks([{ id: PASTED_BLOCK_ID, keep: "", note: "" }], judgedConversation(), 2, 0);

  assert.deepEqual(verdict.accepted, [], "an empty verdict is a malfunction, not a decision to delete everything");
  assert.equal(verdict.rejected.noKeepOrNote, 1);
});

test("a note alone is enough to remove a pure paste", () => {
  const verdict = validateJudgePicks(
    [{ id: PASTED_BLOCK_ID, keep: "", note: "stack trace from the failing auth test" }],
    judgedConversation(),
    2,
    0,
  );

  assert.deepEqual(verdict.accepted, [
    { id: PASTED_BLOCK_ID, keep: "", note: "stack trace from the failing auth test", kind: "user_text" },
  ]);
});

test("the newest assistant turn stays off-limits even where the operator set K to zero", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_newest", name: "Read", input: { file_path: "/a.ts" } }],
    },
  ];

  const verdict = validateJudgePicks([{ id: "call:toolu_newest", keep: "", note: "" }], messages, 0, 0);

  assert.deepEqual(verdict.accepted, [], "the rules gate their own picks on age; the judge has no second gate");
  assert.equal(verdict.rejected.protectedWindow, 1);
});

test("a pick is refused on what its stub would save, not on how big the block is", () => {
  // A Read call's whole input is the path, and the stub keeps the path — so this 120-char input
  // clears any raw size floor while the stub replacing it would be larger than the input itself.
  const longPath = `/repo/${"nested/".repeat(13)}file.ts`;
  const messages = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: longPath } }],
    },
    { role: "assistant", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "two" }] },
  ];

  const verdict = validateJudgePicks([{ id: "call:toolu_read", keep: "", note: "" }], messages, 2, 50);

  assert.deepEqual(verdict.accepted, [], "accepting it would burn an id the eviction pass then refuses");
  assert.equal(verdict.rejected.tooSmall, 1);
});

test("the estimate counts what the stub saves, not what the block holds", () => {
  // FILE_BODY is 1,000 chars and stubs to `[onepass: evicted 1,000 chars]`, which is 30. 970 goes.
  const verdict = validateJudgePicks([{ id: "toolu_1", keep: "", note: "" }], judgedConversation(), 2, 50);

  assert.equal(verdict.charsRemovedEstimate, 970);
});

test("each remaining guard drops its entry and counts it", () => {
  const verdict = validateJudgePicks(
    [
      { id: "toolu_nonexistent", keep: "", note: "" },
      { id: PASTED_BLOCK_ID, keep: "Use tabs not spaces.", note: "" },
      { id: "toolu_1", keep: "some quote", note: "" },
      { id: "call:toolu_1", keep: "", note: "a description" },
      { id: textSegmentId("done"), keep: "", note: "" },
    ],
    judgedConversation(),
    2,
    0,
  );

  assert.deepEqual(verdict.accepted, []);
  assert.deepEqual(verdict.rejected, {
    unknownId: 1,
    protectedWindow: 0,
    tooSmall: 0,
    keepMismatch: 1,
    noKeepOrNote: 0,
    assistantText: 1,
    keepOnNonUserBlock: 2,
  });
});
