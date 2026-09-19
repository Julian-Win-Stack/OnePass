// End-to-end checks against a recorded stub upstream: a local HTTP server that captures
// exactly what the proxy forwarded. This is the "recorded-stub" verification from the build
// plan; the real-API-key check is a documented local step in README.md.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createProxyServer, DEFAULT_TRIP_TOKENS } from "./server.js";
import { STUB_LEGEND } from "./evict.js";
import type { ProxyLogEntry, RequestLogEntry, ThresholdLogEntry } from "./log.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const recorded: RecordedRequest[] = [];
let openSseGate: () => void = () => {};
let sseGate: Promise<void> = Promise.resolve();

const STREAMED_USAGE = { input_tokens: 7, cache_creation_input_tokens: 11, cache_read_input_tokens: 400 };

/**
 * The stub reports usage at 2 chars per token so calibration is observable — or at whatever
 * ratio the request's `x-test-chars-per-token` header names, so one test can send the proxy a
 * side request at a different rate than the conversation. Split across the three fields the
 * speed gauge reads. Cache creation stays a small share, so a plain request is not classified
 * as a rebuild.
 */
function stubUsage(requestBytes: number, charsPerToken = 2): Record<string, number> {
  const total = Math.round(requestBytes / charsPerToken);
  const cacheRead = Math.round(total * 0.8);
  const cacheCreation = Math.round(total * 0.15);
  return {
    input_tokens: total - cacheRead - cacheCreation,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
}

const upstream = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    recorded.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
    if (request.url === "/v1/messages" && body.toString("utf8").includes('"stream":true')) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      // Under the calibration minimum on purpose: the streaming path is here to prove usage is
      // read out of message_start, not to move the chars-per-token ratio.
      response.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { usage: STREAMED_USAGE },
        })}\n\n`,
      );
      void sseGate.then(() => {
        response.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        response.end();
      });
    } else {
      const isMessages = (request.url ?? "").split("?")[0] === "/v1/messages";
      response.writeHead(200, { "content-type": "application/json", "x-upstream": "stub" });
      const ratioHeader = request.headers["x-test-chars-per-token"];
      const ratio = typeof ratioHeader === "string" ? Number(ratioHeader) : 2;
      response.end(
        isMessages
          ? JSON.stringify({ ok: true, echoPath: request.url, usage: stubUsage(body.byteLength, ratio) })
          : JSON.stringify({ ok: true, echoPath: request.url }),
      );
    }
  });
});

let proxy: http.Server;
let proxyOrigin = "";
let upstreamPort = 0;
let logFilePath = "";

function listeningPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

before(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = listeningPort(upstream);
  logFilePath = join(mkdtempSync(join(tmpdir(), "onepass-proxy-test-")), "proxy.log.jsonl");
  proxy = createProxyServer({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    evictAfterAssistantTurns: 2,
    protectLastAssistantTurns: 1,
    minSavedChars: 50,
    tripThresholdTokens: 0,
    batchMinTokens: 0,
    logFilePath,
    quiet: true,
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyOrigin = `http://127.0.0.1:${listeningPort(proxy)}`;
});

