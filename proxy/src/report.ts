#!/usr/bin/env node
// Reads a Claude Code session transcript (read-only) plus the proxy's JSONL log and prints:
// compaction count, tokens evicted, tokens recalled, and per-request size over time.
//
//   npm run report -- <session-jsonl-path> [proxy-log-path]

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { formatThousands, measureContentChars } from "./evict.js";
import {
  latestProxyLogPath,
  proxyLogDir,
  type JudgeLogEntry,
  type ProxyLogEntry,
  type RequestLogEntry,
  type TripLogEntry,
} from "./log.js";
import { describeRebuild, formatDuration, GAUGE_MIN_ESTIMATED_TOKENS, type RebuildKind } from "./speed.js";

const RECALL_TOOL_NAME = /(^|__)recall_(search|get)$/;
const REBUILD_KINDS: RebuildKind[] = ["first", "after-trip", "after-idle", "unexpected"];
const BAR_WIDTH = 24;

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

function parseProxyLog(path: string): { requests: RequestLogEntry[]; trips: TripLogEntry[]; judges: JudgeLogEntry[] } {
  const requests: RequestLogEntry[] = [];
  const trips: TripLogEntry[] = [];
  const judges: JudgeLogEntry[] = [];
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
    else if (entry.kind === "judge") judges.push(entry);
  }
  return { requests, trips, judges };
}

/**
 * What the judge did. Its picks never show up as trips — they are applied by re-stubbing on the
 * next request — so without this section its work is invisible in the report.
 */
function printJudgeSummary(judges: JudgeLogEntry[]): void {
  if (judges.length === 0) return;
  const ran = judges.filter((judge) => judge.skipped !== true && judge.error === undefined);
  const failed = judges.filter((judge) => judge.error !== undefined);
  const skipped = judges.filter((judge) => judge.skipped === true);
  const sum = (pick: (judge: JudgeLogEntry) => number): number => judges.reduce((total, judge) => total + pick(judge), 0);
  const reasons: [string, number][] = [
    ["unknown id", sum((judge) => judge.rejected.unknownId)],
    ["inside the protected window", sum((judge) => judge.rejected.protectedWindow)],
    ["too small to be worth stubbing", sum((judge) => judge.rejected.tooSmall)],
    ["quote not found in the block", sum((judge) => judge.rejected.keepMismatch)],
    ["user block with no quote and no note", sum((judge) => judge.rejected.noKeepOrNote)],
    ["assistant text", sum((judge) => judge.rejected.assistantText)],
    ["quote or note on a non-user block", sum((judge) => judge.rejected.keepOnNonUserBlock)],
  ];
  const rejectedTotal = reasons.reduce((total, [, count]) => total + count, 0);

  console.log("Judge:");
  console.log(
    `  calls: ${ran.length} answered, ${failed.length} failed after retry, ` +
      `${skipped.length} skipped (one already running)`,
  );
  console.log(
    `  picks: ${sum((judge) => judge.accepted)} accepted of ${sum((judge) => judge.proposed)} proposed — ` +
      `${formatThousands(sum((judge) => judge.charsRemovedEstimate))} chars of content selected`,
  );
  console.log(`  rejected by guard: ${rejectedTotal} total`);
  for (const [reason, count] of reasons) {
    if (count > 0) console.log(`    ${String(count).padStart(4)}  ${reason}`);
  }
  console.log(
    `  judge tokens: ${formatThousands(sum((judge) => judge.inputTokens ?? 0))} in, ` +
      `${formatThousands(sum((judge) => judge.outputTokens ?? 0))} out`,
  );
  console.log(
    `  ${"time".padEnd(8)}  ${"took".padStart(7)}  ${"proposed".padStart(8)}  ${"accepted".padStart(8)}  ` +
      `${"chars".padStart(9)}  note`,
  );
  for (const judge of judges) {
    const note = judge.skipped === true ? "skipped — a judge was already running" : (judge.error ?? "");
    console.log(
      `  ${timeOfDay(judge.timestamp)}  ${formatDuration(judge.durationMs).padStart(7)}  ` +
        `${String(judge.proposed).padStart(8)}  ${String(judge.accepted).padStart(8)}  ` +
        `${formatThousands(judge.charsRemovedEstimate).padStart(9)}  ${note}`,
    );
  }
  console.log("");
}

function timeOfDay(isoTimestamp: string): string {
  const timePart = isoTimestamp.split("T")[1];
  return timePart === undefined ? isoTimestamp : timePart.slice(0, 8);
}

