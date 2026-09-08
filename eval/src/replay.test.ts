// Replay, driven the way a run drives it: a real build of the proxy, a child per case, and the
// fake upstream behind it. Nothing here reaches inside the proxy — what replay reports has to be
// readable off the body the upstream received and the log the child wrote, because that is all a
// scored run will have either.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanningCase } from "./cases.js";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";
import { buildProxyUnderTest, type ProxyBuild } from "./proxy.js";
import { diffReplays, replayCases, STUB_PREFIX, type ReplayOutcome } from "./replay.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let build: ProxyBuild;
let upstream: FakeUpstream;

before(async () => {
  build = await buildProxyUnderTest(repoRoot);
  upstream = await startFakeUpstream();
});

after(async () => {
  await upstream.close();
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "onepass-replay-"));
}

/**
 * A case shaped like a deep planning turn: one large tool result, then enough assistant turns after
 * it that the proxy's age gate has let go of it, and a typed turn at the end.
 */
function deepCase(id: string, resultChars: number): PlanningCase {
  const messages: PlanningCase["messages"] = [
    { role: "user", content: [{ type: "text", text: "read the file" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x".repeat(resultChars) }] },
  ];
  for (let turn = 0; turn < 10; turn += 1) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `thinking about it, ${turn}` }] });
    messages.push({ role: "user", content: [{ type: "text", text: `carry on, ${turn}` }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: "so what do you make of it?" }] });

  return {
    id,
    turnIndex: 42,
    typedIndex: 7,
    uuid: `uuid-${id}`,
    timestamp: "2026-08-11T00:00:00.000Z",
    text: "so what do you make of it?",
    stretchIndex: 0,
    opensWithCompactionSummary: false,
    messageTokens: Math.ceil(resultChars / 4),
    prefixTokens: Math.ceil(resultChars / 4) + 54_000,
    answer: "tools",
    messages,
  };
}

test("a case over the threshold trips the build and comes back stubbed", async () => {
  const runDir = scratch();
  const listed: string[] = [];

  const [outcome] = (await replayCases({
    build,
    cases: [deepCase("turn-42", 600_000)],
    upstream,
    runDir,
    onCase: (one, position, total) => listed.push(`${position + 1}/${total} ${one.id} ${one.prefixTokens}`),
  })) as [ReplayOutcome];

  assert.deepEqual(listed, ["1/1 turn-42 204000"], "each case is printed as it goes");
  assert.equal(outcome.tripped, true);
  // One evictable segment in the case, so one stub — and the stub itself is what the model would
  // read in its place, so it is pinned rather than matched on its opening.
  assert.equal(outcome.segmentsEvicted, 1, `evicted ${outcome.segmentsEvicted}: ${JSON.stringify(outcome)}`);
  assert.deepEqual(outcome.stubExamples, ["[onepass: evicted 600,000 chars]"]);
  assert.ok(
    outcome.forwardedBytes < outcome.sentBytes / 2,
    `forwarded ${outcome.forwardedBytes} of ${outcome.sentBytes}`,
  );
  assert.equal(existsSync(outcome.bodyPath), true, "the forwarded body is kept in the corpus");
  assert.ok(readFileSync(outcome.bodyPath, "utf8").includes(STUB_PREFIX));
});

test("the digest is taken over the stub text, so a rewording is a change the diff can see", async () => {
  // A deep case writes dozens of stubs and the result document keeps three, so the digest is the
  // only thing standing for the rest of them. Two cases differing in nothing but what their stub
  // says: a digest over anything other than the text — the number of stubs, say — matches here.
  const outcomes = await replayCases({
    build,
    cases: [deepCase("turn-1", 600_000), deepCase("turn-2", 500_000)],
    upstream,
    runDir: scratch(),
  });

  assert.deepEqual(
    outcomes.map((one) => one.stubExamples),
    [["[onepass: evicted 600,000 chars]"], ["[onepass: evicted 500,000 chars]"]],
    "the same one stub each, saying a different size",
  );
  assert.notEqual(outcomes[0]?.stubDigest, outcomes[1]?.stubDigest);
});

test("a case under the threshold goes through untouched, so both arms would send the same bytes", async () => {
  const [outcome] = (await replayCases({
    build,
    cases: [deepCase("turn-7", 4_000)],
    upstream,
    runDir: scratch(),
  })) as [ReplayOutcome];

  assert.equal(outcome.tripped, false);
  assert.equal(outcome.segmentsEvicted, 0);
  assert.deepEqual(outcome.stubExamples, []);
  assert.equal(outcome.forwardedBytes, outcome.sentBytes);
});

test("each case sees a child of its own, so nothing one case evicted is carried into the next", async () => {
  const outcomes = await replayCases({
    build,
    cases: [deepCase("turn-1", 600_000), deepCase("turn-2", 4_000)],
    upstream,
    runDir: scratch(),
  });

  assert.equal(outcomes[0]?.tripped, true);
  assert.equal(outcomes[1]?.tripped, false, "a fresh child has evicted nothing yet");
  assert.equal(outcomes[1]?.segmentsEvicted, 0);
});

// The diff is pure, so it is checked on made-up outcomes rather than by building the proxy twice.