after(async () => {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

interface SimpleResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function sendRequest(
  origin: string,
  path: string,
  options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {},
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${origin}${path}`,
      { method: options.method ?? "GET", headers: options.headers, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

function lastRecorded(): RecordedRequest {
  const entry = recorded[recorded.length - 1];
  assert.ok(entry, "the stub upstream recorded no request");
  return entry;
}

function loggedEntries(): ProxyLogEntry[] {
  let text = "";
  try {
    text = readFileSync(logFilePath, "utf8");
  } catch {
    return []; // The writer opens the file lazily, on its first entry.
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ProxyLogEntry);
}

/**
 * The proxy logs through a buffered write stream, so an entry can still be in flight once the
 * response it describes has reached the client. Reading the log once does not fail when that
 * happens: it hands back an earlier test's entry and the assertion then describes the wrong
 * request. So every read waits for the entries it expects, and says plainly when they never came.
 *
 * A mark is what "expects" means here. It is taken before the requests it covers and past the
 * current millisecond, so no entry written earlier can share its timestamp.
 */
async function logMark(): Promise<string> {
  const started = Date.now();
  while (Date.now() === started) await new Promise((resolve) => setTimeout(resolve, 1));
  return new Date().toISOString();
}

async function loggedRequestsSince(path: string, mark: string, count: number): Promise<RequestLogEntry[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const requests = loggedEntries().filter(
      (entry): entry is RequestLogEntry =>
        entry.kind === "request" && entry.path === path && entry.timestamp >= mark,
    );
    if (requests.length >= count) return requests;
    assert.ok(
      Date.now() < deadline,
      `the proxy log holds ${requests.length} ${path} request(s) since ${mark}, expected ${count}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The entry for the one `path` request made since `mark`. */
async function loggedRequestSince(path: string, mark: string): Promise<RequestLogEntry> {
  const requests = await loggedRequestsSince(path, mark, 1);
  const last = requests[requests.length - 1];
  assert.ok(last, `the proxy log has no ${path} request since ${mark}`);
  return last;
}

/** An aged conversation: the big Read result has 2 assistant turns after it (N=2, K=1). */
function agedConversation(): string {
  return JSON.stringify({
    model: "claude-test",
    max_tokens: 1000,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_big", name: "Read", input: { file_path: "/big.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_big", content: "x".repeat(5000) }] },
      { role: "assistant", content: [{ type: "text", text: "looked at it" }] },
      { role: "user", content: "and then?" },
      { role: "assistant", content: [{ type: "text", text: "then this" }] },
      { role: "user", content: "go on" },
    ],
  });
}

test("forwards non-messages requests verbatim and returns the upstream response", async () => {
  const response = await sendRequest(proxyOrigin, "/v1/models?limit=2", {
    headers: { "x-api-key": "sk-test-key", "anthropic-version": "2023-06-01" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-upstream"], "stub");
  assert.deepEqual(JSON.parse(response.body.toString("utf8")), { ok: true, echoPath: "/v1/models?limit=2" });

  const seen = lastRecorded();
  assert.equal(seen.method, "GET");
  assert.equal(seen.url, "/v1/models?limit=2");
  assert.equal(seen.headers["x-api-key"], "sk-test-key");
  assert.equal(seen.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.headers.host, `127.0.0.1:${upstreamPort}`);
});

test("forwards /v1/messages byte-for-byte when nothing is stubbed — no legend on a request without a stub", async () => {
  const body = JSON.stringify({
    model: "claude-test",
    max_tokens: 100,
    system: [{ type: "text", text: "You are a test.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hello" }],
  });
  const response = await sendRequest(proxyOrigin, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test-key" },
    body,
  });
  assert.equal(response.status, 200);
  const seen = lastRecorded();
  assert.equal(seen.body.toString("utf8"), body);
  assert.equal(seen.headers["content-type"], "application/json");
  assert.equal(seen.headers["content-length"], String(Buffer.byteLength(body)));
});

test("stubs old large tool results and keeps them stubbed on later requests", async () => {
  const mark = await logMark();
  await sendRequest(proxyOrigin, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: agedConversation(),
  });
  const firstSeen = JSON.parse(lastRecorded().body.toString("utf8")) as {
    messages: { content: { content?: unknown }[] }[];
  };
  const firstStub = firstSeen.messages[1]?.content[0]?.content;
  assert.ok(typeof firstStub === "string");
  assert.equal(firstStub, "[onepass: evicted 5,000 chars]");

  // Claude Code resends the original conversation every turn; the proxy must re-stub it.
  await sendRequest(proxyOrigin, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: agedConversation(),
  });
  const secondSeen = JSON.parse(lastRecorded().body.toString("utf8")) as {
    messages: { content: { content?: unknown }[] }[];
  };
  assert.equal(secondSeen.messages[1]?.content[0]?.content, firstStub);

  // A trip is logged while the request is being handled and the request entry at its response,
  // and the writer keeps that order, so both trips are on disk once both requests are.
  const requests = await loggedRequestsSince("/v1/messages", mark, 2);
  const trips = loggedEntries().filter((entry) => entry.kind === "trip");
  assert.equal(trips.length, 1, "the second identical request must not log a second trip");
  assert.deepEqual(trips[0]?.addedToolUseIds, ["toolu_big"]);

  // The second request went over the threshold and found nothing new to take. A reader counting
  // `trip` entries reads that as a quiet request under the line, which is the opposite of what
  // happened, so the threshold decision is written on every request entry in its own right.
  assert.deepEqual(
    requests.map((entry) => [entry.overThreshold, entry.newlyEvictedCount]),
    [
      [true, 1],
      [true, 0],
    ],
  );
});

test("count_tokens is evicted identically so counts describe the real request", async () => {
  const body = agedConversation();
  await sendRequest(proxyOrigin, "/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const seen = JSON.parse(lastRecorded().body.toString("utf8")) as {
    messages: { content: { content?: unknown }[] }[];
  };
  const stub = seen.messages[1]?.content[0]?.content;
  assert.equal(stub, "[onepass: evicted 5,000 chars]", `count_tokens body was not evicted: ${String(stub).slice(0, 80)}`);
});

test("calibrates chars-per-token from the API's reported usage", async () => {
  // The first request teaches the ratio: the stub reports input_tokens = bytes ÷ 2.
  const teach = JSON.stringify({
    model: "claude-test",
    max_tokens: 100,
    messages: [{ role: "user", content: "c".repeat(6000) }],
  });
  await sendRequest(proxyOrigin, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: teach,
  });
  const second = JSON.stringify({ model: "claude-test", max_tokens: 100, messages: [{ role: "user", content: "hello again" }] });
  const mark = await logMark();
  await sendRequest(proxyOrigin, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: second,
  });
  const last = await loggedRequestSince("/v1/messages", mark);
  assert.ok(last.charsPerToken !== undefined, "request log entry should record charsPerToken");
  assert.ok(Math.abs(last.charsPerToken - 2) < 0.1, `expected ~2 chars/token, got ${last.charsPerToken}`);
});

