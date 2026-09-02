import * as http from "node:http";
import * as https from "node:https";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  evictContextSegments,
  formatThousands,
  isRecord,
  type EvictionConfig,
  type JudgeDecision,
} from "./evict.js";
import { callJudge, NO_REJECTIONS, validateJudgePicks, type JudgeConfig } from "./judge.js";
import { createProxyLogWriter, type JudgeLogEntry, type RequestLogEntry } from "./log.js";
import {
  classifyRebuild,
  describeRebuild,
  extractUsage,
  GAUGE_MIN_ESTIMATED_TOKENS,
  formatDuration,
  totalContextTokens,
  type ResponseUsage,
} from "./speed.js";

/** charsPerToken is calibrated live from API responses, not configured. */
export interface ProxyConfig extends Omit<EvictionConfig, "charsPerToken"> {
  upstreamUrl: string;
  logFilePath: string;
  /** Suppress per-request stdout lines (used by tests). The JSONL log is always written. */
  quiet?: boolean;
  /** When set, every transformable request body is written here pre-eviction — debugging only. */
  dumpDir?: string;
  /** Absent means no judge: the proxy evicts by the rules alone, exactly as it did before. */
  judge?: JudgeConfig;
}

// Deliberately low (code averages ~3.2–3.5): over-estimating tokens before the first
// calibration sample trips eviction early rather than letting a session overshoot the cap.
export const FALLBACK_CHARS_PER_TOKEN = 3.2;
const CALIBRATION_MIN_TOKENS = 1000;
const USAGE_SCAN_LIMIT_CHARS = 262_144;

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

/** The line the user watches while a session runs. Same numbers the JSONL log records. */
function formatLiveLine(entry: RequestLogEntry): string {
  const parts = [`[onepass] ${entry.timestamp.slice(11, 19)} ${entry.method} ${entry.path} ${entry.status}`];
  if (entry.proxyMs !== undefined) parts.push(`proxy ${formatDuration(entry.proxyMs)}`);
  if (entry.upstreamFirstByteMs !== undefined) parts.push(`first-byte ${formatDuration(entry.upstreamFirstByteMs)}`);
  parts.push(`total ${formatDuration(entry.durationMs)}`);
  if (entry.cacheReadInputTokens !== undefined && entry.cacheCreationInputTokens !== undefined) {
    parts.push(
      `cache read ${formatTokensShort(entry.cacheReadInputTokens)} / ` +
        `new ${formatTokensShort(entry.cacheCreationInputTokens)}`,
    );
  }
  if (entry.estimatedTokensBefore !== undefined && entry.estimatedTokensSent !== undefined) {
    parts.push(
      `est ${formatTokensShort(entry.estimatedTokensBefore)} -> ${formatTokensShort(entry.estimatedTokensSent)} tok, ` +
        `${entry.stubbedResultCount ?? 0} stubbed (${entry.newlyEvictedCount ?? 0} new)`,
    );
  }
  const rebuildNote =
    entry.rebuild === undefined
      ? ""
      : entry.rebuild === "unexpected"
        ? "  <- REBUILD (unexpected)"
        : `  <- rebuild (${describeRebuild(entry.rebuild)})`;
  return parts.join(" | ") + rebuildNote;
}

