import { createWriteStream, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One JSON object per line. Never any request or response body — sizes, ids, and paths only.

export interface RequestLogEntry {
  kind: "request";
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestBodyBytes: number;
  sentBodyBytes: number;
  estimatedTokensBefore?: number;
  estimatedTokensSent?: number;
  stubbedResultCount?: number;
  newlyEvictedCount?: number;
}

export interface TripLogEntry {
  kind: "trip";
  timestamp: string;
  addedToolUseIds: string[];
  charsRemoved: number;
  estimatedTokensBefore: number;
  estimatedTokensSent: number;
}

export interface ProxyErrorLogEntry {
  kind: "proxy_error";
  timestamp: string;
  method: string;
  path: string;
  message: string;
}

export type ProxyLogEntry = RequestLogEntry | TripLogEntry | ProxyErrorLogEntry;

export const defaultProxyLogPath = join(dirname(fileURLToPath(import.meta.url)), "..", "proxy.log.jsonl");

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
