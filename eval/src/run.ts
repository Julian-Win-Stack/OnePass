// One run, start to finish.
//
// It resolves the corpus, opens the planning session that was imported into it, builds the proxy
// under test, labels the run by that build, opens the control baseline for the two worlds the arms
// run in, starts a proxy child the way every arm will start one, lists the eligible cases by rule,
// and writes the result document and its table. In replay mode it also pushes every case through a
// fresh proxy child and diffs what came out against the previous build.
//
// The order matters. Everything that can refuse — an unset corpus, a planning session that was
// never imported, a proxy that does not build, a previous run named for a report that was never
// written — refuses before a child is started or a byte is written, so a run that is going to fail
// costs nothing but the build.
//
// Two upstreams, and they are not the same thing. The proxy children forward to one: the real API
// on a scored run, the fake on a replay, so a replay never reaches the network. The eval's own
// count-tokens calls go to the other, which is the API in every mode — replay measures its cases
// the same way a scored run does, or the list it prints would not be the list a scored run covers.

import { isScored } from "./args.js";
import type { RunCommand } from "./args.js";
import {
  openBaselineStore,
  planningBaselineKey,
  readClaudeCodeVersion,
  tailBaselineKey,
  type BaselineKey,
} from "./baseline.js";
import { extractCases, selectCases, type CaseList, type PlanningCase } from "./cases.js";
import { API_KEY_ENV, createTokenCounter } from "./countTokens.js";
import { resolveCorpus } from "./corpus.js";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";
import { formatTokens } from "./format.js";
import { openImported, PLANNING_SESSION } from "./importSession.js";
import { buildProxyUnderTest, withProxyChild, type ProxyBuild } from "./proxy.js";
import { diffReplays, replayCases, totalsOf, type ReplayOutcome } from "./replay.js";
import {
  freeLabel,
  latestReplayBefore,
  readRunResult,
  RESULT_SCHEMA,
  runLabel,
  writeRunResult,
  type BaselineUse,
  type CaseRecord,
  type Problem,
  type ReplayReport,
  type RunResult,
  type WrittenResult,
} from "./result.js";
import { join } from "node:path";
import { EvalError } from "./errors.js";

export const UPSTREAM_ENV = "ONEPASS_EVAL_UPSTREAM";
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

export interface RunContext {
  options: RunCommand;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  /** Read once when the run starts and once when it ends; injected so tests can pin a label. */
  clock?: () => Date;
  /** Where progress is printed. Replay lists each case as it goes. */
  say?: (line: string) => void;
}

export interface RunOutcome {
  result: RunResult;
  written: WrittenResult;
}

export async function runEval(context: RunContext): Promise<RunOutcome> {
  const { options, env, repoRoot } = context;
  const clock = context.clock ?? (() => new Date());
  const say = context.say ?? ((line: string) => console.log(line));
  const startedAt = clock();
  const resultsDir = options.resultsDir ?? join(repoRoot, "eval", "results");

  const corpus = resolveCorpus(env, repoRoot);
  if (options.compareWith !== null && readRunResult(resultsDir, options.compareWith) === null) {
    throw new EvalError(
      `no run labelled ${options.compareWith} in ${resultsDir}. ` +
        `A run is reported against a label that was written there; \`ls\` it for the ones that exist.`,
    );
  }

  // The session every case is cut from. Opened before the build, because a corpus with nothing
  // imported into it is the one mistake that costs nothing at all to catch.
  const planning = openImported(corpus, PLANNING_SESSION);

  // Replay is the check run after every proxy fix, so it depends on as little as it can: no
  // control to compare against means no baseline, and no baseline means no reason to ask an
  // installed `claude` what version it is.
  const baselines: BaselineUse[] = isScored(options.mode) ? describeBaselines(env, corpus.baselines) : [];

  const build = await buildProxyUnderTest(repoRoot);
  const label = freeLabel(resultsDir, runLabel(build.shortSha, build.dirty, startedAt));
  const runDir = corpus.runDir(label);

  // Replay makes no model calls by definition, so it serves its own upstream and the children
  // never reach the network. A scored run points at the real API unless a test redirects it.
  // Having one is what says a run replays: no other mode has one, and no other mode may.
  const replayUpstream = options.mode === "replay" ? await startFakeUpstream() : null;
  const sizingUpstream = env[UPSTREAM_ENV] ?? DEFAULT_UPSTREAM;
  const upstream = replayUpstream?.url ?? sizingUpstream;

  const problems: Problem[] = [];
  try {
    // One child, started and stopped the way every arm will start and stop one. It is what says
    // the build under test runs at all, that its judge is off, and that a port was free — all
    // three before a model call is paid for.
    const child = await withProxyChild(build, { upstreamUrl: upstream }, async (started) => ({
      judge: started.judge,
      logFilePath: started.logFilePath,
    }));

    const caseList = await extractCases(
      planning.branch,
      createTokenCounter({ baseUrl: sizingUpstream, apiKey: env[API_KEY_ENV] }),
    );
    const selected = selectCases(caseList.cases, options.mode);
    for (const line of renderCaseList(caseList, selected, options.mode)) say(line);
    problems.push(...caseProblems(caseList, planning.record.transcriptPath));

    const replay =
      replayUpstream === null
        ? null
        : await runReplay({
            build,
            cases: selected,
            upstream: replayUpstream,
            runDir,
            resultsDir,
            compareWith: options.compareWith,
            say,
          });
    if (replay !== null) problems.push(...driftProblems(replay));

    const finishedAt = clock();
    const result: RunResult = {
      schema: RESULT_SCHEMA,
      label,
      mode: options.mode,
      scored: isScored(options.mode),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      comparedWith: options.compareWith,
      proxy: {
        shortSha: build.shortSha,
        dirty: build.dirty,
        version: build.version,
        judge: child.judge,
        logs: [child.logFilePath],
      },
      corpusDir: corpus.dir,
      upstream,
      baselines,
      cases: recordCases(caseList, selected),
      caseSelection: {
        typedTurns: caseList.typedTurns,
        eligible: caseList.cases.length,
        selected: selected.length,
        belowThreshold: caseList.belowThreshold,
        thresholdTokens: caseList.thresholdTokens,
        overheadTokens: caseList.overheadTokens,
        answers: caseList.answers,
      },
      replay,
      arms: [],
      problems,
      notes: notesFor(options.mode, caseList),
    };
    return { result, written: writeRunResult(resultsDir, result) };
  } finally {
    await replayUpstream?.close();
  }
}

