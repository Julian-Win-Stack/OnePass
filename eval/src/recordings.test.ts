import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCorpus, type Corpus } from "./corpus.js";
import { EvalError } from "./errors.js";
import {
  bodyOf,
  conversationRequests,
  deepest,
  importRecordings,
  readRecordings,
  RECORDINGS_SCHEMA,
} from "./recordings.js";

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function corpusFor(): Corpus {
  return resolveCorpus({ ONEPASS_EVAL_CORPUS: scratch("onepass-corpus-") }, scratch("onepass-repo-"));
}

/**
 * A dump directory the way the proxy leaves one: a name per body, the name being the clock and then
 * the count the proxy wrote it in. The count is written here too, rather than left to a helper, so
 * that a fixture cannot drift from the shape the proxy actually produces.
 */
function dumpDir(
  bodies: readonly { stamp: string; sequence?: number; path?: "messages" | "count"; chars: number }[],
): string {
  const dir = scratch("onepass-dump-");
  for (const [index, body] of bodies.entries()) {
    const suffix = body.path === "count" ? "_v1_messages_count_tokens.json" : "_v1_messages.json";
    const sequence = String(body.sequence ?? index + 1).padStart(6, "0");
    writeFileSync(join(dir, `${body.stamp}_${sequence}${suffix}`), "x".repeat(body.chars), "utf8");
  }
  return dir;
}

test("the recorded requests come back in the order the session sent them", () => {
  // Written out of order on purpose: the sequence is the whole point, and `readdir` promises
  // nothing about the order it hands names back in.
  const dir = dumpDir([
    { stamp: "2026-09-08T23-23-53-000Z", sequence: 3, chars: 30 },
    { stamp: "2026-09-08T23-23-51-000Z", sequence: 1, chars: 10 },
    { stamp: "2026-09-08T23-23-52-000Z", sequence: 2, path: "count", chars: 20 },
  ]);
  const set = importRecordings(corpusFor(), dir);

  assert.deepEqual(
    set.requests.map((request) => [request.id, request.path, request.bytes]),
    [
      ["req-0001", "/v1/messages", 10],
      ["req-0002", "/v1/messages/count_tokens", 20],
      ["req-0003", "/v1/messages", 30],
    ],
  );
  assert.equal(set.requests[0]?.receivedAt, "2026-09-08T23:23:51.000Z");
});

test("a body is handed back byte for byte, because replay sends it unchanged", () => {
  const dir = scratch("onepass-dump-");
  const body = JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hello" }] });
  writeFileSync(join(dir, "2026-09-08T23-23-51-000Z_000001_v1_messages.json"), body, "utf8");

  const set = importRecordings(corpusFor(), dir);
  assert.equal(bodyOf(set, set.requests[0]!), body);
});

test("the import records how much was recorded and of what kind", () => {
  const dir = dumpDir([
    { stamp: "2026-09-08T23-23-51-000Z", chars: 10 },
    { stamp: "2026-09-08T23-23-52-000Z", path: "count", chars: 20 },
    { stamp: "2026-09-08T23-23-53-000Z", chars: 30 },
  ]);
  const set = importRecordings(corpusFor(), dir, { name: "planning" });

  const manifest = JSON.parse(readFileSync(set.manifestPath, "utf8")) as {
    schema: string;
    counts: { requests: number; messages: number; countTokens: number };
    bytes: { total: number; largest: number; smallest: number };
  };
  assert.equal(manifest.schema, RECORDINGS_SCHEMA);
  assert.deepEqual(manifest.counts, { requests: 3, messages: 2, countTokens: 1 });
  assert.deepEqual(manifest.bytes, { total: 60, largest: 30, smallest: 10 });
});

test("a recording is read back from the corpus by the name it was filed under", () => {
  const corpus = corpusFor();
  importRecordings(corpus, dumpDir([{ stamp: "2026-09-08T23-23-51-000Z", chars: 10 }]), { name: "planning" });

  const set = readRecordings(corpus, "planning");
  assert.equal(set.requests.length, 1);
  assert.throws(() => readRecordings(corpus, "nothing-here"), EvalError);
});

test("a dump directory already inside the corpus is adopted rather than copied", () => {
  const corpus = corpusFor();
  const inside = join(corpus.recordings, "planning");
  mkdirSync(inside, { recursive: true });
  writeFileSync(join(inside, "2026-09-08T23-23-51-000Z_000001_v1_messages.json"), "{}", "utf8");

  // Copying it would refuse — the destination already holds bodies — so this passing is the check
  // that the recording script can point the proxy straight at the corpus.
  const set = importRecordings(corpus, inside, { name: "planning" });
  assert.equal(set.requests.length, 1);
  assert.equal(set.dir, inside);
});

test("importing a second session over a filed one is refused rather than interleaved", () => {
  const corpus = corpusFor();
  importRecordings(corpus, dumpDir([{ stamp: "2026-09-08T23-23-51-000Z", chars: 10 }]), { name: "planning" });
  assert.throws(
    () => importRecordings(corpus, dumpDir([{ stamp: "2026-09-08T23-23-52-000Z", chars: 10 }]), { name: "planning" }),
    EvalError,
  );
});

