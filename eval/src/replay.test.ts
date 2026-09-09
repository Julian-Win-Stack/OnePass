// Replay, driven the way a run drives it: a real build of the proxy, a recording read off disk, one
// child for the whole sequence, and the fake upstream behind it. Nothing here reaches inside the
// proxy — what replay reports has to be readable off the body the upstream received and the log the
// child wrote, because that is all a scored run will have either.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCorpus } from "./corpus.js";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";
import { buildProxyUnderTest, type ProxyBuild } from "./proxy.js";
import { importRecordings, type RecordingSet } from "./recordings.js";
import { diffReplays, replayRecordings, STUB_PREFIX, type ReplayOutcome } from "./replay.js";

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

function scratch(prefix = "onepass-replay-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * A request body shaped like a deep session turn: one large tool result, then enough assistant
 * turns after it that the proxy's age gate has let go of it, and a typed turn at the end.
 */
function deepBody(resultChars: number, turnsAfter = 10): string {
  const messages: unknown[] = [
    { role: "user", content: [{ type: "text", text: "read the file" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x".repeat(resultChars) }] },
  ];
  for (let turn = 0; turn < turnsAfter; turn += 1) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `thinking about it, ${turn}` }] });
    messages.push({ role: "user", content: [{ type: "text", text: `carry on, ${turn}` }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: "so what do you make of it?" }] });
  return JSON.stringify({ model: "claude-opus-5", max_tokens: 1_024, messages });
}

/** A recording of the given bodies, filed into a corpus of its own, in the order they are listed. */
function recordingOf(bodies: readonly { chars: number; count?: boolean; turnsAfter?: number }[]): RecordingSet {
  const dumpDir = scratch("onepass-dump-");
  for (const [index, body] of bodies.entries()) {
    const stamp = `2026-09-08T23-23-${String(index).padStart(2, "0")}-000Z`;
    const suffix = body.count === true ? "_v1_messages_count_tokens.json" : "_v1_messages.json";
    const sequence = String(index + 1).padStart(6, "0");
    writeFileSync(join(dumpDir, `${stamp}_${sequence}${suffix}`), deepBody(body.chars, body.turnsAfter), "utf8");
  }
  const corpus = resolveCorpus({ ONEPASS_EVAL_CORPUS: scratch("onepass-corpus-") }, scratch("onepass-repo-"));
  return importRecordings(corpus, dumpDir);
}

/** Everything replay is given except the recording, which each test names. */
function options(recordings: RecordingSet, reported: readonly string[]) {
  return { build, recordings, upstream, runDir: scratch(), reported: new Set(reported) };
}

test("a request over the threshold trips the build and comes back stubbed", async () => {
  const recordings = recordingOf([{ chars: 600_000 }]);
  const listed: string[] = [];

  const [outcome] = (await replayRecordings({
    ...options(recordings, ["req-0001"]),
    onRequest: (one, position, total) => listed.push(`${position}/${total} ${one.id}`),
  })) as [ReplayOutcome];

  assert.deepEqual(listed, ["1/1 req-0001"], "each request is offered to the caller as it goes");
  assert.equal(outcome.overThreshold, true);
  assert.equal(outcome.newlyEvicted, 1);
  // One evictable block in the request, so one stub — and the stub itself is what the model would
  // read in its place, so it is pinned rather than matched on its opening.
  assert.equal(outcome.stubbed, 1, `stubbed ${outcome.stubbed}: ${JSON.stringify(outcome)}`);
  assert.deepEqual(outcome.stubExamples, ["[onepass: evicted 600,000 chars]"]);
  assert.ok(
    outcome.forwardedBytes < outcome.recordedBytes / 2,
    `forwarded ${outcome.forwardedBytes} of ${outcome.recordedBytes}`,
  );
  assert.ok(outcome.bodyPath !== null, "a reported request keeps its forwarded body in the corpus");
  assert.equal(existsSync(outcome.bodyPath), true);
  assert.ok(readFileSync(outcome.bodyPath, "utf8").includes(STUB_PREFIX));
});

test("the whole sequence goes through one child, so what one request evicted is carried into the next", async () => {
  // The second request is the same conversation one turn on, which is what Claude Code really
  // sends: the original tool result again, in full. A fresh child would take it as new and evict it
  // afresh; the one child re-stubs a block it has already taken, and takes nothing new.
  const outcomes = await replayRecordings(options(recordingOf([{ chars: 600_000 }, { chars: 600_000 }]), []));

  assert.deepEqual(
    outcomes.map((one) => [one.newlyEvicted, one.stubbed]),
    [
      [1, 1],
      [0, 1],
    ],
  );
  // The second request is under the line by the time the proxy looks at it, because the stub it
  // already holds is what brings it there. That is eviction working, and it only reads that way
  // because the child carried its state across.
  assert.deepEqual(
    outcomes.map((one) => one.overThreshold),
    [true, false],
  );
});

