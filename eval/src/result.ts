// What a run leaves behind.
//
// Two files per run, both inside the repository: the JSON document, which is the record, and a
// Markdown table rendered from it, which is what a stranger reads. Neither carries anything
// only the eval could interpret — no handles, no ids into a store, no paths into internal
// state — because the result has to be judgeable by someone who has not read this code.
//
// A run is labelled by the proxy's short SHA and the time it started, so two runs of the same
// build never collide and a label sorts by build then by time. A build with uncommitted changes
// under `proxy/` says so in its own label, since the SHA alone would be a claim about code that
// is not what ran.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Mode } from "./args.js";
import type { BaselineKey } from "./baseline.js";
import { EvalError, messageOf } from "./errors.js";

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
  /** The cases this run covered. Empty until case extraction lands. */
  cases: unknown[];
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

export function renderRunResult(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`# Onepass eval — ${result.label}`, "");
  lines.push(`${result.mode} mode, ${result.scored ? "scored" : "not scored"}, started ${result.startedAt}.`, "");

  lines.push("| | |", "| --- | --- |");
  lines.push(`| proxy build | \`${result.proxy.shortSha}\`${result.proxy.dirty ? " **with uncommitted changes**" : ""} |`);
  lines.push(`| proxy version | ${result.proxy.version} |`);
  lines.push(`| judge | ${result.proxy.judge} |`);
  lines.push(`| upstream | ${result.upstream} |`);
  lines.push(`| corpus | ${result.corpusDir} |`);
  lines.push(`| compared with | ${result.comparedWith ?? "nothing"} |`);
  lines.push(`| cases | ${result.cases.length} |`);
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

  lines.push("## Result", "");
  if (result.arms.length === 0) {
    lines.push("Nothing measured. This run built the proxy, started a child and wrote this document.", "");
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
