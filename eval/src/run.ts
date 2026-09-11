// One run, start to finish.
//
// It resolves the corpus, opens the planning session that was imported into it, builds the proxy
// under test, labels the run by that build, opens the control baseline for the two worlds the arms
// run in, starts a proxy child the way every arm will start one, lists the eligible cases by rule,
// and writes the result document and its table. In replay mode it also pushes every recorded
// request through one proxy child and diffs what came out against the previous build.
//
// The order matters. Everything that can refuse — an unset corpus, a planning session that was
// never imported, a recording that was never imported, a proxy that does not build, a previous run
// named for a report that was never written — refuses before a child is started or a byte is
// written, so a run that is going to fail costs nothing but the build.
//
// A run reaches the network only where it has to. Replay serves its own fake upstream and makes no
// model call at all, so it costs nothing and needs no key: the case list is read out of the
// transcript, and what replay sends is a file on disk.

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
import { resolveCorpus } from "./corpus.js";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";
import { describeAnswerGroups, describeEligibility, describeNonCases, formatTokens } from "./format.js";
import { openImported, PLANNING_SESSION } from "./importSession.js";
import { buildProxyUnderTest, withProxyChild, type ProxyBuild, type ProxySettings } from "./proxy.js";
import {
  conversationRequests,
  approximateTokens,
  deepest,
  REPORTED_REQUESTS,
  readRecordings,
  PLANNING_RECORDING,
  type Recording,
  type RecordingSet,
} from "./recordings.js";
import { diffReplays, replayRecordings, totalsOf, type ReplayOutcome } from "./replay.js";
import {
  describeSettings,
  freeLabel,
  latestReplayedRun,
  sameSettings,
  readRunResult,
  RESULT_SCHEMA,
  runLabel,
  writeRunResult,
  type BaselineUse,
  type CaseRecord,
  type CaseSelection,
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
  const comparedRun = options.compareWith === null ? null : readRunResult(resultsDir, options.compareWith);
  if (options.compareWith !== null && comparedRun === null) {
    throw new EvalError(
      `no run labelled ${options.compareWith} in ${resultsDir}. ` +
        `A run is reported against a label that was written there; \`ls\` it for the ones that exist.`,
    );
  }

  // The session every case is cut from, and the recording replay sends. Both are read before the
  // build and before anything is started: a corpus with nothing in it is the one mistake that
  // costs nothing at all to catch, and a refusal after a fake upstream is listening would leave
  // the run holding an open server it never gets to close.
  const planning = openImported(corpus, PLANNING_SESSION);
  const recordings =
    options.mode === "replay" ? readRecordings(corpus, options.recording ?? PLANNING_RECORDING) : null;

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
  const upstream = replayUpstream?.url ?? env[UPSTREAM_ENV] ?? DEFAULT_UPSTREAM;

  const problems: Problem[] = [];
  try {
    // One child, started and stopped the way every arm will start and stop one. It is what says
    // the build under test runs at all, that its judge is off, and that a port was free — all
    // three before a model call is paid for.
    const child = await withProxyChild(build, { upstreamUrl: upstream }, async (started) => ({
      judge: started.judge,
      logFilePath: started.logFilePath,
      settings: started.settings,
    }));
    const comparisonNote =
      comparedRun === null ? null : refuseUnlikeComparison(comparedRun, child.settings, recordings?.name ?? null);

    const caseList = extractCases(planning.branch);
    const selected = selectCases(caseList.cases, options.mode);
    const caseSelection: CaseSelection = {
      typedTurns: caseList.typedTurns,
      notPrompts: caseList.notPrompts,
      eligible: caseList.cases.length,
      selected: selected.length,
      belowThreshold: caseList.belowThreshold,
      unanswered: caseList.unanswered,
      thresholdTokens: caseList.thresholdTokens,
      answers: caseList.answers,
    };
    for (const line of renderCaseList(caseList, caseSelection, selected, options.mode)) say(line);
    problems.push(...caseProblems(caseList, planning.record.transcriptPath));

    const replay =
      replayUpstream === null || recordings === null
        ? null
        : await runReplay({
            build,
            recordings,
            upstream: replayUpstream,
            runDir,
            resultsDir,
            compareWith: options.compareWith,
            settings: child.settings,
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
        settings: child.settings,
        logs: [child.logFilePath],
      },
      corpusDir: corpus.dir,
      upstream,
      baselines,
      cases: recordCases(caseList, selected),
      caseSelection,
      replay,
      arms: [],
      problems,
      notes: [...notesFor(options.mode, caseList, replay), ...(comparisonNote === null ? [] : [comparisonNote])],
    };
    return { result, written: writeRunResult(resultsDir, result) };
  } finally {
    await replayUpstream?.close();
  }
}

