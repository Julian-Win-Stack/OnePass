// What a run leaves behind.
//
// Two files per run, both inside the repository: the JSON document, which is the record, and a
// Markdown table rendered from it, which is what a stranger reads. Neither carries anything
// only the eval could interpret — no handles, no ids into a store, no paths into internal
// state — because the result has to be judgeable by someone who has not read this code.
//
// A run is labelled by the proxy's short SHA and the time it started, so two runs of the same
// build never collide and a label sorts by build then by time. A repository with uncommitted
// changes says so in its own label, since the SHA alone would be a claim about code that is not
// what ran — and the eval decides what is replayed as much as the proxy decides what is evicted.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Mode } from "./args.js";
import type { BaselineKey } from "./baseline.js";
import type { AnswerLabel } from "./cases.js";
import { EvalError, messageOf } from "./errors.js";
import {
  describeAnswerGroups,
  describeEligibility,
  describeNonCases,
  describeSizing,
  formatTokens,
} from "./format.js";
import type { ReplayDiff, ReplayOutcome, ReplayTotals } from "./replay.js";

/** Bumped when a field older result documents carry stops meaning what it did. */
export const RESULT_SCHEMA = 1;

export interface BaselineUse {
  /** Which arms this baseline holds the control for. */
  purpose: "planning" | "tails";
  key: BaselineKey;
  /** The directory it lives in under the corpus, which is what the report calls it. */
  directory: string;
  /** Whether this run found content under the key already. */
  recorded: boolean;
}

/** Anything that stopped early. Printed in full under the tables, never counted. */
export interface Problem {
  what: string;
  detail: string;
}

/**
 * One eligible case, as a result document records it. No message list and no bodies: those are in
 * the corpus, and what a stranger has to be able to read here is which turns the run covered and
 * how deep they were.
 */
export interface CaseRecord {
  id: string;
  turnIndex: number;
  /** Which prompt of the session this is, counting from the start of the branch. */
  promptIndex: number;
  stretchIndex: number;
  /** The whole request, as the model turn that answered it reported being shown. */
  prefixTokens: number;
  /** Whether the recorded answer used tools. Not a criterion — a label the groups are read by. */
  answer: AnswerLabel;
  /** True when the request opened with a compaction summary rather than the session's own start. */
  opensWithCompactionSummary: boolean;
  /** Whether this run covered the case. Quick mode takes every second one; the rest are listed. */
  selected: boolean;
}

// What I typed is deliberately not here. A result document is committed, my session's words are
// corpus content, and the corpus directory exists so that none of it lands in git. A case is named
// by its turn index, which is enough to find it in the transcript copy.

/** How the case list came out, before any arm ran. */
export interface CaseSelection {
  /** Turns on the branch that sit in the user slot, prompts and Claude Code's own entries alike. */
  typedTurns: number;
  /** Of those, the ones Claude Code wrote itself: interrupts and slash-command echoes. */
  notPrompts: number;
  eligible: number;
  selected: number;
  belowThreshold: number;
  /** Prompts with no model turn after them, so no recorded depth. */
  unanswered: number;
  thresholdTokens: number;
  /** Eligible cases per answer group. */
  answers: Record<AnswerLabel, number>;
}

/** What replay did. Absent on a scored run, which does not replay. */
export interface ReplayReport {
  /** The recording it replayed, and how much of it. */
  recording: { name: string; dir: string; requests: number; messages: number; countTokens: number };
  /**
   * Every recorded request, in order. All of them, not only the reported ones: the sequence is what
   * the diff is over, because a change the report does not print is still a change in the build.
   */
  outcomes: ReplayOutcome[];
  /** The ids the rendered table covers: the deepest requests, which are the ones eviction acts on. */
  reported: string[];
  totals: ReplayTotals;
  diff: ReplayDiff;
}

export interface RunResult {
  schema: number;
  label: string;
  mode: Mode;
  scored: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** The label of the run this one is reported against, or null. */
  comparedWith: string | null;
  proxy: {
    shortSha: string;
    dirty: boolean;
    version: string;
    /** What the proxy children reported about their judge. Every arm expects "off". */
    judge: string;
    /** The proxy's own logs, one per child: trips, rebuilds, first-byte latency. */
    logs: string[];
  };
  /** Where session content was written. Named so a result can be traced to what produced it. */
  corpusDir: string;
  /** Where the proxy children sent what they forwarded. */
  upstream: string;
  baselines: BaselineUse[];
  /** Every eligible case, in session order, with the ones this run covered marked. */
  cases: CaseRecord[];
  /** How the list was arrived at, or null when no session was read. */
  caseSelection: CaseSelection | null;
  /** What replay found, or null on a scored run. */
  replay: ReplayReport | null;
  /** What each arm scored. Empty until the arms land. */
  arms: unknown[];
  problems: Problem[];
  /** Anything a reader has to know to read the numbers honestly. */
  notes: string[];
}

