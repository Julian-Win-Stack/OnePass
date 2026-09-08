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
//
// A caller can script what `/v1/messages` answers, which is how the grader is driven with no
// model: canned verdicts, canned tool calls, and a grader that never stops calling tools so the
// turn cap can be reached for nothing. Only unstreamed calls are scripted. Claude Code's own
// requests through a proxy child stream, and they must not eat the grader's script.

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

/** What an unscripted `/v1/messages` call is answered with, so a caller can tell fake from real. */
const ANSWER = "fake upstream";

/** A canned assistant turn: the text it ends on, or a call to one of the caller's tools. */
export type CannedTurn = { say: string } | { call: string; input?: unknown };

export interface FakeUpstreamOptions {
  /**
   * What an unstreamed `/v1/messages` is answered with, asked once per such call with the number
   * already served. Returning undefined serves the default one-line answer, which is also what a
   * streamed call always gets.
   */
  answer?: (turn: number, request: RecordedRequest) => CannedTurn | undefined;
}

export interface FakeUpstream {
  url: string;
  port: number;
  /** Every request that reached it, in order, bodies included. */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakeUpstream(options: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  let scripted = 0;

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
        const turn = options.answer?.(scripted, requests[requests.length - 1] as RecordedRequest);
        if (turn !== undefined) scripted += 1;
        json(response, 200, message(turn ?? { say: ANSWER }, tokens));
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

let toolUseId = 0;

function message(turn: CannedTurn, inputTokens: number): unknown {
  const calling = "call" in turn;
  const content =
    calling ?
      [{ type: "tool_use", id: `toolu_fake_${(toolUseId += 1)}`, name: turn.call, input: turn.input ?? {} }]
    : [{ type: "text", text: turn.say }];
  const spoken = calling ? JSON.stringify(content) : turn.say;
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake-upstream",
    content,
    stop_reason: calling ? "tool_use" : "end_turn",
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: Math.max(1, Math.ceil(spoken.length / 4)),
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
  const started = message({ say: text }, inputTokens) as { usage: unknown };
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
