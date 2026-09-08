// Replay: what this build evicts, checked for nothing.
//
// This is the check run after every proxy fix. It makes no model calls and costs no money, so it
// can be run on a whim and there is no reason to skip it. Each case's message list is put into a
// request body with a placeholder system prompt — eviction acts on messages, not on the system
// prompt, so a real one would only be bytes nothing reads — and pushed through a proxy child of
// its own against the fake upstream. What comes out the far side is read off two places: the body
// the fake received, which is the whole of what the proxy decided, and the child's own log, which
// is where the trip and the rebuild classification are written.
//
// One child per case, torn down after. A child that has already evicted something is carrying
// state the next case did not put there, and every case has to see the build cold.
//
// It is not scored. There is no verdict here and no bar to clear: the output is a diff against the
// previous build, and a diff is read, not passed.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnswerLabel, PlanningCase } from "./cases.js";
import { EvalError } from "./errors.js";
import type { FakeUpstream } from "./fakeUpstream.js";
import { withProxyChild, type ProxyBuild } from "./proxy.js";

/**
 * The proxy's stub marker. Held here rather than imported: the eval measures a proxy it builds from
 * source, and reaching into that build's source for the constant would make a build that renamed
 * its stubs look like a build that stopped evicting.
 */
export const STUB_PREFIX = "[onepass: evicted";

/** Stands in for Claude Code's system prompt, which the transcript does not hold and no rule reads. */
export const PLACEHOLDER_SYSTEM =
  "[onepass-eval replay] Placeholder system prompt. Eviction acts on the message list, not on the " +
  "system prompt, so nothing here changes what the proxy does.";

/** The model named on the replayed body. Nothing answers it: the fake upstream serves one line. */
const REPLAY_MODEL = "claude-opus-5";

/** Long enough for a log line still in the write stream's buffer, short enough to fail a run. */
const LOG_WAIT_MS = 5_000;

/** What one case did when this build saw it. */
export interface ReplayOutcome {
  caseId: string;
  turnIndex: number;
  prefixTokens: number;
  answer: AnswerLabel;
  /** Bytes of the body replay handed the proxy. */
  sentBytes: number;
  /** Bytes of the body the proxy handed the upstream. The difference is what eviction bought. */
  forwardedBytes: number;
  /** The request crossed the threshold, whether or not anything new was eligible. */
  tripped: boolean;
  /** Segments the forwarded body carries a stub in place of. */
  segmentsEvicted: number;
  /**
   * Every stub of the case, in one line. A deep case writes dozens, and a result document that
   * carried all of them would be hundreds of kilobytes of near-identical text inside the
   * repository — so the digest is what the diff compares and the examples are what it prints. The
   * stubs themselves are in the forwarded body, which is kept in the corpus.
   */
  stubDigest: string;
  /** The first few stubs, so a change in their wording can be read rather than only detected. */
  stubExamples: string[];
  /** How the proxy classified the request against the cache, or null when it classified none. */
  rebuild: string | null;
  estimatedTokensBefore: number | null;
  estimatedTokensSent: number | null;
  /** The forwarded body, written under the run's corpus directory. */
  bodyPath: string;
}

export interface ReplayOptions {
  build: ProxyBuild;
  cases: readonly PlanningCase[];
  /** The fake the proxy children forward to. Replay never reaches the network. */
  upstream: FakeUpstream;
  /** Where the forwarded bodies are written: the run's own directory under the corpus. */
  runDir: string;
  /** Called before each case is run, which is what makes replay a look at a scored run's coverage. */
  onCase?: (planningCase: PlanningCase, position: number, total: number) => void;
}

export async function replayCases(options: ReplayOptions): Promise<ReplayOutcome[]> {
  const bodiesDir = join(options.runDir, "replay");
  mkdirSync(bodiesDir, { recursive: true });

  const outcomes: ReplayOutcome[] = [];
  for (const [position, planningCase] of options.cases.entries()) {
    options.onCase?.(planningCase, position, options.cases.length);
    outcomes.push(await replayOne(planningCase, options, bodiesDir));
  }
  return outcomes;
}

