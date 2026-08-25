#!/usr/bin/env node
// Reads a Claude Code session transcript (read-only) plus the proxy's JSONL log and prints:
// compaction count, tokens evicted, tokens recalled, and per-request size over time.
//
//   npm run report -- <session-jsonl-path> [proxy-log-path]

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { formatThousands, measureContentChars } from "./evict.js";
import { defaultProxyLogPath, type ProxyLogEntry, type RequestLogEntry, type TripLogEntry } from "./log.js";

const RECALL_TOOL_NAME = /(^|__)recall_(search|get)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TranscriptStats {
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

async function scanTranscript(path: string): Promise<TranscriptStats> {
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

function parseProxyLog(path: string): { requests: RequestLogEntry[]; trips: TripLogEntry[] } {
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

function timeOfDay(isoTimestamp: string): string {
  const timePart = isoTimestamp.split("T")[1];
  return timePart === undefined ? isoTimestamp : timePart.slice(0, 8);
}

function ratioLine(tokensEvicted: number, tokensRecalled: number): string {
  if (tokensEvicted === 0) return "n/a — nothing evicted";
  if (tokensRecalled === 0) return `${formatThousands(tokensEvicted)} : 0 — nothing recalled yet`;
  return `${Math.round(tokensEvicted / tokensRecalled)} : 1`;
}

async function main(): Promise<void> {
  const [sessionPath, proxyLogArg] = process.argv.slice(2);
  if (sessionPath === undefined) {
    console.error("usage: onepass-report <session-jsonl-path> [proxy-log-path]");
    process.exit(1);
  }
  if (!existsSync(sessionPath)) {
    console.error(`no transcript at ${sessionPath}`);
    process.exit(1);
  }
  const proxyLogPath = proxyLogArg ?? defaultProxyLogPath;

  const transcript = await scanTranscript(sessionPath);
  const recalledTokens = Math.round(transcript.recallChars / 4);

  console.log(`Onepass report — ${basename(sessionPath)}`);
  console.log("");
  console.log(`Transcript: ${sessionPath}`);
  console.log(
    `  entries: ${transcript.entryCount}` +
      (transcript.firstTimestamp !== null ? ` (${transcript.firstTimestamp} -> ${transcript.lastTimestamp})` : ""),
  );
  console.log(`  compactions: ${transcript.compactionCount}  (target: 0)`);
  if (transcript.realUsageSamples > 0) {
    console.log(
      `  peak real context (API-reported usage): ${formatThousands(transcript.realUsagePeak)} tokens ` +
        `over ${transcript.realUsageSamples} assistant turns — ` +
        `${transcript.realUsageTurnsAbove150k} above 150,000 (goal: 0)`,
    );
  }
  console.log(
    `  recall results: ${transcript.recallResultCount} — ~${formatThousands(recalledTokens)} tokens recalled`,
  );
  console.log("");

  if (!existsSync(proxyLogPath)) {
    console.log(`Proxy log: none found at ${proxyLogPath} — start the proxy and run the session through it.`);
    return;
  }

  const { requests, trips } = parseProxyLog(proxyLogPath);
  const evictedIdCount = trips.reduce((sum, trip) => sum + trip.addedToolUseIds.length, 0);
  const tripCharsRemoved = trips.reduce((sum, trip) => sum + trip.charsRemoved, 0);
  const tokensEvictedOnce = Math.round(tripCharsRemoved / 4);
  const cumulativeTokensKeptOut = requests.reduce(
    (sum, request) =>
      request.estimatedTokensBefore !== undefined && request.estimatedTokensSent !== undefined
        ? sum + (request.estimatedTokensBefore - request.estimatedTokensSent)
        : sum,
    0,
  );

  console.log(`Proxy log: ${proxyLogPath}`);
  console.log(`  /v1/messages requests: ${requests.length}`);
  console.log(
    `  eviction trips: ${trips.length} — ${evictedIdCount} tool results evicted, ` +
      `${formatThousands(tripCharsRemoved)} chars removed`,
  );
  console.log(`  tokens evicted (one-time, chars/4): ${formatThousands(tokensEvictedOnce)}`);
  console.log(`  tokens kept out of requests (cumulative over turns): ${formatThousands(cumulativeTokensKeptOut)}`);
  console.log("");
  console.log(`Product metric — tokens evicted : tokens recalled = ${ratioLine(tokensEvictedOnce, recalledTokens)}`);
  console.log("");

  if (requests.length === 0) return;
  console.log("Estimated tokens sent per /v1/messages request (flat is good; unproxied it climbs):");
  const maxSent = Math.max(...requests.map((request) => request.estimatedTokensSent ?? 0), 1);
  requests.forEach((request, index) => {
    const sent = request.estimatedTokensSent ?? 0;
    const before = request.estimatedTokensBefore ?? sent;
    const bar = "#".repeat(Math.max(sent > 0 ? 1 : 0, Math.round((sent / maxSent) * 40)));
    const tripMark = (request.newlyEvictedCount ?? 0) > 0 ? "  <- trip" : "";
    console.log(
      `  ${String(index + 1).padStart(4)}  ${timeOfDay(request.timestamp)}  ` +
        `${formatThousands(sent).padStart(9)}  ${bar}${before !== sent ? `  (raw ${formatThousands(before)})` : ""}${tripMark}`,
    );
  });
}

await main();
