// Replay: what this build evicts, checked for nothing.
//
// This is the check run after every proxy fix. It makes no model calls and costs no money, so it
// can be run on a whim and there is no reason to skip it.
//
// What goes in is a recording: the raw request bodies a real Claude Code session sent through a
// proxy, written to disk untouched before anything was evicted. Nothing here rebuilds a request.
// It used to, from the transcript, and that was the bug this replaced — the transcript does not
// hold what was sent, so three of the proxy's rules were keyed on text no replayed body ever
// carried and could have been deleted with replay still reporting everything identical.
//
// **One child for the whole sequence, in order.** Eviction is monotonic: what the proxy does at
// request 400 depends on everything it took at requests 1 to 399. A fresh child per request, or a
// run over only the deep ones, would hand the proxy a history the session never had, and the
// answer would be about that history rather than about the build. So every recorded request goes
// through one child, in the order it was recorded, and the report is a subset of what came out.
//
// It is not scored. There is no verdict here and no bar to clear: the output is a diff against the
// previous build, and a diff is read, not passed.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EvalError } from "./errors.js";
import type { FakeUpstream } from "./fakeUpstream.js";
import { withProxyChild, type ProxyBuild } from "./proxy.js";
import { bodyOf, type Recording, type RecordingSet } from "./recordings.js";

/**
 * The proxy's stub marker. Held here rather than imported: the eval measures a proxy it builds from
 * source, and reaching into that build's source for the constant would make a build that renamed
 * its stubs look like a build that stopped evicting.
 */
export const STUB_PREFIX = "[onepass: evicted";

/** Long enough for a log line still in the write stream's buffer, short enough to fail a run. */
const LOG_WAIT_MS = 10_000;

/** What one recorded request did when this build saw it. */
export interface ReplayOutcome {
  /** The recording's own id, which is fixed on disk and so is stable across builds. */
  id: string;
  /** Where in the recorded sequence it sits, from 1. */
  position: number;
  /** `/v1/messages` or `/v1/messages/count_tokens`. Both are evicted; only the first is answered. */
  path: string;
  /**
   * Bytes of the recorded body. This is the input, fixed on disk, so it cannot move when the proxy
   * changes: it is here to say how deep the request was, and is never read as evidence about a build.
   */
  recordedBytes: number;
  /** Bytes of the body the proxy handed the upstream. The difference is what eviction bought. */
  forwardedBytes: number;
  /**
   * The proxy decided this request was over its trip threshold. Read from the proxy's own log,
   * which records the decision itself — not inferred from whether anything was evicted, because
   * over the line with nothing eligible is the failure most worth catching and looks identical to
   * a quiet request from the outside.
   */
  overThreshold: boolean;
  /** Blocks this request was the first to take. Zero on a request that re-sent earlier stubs. */
  newlyEvicted: number;
  /** Blocks the forwarded body carries a stub in place of, new ones and old ones alike. */
  stubbed: number;
  /**
   * Every stub of the request, in one line. A deep request carries dozens, and a result document
   * holding all of them would be hundreds of kilobytes of near-identical text — so the digest is
   * what the diff compares and the examples are what it prints. The stubs themselves are in the
   * forwarded body, which is kept in the corpus for the requests the report covers.
   */
  stubDigest: string;
  /** The first few stubs, so a change in their wording can be read rather than only detected. */
  stubExamples: string[];
  estimatedTokensBefore: number | null;
  estimatedTokensSent: number | null;
  /** The forwarded body under the run's corpus directory, for reported requests; null otherwise. */
  bodyPath: string | null;
}

export interface ReplayOptions {
  build: ProxyBuild;
  /** The recording to replay, in the order it was recorded. */
  recordings: RecordingSet;
  /** The fake the proxy child forwards to. Replay never reaches the network. */
  upstream: FakeUpstream;
  /** Where the forwarded bodies are written: the run's own directory under the corpus. */
  runDir: string;
  /** Ids of the requests the report covers. Only their forwarded bodies are kept. */
  reported: ReadonlySet<string>;
  /** Called before each request goes through, so a long sequence shows progress. */
  onRequest?: (recording: Recording, position: number, total: number) => void;
}

