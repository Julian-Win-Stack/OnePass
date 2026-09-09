// The entry command's argument surface: one place that knows the whole of it, so it can be checked
// without a proxy, a corpus or a model.
//
// Two commands, because they are two different jobs. A run measures a build and writes a result
// document; an import copies one session into the corpus and prints what it holds. A run is named
// by its mode alone — `onepass-eval quick` — because that is the command anyone types twenty times
// a day, and import is named because it is not.

import { UsageError } from "./errors.js";

/** What a run does. Replay makes no model calls; quick and full are scored. */
export type Mode = "replay" | "quick" | "full";

export const MODES: readonly Mode[] = ["replay", "quick", "full"];

export interface RunCommand {
  kind: "run";
  mode: Mode;
  /** Label of a previous run this one is reported against, or null for none. */
  compareWith: string | null;
  /** Where result documents are written, or null for the repository's own `eval/results`. */
  resultsDir: string | null;
}

export interface ImportCommand {
  kind: "import";
  /** The transcript to read. Only ever opened for reading. */
  transcript: string;
  /** The tip of the branch to import, or null for the last entry written. */
  tip: string | null;
  /** What the copy is filed under in the corpus, or null for the source file's own name. */
  name: string | null;
}

export type Command = RunCommand | ImportCommand;

export const USAGE = `onepass-eval <replay|quick|full> [options]
onepass-eval import <transcript.jsonl> [options]

Modes
  replay   Push every eligible case through a fresh proxy child against a fake upstream, and
           diff what it evicted against the previous build. No model calls, no score, costs
           nothing. It lists the cases as it goes, so it also shows what a scored run covers.
  quick    Three proxied tails and every second eligible planning case.
  full     Five proxied tails and every eligible planning case.

Every mode lists the eligible cases by rule: the turns of the planning session whose full prefix
is past the proxy's trip threshold. There is no case manifest — the list is recomputed each run
and recorded in the result document.

Run options
  --compare <label>      Report this run against a previous run's label.
  --results-dir <path>   Write the result document here instead of the repo's eval/results.

Import
  Copies a session transcript into the corpus and prints the branch it holds: turn counts,
  compaction points and the token trajectory. The source is never opened for writing.

  A run takes its cases from the session filed under \`planning\`, so import it under that name:
    onepass-eval import <transcript.jsonl> --tip <uuid> --name planning

  --tip <uuid>           Walk back from this entry. A transcript file is a tree and a session is
                         one branch of it; without this, the branch ending at the last entry
                         written is the one imported.
  --name <name>          File the copy under this name instead of the source file's.

Anywhere
  --help                 Show this text.

Environment
  ONEPASS_EVAL_CORPUS                 Required. Every byte of session content is written here:
                                      transcript copies, fork and grader outputs, hand labels,
                                      the control baseline and the case worktrees. It has to
                                      resolve outside this repository, so none of it can be
                                      committed.
  ONEPASS_EVAL_CLAUDE_CODE_VERSION    The Claude Code version the control baseline is keyed by.
                                      Read from \`claude --version\` when unset.
  ONEPASS_EVAL_UPSTREAM               Where requests go. The proxy children use it in a scored
                                      run; replay serves its own fake upstream to them instead.
                                      The eval's own count-tokens calls go here in every mode,
                                      replay included, so a replay lists the same cases a scored
                                      run would. Defaults to the Anthropic API.
  ANTHROPIC_API_KEY                   Used for count-tokens and, later, the graders. Never for
                                      the proxy's judge, which stays off in every arm.`;

/**
 * `argv` is the arguments after the program name. Throws `UsageError` on anything it cannot read,
 * so callers report one kind of failure rather than inspecting a result.
 */
export function parseArgs(argv: readonly string[]): Command {
  return argv[0] === "import" ? parseImport(argv.slice(1)) : parseRun(argv);
}

function parseRun(argv: readonly string[]): RunCommand {
  const { positionals, values } = splitArgs(argv, ["--compare", "--results-dir"]);
  if (positionals.length === 0) throw new UsageError(`no mode given (expected ${MODES.join(", ")}, or import)`);
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);

  const mode = positionals[0] as string;
  if (!isMode(mode)) throw new UsageError(`unknown mode: ${mode} (expected ${MODES.join(", ")})`);
  return {
    kind: "run",
    mode,
    compareWith: values.get("--compare") ?? null,
    resultsDir: values.get("--results-dir") ?? null,
  };
}

function parseImport(argv: readonly string[]): ImportCommand {
  const { positionals, values } = splitArgs(argv, ["--tip", "--name"]);
  if (positionals.length === 0) throw new UsageError("import needs the path of a transcript to read");
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);

  return {
    kind: "import",
    transcript: positionals[0] as string,
    tip: values.get("--tip") ?? null,
    name: values.get("--name") ?? null,
  };
}

/**
 * Splits `argv` into the arguments that are not options and the options that are, taking the value
 * of each option named in `takesValue` — `--tip x` and `--tip=x` alike. Any other option is a
 * mistake, and is refused by name.
 */
function splitArgs(
  argv: readonly string[],
  takesValue: readonly string[],
): { positionals: string[]; values: Map<string, string> } {
  const positionals: string[] = [];
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!takesValue.includes(name)) throw new UsageError(`unknown option: ${name}`);

    if (equals !== -1) {
      values.set(name, arg.slice(equals + 1));
      continue;
    }
    // An option whose value is missing would otherwise swallow the next option, so a value that
    // looks like one is refused instead.
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) throw new UsageError(`${name} needs a value`);
    values.set(name, next);
    i += 1;
  }
  return { positionals, values };
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
