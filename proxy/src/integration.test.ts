// End-to-end checks against a recorded stub upstream: a local HTTP server that captures
// exactly what the proxy forwarded. This is the "recorded-stub" verification from the build
// plan; the real-API-key check is a documented local step in README.md.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createProxyServer } from "./server.js";
import type { ProxyLogEntry, RequestLogEntry } from "./log.js";

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
 * The stub reports usage at 2 chars per token so calibration is observable, split across the
 * three fields the speed gauge reads. Cache creation stays a small share, so a plain request
 * is not classified as a rebuild.
 */
function stubUsage(requestBytes: number): Record<string, number> {
  const total = Math.round(requestBytes / 2);
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
      response.end(
        isMessages
          ? JSON.stringify({ ok: true, echoPath: request.url, usage: stubUsage(body.byteLength) })
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
    minSegmentChars: 100,
    tripThresholdTokens: 0,
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
  return readFileSync(logFilePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ProxyLogEntry);
}

function lastLoggedRequest(path: string): RequestLogEntry {
  const requests = loggedEntries().filter(
    (entry): entry is RequestLogEntry => entry.kind === "request" && entry.path === path,
  );
  const last = requests[requests.length - 1];
  assert.ok(last, `the proxy log has no ${path} request`);
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

test("forwards /v1/messages byte-for-byte when nothing is stubbed", async () => {
  const body = JSON.stringify({
    model: "claude-test",
    max_tokens: 100,
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
  assert.ok(
    firstStub.startsWith("[onepass: evicted Read result for /big.ts (5,000 chars)."),
    `unexpected stub: ${firstStub}`,
  );

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

  const trips = loggedEntries().filter((entry) => entry.kind === "trip");
  assert.equal(trips.length, 1, "the second identical request must not log a second trip");
  assert.deepEqual(trips[0]?.addedToolUseIds, ["toolu_big"]);
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
  assert.ok(
    typeof stub === "string" && stub.startsWith("[onepass: evicted Read result for /big.ts"),
    `count_tokens body was not evicted: ${String(stub).slice(0, 80)}`,
  );
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
  await sendRequest(proxyOrigin, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: second,
  });
  const last = lastLoggedRequest("/v1/messages");
  assert.ok(last.charsPerToken !== undefined, "request log entry should record charsPerToken");
  assert.ok(Math.abs(last.charsPerToken - 2) < 0.1, `expected ~2 chars/token, got ${last.charsPerToken}`);
});

test("logs the speed gauge: proxy time, first byte, and the cache numbers from usage", async () => {
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

  const entry = lastLoggedRequest("/v1/messages");
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

  const entry = lastLoggedRequest("/v1/messages");
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
    minSegmentChars: 100,
    tripThresholdTokens: 0,
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
  assert.equal(firstInput.file_path, "/repo/x.ts");
  assert.ok(
    typeof firstInput.evicted === "string" && firstInput.evicted.startsWith("[onepass: evicted Edit input for /repo/x.ts ("),
    `unexpected call stub: ${JSON.stringify(firstInput.evicted)}`,
  );
  assert.ok(!lastRecorded().body.toString("utf8").includes("x".repeat(937)), "the edit text still reached upstream");
  assert.equal(first.messages[1]?.content[0]?.content, "The file /repo/x.ts has been updated.");

  await send();
  const second = JSON.parse(lastRecorded().body.toString("utf8")) as ForwardedCallBody;
  assert.deepEqual(second.messages[0]?.content[0]?.input, firstInput);

  const callTrips = loggedEntries().filter(
    (entry) => entry.kind === "trip" && (entry.addedToolUseIds ?? []).includes("call:toolu_call"),
  );
  assert.equal(callTrips.length, 1, "the call must be added exactly once");
});