interface ReplayContext {
  build: ProxyBuild;
  cases: readonly PlanningCase[];
  /** The children forward here, so replay never reaches the network. */
  upstream: FakeUpstream;
  runDir: string;
  resultsDir: string;
  /** A run named on the command line to compare with, or null to take the last one that replayed. */
  compareWith: string | null;
  say: (line: string) => void;
}

/** Replay, and the comparison with whichever earlier run this one is reported against. */
async function runReplay(context: ReplayContext): Promise<ReplayReport> {
  const outcomes = await replayCases({
    build: context.build,
    cases: context.cases,
    upstream: context.upstream,
    runDir: context.runDir,
    onCase: (planningCase, position, total) =>
      context.say(
        `[onepass-eval] replay ${position + 1}/${total}  ${planningCase.id}  ` +
          `${formatTokens(planningCase.prefixTokens)}  ${planningCase.answer}`,
      ),
  });

  // A scored run holds no replay outcomes, so a comparison with one has nothing to read. Naming it
  // anyway is answered by saying so — `comparedWith` is kept — rather than by quietly reporting
  // this build against nothing.
  const against =
    context.compareWith === null
      ? latestReplayBefore(context.resultsDir)
      : readRunResult(context.resultsDir, context.compareWith);
  const previous: ReplayOutcome[] | null = against?.replay?.outcomes ?? null;
  return {
    outcomes,
    totals: totalsOf(outcomes),
    diff: diffReplays(against?.label ?? null, previous, outcomes),
  };
}

/** Anything about the case list a reader has to be told rather than left to notice. */
function caseProblems(list: CaseList, transcriptPath: string): Problem[] {
  const problems: Problem[] = [];
  if (list.cases.length === 0) {
    problems.push({
      what: "no eligible cases",
      detail:
        `None of the ${list.typedTurns} typed turns on ${transcriptPath} reaches the ` +
        `${list.thresholdTokens}-token trip threshold, so this run covered nothing.`,
    });
  }
  // The typed-turn rule admits three shapes Claude Code writes for itself — `[Request interrupted
  // by user]`, a slash command's `<command-name>` echo, and its `<local-command-stdout>` — and
  // those are exactly the eligible turns with nothing recorded as an answer. A case cut at one
  // would be typed at the fork as though I had written it, which is the failure the rule is
  // spelled out to prevent, arriving by another door. It is reported rather than filtered: the
  // rule is the spec's, and narrowing it here would change the corpus without saying so.
  if (list.answers.none > 0) {
    problems.push({
      what: "cases with no recorded answer",
      detail:
        `${list.answers.none} of ${list.cases.length} eligible turns have no model answer recorded after them. ` +
        `These are interrupted turns and Claude Code's own local-command entries, which the typed-turn rule as ` +
        `written admits. They carry no tool label and are counted apart from the two answer groups.`,
    });
  }
  return problems;
}