function outcome(overrides: Partial<ReplayOutcome> & { caseId: string }): ReplayOutcome {
  return {
    turnIndex: 42,
    prefixTokens: 200_000,
    answer: "tools",
    sentBytes: 1_000,
    forwardedBytes: 500,
    tripped: true,
    segmentsEvicted: 1,
    stubDigest: "aaaaaaaaaaaa",
    stubExamples: [`${STUB_PREFIX} 600,000 chars]`],
    rebuild: null,
    estimatedTokensBefore: 200_000,
    estimatedTokensSent: 100_000,
    bodyPath: "/tmp/body.json",
    ...overrides,
  };
}

test("the diff names what moved, and counts what did not", () => {
  // turn-3 is the case that evicted nothing last time, so it is where a change in the trip itself
  // and in how the proxy classified the request against the cache can be read.
  const quiet = { tripped: false, segmentsEvicted: 0, stubExamples: [], rebuild: null };
  const previous = [
    outcome({ caseId: "turn-1" }),
    outcome({ caseId: "turn-2" }),
    outcome({ caseId: "turn-3", ...quiet }),
  ];
  const current = [
    outcome({ caseId: "turn-1" }),
    outcome({ caseId: "turn-2", segmentsEvicted: 3, sentBytes: 1_200, forwardedBytes: 300 }),
    outcome({ caseId: "turn-3", ...quiet, tripped: true, rebuild: "prefix changed" }),
  ];

  const diff = diffReplays("abc1234-20260906T101112Z", previous, current);

  assert.equal(diff.unchanged, 1);
  assert.deepEqual(
    diff.changes.map((change) => [change.caseId, change.what, change.previous, change.current]),
    [
      ["turn-2", "segments evicted", "1", "3"],
      ["turn-2", "bytes sent", "1000", "1200"],
      ["turn-2", "bytes forwarded", "500", "300"],
      ["turn-3", "tripped", "false", "true"],
      ["turn-3", "rebuild", "none", "prefix changed"],
    ],
    "both body sizes are diffed: what the case was, and what the proxy made of it",
  );
  assert.equal(diff.totals?.previous.segmentsEvicted, 2);
  assert.equal(diff.totals?.current.segmentsEvicted, 4);
  assert.equal(diff.totals?.previous.trips, 2);
  assert.equal(diff.totals?.current.trips, 3);
  assert.equal(diff.totals?.previous.rebuilds, 0);
  assert.equal(diff.totals?.current.rebuilds, 1);
});

test("a stub whose wording changed is a change, even when the sizes did not move", () => {
  const previous = [outcome({ caseId: "turn-1" })];
  const current = [
    outcome({
      caseId: "turn-1",
      stubDigest: "bbbbbbbbbbbb",
      stubExamples: ["[onepass: evicted a tool result of 600000 chars]"],
    }),
  ];

  const diff = diffReplays("abc1234", previous, current);

  assert.deepEqual(
    diff.changes.map((change) => change.what),
    ["stub text"],
  );
  assert.match(diff.changes[0]?.current ?? "", /a tool result of 600000 chars/);
});

// Drift in one direction only, in each direction, as well as both at once. A fixture that only
// ever drifted both ways would hold just as well if the rule asked for a case missing from the
// current list *and* one missing from the previous — and then a list that had merely grown, or
// merely shrunk, would be diffed as though the two builds covered the same turns.
for (const { what, previousIds, currentIds, gone, added } of [
  { what: "shrank", previousIds: ["turn-1", "turn-2"], currentIds: ["turn-1"], gone: ["turn-2"], added: [] },
  { what: "grew", previousIds: ["turn-1"], currentIds: ["turn-1", "turn-9"], gone: [], added: ["turn-9"] },
  {
    what: "swapped a case",
    previousIds: ["turn-1", "turn-2"],
    currentIds: ["turn-1", "turn-9"],
    gone: ["turn-2"],
    added: ["turn-9"],
  },
]) {
  test(`a case list that ${what} refuses the comparison rather than diffing what the two share`, () => {
    // turn-1 is in both lists and *moved* between them, so a rule that diffed the overlap would
    // have a change to report. Nothing is reported at all.
    const previous = previousIds.map((caseId) => outcome({ caseId, segmentsEvicted: 9 }));
    const current = currentIds.map((caseId) => outcome({ caseId }));

    const diff = diffReplays("abc1234", previous, current);

    assert.deepEqual(diff.onlyInPrevious, gone);
    assert.deepEqual(diff.onlyInCurrent, added);
    assert.deepEqual(diff.changes, []);
    assert.equal(diff.unchanged, 0);
    assert.equal(diff.totals, null, "totals over two different sets of turns are not a comparison");
  });
}

test("with no previous build to compare against, the diff says so rather than inventing one", () => {
  const diff = diffReplays(null, null, [outcome({ caseId: "turn-1" })]);

  assert.equal(diff.comparedWith, null);
  assert.equal(diff.totals, null);
  assert.deepEqual(diff.changes, []);
  // Having nothing to compare with is not the same state as a case list that drifted, and the two
  // are reported differently. Treating a missing previous run as an empty one would make every
  // case look newly appeared, and the report would say the list drifted when nothing had.
  assert.deepEqual(diff.onlyInPrevious, []);
  assert.deepEqual(diff.onlyInCurrent, []);
  assert.equal(diff.unchanged, 0);
});