interface ReplayContext {
  build: ProxyBuild;
  /** The recorded requests, in the order the session sent them. */
  recordings: RecordingSet;
  /** The child forwards here, so replay never reaches the network. */
  upstream: FakeUpstream;
  runDir: string;
  resultsDir: string;
  /** A run named on the command line to compare with, or null to take the last one that replayed. */
  compareWith: string | null;
  /** What this run's child evicts by. With no run named, only one at the same settings is compared. */
  settings: ProxySettings | null;
  say: (line: string) => void;
}

/** Replay, and the comparison with whichever earlier run this one is reported against. */
async function runReplay(context: ReplayContext): Promise<ReplayReport> {
  const requests = context.recordings.requests;
  const reported = deepest(requests, REPORTED_REQUESTS);
  const reportedIds = new Set(reported.map((request) => request.id));

  const outcomes = await replayRecordings({
    build: context.build,
    recordings: context.recordings,
    upstream: context.upstream,
    runDir: context.runDir,
    reported: reportedIds,
    // One line per request would be several hundred lines of scroll for a check run on a whim, so
    // the progress ticks and the requests the report covers are named as they go past.
    onRequest: (recording, position, total) => {
      if (!reportedIds.has(recording.id) && position % 25 !== 0 && position !== total) return;
      context.say(
        `[onepass-eval] replay ${position}/${total}  ${recording.id}  ` +
          `${formatTokens(approximateTokens(recording.bytes))}${reportedIds.has(recording.id) ? "  *" : ""}`,
      );
    },
  });

  // A scored run holds no replay outcomes, so a comparison with one has nothing to read. Naming it
  // anyway is answered by saying so — `comparedWith` is kept — rather than by quietly reporting
  // this build against nothing.
  // Unnamed, the comparison is with the last replay of this recording at these settings: a replay
  // at another T, or of another session, would be a diff of the settings or the session, not of
  // the build. Named, a mismatch has already been refused.
  const against =
    context.compareWith === null
      ? latestReplayedRun(
          context.resultsDir,
          (earlier) =>
            earlier.replay?.recording.name === context.recordings.name &&
            // Answered at other ratios, the child calibrated differently and every decision moved.
            (earlier.replay.recording.realCharsPerToken ?? 0) === withRealRatio(context.recordings.requests) &&
            sameSettings(earlier.proxy.settings, context.settings),
        )
      : readRunResult(context.resultsDir, context.compareWith);
  const previous: ReplayOutcome[] | null = against?.replay?.outcomes ?? null;
  return {
    recording: {
      name: context.recordings.name,
      dir: context.recordings.dir,
      requests: requests.length,
      messages: conversationRequests(requests).length,
      countTokens: requests.length - conversationRequests(requests).length,
      realCharsPerToken: withRealRatio(requests),
    },
    outcomes,
    reported: reported.map((request) => request.id),
    totals: totalsOf(outcomes),
    diff: diffReplays(against?.label ?? null, previous, outcomes),
  };
}

/**
 * A comparison named on the command line is only between two runs that evicted by the same T, N
 * and K and, when both replayed, sent the same recording. Two replays at different T come out
 * different whatever the build, and before settings were recorded nothing in either document said
 * so. The batch minimum is the one setting that may differ, because a run with it on against the
 * same build with it off is how the minimum is measured; the returned note says so in the result.
 */
function refuseUnlikeComparison(
  previous: RunResult,
  settings: ProxySettings | null,
  recording: string | null,
): string | null {
  const earlier = previous.proxy.settings;
  const minimumAside = (one: ProxySettings | null | undefined): ProxySettings | null =>
    one == null ? null : { ...one, batchMinTokens: null };
  if (!sameSettings(minimumAside(earlier), minimumAside(settings))) {
    throw new EvalError(
      `${previous.label} ran its proxy at ${describeSettings(earlier)}, and this run's evicts at ` +
        `${describeSettings(settings)}. A comparison across T, N or K reports what the settings did, not the ` +
        `build, so it is refused: run both at the same ONEPASS_TRIP_TOKENS, ONEPASS_EVICT_AFTER_TURNS and ` +
        `ONEPASS_PROTECT_LAST_TURNS.`,
    );
  }
  const previousRecording = previous.replay?.recording.name ?? null;
  if (recording !== null && previousRecording !== null && previousRecording !== recording) {
    throw new EvalError(
      `${previous.label} replayed \`${previousRecording}\` and this run replays \`${recording}\`. Two sessions ` +
        `are not a comparison of two builds, so it is refused.`,
    );
  }
  if (sameSettings(earlier, settings)) return null;
  return (
    `Compared with ${previous.label}, which evicted at ${describeSettings(earlier)}; this run evicts at ` +
    `${describeSettings(settings)}. The diff is what the batch minimum did, not what the build did.`
  );
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
  // Three shapes sit in the user slot that nobody typed — `[Request interrupted by user]`, a slash
  // command's `<command-name>` echo, and its `<local-command-stdout>`. A case cut at one would be
  // typed at the fork as though I had written it, buying a paid call and no information, so they
  // are held out of the case list. Held out, not silent: they are part of what the branch holds and
  // a reader comparing this count with the transcript's own would otherwise be short by seven.
  if (list.notPrompts > 0) {
    problems.push({
      what: "typed turns Claude Code wrote itself",
      detail:
        `${list.notPrompts} of the ${list.typedTurns} turns in the user slot on ${transcriptPath} are Claude ` +
        `Code's own entries: interrupt notices, slash-command echoes and their output. They are not prompts, ` +
        `so they are neither cases nor fed to a recording session.`,
    });
  }
  return problems;
}