export function createProxyServer(config: ProxyConfig): http.Server {
  const upstream = new URL(config.upstreamUrl);
  const upstreamIsHttps = upstream.protocol === "https:";
  const requestModule = upstreamIsHttps ? https : http;
  const upstreamPort = upstream.port !== "" ? Number(upstream.port) : upstreamIsHttps ? 443 : 80;
  const agent = upstreamIsHttps ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });

  const logWriter = createProxyLogWriter(config.logFilePath);
  const evictedSegmentIds = new Set<string>();
  // Deliberately narrower than `evictedSegmentIds`, not a parallel copy of it: this holds only
  // the judge's picks on the user's own text, which are the only ids that carry anything back
  // into the stub. Every other judge pick needs nothing beyond membership of the set above.
  const judgeDecisionById = new Map<string, JudgeDecision>();
  // One judge at a time — a second would read a conversation the first is about to shrink.
  let judgeRunning = false;
  // What went upstream on the most recent transformable request. The judge's verdict is
  // validated against this, not against the snapshot it read: a file re-read since then is
  // young again, and the protected window has to be measured against what is going out now.
  let lastSentMessages: unknown[] = [];
  // Live chars-per-token ratio, calibrated from the API's reported usage on each response so
  // the trip threshold is denominated in real tokens rather than a fixed chars ÷ 4 guess.
  let charsPerToken = FALLBACK_CHARS_PER_TOKEN;
  // Speed-gauge bookkeeping. Only /v1/messages requests are classified, but a trip on a
  // count_tokens request changes the prefix for the /v1/messages request that follows it.
  let previousMessagesRequestAt: number | null = null;
  let trippedSinceLastMessagesRequest = false;

  interface EvictionRequestMeta {
    estimatedTokensBefore: number;
    estimatedTokensSent: number;
    stubbedResultCount: number;
    newlyEvictedCount: number;
    charsPerToken: number;
  }

  /** What the rebuild rule needs to know about this request's place in the session. */
  interface RebuildContext {
    firstMessagesRequest: boolean;
    tripped: boolean;
    secondsSincePrevious: number | null;
  }

  interface ForwardOptions {
    /** The evicted body to send, or null to stream the client's bytes through untouched. */
    bufferedBody: Buffer | null;
    evictionMeta: EvictionRequestMeta | null;
    /** When the request body was fully read — the start of everything the client waits for. */
    receivedAt: number;
    /** Scan the response for `usage`: calibrates chars-per-token and feeds the speed gauge. */
    readUsage: boolean;
    /** Null for anything that is not a /v1/messages request; only those are classified. */
    rebuildContext: RebuildContext | null;
  }

  /** Every judge record starts here, so the outcomes cannot drift apart field by field. */
  function newJudgeLogEntry(model: string, durationMs: number): JudgeLogEntry {
    return {
      kind: "judge",
      timestamp: new Date().toISOString(),
      model,
      durationMs,
      proposed: 0,
      accepted: 0,
      rejected: { ...NO_REJECTIONS },
      charsRemovedEstimate: 0,
    };
  }

  /**
   * Runs alongside the request that tripped, never in front of it. The verdict lands in the
   * shared evicted-id set, so the agent's next request — trip or not — carries the stubs.
   * Owns the one-at-a-time guard: a second judge would be reading a conversation the first is
   * about to shrink.
   */
  async function maybeRunJudge(judge: JudgeConfig, messagesAtTrip: unknown[]): Promise<void> {
    if (judgeRunning) {
      logWriter.append({ ...newJudgeLogEntry(judge.model, 0), skipped: true });
      return;
    }
    judgeRunning = true;
    const startedAt = Date.now();
    let entry: JudgeLogEntry;
    try {
      const result = await callJudge(messagesAtTrip, { upstreamUrl: config.upstreamUrl, judge });
      entry = { ...newJudgeLogEntry(judge.model, Date.now() - startedAt), ...result.usage };
      if (result.picks === null) {
        entry.error = result.error ?? "judge call failed";
      } else {
        const verdict = validateJudgePicks(
          result.picks,
          lastSentMessages,
          config.protectLastAssistantTurns,
          config.minSegmentChars,
        );
        for (const pick of verdict.accepted) {
          evictedSegmentIds.add(pick.id);
          if (pick.kind === "user_text") {
            judgeDecisionById.set(pick.id, { keep: pick.keep, note: pick.note });
          }
        }
        entry.proposed = result.picks.length;
        entry.accepted = verdict.accepted.length;
        entry.rejected = verdict.rejected;
        entry.charsRemovedEstimate = verdict.charsRemovedEstimate;
      }
    } finally {
      judgeRunning = false;
    }
    logWriter.append(entry);
    if (config.quiet !== true) {
      console.log(
        entry.error !== undefined
          ? `[onepass] JUDGE failed after ${formatDuration(entry.durationMs)}: ${entry.error} — nothing extra evicted`
          : `[onepass] JUDGE: ${entry.accepted}/${entry.proposed} picks accepted, ` +
              `~${formatThousands(entry.charsRemovedEstimate)} chars will come out (${formatDuration(entry.durationMs)})`,
      );
    }
  }

  function forward(
    clientRequest: http.IncomingMessage,
    clientResponse: http.ServerResponse,
    options: ForwardOptions,
  ): void {
    const { bufferedBody, evictionMeta, receivedAt, readUsage, rebuildContext } = options;
    const timestamp = new Date(receivedAt).toISOString();
    const method = clientRequest.method ?? "GET";
    const path = clientRequest.url ?? "/";

    const headers = filterHeaders(clientRequest.headers, DROPPED_REQUEST_HEADERS);
    if (bufferedBody !== null) headers["content-length"] = bufferedBody.byteLength;
    // The usage scan reads the response as plain text, so ask the upstream not to compress.
    if (readUsage) delete headers["accept-encoding"];

    let requestBodyBytes = bufferedBody?.byteLength ?? 0;
    let forwardedAt: number | null = null;
    let firstByteAt: number | null = null;
    let logged = false;
    const logRequest = (status: number, usage: ResponseUsage | null): void => {
      if (logged) return;
      logged = true;
      const rebuild =
        usage === null || rebuildContext === null
          ? null
          : classifyRebuild({
              ...rebuildContext,
              cacheCreationInputTokens: usage.cacheCreationInputTokens,
              contextTotal: totalContextTokens(usage),
            });
      const entry: RequestLogEntry = {
        kind: "request",
        timestamp,
        method,
        path,
        status,
        durationMs: Date.now() - receivedAt,
        ...(forwardedAt !== null ? { proxyMs: forwardedAt - receivedAt } : {}),
        ...(forwardedAt !== null && firstByteAt !== null ? { upstreamFirstByteMs: firstByteAt - forwardedAt } : {}),
        requestBodyBytes,
        sentBodyBytes: bufferedBody?.byteLength ?? requestBodyBytes,
        ...(usage ?? {}),
        ...(rebuild !== null ? { rebuild } : {}),
        ...(evictionMeta ?? {}),
      };
      logWriter.append(entry);
      if (config.quiet !== true) console.log(formatLiveLine(entry));
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
      const scanUsage = readUsage && status === 200;
      let responseHead = "";
      upstreamResponse.on("data", (chunk: Buffer) => {
        firstByteAt ??= Date.now();
        if (scanUsage && responseHead.length <= USAGE_SCAN_LIMIT_CHARS) responseHead += chunk.toString("utf8");
      });
      upstreamResponse.on("end", () => {
        const usage = scanUsage ? extractUsage(responseHead) : null;
        if (usage !== null && bufferedBody !== null) {
          const realInputTokens = totalContextTokens(usage);
          if (realInputTokens >= CALIBRATION_MIN_TOKENS) {
            charsPerToken = Math.min(8, Math.max(2, bufferedBody.byteLength / realInputTokens));
          }
        }
        logRequest(status, usage);
      });
      // A client that hangs up mid-stream never fires `end`, but `close` always fires.
      upstreamResponse.on("close", () => logRequest(status, null));
      clientResponse.writeHead(status, filterHeaders(upstreamResponse.headers, DROPPED_RESPONSE_HEADERS));
      upstreamResponse.pipe(clientResponse);
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
        logRequest(502, null);
      } else {
        clientResponse.destroy();
      }
    });

    clientRequest.on("error", () => upstreamRequest.destroy());
    clientResponse.on("close", () => {
      if (!clientResponse.writableEnded) upstreamRequest.destroy();
    });

    if (bufferedBody !== null) {
      forwardedAt = Date.now();
      upstreamRequest.end(bufferedBody);
    } else {
      clientRequest.on("data", (chunk: Buffer) => {
        requestBodyBytes += chunk.length;
      });
      forwardedAt = Date.now();
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
      forward(clientRequest, clientResponse, {
        bufferedBody: null,
        evictionMeta: null,
        receivedAt: Date.now(),
        readUsage: false,
        rebuildContext: null,
      });
      return;
    }

    const rawBody = await readEntireBody(clientRequest);
    const receivedAt = Date.now();
    if (config.dumpDir !== undefined) {
      try {
        mkdirSync(config.dumpDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(config.dumpDir, `${stamp}${pathname.replace(/[^a-zA-Z0-9]/g, "_")}.json`), rawBody);
      } catch {
        // Dumping is best-effort; never fail the request over it.
      }
    }
    let forwardBody = rawBody;
    let evictionMeta: EvictionRequestMeta | null = null;
    let tripped = false;
    try {
      const parsedBody: unknown = JSON.parse(rawBody.toString("utf8"));
      const requestCharsPerToken = Math.round(charsPerToken * 100) / 100;
      const outcome = evictContextSegments(parsedBody, evictedSegmentIds, {
        evictAfterAssistantTurns: config.evictAfterAssistantTurns,
        protectLastAssistantTurns: config.protectLastAssistantTurns,
        minSegmentChars: config.minSegmentChars,
        tripThresholdTokens: config.tripThresholdTokens,
        charsPerToken: requestCharsPerToken,
      }, judgeDecisionById);
      for (const id of outcome.newlyEvictedIds) evictedSegmentIds.add(id);
      if (outcome.newlyEvictedIds.length > 0) {
        logWriter.append({
          kind: "trip",
          timestamp: new Date().toISOString(),
          addedToolUseIds: outcome.newlyEvictedIds,
          charsRemoved: outcome.newlyEvictedCharsRemoved,
          estimatedTokensBefore: outcome.estimatedTokensBefore,
          estimatedTokensSent: outcome.estimatedTokensSent,
          ...(outcome.pressure ? { pressure: true } : {}),
        });
        if (config.quiet !== true) {
          console.log(
            `[onepass] TRIP${outcome.pressure ? " (pressure)" : ""}: evicted ${outcome.newlyEvictedIds.length} segment(s), ` +
              `${formatThousands(outcome.newlyEvictedCharsRemoved)} chars removed ` +
              `(est ${formatTokensShort(outcome.estimatedTokensBefore)} -> ${formatTokensShort(outcome.estimatedTokensSent)} tok, ` +
              `${evictedSegmentIds.size} evicted total)`,
          );
        }
      }
      if (outcome.bodyChanged) forwardBody = Buffer.from(JSON.stringify(outcome.body), "utf8");
      tripped = outcome.tripped;
      const sentBody = outcome.body;
      if (isRecord(sentBody) && Array.isArray(sentBody.messages)) lastSentMessages = sentBody.messages;
      evictionMeta = {
        estimatedTokensBefore: outcome.estimatedTokensBefore,
        estimatedTokensSent: outcome.estimatedTokensSent,
        stubbedResultCount: outcome.stubbedIds.length,
        newlyEvictedCount: outcome.newlyEvictedIds.length,
        charsPerToken: requestCharsPerToken,
      };
    } catch {
      // Unparseable body: forward the original bytes untouched. Never fail a request.
    }

    if (evictionMeta !== null && evictionMeta.newlyEvictedCount > 0) trippedSinceLastMessagesRequest = true;
    let rebuildContext: RebuildContext | null = null;
    if (pathname === "/v1/messages" && (evictionMeta?.estimatedTokensSent ?? 0) >= GAUGE_MIN_ESTIMATED_TOKENS) {
      rebuildContext = {
        firstMessagesRequest: previousMessagesRequestAt === null,
        tripped: trippedSinceLastMessagesRequest,
        secondsSincePrevious:
          previousMessagesRequestAt === null ? null : (receivedAt - previousMessagesRequestAt) / 1000,
      };
      previousMessagesRequestAt = receivedAt;
      trippedSinceLastMessagesRequest = false;
    }

    forward(clientRequest, clientResponse, {
      bufferedBody: forwardBody,
      evictionMeta,
      receivedAt,
      readUsage: evictionMeta !== null,
      rebuildContext,
    });

    // count_tokens carries the same conversation, so judging it too would only double the bill.
    if (config.judge !== undefined && tripped && pathname === "/v1/messages") {
      // A rejection here would take the whole proxy down with it; the judge is never worth that.
      maybeRunJudge(config.judge, lastSentMessages).catch((err: unknown) => {
        logWriter.append({
          kind: "proxy_error",
          timestamp: new Date().toISOString(),
          method: "POST",
          path: "/v1/messages (judge)",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
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