test("a side request smaller than half the conversation does not move the ratio the conversation set", async () => {
  // Its own proxy: the shared one has a calibration history of its own by now.
  const ownLog = join(mkdtempSync(join(tmpdir(), "onepass-proxy-test-")), "proxy.log.jsonl");
  const server = createProxyServer({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    evictAfterAssistantTurns: 2,
    protectLastAssistantTurns: 1,
    minSavedChars: 50,
    tripThresholdTokens: 1_000_000,
    batchMinTokens: 0,
    logFilePath: ownLog,
    quiet: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${listeningPort(server)}`;
  const post = (chars: number, charsPerToken: number): Promise<SimpleResponse> =>
    sendRequest(origin, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-chars-per-token": String(charsPerToken) },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "c".repeat(chars) }] }),
    });
  const loggedRatios = async (count: number): Promise<number[]> => {
    const deadline = Date.now() + 2000;
    for (;;) {
      const entries = existsSync(ownLog)
        ? readFileSync(ownLog, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as ProxyLogEntry)
        : [];
      const ratios = entries.flatMap((entry) => (entry.kind === "request" && entry.charsPerToken !== undefined ? [entry.charsPerToken] : []));
      if (ratios.length >= count) return ratios;
      assert.ok(Date.now() < deadline, `logged ${ratios.length} ratios, expected ${count}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    // The conversation: 40,000 chars the stub bills at 2 per token, 20,000 tokens. It teaches 2.
    await post(40_000, 2);
    // A side call of 8,000 chars billed at 4 per token: 2,000 tokens, over the old floor of 1,000
    // and under half of 20,000. Before, this set the ratio to 4 for the conversation's next request.
    await post(8_000, 4);
    // The conversation again: a sample at 2 per token, taken because it is conversation-sized.
    await post(40_000, 2);
    const ratios = await loggedRatios(3);
    const [afterNothing, afterConversation, afterSideCall] = ratios;
    assert.equal(afterNothing, 2.5, "the first request runs at the uncalibrated fallback");
    assert.ok(Math.abs((afterConversation ?? 0) - 2) < 0.05, `the conversation taught ${afterConversation}`);
    assert.ok(Math.abs((afterSideCall ?? 0) - 2) < 0.05, `the side call moved the ratio to ${afterSideCall}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an automatic T is the first conversation request's floor plus the headroom, and holds from then on", async () => {
  const ownLog = join(mkdtempSync(join(tmpdir(), "onepass-proxy-test-")), "proxy.log.jsonl");
  const headroomTokens = 10_000;
  const server = createProxyServer({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    evictAfterAssistantTurns: 2,
    protectLastAssistantTurns: 1,
    minSavedChars: 50,
    tripThresholdTokens: "auto",
    headroomTokens,
    batchMinTokens: 0,
    logFilePath: ownLog,
    quiet: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${listeningPort(server)}`;
  const entriesOf = (): ProxyLogEntry[] =>
    existsSync(ownLog)
      ? readFileSync(ownLog, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as ProxyLogEntry)
      : [];
  const requestEntries = async (count: number): Promise<RequestLogEntry[]> => {
    const deadline = Date.now() + 2000;
    for (;;) {
      const requests = entriesOf().filter((entry): entry is RequestLogEntry => entry.kind === "request");
      if (requests.length >= count) return requests;
      assert.ok(Date.now() < deadline, `logged ${requests.length} requests, expected ${count}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    // A conversation-sized first request: 60,000 chars of typed text eviction may never touch —
    // the floor — and one aged 5,000-char result it could take. The stub bills at 2 per token.
    const conversation = JSON.parse(agedConversation()) as { messages: unknown[] };
    const send = (): Promise<SimpleResponse> =>
      sendRequest(origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...conversation, messages: [{ role: "user", content: "p".repeat(60_000) }, ...conversation.messages] }),
      });
    await send();
    await send();
    const [first, second] = await requestEntries(2);
    const threshold = entriesOf().find((entry): entry is ThresholdLogEntry => entry.kind === "threshold");

    assert.equal(first?.tripThresholdTokens, DEFAULT_TRIP_TOKENS, "until the floor is measured T is the default");
    assert.ok(threshold, "the floor was never measured");
    assert.equal(threshold.headroomTokens, headroomTokens);
    assert.equal(threshold.tripThresholdTokens, threshold.floorTokens + headroomTokens);
    // The floor is what the API reported less the one evictable result, (5,000 − 30) chars at the
    // ratio this very response calibrated (~2): about 2,485 tokens under the measured size.
    const evictable = threshold.measuredTokens - threshold.floorTokens;
    assert.ok(Math.abs(evictable - 2_485) < 60, `floor left ${evictable} tokens for the evictable result`);
    assert.ok(threshold.measuredTokens > 30_000, `measured ${threshold.measuredTokens}: the request was not conversation-sized`);
    assert.equal(second?.tripThresholdTokens, threshold.tripThresholdTokens, "the second request runs at the measured T");
    assert.equal(entriesOf().filter((entry) => entry.kind === "threshold").length, 1, "the floor is read once");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("logs the speed gauge: proxy time, first byte, and the cache numbers from usage", async () => {
  const mark = await logMark();
  const body = JSON.stringify({
    model: "claude-test",
    max_tokens: 100,
    messages: [{ role: "user", content: "how fast was that" }],
  });
  await sendRequest(proxyOrigin, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  const entry = await loggedRequestSince("/v1/messages", mark);
  // The stub's three counts differ in size, so a swapped or dropped field shows up here.
  const reported = stubUsage(lastRecorded().body.byteLength);
  assert.equal(entry.inputTokens, reported.input_tokens);
  assert.equal(entry.cacheCreationInputTokens, reported.cache_creation_input_tokens);
  assert.equal(entry.cacheReadInputTokens, reported.cache_read_input_tokens);
  assert.ok(entry.proxyMs !== undefined && entry.proxyMs >= 0, `proxyMs missing: ${String(entry.proxyMs)}`);
  assert.ok(
    entry.upstreamFirstByteMs !== undefined && entry.upstreamFirstByteMs >= 0,
    `upstreamFirstByteMs missing: ${String(entry.upstreamFirstByteMs)}`,
  );
  assert.ok(
    entry.durationMs >= entry.upstreamFirstByteMs,
    "the total must span the wait for the first byte, not stop at the headers",
  );
  assert.equal(entry.rebuild, undefined, "a request served from cache is not a rebuild");
});

test("forwards malformed /v1/messages bodies unchanged", async () => {
  const body = "this is {not json";
  const response = await sendRequest(proxyOrigin, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(lastRecorded().body.toString("utf8"), body);
});

test("streams SSE responses without buffering, and gauges them from message_start", async () => {
  const mark = await logMark();
  sseGate = new Promise<void>((resolve) => {
    openSseGate = resolve;
  });
  const body = JSON.stringify({
    model: "claude-test",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });

  const received: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("first SSE chunk did not arrive before the upstream finished — the proxy is buffering")),
      3000,
    );
    const request = http.request(
      `${proxyOrigin}/v1/messages`,
      { method: "POST", headers: { "content-type": "application/json" }, agent: false },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          received.push(chunk);
          // Only once the first chunk has arrived at the client may the upstream send the rest.
          if (received.join("").includes("message_start")) openSseGate();
        });
        response.on("end", () => {
          clearTimeout(timeout);
          resolve();
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });

  const fullStream = received.join("");
  assert.ok(fullStream.includes("message_start"));
  assert.ok(fullStream.includes("message_stop"));
  assert.ok(received.length >= 2, "expected the SSE stream to arrive in more than one chunk");

  const entry = await loggedRequestSince("/v1/messages", mark);
  assert.equal(
    entry.cacheReadInputTokens,
    STREAMED_USAGE.cache_read_input_tokens,
    "usage must be read out of the streamed message_start, not only from JSON bodies",
  );
  // The gate held message_stop until the client had the first chunk, so the first byte was
  // timed while the stream was still open — the total spans the rest of it.
  assert.ok(entry.upstreamFirstByteMs !== undefined, "upstreamFirstByteMs missing on the streaming path");
  assert.ok(entry.durationMs >= entry.upstreamFirstByteMs);
});

test("answers 502 with an API-shaped error when the upstream is unreachable", async () => {
  const deadUpstreamProxy = createProxyServer({
    upstreamUrl: "http://127.0.0.1:9",
    evictAfterAssistantTurns: 2,
    protectLastAssistantTurns: 1,
    minSavedChars: 50,
    tripThresholdTokens: 0,
    batchMinTokens: 0,
    logFilePath: join(mkdtempSync(join(tmpdir(), "onepass-proxy-test-")), "proxy.log.jsonl"),
    quiet: true,
  });
  await new Promise<void>((resolve) => deadUpstreamProxy.listen(0, "127.0.0.1", resolve));
  try {
    const response = await sendRequest(`http://127.0.0.1:${listeningPort(deadUpstreamProxy)}`, "/v1/models");
    assert.equal(response.status, 502);
    const parsed = JSON.parse(response.body.toString("utf8")) as { type?: string; error?: { type?: string } };
    assert.equal(parsed.type, "error");
    assert.equal(parsed.error?.type, "api_error");
  } finally {
    await new Promise<void>((resolve) => deadUpstreamProxy.close(() => resolve()));
  }
});

test("a batch held back under the minimum, and a request above the alarm line, both reach the request log line", async () => {
  const ownLog = join(mkdtempSync(join(tmpdir(), "onepass-proxy-test-")), "proxy.log.jsonl");
  const batchingProxy = createProxyServer({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    evictAfterAssistantTurns: 2,
    protectLastAssistantTurns: 1,
    minSavedChars: 50,
    tripThresholdTokens: 0,
    batchMinTokens: 1_000_000,
    logFilePath: ownLog,
    quiet: true,
  });
  await new Promise<void>((resolve) => batchingProxy.listen(0, "127.0.0.1", resolve));
  try {
    // The aged 5,000-char result is the whole batch: (5,000 − 30) chars at the uncalibrated 2.5
    // chars per token is 1,988 tokens, far under the minimum. The 200,000 chars of typed text in
    // front of it are ~80k tokens the rules may never touch, which is over T = 0 plus 40k.
    const conversation = JSON.parse(agedConversation()) as { messages: unknown[] };
    const body = JSON.stringify({
      ...conversation,
      messages: [{ role: "user", content: "p".repeat(200_000) }, ...conversation.messages],
    });
    await sendRequest(`http://127.0.0.1:${listeningPort(batchingProxy)}`, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const deadline = Date.now() + 2000;
    let entries: ProxyLogEntry[] = [];
    while (!entries.some((entry) => entry.kind === "request") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      entries = existsSync(ownLog)
        ? readFileSync(ownLog, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as ProxyLogEntry)
        : [];
    }
    const request = entries.find((entry): entry is RequestLogEntry => entry.kind === "request");
    assert.ok(request, "the proxy logged no request entry");
    assert.equal(request.overThreshold, true);
    assert.equal(request.newlyEvictedCount, 0);
    assert.equal(request.heldBackTokens, 1_988);
    assert.equal(request.aboveAlarmLine, true);
    assert.equal(entries.filter((entry) => entry.kind === "trip").length, 0, "a held-back batch is not a trip");
  } finally {
    await new Promise<void>((resolve) => batchingProxy.close(() => resolve()));
  }
});

test("a request that carries a stub carries the legend as its last system block, on count_tokens too", async () => {
  // Its own tool_use id: the shared proxy's evicted set must not learn `toolu_big` from here.
  const conversation = JSON.parse(agedConversation().replaceAll("toolu_big", "toolu_legend")) as Record<string, unknown>;
  const clientSystem = [{ type: "text", text: "You are a test.", cache_control: { type: "ephemeral" } }];
  await sendRequest(proxyOrigin, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...conversation, system: clientSystem }),
  });
  const forwarded = JSON.parse(lastRecorded().body.toString("utf8")) as {
    system: unknown[];
    messages: { content: { content?: unknown }[] }[];
  };
  assert.equal(forwarded.messages[1]?.content[0]?.content, "[onepass: evicted 5,000 chars]", "the request carries a stub");
  // After the client's own blocks and their cache breakpoint, so the prefix the client built is
  // the same bytes it was.
  assert.deepEqual(forwarded.system, [...clientSystem, { type: "text", text: STUB_LEGEND }]);

  await sendRequest(proxyOrigin, "/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...conversation, system: "Be brief." }),
  });
  assert.equal((JSON.parse(lastRecorded().body.toString("utf8")) as { system: string }).system, `Be brief.\n\n${STUB_LEGEND}`);
});

/** The same shape one turn later: a big Edit call whose result is a short confirmation. */
function agedCallConversation(): string {
  return JSON.stringify({
    model: "claude-test",
    max_tokens: 1000,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_call",
            name: "Edit",
            input: { file_path: "/repo/x.ts", old_string: "a", new_string: "x".repeat(937) },
          },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_call", content: "The file /repo/x.ts has been updated." }] },
      { role: "assistant", content: [{ type: "text", text: "edited" }] },
      { role: "user", content: "and then?" },
      { role: "assistant", content: [{ type: "text", text: "then this" }] },
      { role: "user", content: "go on" },
    ],
  });
}