/**
 * A recording that has drifted is a problem, not a diff line. The whole point of reporting one
 * build against another is that both sent the same requests, and a reader comparing totals across
 * two different sequences would be comparing nothing.
 */
function driftProblems(replay: ReplayReport): Problem[] {
  const { diff } = replay;
  if (diff.onlyInPrevious.length === 0 && diff.onlyInCurrent.length === 0 && diff.unnamedInPrevious === 0) return [];
  const few = (ids: readonly string[]): string =>
    ids.length === 0 ? "none" : `${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}`;
  const previousRun = diff.comparedWith ?? "the previous run";
  // A document that names none of its requests is not drift a reader can act on by re-recording —
  // it is an older eval's document — so it is said as itself rather than folded into the counts.
  const unnamed =
    diff.unnamedInPrevious === 0
      ? ""
      : ` ${diff.unnamedInPrevious} of ${previousRun}'s outcomes name no request at all: that document was` +
        ` written before replay read recordings, and there is nothing in it to match against.`;
  return [
    {
      what: "the recording drifted",
      detail:
        `${previousRun} replayed ${diff.onlyInPrevious.length} request(s) this run did ` +
        `not (${few(diff.onlyInPrevious)}), and this run replayed ${diff.onlyInCurrent.length} it did not ` +
        `(${few(diff.onlyInCurrent)}). The totals of the two runs are not comparable.${unnamed}`,
    },
  ];
}

function recordCases(list: CaseList, selected: readonly PlanningCase[]): CaseRecord[] {
  const ran = new Set(selected.map((planningCase) => planningCase.id));
  return list.cases.map((planningCase) => ({
    id: planningCase.id,
    turnIndex: planningCase.turnIndex,
    promptIndex: planningCase.promptIndex,
    stretchIndex: planningCase.stretchIndex,
    prefixTokens: planningCase.prefixTokens,
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
function renderCaseList(
  list: CaseList,
  counts: CaseSelection,
  selected: readonly PlanningCase[],
  mode: RunCommand["mode"],
): string[] {
  const ran = new Set(selected.map((planningCase) => planningCase.id));
  const lines = [
    `[onepass-eval] ${describeEligibility(counts)}; ${mode} mode covers ${selected.length} of them`,
    `[onepass-eval] ${describeNonCases(counts)}`,
    `[onepass-eval] ${describeAnswerGroups(counts)}`,
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
function notesFor(mode: RunCommand["mode"], list: CaseList, replay: ReplayReport | null): string[] {
  const notes = [
    "Nothing is scored yet: this build of the eval lists the cases and replays a recording, and the arms are " +
      "not written.",
  ];
  const opened = list.cases.filter((one) => one.opensWithCompactionSummary).length;
  if (opened > 0) {
    notes.push(`${opened} of ${list.cases.length} cases sit on history that opens with a compaction summary.`);
  }
  if (mode === "replay" && replay !== null) {
    notes.push(
      `The case list above and the replay below are about two different sessions. The cases are turns of the ` +
        `recorded planning session, which a scored run forks. Replay sends the requests of \`${replay.recording.name}\`, ` +
        `a session driven by that session's prompts and recorded through the proxy — the proxy's own view of a ` +
        `real deep session, which is the only thing that carries what Claude Code injects.`,
    );
    const answered = replay.recording.realCharsPerToken ?? 0;
    notes.push(
      answered > 0
        ? `Replay's fake upstream answered ${answered} of the ${replay.recording.requests} requests at the chars ` +
            `per token the real API reported for them, read from the recording proxy's log, and left the last ` +
            `ratio standing for the rest. The proxy calibrates on that usage, so it estimated each request the way ` +
            `the recording proxy did.`
        : "Replay's fake upstream reports usage at four characters per token, so the proxy calibrates to that " +
            "rather than to the ~3.2 a real session teaches it. Every build sees the same fake, so a comparison " +
            "between builds is unaffected; the estimated sizes in the table are not the sizes the API would " +
            "report. Import the recording with --proxy-log to answer at the real ratios.",
    );
  }
  return notes;
}

/** How many of a recording's requests carry the ratio the real API reported for them. */
function withRealRatio(requests: readonly Recording[]): number {
  return requests.filter((request) => request.realCharsPerToken !== null).length;
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
