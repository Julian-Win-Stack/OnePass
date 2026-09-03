// Unit tests for the speed gauge: reading `usage` off a response, and the rule that decides
// whether a request made Anthropic re-read the conversation instead of serving it from cache.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRebuild, extractUsage, type RebuildInput, type ResponseUsage } from "./speed.js";

const usageCases: { scenario: string; responseText: string; expected: ResponseUsage | null }[] = [
  {
    scenario: "reads the counts past usage's nested cache_creation object",
    responseText:
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{' +
      '"input_tokens":12,' +
      '"cache_creation":{"ephemeral_5m_input_tokens":2000,"ephemeral_1h_input_tokens":100},' +
      '"cache_creation_input_tokens":2100,"cache_read_input_tokens":141200,"output_tokens":9}}}\n\n',
    expected: { inputTokens: 12, cacheCreationInputTokens: 2100, cacheReadInputTokens: 141200 },
  },
  {
    scenario: "reads a top-level JSON body",
    responseText: JSON.stringify({
      id: "msg_2",
      usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
    }),
    expected: { inputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 900 },
  },
  {
    scenario: "returns null for a response that carries no usage",
    responseText: '{"type":"error","error":{"type":"overloaded_error"}}',
    expected: null,
  },
  {
    scenario: "returns null for an empty usage object, which is not a measurement",
    responseText: '{"usage":{}}',
    expected: null,
  },
];

for (const { scenario, responseText, expected } of usageCases) {
  test(`extractUsage ${scenario}`, () => {
    assert.deepEqual(extractUsage(responseText), expected);
  });
}

/** A request Anthropic processed fresh: almost none of it came from cache. */
function rebuiltRequest(overrides: Partial<RebuildInput> = {}): RebuildInput {
  return {
    firstMessagesRequest: false,
    tripped: false,
    secondsSincePrevious: 30,
    cacheCreationInputTokens: 143_000,
    contextTotal: 145_000,
    ...overrides,
  };
}

test("classifyRebuild names the three causes that explain a rebuild", () => {
  assert.equal(classifyRebuild(rebuiltRequest({ firstMessagesRequest: true, secondsSincePrevious: null })), "first");
  assert.equal(classifyRebuild(rebuiltRequest({ tripped: true })), "after-trip");
  assert.equal(classifyRebuild(rebuiltRequest({ secondsSincePrevious: 301 })), "after-idle");
});

test("classifyRebuild flags a rebuild nothing explains", () => {
  assert.equal(classifyRebuild(rebuiltRequest()), "unexpected");
});

test("classifyRebuild reports no rebuild when the context came from cache", () => {
  // A normal turn always writes a little fresh cache — the new user message and tool results.
  assert.equal(classifyRebuild(rebuiltRequest({ cacheCreationInputTokens: 2_100 })), null);
  assert.equal(
    classifyRebuild(rebuiltRequest({ tripped: true, cacheCreationInputTokens: 2_100 })),
    null,
    "a trip whose cache survived is not a rebuild",
  );
});

test("classifyRebuild stays silent when there are no usage numbers to judge", () => {
  // Without the guard the share is 0/0 = NaN, which falls through and shouts "unexpected".
  assert.equal(classifyRebuild(rebuiltRequest({ cacheCreationInputTokens: 0, contextTotal: 0 })), null);
});