interface ForwardedCallBody {
  messages: { content: { input?: unknown; content?: unknown }[] }[];
}

test("stubs an old large tool_use input, leaves its small result, and keeps both that way", async () => {
  const mark = await logMark();
  const send = (): Promise<unknown> =>
    sendRequest(proxyOrigin, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: agedCallConversation(),
    });

  await send();
  const first = JSON.parse(lastRecorded().body.toString("utf8")) as ForwardedCallBody;
  const firstInput = first.messages[0]?.content[0]?.input as Record<string, unknown> | undefined;
  assert.ok(firstInput, "the forwarded call has no input object");
  assert.deepEqual(firstInput, {}, `unexpected call stub: ${JSON.stringify(firstInput)}`);
  assert.ok(!lastRecorded().body.toString("utf8").includes("x".repeat(937)), "the edit text still reached upstream");
  assert.equal(first.messages[1]?.content[0]?.content, "The file /repo/x.ts has been updated.");

  await send();
  const second = JSON.parse(lastRecorded().body.toString("utf8")) as ForwardedCallBody;
  assert.deepEqual(second.messages[0]?.content[0]?.input, firstInput);

  await loggedRequestsSince("/v1/messages", mark, 2);
  const callTrips = loggedEntries().filter(
    (entry) => entry.kind === "trip" && (entry.addedToolUseIds ?? []).includes("call:toolu_call"),
  );
  assert.equal(callTrips.length, 1, "the call must be added exactly once");
});