/** `<short sha>[-dirty]-<start time>`, e.g. `a001c2b-20260906T101112Z`. */
export function runLabel(shortSha: string, dirty: boolean, startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${shortSha}${dirty ? "-dirty" : ""}-${stamp}`;
}

/**
 * `label`, or the next free variant of it. The stamp is whole seconds, so two runs of the same
 * build started inside one second would otherwise write over each other — and a result document
 * that silently replaced another one is worse than a long name.
 */
export function freeLabel(resultsDir: string, label: string): string {
  let candidate = label;
  for (let attempt = 2; existsSync(join(resultsDir, `${candidate}.json`)); attempt += 1) {
    candidate = `${label}-${attempt}`;
  }
  return candidate;
}

export interface WrittenResult {
  jsonPath: string;
  markdownPath: string;
}

export function writeRunResult(resultsDir: string, result: RunResult): WrittenResult {
  mkdirSync(resultsDir, { recursive: true });
  const jsonPath = join(resultsDir, `${result.label}.json`);
  const markdownPath = join(resultsDir, `${result.label}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(markdownPath, renderRunResult(result));
  return { jsonPath, markdownPath };
}

/** The run written under `label`, or null when there is none. A document that exists but will
 * not parse is a refusal, not a null: silently reading it as "no such run" would let a corrupt
 * result hide behind a message about a label. */