/**
 * Sends every recorded request through one proxy child, in order, and reports what came out.
 *
 * The whole sequence runs inside a single child: see the note at the top of this file for why
 * that is not an optimisation but the thing that makes the answer mean anything.
 */
export async function replayRecordings(options: ReplayOptions): Promise<ReplayOutcome[]> {
  const bodiesDir = join(options.runDir, "replay");
  mkdirSync(bodiesDir, { recursive: true });
  const requests = options.recordings.requests;

  return withProxyChild(options.build, { upstreamUrl: options.upstream.url }, async (child) => {
    const outcomes: ReplayOutcome[] = [];
    for (const [index, recording] of requests.entries()) {
      options.onRequest?.(recording, index + 1, requests.length);
      outcomes.push(await replayOne(recording, index, child.baseUrl, child.logFilePath, options, bodiesDir));
    }
    return outcomes;
  });
}

async function replayOne(
  recording: Recording,
  index: number,
  baseUrl: string,
  logFilePath: string,
  options: ReplayOptions,
  bodiesDir: string,
): Promise<ReplayOutcome> {
  const body = bodyOf(options.recordings, recording);
  const seen = options.upstream.requests.length;

  const response = await fetch(`${baseUrl}${recording.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body,
  });
  const answered = await response.text();
  if (!response.ok) {
    throw new EvalError(`replaying ${recording.id} through the proxy answered ${response.status}: ${answered.trim()}`);
  }

  const forwarded = options.upstream.requests.slice(seen).find((request) => request.url.startsWith("/v1/messages"));
  if (forwarded === undefined) {
    throw new EvalError(`replaying ${recording.id} reached the proxy but nothing reached the upstream behind it`);
  }
  // The child logs one request entry per request it handled, in the order it handled them, so the
  // entry for this one is the entry at this one's place in the sequence.
  const logged = await waitForRequestEntry(logFilePath, index, recording.id);
  const stubs = readStubs(forwarded.body);

  const reported = options.reported.has(recording.id);
  const bodyPath = reported ? join(bodiesDir, `${recording.id}.json`) : null;
  if (bodyPath !== null) writeFileSync(bodyPath, forwarded.body);

  return {
    id: recording.id,
    position: index + 1,
    path: recording.path,
    recordedBytes: recording.bytes,
    forwardedBytes: Buffer.byteLength(forwarded.body),
    overThreshold: logged.overThreshold,
    newlyEvicted: logged.newlyEvicted,
    stubbed: stubs.length,
    stubDigest: digestOf(stubs),
    stubExamples: stubs.slice(0, STUB_EXAMPLES),
    estimatedTokensBefore: logged.estimatedTokensBefore,
    estimatedTokensSent: logged.estimatedTokensSent,
    bodyPath,
  };
}

interface LoggedRequest {
  overThreshold: boolean;
  newlyEvicted: number;
  estimatedTokensBefore: number | null;
  estimatedTokensSent: number | null;
}

/**
 * What the child logged about the request at `index` of the sequence.
 *
 * The proxy logs through a buffered write stream, so the line can still be in flight when the
 * response has already come back. Reading once would hand back the previous request's line and
 * report this request's numbers as that one's, so this waits for the line and says plainly when it
 * never came.
 */
async function waitForRequestEntry(logFilePath: string, index: number, id: string): Promise<LoggedRequest> {
  const deadline = Date.now() + LOG_WAIT_MS;
  for (;;) {
    const requests = readLog(logFilePath).filter((entry) => entry.kind === "request");
    const entry = requests[index];
    if (entry !== undefined) {
      return {
        overThreshold: entry.overThreshold === true,
        newlyEvicted: typeof entry.newlyEvictedCount === "number" ? entry.newlyEvictedCount : 0,
        estimatedTokensBefore: numberOrNull(entry.estimatedTokensBefore),
        estimatedTokensSent: numberOrNull(entry.estimatedTokensSent),
      };
    }
    if (Date.now() >= deadline) {
      throw new EvalError(
        `the proxy child logged ${requests.length} request(s) in ${LOG_WAIT_MS}ms at ${logFilePath}, and ` +
          `${id} is number ${index + 1}. Replay reads what the build did from that log, so there is ` +
          `nothing to report for it.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface LogEntry {
  kind?: unknown;
  overThreshold?: unknown;
  newlyEvictedCount?: unknown;
  estimatedTokensBefore?: unknown;
  estimatedTokensSent?: unknown;
}

function readLog(path: string): LogEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // A line still being written is half a line. The next read will see the whole of it.
    }
  }
  return entries;
}

