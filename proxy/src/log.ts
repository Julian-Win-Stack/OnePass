import { createWriteStream, mkdirSync, readdirSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { RebuildKind } from "./speed.js";

// One JSON object per line. Never any request or response body — sizes, ids, and paths only.

export interface RequestLogEntry {
  kind: "request";
  timestamp: string;
  method: string;
  path: string;
  status: number;
  /** Request received to upstream response ended — the whole time the client waited. */
  durationMs: number;
  /** The proxy's own work: body read to upstream request sent. Parse + evict + serialize. */
  proxyMs?: number;
  /** Upstream request sent to its first response byte. Absent when no byte ever arrived. */
  upstreamFirstByteMs?: number;
  requestBodyBytes: number;
  sentBodyBytes: number;
  /** From the response `usage`. Absent when the response carried none (errors, non-messages paths). */
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Set only when Anthropic re-read the conversation instead of serving it from cache. */
  rebuild?: RebuildKind;
  estimatedTokensBefore?: number;
  estimatedTokensSent?: number;
  stubbedResultCount?: number;
  newlyEvictedCount?: number;
  /** Chars-per-token ratio used for this request's token estimates (calibrated from API usage). */
  charsPerToken?: number;
}

export interface TripLogEntry {
  kind: "trip";
  timestamp: string;
  addedToolUseIds: string[];
  charsRemoved: number;
  estimatedTokensBefore: number;
  estimatedTokensSent: number;
  /** The age gate was relaxed from N down to K because the normal pass left the request over T. */
  pressure?: boolean;
}

export interface ProxyErrorLogEntry {
  kind: "proxy_error";
  timestamp: string;
  method: string;
  path: string;
  message: string;
}

export type ProxyLogEntry = RequestLogEntry | TripLogEntry | ProxyErrorLogEntry;

export const proxyLogDir = join(homedir(), ".onepass");

// One log file per proxy run, so a report never mixes metrics from unrelated runs.
// The ISO timestamp in the name sorts lexically, so "latest" is a plain string max.
const proxyLogFilePattern = /^proxy\.log\..+\.jsonl$/;

export function newProxyLogPath(): string {
  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  return join(proxyLogDir, `proxy.log.${startedAt}.jsonl`);
}

export function latestProxyLogPath(): string | null {
  let names: string[];
  try {
    names = readdirSync(proxyLogDir);
  } catch {
    return null;
  }
  const logNames = names.filter((name) => proxyLogFilePattern.test(name)).sort();
  const newest = logNames.at(-1);
  return newest === undefined ? null : join(proxyLogDir, newest);
}

export interface ProxyLogWriter {
  append(entry: ProxyLogEntry): void;
  close(): void;
}

export function createProxyLogWriter(filePath: string): ProxyLogWriter {
  let stream: WriteStream | null = null;
  let warned = false;
  const warnOnce = (err: unknown): void => {
    if (warned) return;
    warned = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[onepass] cannot write proxy log at ${filePath}: ${message}`);
  };
  return {
    append(entry) {
      try {
        if (stream === null) {
          mkdirSync(dirname(filePath), { recursive: true });
          stream = createWriteStream(filePath, { flags: "a" });
          stream.on("error", warnOnce);
        }
        stream.write(`${JSON.stringify(entry)}\n`);
      } catch (err: unknown) {
        warnOnce(err);
      }
    },
    close() {
      stream?.end();
      stream = null;
    },
  };
}