export function readRunResult(resultsDir: string, label: string): RunResult | null {
  const path = join(resultsDir, `${label}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunResult;
  } catch (err: unknown) {
    throw new EvalError(`the result document at ${path} is not readable JSON: ${messageOf(err)}`);
  }
}

/**
 * The case list, which is the record of what a run covered. It is printed whole rather than
 * summarised: a run reported against an earlier one is only meaningful if both covered the same
 * turns, and a reader cannot check that against a count.
 */
function renderCases(result: RunResult): string[] {
  const lines: string[] = ["## Cases", ""];
  const selection = result.caseSelection;
  if (selection === null) {
    lines.push("No session was read, so no case was listed.", "");
    return lines;
  }
  lines.push(
    `${describeEligibility(selection)}. A prefix under the threshold buys no information: the proxy ` +
      `evicts nothing there and both arms send the same bytes.`,
    "",
    describeNonCases(selection),
    "",
    describeSizing(selection),
    "",
    describeAnswerGroups(selection),
    "",
  );
  if (result.cases.length === 0) return lines;

  lines.push(
    "| case | turn | prompt | stretch | prefix | answer | opens on | ran |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const record of result.cases) {
    lines.push(
      `| ${record.id} | ${record.turnIndex} | ${record.promptIndex} | ${record.stretchIndex} | ` +
        `${formatTokens(record.prefixTokens)} | ${record.answer} | ` +
        `${record.opensWithCompactionSummary ? "a compaction summary" : "the session start"} | ` +
        `${record.selected ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  return lines;
}

/** What replay did, and what moved since the build before it. */
function renderReplay(result: RunResult): string[] {
  if (result.replay === null) return [];
  const { recording, totals, diff, outcomes } = result.replay;
  const lines: string[] = ["## Replay", ""];
  lines.push(
    `No model calls and no score. Every one of the ${recording.requests} requests the recording ` +
      `\`${recording.name}\` holds went through **one** proxy child, in the order the session sent them — ` +
      `${recording.messages} a model answered and ${recording.countTokens} it only counted. Eviction is ` +
      `monotonic, so what the proxy does at one request depends on everything it took before it; a ` +
      `fresh child per request, or a run over only the deep ones, would be answering about a session ` +
      `that never happened.`,
    "",
  );
  const before = diff.totals?.previous ?? null;
  const heading = before === null ? [] : [diff.comparedWith ?? "previously"];
  lines.push(`| | ${[...heading, "this build"].join(" | ")} |`, `| --- |${" --- |".repeat(heading.length + 1)}`);
  const row = (name: string, was: string | number | null, now: string | number): void => {
    lines.push(`| ${name} | ${was === null ? "" : `${was} | `}${now} |`);
  };
  row("requests replayed", before?.requests ?? null, totals.requests);
  row("over the threshold", before?.overThreshold ?? null, totals.overThreshold);
  row(
    "over it with nothing evicted",
    before?.overThresholdNothingEvicted ?? null,
    totals.overThresholdNothingEvicted,
  );
  row("blocks evicted, first time", before?.newlyEvicted ?? null, totals.newlyEvicted);
  row("stubs sent", before?.stubbed ?? null, totals.stubbed);
  row("bytes forwarded", before === null ? null : formatBytes(before.forwardedBytes), formatBytes(totals.forwardedBytes));
  lines.push("");

  lines.push(...renderReported(result.replay.reported, outcomes));

  lines.push("### Against the previous build", "");
  if (diff.onlyInPrevious.length > 0 || diff.onlyInCurrent.length > 0) {
    lines.push(
      `**Refused.** The recording drifted since \`${diff.comparedWith ?? "the previous run"}\`: ` +
        `${diff.onlyInPrevious.length} request(s) it replayed are gone and ${diff.onlyInCurrent.length} are new. ` +
        `Totals over two different sequences are not a comparison, so none is shown.`,
      "",
    );
    return lines;
  }
  if (diff.totals === null) {
    const named = diff.comparedWith === null ? "" : `: \`${diff.comparedWith}\` replayed nothing`;
    lines.push(`Nothing to compare against${named}.`, "");
    return lines;
  }
  lines.push(`Compared with \`${diff.comparedWith ?? "the previous run"}\`, over every replayed request.`, "");
  if (diff.changes.length === 0) {
    lines.push(`No request came out differently; ${diff.unchanged} were identical.`, "");
  } else {
    lines.push("| request | what | previous | now |", "| --- | --- | --- | --- |");
    for (const change of diff.changes) {
      lines.push(`| ${change.id} | ${change.what} | ${change.previous} | ${change.current} |`);
    }
    lines.push("", `${diff.unchanged} request(s) came out the same.`, "");
  }
  return lines;
}

/**
 * The deepest requests, in the order they were sent. Every request is replayed and every one is in
 * the JSON; a table of several hundred near-identical rows is one nobody reads, and eviction only
 * does anything near the threshold, so the shallow ones all say the same thing.
 */
function renderReported(reported: readonly string[], outcomes: readonly ReplayOutcome[]): string[] {
  const shown = new Set(reported);
  const rows = outcomes.filter((outcome) => shown.has(outcome.id));
  if (rows.length === 0) return [];
  const lines: string[] = [`### The ${rows.length} deepest requests`, ""];
  lines.push(
    "| request | of | est. before | est. sent | forwarded | over T | new | stubs | stub |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const outcome of rows) {
    lines.push(
      `| ${outcome.id} | ${outcome.position} | ${formatTokens(outcome.estimatedTokensBefore)} | ` +
        `${formatTokens(outcome.estimatedTokensSent)} | ${formatBytes(outcome.forwardedBytes)} | ` +
        `${outcome.overThreshold ? "yes" : "no"} | ${outcome.newlyEvicted} | ${outcome.stubbed} | ` +
        `${outcome.stubbed === 0 ? "none" : `\`${outcome.stubDigest}\``} |`,
    );
  }
  lines.push("");
  return lines;
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1_000)} kB`;
}

/**
 * The most recent run in `resultsDir` that replayed anything. A scored run holds no replay
 * outcomes, so diffing against one would report every case as newly appeared; only a run that
 * replayed is a build's replay behaviour written down.
 */
export function latestReplayedRun(resultsDir: string): RunResult | null {
  let names: string[];
  try {
    names = readdirSync(resultsDir);
  } catch {
    return null;
  }
  const labels = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
  // A label is `<short sha>[-dirty]-<start time>`, so it sorts by build then by time, not by time
  // alone. The most recent replay is therefore found by reading them, not by sorting the names.
  let latest: RunResult | null = null;
  for (const label of labels) {
    const result = readRunResult(resultsDir, label);
    if (result?.replay == null || result.replay.outcomes.length === 0) continue;
    if (latest === null || result.startedAt > latest.startedAt) latest = result;
  }
  return latest;
}

export function renderRunResult(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`# Onepass eval — ${result.label}`, "");
  lines.push(`${result.mode} mode, ${result.scored ? "scored" : "not scored"}, started ${result.startedAt}.`, "");

  lines.push("| | |", "| --- | --- |");
  lines.push(`| build | \`${result.proxy.shortSha}\`${result.proxy.dirty ? " **with uncommitted changes**" : ""} |`);
  lines.push(`| proxy version | ${result.proxy.version} |`);
  lines.push(`| judge | ${result.proxy.judge} |`);
  lines.push(`| upstream | ${result.upstream} |`);
  lines.push(`| corpus | ${result.corpusDir} |`);
  lines.push(`| compared with | ${result.comparedWith ?? "nothing"} |`);
  lines.push(`| cases | ${result.cases.filter((one) => one.selected).length} of ${result.cases.length} eligible |`);
  lines.push(`| took | ${(result.durationMs / 1000).toFixed(1)}s |`);
  lines.push("");

  lines.push("## Control baseline", "");
  if (result.baselines.length === 0) {
    lines.push("None used.", "");
  } else {
    lines.push("| arms | model | effort | Claude Code | recorded |", "| --- | --- | --- | --- | --- |");
    for (const baseline of result.baselines) {
      lines.push(
        `| ${baseline.purpose} | ${baseline.key.model} | ${baseline.key.effort} | ${baseline.key.claudeCode} | ` +
          `${baseline.recorded ? "yes" : "not yet"} |`,
      );
    }
    lines.push("");
  }

  lines.push(...renderCases(result));
  lines.push(...renderReplay(result));

  lines.push("## Result", "");
  if (result.arms.length === 0) {
    lines.push(
      "No arm has been measured. This run built the proxy, listed the cases above" +
        `${result.replay === null ? "" : ", replayed them"} and wrote this document.`,
      "",
    );
  }

  lines.push("## Problems", "");
  if (result.problems.length === 0) {
    lines.push("None.", "");
  } else {
    for (const problem of result.problems) lines.push(`- **${problem.what}** — ${problem.detail}`);
    lines.push("");
  }

  if (result.notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of result.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  return `${lines.join("\n")}`;
}
