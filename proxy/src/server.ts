import * as http from "node:http";
import * as https from "node:https";
import { evictToolResults, formatThousands, type EvictionConfig } from "./evict.js";
import { createProxyLogWriter, type RequestLogEntry } from "./log.js";

/** charsPerToken is calibrated live from API responses, not configured. */
export interface ProxyConfig extends Omit<EvictionConfig, "charsPerToken"> {
  upstreamUrl: string;
  logFilePath: string;
  /** Suppress per-request stdout lines (used by tests). The JSONL log is always written. */
  quiet?: boolean;
}

// Deliberately low (code averages ~3.2–3.5): over-estimating tokens before the first
// calibration sample trips eviction early rather than letting a session overshoot the cap.
export const FALLBACK_CHARS_PER_TOKEN = 3.2;
const CALIBRATION_MIN_TOKENS = 1000;
const USAGE_SCAN_LIMIT_CHARS = 262_144;

/**
 * Pull the real input-token total out of an Anthropic response — the first `usage` object in
 * the body (message_start for SSE, top level for JSON). Brace-matched rather than regexed
 * whole: usage contains nested objects (`cache_creation`, `server_tool_use`).
 */
export function extractRealInputTokens(responseText: string): number | null {
  const keyIndex = responseText.indexOf('"usage"');
  if (keyIndex === -1) return null;
  const openIndex = responseText.indexOf("{", keyIndex);
  if (openIndex === -1) return null;
  let depth = 0;
  let closeIndex = -1;
  for (let i = openIndex; i < responseText.length; i++) {
    const ch = responseText[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return null;
  const usageSlice = responseText.slice(openIndex, closeIndex + 1);
  const field = (name: string): number => {
    const match = new RegExp(`"${name}"\\s*:\\s*(\\d+)`).exec(usageSlice);
    return match === null ? 0 : Number(match[1]);
  };
  const total = field("input_tokens") + field("cache_creation_input_tokens") + field("cache_read_input_tokens");
  return total > 0 ? total : null;
}

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]);

function filterHeaders(headers: http.IncomingHttpHeaders, dropped: Set<string>): http.OutgoingHttpHeaders {
  const filtered: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || dropped.has(name.toLowerCase())) continue;
    filtered[name] = value;
  }
  return filtered;
}

function readEntireBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function formatTokensShort(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function createProxyServer(config: ProxyConfig): http.Server {
  const upstream = new URL(config.upstreamUrl);
  const upstreamIsHttps = upstream.protocol === "https:";
  const requestModule = upstreamIsHttps ? https : http;
  const upstreamPort = upstream.port !== "" ? Number(upstream.port) : upstreamIsHttps ? 443 : 80;
  const agent = upstreamIsHttps ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });

  const logWriter = createProxyLogWriter(config.logFilePath);
  const evictedToolUseIds = new Set<string>();
  // Live chars-per-token ratio, calibrated from the API's reported usage on each response so
  // the trip threshold is denominated in real tokens rather than a fixed chars ÷ 4 guess.
  let charsPerToken = FALLBACK_CHARS_PER_TOKEN;

  interface EvictionRequestMeta {
    estimatedTokensBefore: number;
    estimatedTokensSent: number;
    stubbedResultCount: number;
    newlyEvictedCount: number;
    charsPerToken: number;
  }

  function forward(
    clientRequest: http.IncomingMessage,
    clientResponse: http.ServerResponse,
    bufferedBody: Buffer | null,
    evictionMeta: EvictionRequestMeta | null,
    calibrate = false,
  ): void {
    const startedAt = Date.now();
    const timestamp = new Date(startedAt).toISOString();
    const method = clientRequest.method ?? "GET";
    const path = clientRequest.url ?? "/";

    const headers = filterHeaders(clientRequest.headers, DROPPED_REQUEST_HEADERS);
    if (bufferedBody !== null) headers["content-length"] = bufferedBody.byteLength;
    // The usage scan reads the response as plain text, so ask the upstream not to compress.
    if (calibrate) delete headers["accept-encoding"];

    let requestBodyBytes = bufferedBody?.byteLength ?? 0;
    let logged = false;
    const logRequest = (status: number): void => {
      if (logged) return;
      logged = true;
      const entry: RequestLogEntry = {
        kind: "request",
        timestamp,
        method,
        path,
        status,
        durationMs: Date.now() - startedAt,
        requestBodyBytes,
        sentBodyBytes: bufferedBody?.byteLength ?? requestBodyBytes,
        ...(evictionMeta ?? {}),
      };
      logWriter.append(entry);
      if (config.quiet !== true) {
        const evictionNote =
          evictionMeta === null
            ? ""
            : ` | est ${formatTokensShort(evictionMeta.estimatedTokensBefore)} -> ${formatTokensShort(
                evictionMeta.estimatedTokensSent,
              )} tok, ${evictionMeta.stubbedResultCount} stubbed (${evictionMeta.newlyEvictedCount} new)`;
        console.log(`[onepass] ${timestamp} ${method} ${path} ${status} ${entry.durationMs}ms${evictionNote}`);
      }
    };

    const upstreamRequest = requestModule.request({
      host: upstream.hostname,
      port: upstreamPort,
      path,
      method,
      headers,
      agent,
    });
    upstreamRequest.setNoDelay(true);

    upstreamRequest.on("response", (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502;
      if (calibrate && status === 200 && bufferedBody !== null) {
        let responseHead = "";
        upstreamResponse.on("data", (chunk: Buffer) => {
          if (responseHead.length <= USAGE_SCAN_LIMIT_CHARS) responseHead += chunk.toString("utf8");
        });
        upstreamResponse.on("end", () => {
          const realInputTokens = extractRealInputTokens(responseHead);
          if (realInputTokens !== null && realInputTokens >= CALIBRATION_MIN_TOKENS) {
            charsPerToken = Math.min(8, Math.max(2, bufferedBody.byteLength / realInputTokens));
          }
        });
      }
      clientResponse.writeHead(status, filterHeaders(upstreamResponse.headers, DROPPED_RESPONSE_HEADERS));
      upstreamResponse.pipe(clientResponse);
      logRequest(status);
    });

    upstreamRequest.on("error", (err: Error) => {
      logWriter.append({ kind: "proxy_error", timestamp: new Date().toISOString(), method, path, message: err.message });
      if (!clientResponse.headersSent) {
        clientResponse.writeHead(502, { "content-type": "application/json" });
        clientResponse.end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: `onepass proxy: upstream request failed (${err.message})` },
          }),
        );
        logRequest(502);
      } else {
        clientResponse.destroy();
      }
    });

    clientRequest.on("error", () => upstreamRequest.destroy());
    clientResponse.on("close", () => {
      if (!clientResponse.writableEnded) upstreamRequest.destroy();
    });

    if (bufferedBody !== null) {
      upstreamRequest.end(bufferedBody);
    } else {
      clientRequest.on("data", (chunk: Buffer) => {
        requestBodyBytes += chunk.length;
      });
      clientRequest.pipe(upstreamRequest);
    }
  }

  async function handle(clientRequest: http.IncomingMessage, clientResponse: http.ServerResponse): Promise<void> {
    const method = clientRequest.method ?? "GET";
    const pathname = new URL(clientRequest.url ?? "/", "http://proxy.local").pathname;
    // count_tokens carries the same messages array and must be evicted identically: the
    // client's context bookkeeping may consume the count, and an un-evicted count describes
    // a request that will never be sent.
    const transformable =
      method === "POST" &&
      (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens") &&
      clientRequest.headers["content-encoding"] === undefined;

    if (!transformable) {
      forward(clientRequest, clientResponse, null, null);
      return;
    }

    const rawBody = await readEntireBody(clientRequest);
    let forwardBody = rawBody;
    let evictionMeta: EvictionRequestMeta | null = null;
    try {
      const parsedBody: unknown = JSON.parse(rawBody.toString("utf8"));
      const requestCharsPerToken = Math.round(charsPerToken * 100) / 100;
      const outcome = evictToolResults(parsedBody, evictedToolUseIds, {
        evictAfterAssistantTurns: config.evictAfterAssistantTurns,
        protectLastAssistantTurns: config.protectLastAssistantTurns,
        minResultChars: config.minResultChars,
        tripThresholdTokens: config.tripThresholdTokens,
        charsPerToken: requestCharsPerToken,
      });
      for (const id of outcome.newlyEvictedToolUseIds) evictedToolUseIds.add(id);
      if (outcome.newlyEvictedToolUseIds.length > 0) {
        logWriter.append({
          kind: "trip",
          timestamp: new Date().toISOString(),
          addedToolUseIds: outcome.newlyEvictedToolUseIds,
          charsRemoved: outcome.newlyEvictedCharsRemoved,
          estimatedTokensBefore: outcome.estimatedTokensBefore,
          estimatedTokensSent: outcome.estimatedTokensSent,
          ...(outcome.pressure ? { pressure: true } : {}),
        });
        if (config.quiet !== true) {
          console.log(
            `[onepass] TRIP${outcome.pressure ? " (pressure)" : ""}: evicted ${outcome.newlyEvictedToolUseIds.length} tool result(s), ` +
              `${formatThousands(outcome.newlyEvictedCharsRemoved)} chars removed ` +
              `(est ${formatTokensShort(outcome.estimatedTokensBefore)} -> ${formatTokensShort(outcome.estimatedTokensSent)} tok, ` +
              `${evictedToolUseIds.size} evicted total)`,
          );
        }
      }
      if (outcome.bodyChanged) forwardBody = Buffer.from(JSON.stringify(outcome.body), "utf8");
      evictionMeta = {
        estimatedTokensBefore: outcome.estimatedTokensBefore,
        estimatedTokensSent: outcome.estimatedTokensSent,
        stubbedResultCount: outcome.stubbedToolUseIds.length,
        newlyEvictedCount: outcome.newlyEvictedToolUseIds.length,
        charsPerToken: requestCharsPerToken,
      };
    } catch {
      // Unparseable body: forward the original bytes untouched. Never fail a request.
    }
    forward(clientRequest, clientResponse, forwardBody, evictionMeta, evictionMeta !== null);
  }

  const server = http.createServer((clientRequest, clientResponse) => {
    handle(clientRequest, clientResponse).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logWriter.append({
        kind: "proxy_error",
        timestamp: new Date().toISOString(),
        method: clientRequest.method ?? "GET",
        path: clientRequest.url ?? "/",
        message,
      });
      if (!clientResponse.headersSent) {
        clientResponse.writeHead(502, { "content-type": "application/json" });
        clientResponse.end(
          JSON.stringify({ type: "error", error: { type: "api_error", message: `onepass proxy: ${message}` } }),
        );
      } else {
        clientResponse.destroy();
      }
    });
  });

  server.on("connection", (socket) => socket.setNoDelay(true));
  server.on("close", () => {
    agent.destroy();
    logWriter.close();
  });
  return server;
}