test("an empty dump directory is refused, and says what was missing", () => {
  assert.throws(
    () => importRecordings(corpusFor(), scratch("onepass-dump-")),
    (err: unknown) => err instanceof EvalError && err.message.includes("ONEPASS_DUMP_DIR"),
  );
});

test("the deepest requests are chosen by size and reported in sequence order", () => {
  const set = importRecordings(
    corpusFor(),
    dumpDir([
      { stamp: "2026-09-08T23-23-51-000Z", chars: 50 },
      { stamp: "2026-09-08T23-23-52-000Z", chars: 10 },
      { stamp: "2026-09-08T23-23-53-000Z", chars: 90 },
      { stamp: "2026-09-08T23-23-54-000Z", chars: 20 },
    ]),
  );

  assert.deepEqual(
    deepest(set.requests, 2).map((request) => request.id),
    ["req-0001", "req-0003"],
  );
  assert.equal(conversationRequests(set.requests).length, 4);
});

test("two requests inside one millisecond keep the order they arrived in", () => {
  // The clock is not fine enough on its own: a busy session puts several requests into the same
  // millisecond, and replay feeds them through one child in name order. Read the wrong way round,
  // the proxy is handed a state history the session never had, and — because eviction is monotonic
  // — every request after the pair inherits it. So the name carries the count as well as the clock.
  const dir = dumpDir([
    { stamp: "2026-09-08T23-23-51-000Z", sequence: 1, chars: 10 },
    { stamp: "2026-09-08T23-23-51-000Z", sequence: 2, path: "count", chars: 20 },
    { stamp: "2026-09-08T23-23-51-000Z", sequence: 3, chars: 30 },
  ]);
  const set = importRecordings(corpusFor(), dir);

  assert.deepEqual(
    set.requests.map((request) => [request.id, request.bytes]),
    [
      ["req-0001", 10],
      ["req-0002", 20],
      ["req-0003", 30],
    ],
  );
  // The count is not part of the timestamp, which is a label a person reads.
  assert.deepEqual(new Set(set.requests.map((request) => request.receivedAt)), new Set(["2026-09-08T23:23:51.000Z"]));
});

/** A proxy log the way the recording proxy wrote one: a probe, then one entry per request, in order. */
function proxyLog(entries: readonly { path: "messages" | "count"; sent: number; tokens?: number }[]): string {
  const lines = [{ kind: "request", method: "HEAD", path: "/api/hello", status: 200 }];
  for (const entry of entries) {
    lines.push({
      kind: "request",
      method: "POST",
      path: entry.path === "count" ? "/v1/messages/count_tokens?beta=true" : "/v1/messages?beta=true",
      status: 200,
      sentBodyBytes: entry.sent,
      // Split the way the API splits a cached turn, so the total is what has to be read back.
      ...(entry.tokens === undefined
        ? {}
        : { inputTokens: 2, cacheCreationInputTokens: 8, cacheReadInputTokens: entry.tokens - 10 }),
    } as never);
  }
  const path = join(scratch("onepass-log-"), "proxy.log.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return path;
}

test("with the recording proxy's log, each request carries the chars per token the real API reported", () => {
  const dir = dumpDir([
    { stamp: "2026-09-08T23-23-51-000Z", chars: 10 },
    { stamp: "2026-09-08T23-23-52-000Z", path: "count", chars: 20 },
    { stamp: "2026-09-08T23-23-53-000Z", chars: 30 },
  ]);
  const log = proxyLog([
    { path: "messages", sent: 25_000, tokens: 10_000 },
    // The API's count-tokens answer is not logged, so there is nothing to read for it.
    { path: "count", sent: 20 },
    { path: "messages", sent: 16_000, tokens: 5_000 },
  ]);
  const corpus = corpusFor();

  const set = importRecordings(corpus, dir, { proxyLog: log });

  assert.deepEqual(
    set.requests.map((request) => request.realCharsPerToken),
    [2.5, null, 3.2],
  );
  assert.deepEqual(
    readRecordings(corpus, set.name).requests.map((request) => request.realCharsPerToken),
    [2.5, null, 3.2],
    "the ratios are filed with the recording, not read from a log outside the corpus",
  );
});

test("without a log, no request claims a ratio", () => {
  const set = importRecordings(corpusFor(), dumpDir([{ stamp: "2026-09-08T23-23-51-000Z", chars: 10 }]));
  assert.deepEqual(
    set.requests.map((request) => request.realCharsPerToken),
    [null],
  );
});

test("a log that does not line up with the bodies is refused, rather than pairing ratios with the wrong requests", () => {
  const dir = dumpDir([
    { stamp: "2026-09-08T23-23-51-000Z", chars: 10 },
    { stamp: "2026-09-08T23-23-52-000Z", chars: 30 },
  ]);
  assert.throws(
    () => importRecordings(corpusFor(), dir, { proxyLog: proxyLog([{ path: "messages", sent: 10, tokens: 1_000 }]) }),
    (err: unknown) => err instanceof EvalError && /1 request/.test(err.message) && /2 recorded/.test(err.message),
  );
  assert.throws(
    () =>
      importRecordings(corpusFor(), dir, {
        proxyLog: proxyLog([
          { path: "messages", sent: 10, tokens: 1_000 },
          { path: "count", sent: 30 },
        ]),
      }),
    (err: unknown) => err instanceof EvalError && /req-0002/.test(err.message),
  );
});
