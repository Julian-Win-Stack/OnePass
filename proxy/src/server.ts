import * as http from "node:http";
import * as https from "node:https";
import { evictToolResults, formatThousands, type EvictionConfig } from "./evict.js";
import { createProxyLogWriter, type RequestLogEntry } from "./log.js";

export interface ProxyConfig extends EvictionConfig {
  upstreamUrl: string;
  logFilePath: string;
  /** Suppress per-request stdout lines (used by tests). The JSONL log is always written. */
  quiet?: boolean;
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

  interface EvictionRequestMeta {
    estimatedTokensBefore: number;
    estimatedTokensSent: number;
    stubbedResultCount: number;
    newlyEvictedCount: number;
  }

  function forward(
    clientRequest: http.IncomingMessage,
    clientResponse: http.ServerResponse,
    bufferedBody: Buffer | null,
    evictionMeta: EvictionRequestMeta | null,
  ): void {
    const startedAt = Date.now();
    const timestamp = new Date(startedAt).toISOString();
    const method = clientRequest.method ?? "GET";
    const path = clientRequest.url ?? "/";

    const headers = filterHeaders(clientRequest.headers, DROPPED_REQUEST_HEADERS);
    if (bufferedBody !== null) headers["content-length"] = bufferedBody.byteLength;

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
    const transformable =
      method === "POST" && pathname === "/v1/messages" && clientRequest.headers["content-encoding"] === undefined;

    if (!transformable) {
      forward(clientRequest, clientResponse, null, null);
      return;
    }

    const rawBody = await readEntireBody(clientRequest);
    let forwardBody = rawBody;
    let evictionMeta: EvictionRequestMeta | null = null;
    try {
      const parsedBody: unknown = JSON.parse(rawBody.toString("utf8"));
      const outcome = evictToolResults(parsedBody, evictedToolUseIds, config);
      for (const id of outcome.newlyEvictedToolUseIds) evictedToolUseIds.add(id);
      if (outcome.newlyEvictedToolUseIds.length > 0) {
        logWriter.append({
          kind: "trip",
          timestamp: new Date().toISOString(),
          addedToolUseIds: outcome.newlyEvictedToolUseIds,
          charsRemoved: outcome.newlyEvictedCharsRemoved,
          estimatedTokensBefore: outcome.estimatedTokensBefore,
          estimatedTokensSent: outcome.estimatedTokensSent,
        });
        if (config.quiet !== true) {
          console.log(
            `[onepass] TRIP: evicted ${outcome.newlyEvictedToolUseIds.length} tool result(s), ` +
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
      };
    } catch {
      // Unparseable body: forward the original bytes untouched. Never fail a request.
    }
    forward(clientRequest, clientResponse, forwardBody, evictionMeta);
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