test("a request over the line whose content is too young to take says so, rather than looking quiet", async () => {
  // The big block has two assistant turns after it. The age gate needs eight, and even the pressure
  // pass — which relaxes it — stops at four, so there is nothing this request is allowed to take.
  // Counting the proxy's trip log entries reads this as a small quiet request, which is the
  // opposite of what happened: it is the one shape most worth catching.
  const [outcome] = (await replayRecordings(
    options(recordingOf([{ chars: 600_000, turnsAfter: 2 }]), []),
  )) as [ReplayOutcome];

  assert.equal(outcome.overThreshold, true);
  assert.equal(outcome.newlyEvicted, 0);
  assert.equal(outcome.stubbed, 0);
  assert.equal(outcome.forwardedBytes, outcome.recordedBytes, "nothing was taken, so nothing changed");
});

test("a request under the threshold goes through untouched", async () => {
  const [outcome] = (await replayRecordings(options(recordingOf([{ chars: 4_000 }]), []))) as [ReplayOutcome];

  assert.equal(outcome.overThreshold, false);
  assert.equal(outcome.stubbed, 0);
  assert.deepEqual(outcome.stubExamples, []);
  assert.equal(outcome.forwardedBytes, outcome.recordedBytes);
});

test("count-tokens requests are replayed too, because the proxy evicts them the same way", async () => {
  const outcomes = await replayRecordings(
    options(recordingOf([{ chars: 600_000, count: true }, { chars: 600_000 }]), []),
  );

  assert.deepEqual(
    outcomes.map((one) => one.path),
    ["/v1/messages/count_tokens", "/v1/messages"],
  );
  // The count request took the block, so the messages request behind it re-sends a stub rather than
  // the original — which is the point: a count that described a request nobody will send is a lie
  // to the client's own bookkeeping.
  assert.deepEqual(
    outcomes.map((one) => [one.newlyEvicted, one.stubbed]),
    [
      [1, 1],
      [0, 1],
    ],
  );
});

test("only the reported requests keep a forwarded body; a whole session's worth would be gigabytes", async () => {
  const outcomes = await replayRecordings(options(recordingOf([{ chars: 600_000 }, { chars: 4_000 }]), ["req-0002"]));

  assert.equal(outcomes[0]?.bodyPath, null);
  assert.ok(outcomes[1]?.bodyPath !== null && existsSync(outcomes[1].bodyPath));
});

// The diff is pure, so it is checked on made-up outcomes rather than by building the proxy twice.

function outcome(overrides: Partial<ReplayOutcome> & { id: string }): ReplayOutcome {
  return {
    position: 1,
    path: "/v1/messages",
    recordedBytes: 1_000,
    forwardedBytes: 500,
    overThreshold: true,
    newlyEvicted: 1,
    stubbed: 1,
    stubDigest: "aaaaaaaaaaaa",
    stubExamples: [`${STUB_PREFIX} 600,000 chars]`],
    estimatedTokensBefore: 200_000,
    estimatedTokensSent: 100_000,
    bodyPath: "/tmp/body.json",
    ...overrides,
  };
}

test("the diff names what moved, and counts what did not", () => {
  // req-0003 is the request that evicted nothing last time, so it is where a change in the
  // threshold decision itself can be read.
  const quiet = { overThreshold: false, newlyEvicted: 0, stubbed: 0, stubExamples: [] };
  const previous = [outcome({ id: "req-0001" }), outcome({ id: "req-0002" }), outcome({ id: "req-0003", ...quiet })];
  const current = [
    outcome({ id: "req-0001" }),
    outcome({ id: "req-0002", stubbed: 3, newlyEvicted: 2, forwardedBytes: 300 }),
    outcome({ id: "req-0003", ...quiet, overThreshold: true }),
  ];

  const diff = diffReplays("abc1234-20260906T101112Z", previous, current);

  assert.equal(diff.unchanged, 1);
  assert.deepEqual(
    diff.changes.map((change) => [change.id, change.what, change.previous, change.current]),
    [
      ["req-0002", "newly evicted", "1", "2"],
      ["req-0002", "stubbed", "1", "3"],
      ["req-0002", "bytes forwarded", "500", "300"],
      ["req-0003", "over threshold", "false", "true"],
    ],
  );
  assert.equal(diff.totals?.previous.stubbed, 2);
  assert.equal(diff.totals?.current.stubbed, 4);
  assert.equal(diff.totals?.previous.overThreshold, 2);
  assert.equal(diff.totals?.current.overThreshold, 3);
  // The one over the line that took nothing: the count a reader is meant to look at first.
  assert.equal(diff.totals?.previous.overThresholdNothingEvicted, 0);
  assert.equal(diff.totals?.current.overThresholdNothingEvicted, 1);
});

