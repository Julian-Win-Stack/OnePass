// The entry command's argument surface: one mode, and the label of a previous run to compare
// against. Kept apart from the run itself so the whole surface can be checked without a proxy,
// a corpus or a model.

import { UsageError } from "./errors.js";

/** What a run does. Replay makes no model calls; quick and full are scored. */
export type Mode = "replay" | "quick" | "full";

export const MODES: readonly Mode[] = ["replay", "quick", "full"];

export interface Options {
  mode: Mode;
  /** Label of a previous run this one is reported against, or null for none. */
  compareWith: string | null;
  /** Where result documents are written, or null for the repository's own `eval/results`. */
  resultsDir: string | null;
}

export const USAGE = `onepass-eval <replay|quick|full> [options]

Modes
  replay   Push the stored prefixes through a fresh proxy child against a fake upstream.
           No model calls, no score, costs nothing.
  quick    Three proxied tails and every second eligible planning case.
  full     Five proxied tails and every eligible planning case.

Options
  --compare <label>      Report this run against a previous run's label.
  --results-dir <path>   Write the result document here instead of the repo's eval/results.
  --help                 Show this text.

Environment
  ONEPASS_EVAL_CORPUS                 Required. Every byte of session content is written here:
                                      transcript copies, fork and grader outputs, hand labels,
                                      the control baseline and the case worktrees. It has to
                                      resolve outside this repository, so none of it can be
                                      committed.
  ONEPASS_EVAL_CLAUDE_CODE_VERSION    The Claude Code version the control baseline is keyed by.
                                      Read from \`claude --version\` when unset.
  ONEPASS_EVAL_UPSTREAM               Where the proxy child sends requests in a scored run.
                                      Defaults to the Anthropic API. Replay ignores it and
                                      serves its own fake upstream.`;

/**
 * `argv` is the arguments after the program name. Throws `UsageError` on anything it cannot
 * read, so callers report one kind of failure rather than inspecting a result.
 */
export function parseArgs(argv: readonly string[]): Options {
  let mode: Mode | null = null;
  let compareWith: string | null = null;
  let resultsDir: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith("-")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      const inlineValue = equals === -1 ? null : arg.slice(equals + 1);
      const takeValue = (): string => {
        if (inlineValue !== null) return inlineValue;
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          throw new UsageError(`${name} needs a value`);
        }
        i += 1;
        return next;
      };
      if (name === "--compare") compareWith = takeValue();
      else if (name === "--results-dir") resultsDir = takeValue();
      else throw new UsageError(`unknown option: ${name}`);
      continue;
    }
    if (mode !== null) throw new UsageError(`unexpected argument: ${arg}`);
    if (!isMode(arg)) throw new UsageError(`unknown mode: ${arg} (expected ${MODES.join(", ")})`);
    mode = arg;
  }

  if (mode === null) throw new UsageError(`no mode given (expected ${MODES.join(", ")})`);
  return { mode, compareWith, resultsDir };
}

/** True when the arguments ask for the usage text rather than a run. */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

/** Replay is not scored, so the bar rule and the previous-build report ignore it. */
export function isScored(mode: Mode): boolean {
  return mode !== "replay";
}