// ---------------------------------------------------------------------------------------
// The user's own text. No rule may evict it: there is no file to re-read and no command to
// re-run, so a stub in its place would be the one loss recall cannot undo. Its own proxy,
// configured to evict as eagerly as the settings allow, writing to a log the other tests
// must not see.

const PASTED_USER_TEXT = "Use tabs, not spaces. Here is the log:\n" + "L".repeat(2961);

/**
 * The paste, and beside it a tool result the rules do evict. The tool result is the control:
 * without it a green says only that nothing was evicted, which is also what a broken eviction
 * pass looks like.
 */
function pastedConversation(): string {
  return JSON.stringify({
    model: "claude-test",
    max_tokens: 1000,
    messages: [
      { role: "user", content: [{ type: "text", text: PASTED_USER_TEXT }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/x.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "R".repeat(5000) }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "next" },
      { role: "assistant", content: [{ type: "text", text: "sure" }] },
      { role: "user", content: "go on" },
    ],
  });
}

function lastProxiedConversation(): { content: { text?: unknown; content?: unknown }[] }[] {
  const proxied = recorded.filter((entry) => entry.url === "/v1/messages").at(-1);
  assert.ok(proxied, "the stub upstream recorded no proxied /v1/messages request");
  return (
    JSON.parse(proxied.body.toString("utf8")) as {
      messages: { content: { text?: unknown; content?: unknown }[] }[];
    }
  ).messages;
}

