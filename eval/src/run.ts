// One run, start to finish.
//
// Nothing is measured yet: what this does is establish the shape everything else writes into.
// It resolves the corpus, builds the proxy under test, labels the run by that build, opens the
// control baseline for the two worlds the arms run in, starts a proxy child the way every arm
// will start one, and writes the result document and its table.
//
// The order matters. Everything that can refuse — an unset corpus, a proxy that does not
// build, a previous run named for a report that was never written —
// refuses before a child is started or a byte is written, so a run that is going to fail costs
// nothing but the build.

import { isScored } from "./args.js";
import type { Options } from "./args.js";
import {
  openBaselineStore,
  planningBaselineKey,
  readClaudeCodeVersion,
  tailBaselineKey,
  type BaselineKey,
} from "./baseline.js";
import { resolveCorpus } from "./corpus.js";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";
import { buildProxyUnderTest, withProxyChild } from "./proxy.js";
import {
  freeLabel,
  readRunResult,
  RESULT_SCHEMA,
  runLabel,
  writeRunResult,
  type BaselineUse,
  type RunResult,
  type WrittenResult,
} from "./result.js";
import { join } from "node:path";
import { EvalError } from "./errors.js";

export const UPSTREAM_ENV = "ONEPASS_EVAL_UPSTREAM";
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

export interface RunContext {
  options: Options;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  /** Read once when the run starts and once when it ends; injected so tests can pin a label. */
  clock?: () => Date;
}

export interface RunOutcome {
  result: RunResult;
  written: WrittenResult;
}

export async function runEval(context: RunContext): Promise<RunOutcome> {
  const { options, env, repoRoot } = context;
  const clock = context.clock ?? (() => new Date());
  const startedAt = clock();
  const resultsDir = options.resultsDir ?? join(repoRoot, "eval", "results");

  const corpus = resolveCorpus(env, repoRoot);
  if (options.compareWith !== null && readRunResult(resultsDir, options.compareWith) === null) {
    throw new EvalError(
      `no run labelled ${options.compareWith} in ${resultsDir}. ` +
        `A run is reported against a label that was written there; \`ls\` it for the ones that exist.`,
    );
  }

  // Replay is the check run after every proxy fix, so it depends on as little as it can: no
  // control to compare against means no baseline, and no baseline means no reason to ask an
  // installed `claude` what version it is.
  const baselines: BaselineUse[] = isScored(options.mode) ? describeBaselines(env, corpus.baselines) : [];

  const build = await buildProxyUnderTest(repoRoot);
  const label = freeLabel(resultsDir, runLabel(build.shortSha, build.dirty, startedAt));
  corpus.runDir(label);

  // Replay makes no model calls by definition, so it serves its own upstream and the child
  // never reaches the network. A scored run points at the real API unless a test redirects it.
  let fake: FakeUpstream | null = null;
  if (options.mode === "replay") fake = await startFakeUpstream();
  const upstream = fake?.url ?? env[UPSTREAM_ENV] ?? DEFAULT_UPSTREAM;

  try {
    // One child, started and stopped the way every arm will start and stop one. It is what says
    // the build under test runs at all, that its judge is off, and that a port was free — all
    // three before a model call is paid for.
    const child = await withProxyChild(build, { upstreamUrl: upstream }, async (started) => ({
      judge: started.judge,
      logFilePath: started.logFilePath,
    }));

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
      cases: [],
      arms: [],
      problems: [],
      notes: [
        "Nothing is measured yet: this build of the eval is the spine the arms are written into.",
      ],
    };
    return { result, written: writeRunResult(resultsDir, result) };
  } finally {
    await fake?.close();
  }
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