/**
 * A case list that has drifted is a problem, not a diff line. The whole point of reporting one
 * build against another is that both covered the same turns, and a reader comparing totals across
 * two different case lists would be comparing nothing.
 */
function driftProblems(replay: ReplayReport): Problem[] {
  const { diff } = replay;
  if (diff.onlyInPrevious.length === 0 && diff.onlyInCurrent.length === 0) return [];
  return [
    {
      what: "the case list drifted",
      detail:
        `${diff.comparedWith ?? "the previous run"} covered ${diff.onlyInPrevious.length} case(s) this run did not ` +
        `(${diff.onlyInPrevious.join(", ") || "none"}), and this run covered ${diff.onlyInCurrent.length} it did not ` +
        `(${diff.onlyInCurrent.join(", ") || "none"}). The totals of the two runs are not comparable.`,
    },
  ];
}

function recordCases(list: CaseList, selected: readonly PlanningCase[]): CaseRecord[] {
  const ran = new Set(selected.map((planningCase) => planningCase.id));
  return list.cases.map((planningCase) => ({
    id: planningCase.id,
    turnIndex: planningCase.turnIndex,
    typedIndex: planningCase.typedIndex,
    stretchIndex: planningCase.stretchIndex,
    prefixTokens: planningCase.prefixTokens,
    messageTokens: planningCase.messageTokens,
    answer: planningCase.answer,
    opensWithCompactionSummary: planningCase.opensWithCompactionSummary,
    selected: ran.has(planningCase.id),
  }));
}

/**
 * The case list, printed as the run works it out. Every mode prints it, not only replay: the list
 * is what a run covers, and a person watching a scored run start should be able to see the turns it
 * is about to spend money on without waiting for the result document.
 */
function renderCaseList(list: CaseList, selected: readonly PlanningCase[], mode: RunCommand["mode"]): string[] {
  const ran = new Set(selected.map((planningCase) => planningCase.id));
  const lines = [
    `[onepass-eval] ${list.cases.length} of ${list.typedTurns} typed turns are past ` +
      `${formatTokens(list.thresholdTokens)}; ${mode} mode covers ${selected.length} of them`,
    `[onepass-eval] by recorded answer: ${list.answers.tools} used tools, ${list.answers.text} answered in text, ` +
      `${list.answers.none} have none`,
  ];
  for (const planningCase of list.cases) {
    // The id is `turn-<index>`, so it is the turn index as well as the name the diff uses.
    lines.push(
      `[onepass-eval]   ${ran.has(planningCase.id) ? "*" : " "} ${planningCase.id.padEnd(10)} ` +
        `${formatTokens(planningCase.prefixTokens).padStart(5)}  ${planningCase.answer.padEnd(5)}  ${planningCase.text}`,
    );
  }
  return lines;
}

/** Anything a reader has to know to read the numbers honestly. */
function notesFor(mode: RunCommand["mode"], list: CaseList): string[] {
  const notes = [
    "Nothing is scored yet: this build of the eval lists the cases and replays them, and the arms are not written.",
    `Case sizes are the message list measured with count-tokens plus ${list.overheadTokens} tokens of system ` +
      `prompt and tool definitions, read from the first model turn's usage and held fixed for the whole branch.`,
  ];
  const opened = list.cases.filter((one) => one.opensWithCompactionSummary).length;
  if (opened > 0) {
    notes.push(`${opened} of ${list.cases.length} cases sit on history that opens with a compaction summary.`);
  }
  if (mode === "replay") {
    notes.push(
      "Replay's fake upstream reports no cache creation, so the proxy classifies no rebuild against it; the " +
        "rebuild count moves only if the build starts classifying them differently.",
    );
  }
  return notes;
}

/** The two worlds the arms run in, and whether either holds control answers yet. */
function describeBaselines(env: NodeJS.ProcessEnv, baselinesDir: string): BaselineUse[] {
  const claudeCode = readClaudeCodeVersion(env);
  return [
    describeBaseline("planning", baselinesDir, planningBaselineKey(claudeCode)),
    describeBaseline("tails", baselinesDir, tailBaselineKey(claudeCode)),
  ];
}

/** Whether the baseline for a key holds anything yet. Recording it is the arms' job. */
function describeBaseline(purpose: BaselineUse["purpose"], baselinesDir: string, key: BaselineKey): BaselineUse {
  const store = openBaselineStore(baselinesDir, key);
  return { purpose, key, directory: store.directory, recorded: store.recorded };
}