test("a user's paste goes upstream untouched while the tool result beside it is stubbed", async () => {
  const logPath = join(mkdtempSync(join(tmpdir(), "onepass-user-text-test-")), "proxy.log.jsonl");
  const server = createProxyServer({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    evictAfterAssistantTurns: 2,
    protectLastAssistantTurns: 1,
    minSavedChars: 50,
    tripThresholdTokens: 0,
    batchMinTokens: 0,
    logFilePath: logPath,
    quiet: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${listeningPort(server)}`;
  try {
    // Twice: the first request is where the paste could be added to the evicted set, the second
    // is where it would come back as a stub.
    for (let attempt = 0; attempt < 2; attempt++) {
      await sendRequest(origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: pastedConversation(),
      });
      const sent = lastProxiedConversation();
      assert.equal(sent[0]?.content[0]?.text, PASTED_USER_TEXT);
      assert.equal(sent[2]?.content[0]?.content, "[onepass: evicted 5,000 chars]");
    }
    const evictedIds = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as ProxyLogEntry)
      .flatMap((entry) => (entry.kind === "trip" ? entry.addedToolUseIds : []));
    assert.deepEqual(evictedIds, ["toolu_read"], "the paste's content hash must never enter the set");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("dumped bodies are named so that name order is the order they arrived in", async () => {
  // The eval replays a recording by sorting the dump directory and feeding the files through one
  // proxy child in that order. Eviction is monotonic, so a pair read the wrong way round hands the
  // proxy a state history the session never had — and every request after it inherits that. The
  // name therefore has to sort by arrival and not merely be unique, which is what this pins: a
  // millisecond holds several requests, and the clock alone cannot separate them.
  const dumpDir = mkdtempSync(join(tmpdir(), "onepass-dump-test-"));
  const server = createProxyServer({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    evictAfterAssistantTurns: 2,
    protectLastAssistantTurns: 1,
    minSavedChars: 50,
    tripThresholdTokens: 0,
    batchMinTokens: 0,
    logFilePath: join(mkdtempSync(join(tmpdir(), "onepass-dump-log-")), "proxy.log.jsonl"),
    quiet: true,
    dumpDir,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${listeningPort(server)}`;

  // Sent back to back so that several land inside one millisecond, which is the case that used to
  // come back inverted. Both endpoints, because they are dumped under different names.
  const sent = 30;
  try {
    for (let index = 0; index < sent; index += 1) {
      await sendRequest(origin, index % 2 === 0 ? "/v1/messages" : "/v1/messages/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: `body ${index}` }] }),
      });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const names = readdirSync(dumpDir).sort();
  assert.equal(names.length, sent, "every body is kept: a name that repeats would erase one");
  assert.deepEqual(
    names.map((name) => JSON.parse(readFileSync(join(dumpDir, name), "utf8")).messages[0].content),
    Array.from({ length: sent }, (_unused, index) => `body ${index}`),
  );
});