/**
 * The stubs in a forwarded body. Read off the serialized body rather than by walking the message
 * tree: a stub can stand in for a tool result, a tool call's input or a block of injected text, and
 * what replay is checking is that the text the model would see is the text this build writes.
 */
function readStubs(body: string): string[] {
  // Built from the constant rather than spelled again: a second copy of the marker would let a
  // renamed stub go on being found here while nothing else recognised it.
  const marker = new RegExp(`${STUB_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*`, "g");
  const stubs: string[] = [];
  for (const match of body.matchAll(marker)) stubs.push(unescapeJson(match[0]));
  return stubs;
}

/** How many stubs a result document keeps in full. Enough to read a wording change off. */
const STUB_EXAMPLES = 3;

/** The whole stub text of a request in twelve characters, which is what the diff compares. */
function digestOf(stubs: readonly string[]): string {
  return createHash("sha256").update(stubs.join("\n")).digest("hex").slice(0, 12);
}

/** The body is JSON, so a stub read out of it still carries the escapes JSON put in. */
function unescapeJson(text: string): string {
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What a run of replay came to, over every recorded request it sent. */
export interface ReplayTotals {
  requests: number;
  /** Requests the proxy judged over its trip threshold. */
  overThreshold: number;
  /**
   * Requests over the threshold that evicted nothing. This is the number to read first: the proxy
   * decided the conversation was too big and then found nothing it was allowed to take.
   */
  overThresholdNothingEvicted: number;
  /** Blocks evicted for the first time, summed. Each is taken once and stays taken. */
  newlyEvicted: number;
  /** Stubs in the forwarded bodies, summed. A block already evicted is stubbed again every request. */
  stubbed: number;
  /** Bytes the proxy forwarded, summed. What eviction bought over the whole session. */
  forwardedBytes: number;
}

export function totalsOf(outcomes: readonly ReplayOutcome[]): ReplayTotals {
  return {
    requests: outcomes.length,
    overThreshold: outcomes.filter((outcome) => outcome.overThreshold).length,
    overThresholdNothingEvicted: outcomes.filter((outcome) => outcome.overThreshold && outcome.newlyEvicted === 0)
      .length,
    newlyEvicted: outcomes.reduce((sum, outcome) => sum + outcome.newlyEvicted, 0),
    stubbed: outcomes.reduce((sum, outcome) => sum + outcome.stubbed, 0),
    forwardedBytes: outcomes.reduce((sum, outcome) => sum + outcome.forwardedBytes, 0),
  };
}

/** One thing that moved between two builds on one recorded request. */
export interface ReplayChange {
  id: string;
  what: "over threshold" | "newly evicted" | "stubbed" | "stub text" | "bytes forwarded";
  previous: string;
  current: string;
}

export interface ReplayDiff {
  /** The run this was compared with, or null when there was none. */
  comparedWith: string | null;
  /** Null when there was nothing to compare with, and null when the comparison was refused. */
  totals: { previous: ReplayTotals; current: ReplayTotals } | null;
  changes: ReplayChange[];
  /** Requests both builds sent that came out the same. */
  unchanged: number;
  /** Requests only one of the two runs sent. Either being non-empty is what refuses the comparison. */
  onlyInPrevious: string[];
  onlyInCurrent: string[];
  /**
   * Outcomes in the previous run's document that name no request at all. A document written before
   * replay read recordings has no request ids in it, so none of its outcomes can be matched and
   * none can be named. Counting them says that plainly, rather than printing a row of empty names.
   */
  unnamedInPrevious: number;
}

/**
 * What this build did that the previous one did not.
 *
 * A recording that has drifted refuses the comparison outright rather than diffing the requests the
 * two runs happen to share. A total over one sequence against a total over another is not a
 * comparison — it is two numbers side by side. Failing loudly is the point: the caller reports the
 * drift, and nothing is left that a reader could take for a verdict on the build.
 */
export function diffReplays(
  comparedWith: string | null,
  previous: readonly ReplayOutcome[] | null,
  current: readonly ReplayOutcome[],
): ReplayDiff {
  const empty = { comparedWith, totals: null, changes: [], unchanged: 0, onlyInPrevious: [], onlyInCurrent: [] };
  if (previous === null) return { ...empty, unnamedInPrevious: 0 };
  // A result document is read off disk, so its shape is a hope and not a promise: one written by an
  // earlier eval named its outcomes by case and not by request, and reading `id` off those gives
  // nothing. They are counted rather than listed, because a name they do not have cannot be printed.
  const named = previous.filter((outcome) => typeof outcome.id === "string" && outcome.id !== "");
  const unnamedInPrevious = previous.length - named.length;
  const before = new Map(named.map((outcome) => [outcome.id, outcome]));
  const after = new Map(current.map((outcome) => [outcome.id, outcome]));
  const onlyInPrevious = named.filter((outcome) => !after.has(outcome.id)).map((outcome) => outcome.id);
  const onlyInCurrent = current.filter((outcome) => !before.has(outcome.id)).map((outcome) => outcome.id);
  if (onlyInPrevious.length > 0 || onlyInCurrent.length > 0 || unnamedInPrevious > 0) {
    return { ...empty, onlyInPrevious, onlyInCurrent, unnamedInPrevious };
  }

  const changes: ReplayChange[] = [];
  let unchanged = 0;
  for (const outcome of current) {
    const found = changesBetween(before.get(outcome.id) as ReplayOutcome, outcome);
    if (found.length === 0) unchanged += 1;
    else changes.push(...found);
  }

  return {
    comparedWith,
    totals: { previous: totalsOf(previous), current: totalsOf(current) },
    changes,
    unchanged,
    onlyInPrevious,
    onlyInCurrent,
    unnamedInPrevious,
  };
}

/**
 * Everything compared here can move when the proxy changes and cannot move otherwise. The recorded
 * body's size is left out on purpose: it is a file on disk, identical for every build, so counting
 * it as agreement would pad the tally with something that could never disagree.
 */
function changesBetween(was: ReplayOutcome, now: ReplayOutcome): ReplayChange[] {
  const changes: ReplayChange[] = [];
  const note = (what: ReplayChange["what"], previous: string, current: string): void => {
    if (previous !== current) changes.push({ id: now.id, what, previous, current });
  };
  note("over threshold", String(was.overThreshold), String(now.overThreshold));
  note("newly evicted", String(was.newlyEvicted), String(now.newlyEvicted));
  note("stubbed", String(was.stubbed), String(now.stubbed));
  note("bytes forwarded", String(was.forwardedBytes), String(now.forwardedBytes));
  note("stub text", describeStubs(was), describeStubs(now));
  return changes;
}

/** A request's stub text as one line: the digest that decides, and a stub that shows what changed. */
function describeStubs(outcome: ReplayOutcome): string {
  if (outcome.stubbed === 0) return "none";
  return `${outcome.stubDigest} (e.g. ${outcome.stubExamples[0] ?? "unrecorded"})`;
}