function collectDefined(requests: RequestLogEntry[], pick: (request: RequestLogEntry) => number | undefined): number[] {
  return requests.map(pick).filter((value): value is number => value !== undefined);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function formatMedian(values: number[]): string {
  const middle = median(values);
  return middle === null ? "n/a" : formatDuration(middle);
}

function formatMedianAndMax(values: number[]): string {
  const middle = median(values);
  return middle === null ? "n/a" : `median ${formatDuration(middle)}, max ${formatDuration(Math.max(...values))}`;
}

/**
 * A rebuild means Anthropic re-read the conversation instead of serving it from cache — a few
 * extra seconds on that turn. It is normal on the session's first request, on the request
 * where the proxy tripped, and after the cache expires. Anything else is a bug.
 */
function printSpeedSummary(requests: RequestLogEntry[]): void {
  // Same floor the proxy applies: small side calls have their own cache prefix, so mixing them
  // into the cached-versus-rebuilt comparison compares two different conversations.
  const conversation = requests.filter(
    (request) => (request.estimatedTokensSent ?? 0) >= GAUGE_MIN_ESTIMATED_TOKENS,
  );
  const rebuilt = conversation.filter((request) => request.rebuild !== undefined);
  const cached = conversation.filter((request) => request.rebuild === undefined);
  const byKind = REBUILD_KINDS.map(
    (kind) => `${conversation.filter((request) => request.rebuild === kind).length} ${describeRebuild(kind)}`,
  );

  console.log("Speed:");
  console.log(
    `  proxy's own time per request: ${formatMedianAndMax(collectDefined(requests, (r) => r.proxyMs))} ` +
      `(over all ${requests.length} requests)`,
  );
  console.log(
    `  conversation requests, over ${formatThousands(GAUGE_MIN_ESTIMATED_TOKENS)} tokens ` +
      `(smaller side calls are not gauged): ${conversation.length}`,
  );
  console.log(`    rebuilds: ${rebuilt.length} — ${byKind.join(", ")} (goal: 0 unexpected)`);
  console.log(
    `    wait for the first byte: ${formatMedian(collectDefined(cached, (r) => r.upstreamFirstByteMs))} cached, ` +
      `${formatMedian(collectDefined(rebuilt, (r) => r.upstreamFirstByteMs))} rebuilt`,
  );
  console.log("");
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
  const proxyLogPath = proxyLogArg ?? latestProxyLogPath();

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

  if (proxyLogPath === null || !existsSync(proxyLogPath)) {
    console.log(
      `Proxy log: none found at ${proxyLogPath ?? proxyLogDir} — start the proxy and run the session through it.`,
    );
    return;
  }

  const { requests, trips, judges } = parseProxyLog(proxyLogPath);
  const evictedIdCount = trips.reduce((sum, trip) => sum + trip.addedToolUseIds.length, 0);
  const tripCharsRemoved = trips.reduce((sum, trip) => sum + trip.charsRemoved, 0);
  // Judge picks are applied by re-stubbing on a later request, so they never land in a trip
  // record. Left out of the total, the headline under-reports everything the judge removed.
  const judgeCharsRemoved = judges.reduce((sum, judge) => sum + judge.charsRemovedEstimate, 0);
  const tokensEvictedOnce = Math.round((tripCharsRemoved + judgeCharsRemoved) / 4);
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
    `  eviction trips: ${trips.length} — ${evictedIdCount} segments evicted by the rules, ` +
      `${formatThousands(tripCharsRemoved)} chars removed`,
  );
  if (judgeCharsRemoved > 0) {
    console.log(`  judge picks: ${formatThousands(judgeCharsRemoved)} chars selected on top of the rules`);
  }
  console.log(`  tokens evicted (one-time, chars/4, rules + judge): ${formatThousands(tokensEvictedOnce)}`);
  console.log(`  tokens kept out of requests (cumulative over turns): ${formatThousands(cumulativeTokensKeptOut)}`);
  console.log("");
  console.log(`Product metric — tokens evicted : tokens recalled = ${ratioLine(tokensEvictedOnce, recalledTokens)}`);
  console.log("");

  printJudgeSummary(judges);

  if (requests.length === 0) return;
  printSpeedSummary(requests);

  console.log("Per /v1/messages request (chart = estimated tokens sent; flat is good, unproxied it climbs):");
  console.log(
    `  ${"#".padStart(4)}  ${"time".padEnd(8)}  ${"sent tok".padStart(9)}  ${"proxy".padStart(7)}  ` +
      `${"1st byte".padStart(8)}  ${"cached".padStart(9)}  ${"new".padStart(7)}  chart`,
  );
  const maxSent = Math.max(...requests.map((request) => request.estimatedTokensSent ?? 0), 1);
  const column = (value: number | undefined, format: (value: number) => string, width: number): string =>
    (value === undefined ? "-" : format(value)).padStart(width);

  requests.forEach((request, index) => {
    const sent = request.estimatedTokensSent ?? 0;
    const before = request.estimatedTokensBefore ?? sent;
    const bar = "#".repeat(Math.max(sent > 0 ? 1 : 0, Math.round((sent / maxSent) * BAR_WIDTH)));
    const marks: string[] = [];
    if ((request.newlyEvictedCount ?? 0) > 0) marks.push("trip");
    if (request.rebuild !== undefined) {
      marks.push(
        request.rebuild === "unexpected" ? "REBUILD (unexpected)" : `rebuild (${describeRebuild(request.rebuild)})`,
      );
    }
    console.log(
      `  ${String(index + 1).padStart(4)}  ${timeOfDay(request.timestamp)}  ${formatThousands(sent).padStart(9)}  ` +
        `${column(request.proxyMs, formatDuration, 7)}  ${column(request.upstreamFirstByteMs, formatDuration, 8)}  ` +
        `${column(request.cacheReadInputTokens, formatThousands, 9)}  ` +
        `${column(request.cacheCreationInputTokens, formatThousands, 7)}  ` +
        `${bar}${before !== sent ? `  (raw ${formatThousands(before)})` : ""}` +
        `${marks.length === 0 ? "" : `  <- ${marks.join(", ")}`}`,
    );
  });
}

await main();
