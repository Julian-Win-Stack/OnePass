// The one HTTP seam.
//
// Every model call the eval makes goes to the Anthropic API over HTTP: Claude Code's own
// requests through the proxy child, count-tokens for case selection, and the grader's tool
// runner. Standing a fake in front of that one boundary is what lets the whole command be
// driven end to end with no model, no key and no money — the proxy's integration test does the
// same thing for the proxy.
//
// It is not test-only code. Replay mode makes no model calls by definition, so it serves its
// own fake upstream to the proxy child it starts and reads what the proxy sent.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** The body is read at four characters per token, the ratio the proxy's estimator starts from. */
function countTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

/** What a `/v1/messages` call is answered with, so a caller can tell the fake from the real. */
const ANSWER = "fake upstream";

export interface FakeUpstream {
  url: string;
  port: number;
  /** Every request that reached it, in order, bodies included. */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = request.url ?? "";
      requests.push({ method: request.method ?? "", url, headers: request.headers, body });
      const path = url.split("?")[0];

      if (path === "/v1/messages/count_tokens") {
        json(response, 200, { input_tokens: countTokens(body) });
        return;
      }
      if (path === "/v1/messages") {
        const tokens = countTokens(body);
        if (body.includes('"stream":true')) {
          streamedMessage(response, ANSWER, tokens);
          return;
        }
        json(response, 200, message(ANSWER, tokens));
        return;
      }
      json(response, 404, { type: "error", error: { type: "not_found_error", message: `fake upstream has no ${path}` } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function message(text: string, inputTokens: number): unknown {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake-upstream",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: Math.max(1, Math.ceil(text.length / 4)),
    },
  };
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

/** The proxy reads usage out of `message_start`, so a streamed answer has to carry one. */
function streamedMessage(response: http.ServerResponse, text: string, inputTokens: number): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const started = message(text, inputTokens) as { usage: unknown };
  response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: started.usage } })}\n\n`);
  response.write(
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })}\n\n`,
  );
  response.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  response.end();
}
