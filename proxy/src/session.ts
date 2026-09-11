// Reading what a session left behind: the Claude Code transcript (read-only, always) and the
// proxy's own JSONL log. Both `onepass-report` and `claudep`'s exit line are built from these,
// which is why they live here rather than inside the reporter.

import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { measureContentChars } from "./evict.js";
import type { ProxyLogEntry, RequestLogEntry, TripLogEntry } from "./log.js";

const RECALL_TOOL_NAME = /(^|__)recall_(search|get)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface TranscriptStats {
  entryCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  compactionCount: number;
  recallResultCount: number;
  recallChars: number;
  /** Peak of API-reported context (input + cache_creation + cache_read) across assistant turns. */
  realUsagePeak: number;
  realUsageSamples: number;
  realUsageTurnsAbove150k: number;
}

export async function scanTranscript(path: string): Promise<TranscriptStats> {
  const stats: TranscriptStats = {
    entryCount: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    compactionCount: 0,
    recallResultCount: 0,
    recallChars: 0,
    realUsagePeak: 0,
    realUsageSamples: 0,
    realUsageTurnsAbove150k: 0,
  };
  const recallToolUseIds = new Set<string>();

  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    stats.entryCount++;

    if (typeof entry.timestamp === "string") {
      stats.firstTimestamp ??= entry.timestamp;
      stats.lastTimestamp = entry.timestamp;
    }
    if (entry.isCompactSummary === true || (entry.compactMetadata !== undefined && entry.compactMetadata !== null)) {
      stats.compactionCount++;
    }

    const message = entry.message;
    if (!isRecord(message)) continue;
    if (entry.type === "assistant" && isRecord(message.usage)) {
      const usage = message.usage;
      const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);
      const realContext =
        asNumber(usage.input_tokens) +
        asNumber(usage.cache_creation_input_tokens) +
        asNumber(usage.cache_read_input_tokens);
      if (realContext > 0) {
        stats.realUsageSamples++;
        if (realContext > stats.realUsagePeak) stats.realUsagePeak = realContext;
        if (realContext > 150_000) stats.realUsageTurnsAbove150k++;
      }
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        if (RECALL_TOOL_NAME.test(block.name)) recallToolUseIds.add(block.id);
      } else if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        recallToolUseIds.has(block.tool_use_id)
      ) {
        stats.recallResultCount++;
        stats.recallChars += measureContentChars(block.content);
      }
    }
  }
  return stats;
}

export interface ProxyLogContents {
  requests: RequestLogEntry[];
  trips: TripLogEntry[];
}

export function parseProxyLog(path: string): ProxyLogContents {
  const requests: RequestLogEntry[] = [];
  const trips: TripLogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let entry: ProxyLogEntry;
    try {
      entry = JSON.parse(line) as ProxyLogEntry;
    } catch {
      continue;
    }
    if (entry.kind === "request" && entry.path.split("?")[0] === "/v1/messages") requests.push(entry);
    else if (entry.kind === "trip") trips.push(entry);
  }
  return { requests, trips };
}