test("the recorded size is not diffed: it is a file on disk and can never move between builds", () => {
  // A build cannot change what it was handed, so counting it as agreement would pad the tally with
  // something that could not have disagreed. It stays on the outcome to say how deep the request was.
  const diff = diffReplays("abc1234", [outcome({ id: "req-0001" })], [outcome({ id: "req-0001", recordedBytes: 9_999 })]);

  assert.deepEqual(diff.changes, []);
  assert.equal(diff.unchanged, 1);
});

test("a stub whose wording changed is a change, even when the sizes did not move", () => {
  const previous = [outcome({ id: "req-0001" })];
  const current = [
    outcome({
      id: "req-0001",
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
// ever drifted both ways would hold just as well if the rule asked for a request missing from the
// current sequence *and* one missing from the previous — and then a sequence that had merely grown,
// or merely shrunk, would be diffed as though the two builds sent the same requests.
for (const { what, previousIds, currentIds, gone, added } of [
  { what: "shrank", previousIds: ["req-0001", "req-0002"], currentIds: ["req-0001"], gone: ["req-0002"], added: [] },
  { what: "grew", previousIds: ["req-0001"], currentIds: ["req-0001", "req-0009"], gone: [], added: ["req-0009"] },
  {
    what: "swapped a request",
    previousIds: ["req-0001", "req-0002"],
    currentIds: ["req-0001", "req-0009"],
    gone: ["req-0002"],
    added: ["req-0009"],
  },
]) {
  test(`a recording that ${what} refuses the comparison rather than diffing what the two share`, () => {
    // req-0001 is in both sequences and *moved* between them, so a rule that diffed the overlap
    // would have a change to report. Nothing is reported at all.
    const previous = previousIds.map((id) => outcome({ id, stubbed: 9 }));
    const current = currentIds.map((id) => outcome({ id }));

    const diff = diffReplays("abc1234", previous, current);

    assert.deepEqual(diff.onlyInPrevious, gone);
    assert.deepEqual(diff.onlyInCurrent, added);
    assert.deepEqual(diff.changes, []);
    assert.equal(diff.unchanged, 0);
    assert.equal(diff.totals, null, "totals over two different sequences are not a comparison");
  });
}

test("with no previous build to compare against, the diff says so rather than inventing one", () => {
  const diff = diffReplays(null, null, [outcome({ id: "req-0001" })]);

  assert.equal(diff.comparedWith, null);
  assert.equal(diff.totals, null);
  assert.deepEqual(diff.changes, []);
  // Having nothing to compare with is not the same state as a recording that drifted, and the two
  // are reported differently. Treating a missing previous run as an empty one would make every
  // request look newly appeared, and the report would say the recording drifted when nothing had.
  assert.deepEqual(diff.onlyInPrevious, []);
  assert.deepEqual(diff.onlyInCurrent, []);
  assert.equal(diff.unchanged, 0);
});

test("a previous document that names none of its requests is counted, not printed as blanks", () => {
  // Result documents are read off disk, so an old one arrives with whatever shape it was written
  // with. The documents written before replay read recordings named their outcomes by case, so
  // `id` reads back as nothing at all — and the drift message printed a row of empty names.
  const current = [outcome({ id: "req-0001" }), outcome({ id: "req-0002" })];
  const previous = current.map((one) => {
    const { id: _unnamed, ...rest } = one;
    return rest as ReplayOutcome;
  });

  const diff = diffReplays("older-run", previous, current);

  assert.equal(diff.unnamedInPrevious, 2);
  assert.deepEqual(diff.onlyInPrevious, [], "an outcome with no name cannot be named as missing");
  assert.deepEqual(diff.onlyInCurrent, ["req-0001", "req-0002"]);
  assert.equal(diff.totals, null, "the comparison is refused, as it is for any other drift");
});