async function replayOne(planningCase: PlanningCase, options: ReplayOptions, bodiesDir: string): Promise<ReplayOutcome> {
  const body = JSON.stringify({
    model: REPLAY_MODEL,
    max_tokens: 1_024,
    system: PLACEHOLDER_SYSTEM,
    messages: planningCase.messages,
  });
  const seen = options.upstream.requests.length;

  return withProxyChild(options.build, { upstreamUrl: options.upstream.url }, async (child) => {
    const response = await fetch(`${child.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body,
    });
    const answered = await response.text();
    if (!response.ok) {
      throw new EvalError(
        `replaying ${planningCase.id} through the proxy answered ${response.status}: ${answered.trim()}`,
      );
    }

    const forwarded = options.upstream.requests.slice(seen).find((request) => request.url.startsWith("/v1/messages"));
    if (forwarded === undefined) {
      throw new EvalError(`replaying ${planningCase.id} reached the proxy but nothing reached the upstream behind it`);
    }
    const logged = await waitForRequestEntry(child.logFilePath);

    const bodyPath = join(bodiesDir, `${planningCase.id}.json`);
    writeFileSync(bodyPath, forwarded.body);
    const stubs = readStubs(forwarded.body);

    return {
      caseId: planningCase.id,
      turnIndex: planningCase.turnIndex,
      prefixTokens: planningCase.prefixTokens,
      answer: planningCase.answer,
      sentBytes: Buffer.byteLength(body),
      forwardedBytes: Buffer.byteLength(forwarded.body),
      tripped: logged.tripped,
      segmentsEvicted: stubs.length,
      stubDigest: digestOf(stubs),
      stubExamples: stubs.slice(0, STUB_EXAMPLES),
      rebuild: logged.rebuild,
      estimatedTokensBefore: logged.estimatedTokensBefore,
      estimatedTokensSent: logged.estimatedTokensSent,
      bodyPath,
    };
  });
}

interface LoggedRequest {
  tripped: boolean;
  rebuild: string | null;
  estimatedTokensBefore: number | null;
  estimatedTokensSent: number | null;
}

/**
 * What the child logged about the one request replay made it.
 *
 * The proxy logs through a buffered write stream, so the line can still be in flight when the
 * response has already come back. Reading once would hand back an empty file and report a trip
 * that happened as one that did not, so this waits for the line and says plainly when it never
 * came.
 */
async function waitForRequestEntry(logFilePath: string): Promise<LoggedRequest> {
  const deadline = Date.now() + LOG_WAIT_MS;
  for (;;) {
    const entries = readLog(logFilePath);
    const request = entries.find((entry) => entry.kind === "request" && entry.path === "/v1/messages");
    if (request !== undefined) {
      // The proxy logs a trip as its own line; the request line carries the sizes and the rebuild.
      const tripped = entries.some((entry) => entry.kind === "trip");
      return {
        tripped,
        rebuild: typeof request.rebuild === "string" ? request.rebuild : null,
        estimatedTokensBefore: numberOrNull(request.estimatedTokensBefore),
        estimatedTokensSent: numberOrNull(request.estimatedTokensSent),
      };
    }
    if (Date.now() >= deadline) {
      throw new EvalError(
        `the proxy child logged no /v1/messages request in ${LOG_WAIT_MS}ms at ${logFilePath}. ` +
          `Replay reads what the build did from that log, so there is nothing to report.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface LogEntry {
  kind?: unknown;
  path?: unknown;
  rebuild?: unknown;
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

/** The whole stub text of a case in twelve characters, which is what the diff compares. */
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

/** What a run of replay came to, over all its cases. */
export interface ReplayTotals {
  cases: number;
  trips: number;
  segmentsEvicted: number;
  sentBytes: number;
  forwardedBytes: number;
  rebuilds: number;
}

export function totalsOf(outcomes: readonly ReplayOutcome[]): ReplayTotals {
  return {
    cases: outcomes.length,
    trips: outcomes.filter((outcome) => outcome.tripped).length,
    segmentsEvicted: outcomes.reduce((sum, outcome) => sum + outcome.segmentsEvicted, 0),
    sentBytes: outcomes.reduce((sum, outcome) => sum + outcome.sentBytes, 0),
    forwardedBytes: outcomes.reduce((sum, outcome) => sum + outcome.forwardedBytes, 0),
    rebuilds: outcomes.filter((outcome) => outcome.rebuild !== null).length,
  };
}

/** One thing that moved between two builds on one case. */
export interface ReplayChange {
  caseId: string;
  what: "tripped" | "segments evicted" | "stub text" | "bytes sent" | "bytes forwarded" | "rebuild";
  previous: string;
  current: string;
}

export interface ReplayDiff {
  /** The run this was compared with, or null when there was none. */
  comparedWith: string | null;
  /** Null when there was nothing to compare with, and null when the comparison was refused. */
  totals: { previous: ReplayTotals; current: ReplayTotals } | null;
  changes: ReplayChange[];
  /** Cases both builds ran that came out the same. */
  unchanged: number;
  /** Cases only one of the two runs covered. Either being non-empty is what refuses the comparison. */
  onlyInPrevious: string[];
  onlyInCurrent: string[];
}

/**
 * What this build did that the previous one did not.
 *
 * A case list that has drifted refuses the comparison outright rather than diffing the cases the
 * two runs happen to share. Eligibility is recomputed every run, so drift is a real possibility,
 * and a total over one set of turns against a total over another is not a comparison — it is two
 * numbers side by side. Failing loudly is the point: the caller reports the drift, and nothing is
 * left that a reader could take for a verdict on the build.
 */
export function diffReplays(
  comparedWith: string | null,
  previous: readonly ReplayOutcome[] | null,
  current: readonly ReplayOutcome[],
): ReplayDiff {
  if (previous === null) {
    return { comparedWith, totals: null, changes: [], unchanged: 0, onlyInPrevious: [], onlyInCurrent: [] };
  }
  const before = new Map(previous.map((outcome) => [outcome.caseId, outcome]));
  const after = new Map(current.map((outcome) => [outcome.caseId, outcome]));
  const onlyInPrevious = previous.filter((outcome) => !after.has(outcome.caseId)).map((outcome) => outcome.caseId);
  const onlyInCurrent = current.filter((outcome) => !before.has(outcome.caseId)).map((outcome) => outcome.caseId);
  if (onlyInPrevious.length > 0 || onlyInCurrent.length > 0) {
    return { comparedWith, totals: null, changes: [], unchanged: 0, onlyInPrevious, onlyInCurrent };
  }

  const changes: ReplayChange[] = [];
  let unchanged = 0;
  for (const outcome of current) {
    const found = changesBetween(before.get(outcome.caseId) as ReplayOutcome, outcome);
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
  };
}

function changesBetween(was: ReplayOutcome, now: ReplayOutcome): ReplayChange[] {
  const changes: ReplayChange[] = [];
  const note = (what: ReplayChange["what"], previous: string, current: string): void => {
    if (previous !== current) changes.push({ caseId: now.caseId, what, previous, current });
  };
  note("tripped", String(was.tripped), String(now.tripped));
  note("segments evicted", String(was.segmentsEvicted), String(now.segmentsEvicted));
  note("bytes sent", String(was.sentBytes), String(now.sentBytes));
  note("bytes forwarded", String(was.forwardedBytes), String(now.forwardedBytes));
  note("rebuild", was.rebuild ?? "none", now.rebuild ?? "none");
  note("stub text", describeStubs(was), describeStubs(now));
  return changes;
}

/** A case's stub text as one line: the digest that decides, and a stub that shows what changed. */
function describeStubs(outcome: ReplayOutcome): string {
  if (outcome.segmentsEvicted === 0) return "none";
  return `${outcome.stubDigest} (e.g. ${outcome.stubExamples[0] ?? "unrecorded"})`;
}
