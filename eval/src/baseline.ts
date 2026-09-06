// The control baseline.
//
// Control answers cost the same as proxied ones and never change while the thing that produced
// them does not, so they are recorded once and reused by every later run: an iteration pays for
// the proxied arm alone. What can invalidate them is the model, the effort it ran at, and the
// Claude Code version that built the request around it — so those three are the key, and a
// change to any of them lands the run in a different directory with nothing in it, which
// re-records rather than silently comparing against answers from another world.
//
// The key is a directory name rather than a hash, so `ls` over the baselines directory reads
// as the list of worlds that have been recorded.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EvalError, messageOf } from "./errors.js";

export const CLAUDE_CODE_VERSION_ENV = "ONEPASS_EVAL_CLAUDE_CODE_VERSION";

/** What a recorded control answer stops being valid for. */
export interface BaselineKey {
  model: string;
  effort: string;
  claudeCode: string;
}

export interface BaselineStore {
  key: BaselineKey;
  /** The directory it lives in under the corpus, which is also what the report calls it. */
  directory: string;
  path: string;
  /** True once anything has been recorded under this key. */
  readonly recorded: boolean;
  has(name: string): boolean;
  read<T>(name: string): T | null;
  /**
   * The recorded content for `name`, recording it with `record` when this key has none.
   * `reused` is false exactly on the run that paid for it.
   */
  ensure<T>(name: string, record: () => T | Promise<T>): Promise<{ value: T; reused: boolean }>;
}

/** The planning arms: both answer on Opus 5 at xhigh, whichever model recorded the stretch. */
export function planningBaselineKey(claudeCode: string): BaselineKey {
  return { model: "claude-opus-5", effort: "xhigh", claudeCode };
}

/** The implementation arms: the recording and every tail run at Opus 5, effort high. */
export function tailBaselineKey(claudeCode: string): BaselineKey {
  return { model: "claude-opus-5", effort: "high", claudeCode };
}

export function openBaselineStore(baselinesDir: string, key: BaselineKey): BaselineStore {
  const directory = baselineDirectory(key);
  const dir = join(baselinesDir, directory);
  const pathFor = (name: string): string => {
    if (name === "" || name.split("/").includes("..")) {
      throw new EvalError(`bad baseline entry name: ${name}`);
    }
    return join(dir, `${name}.json`);
  };
  const write = (name: string, value: unknown): void => {
    const path = pathFor(name);
    mkdirSync(dirname(path), { recursive: true });
    // Written beside the content so the directory says what it is a baseline of, for anyone
    // reading the corpus without the eval in front of them.
    writeFileSync(join(dir, "key.json"), `${JSON.stringify(key, null, 2)}\n`);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  const read = <T>(name: string): T | null => {
    const path = pathFor(name);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  };
  return {
    key,
    directory,
    path: dir,
    get recorded() {
      return existsSync(join(dir, "key.json"));
    },
    has: (name) => existsSync(pathFor(name)),
    read,
    async ensure<T>(name: string, record: () => T | Promise<T>) {
      const stored = read<T>(name);
      if (stored !== null) return { value: stored, reused: true };
      const value = await record();
      write(name, value);
      return { value, reused: false };
    },
  };
}

/** One directory name per world the control was recorded in. */
export function baselineDirectory(key: BaselineKey): string {
  const part = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${part(key.model)}--${part(key.effort)}--cc${part(key.claudeCode)}`;
}

/**
 * The Claude Code version the baseline is keyed by. The environment variable is what the tests
 * and a pinned rerun set; otherwise the installed CLI is asked, and a missing one is a refusal
 * rather than a guess, because a wrong key silently reuses control answers from another
 * version.
 */
export function readClaudeCodeVersion(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CLAUDE_CODE_VERSION_ENV];
  if (override !== undefined && override.trim() !== "") return override.trim();
  let reported: string;
  try {
    reported = execFileSync("claude", ["--version"], { encoding: "utf8" });
  } catch (err: unknown) {
    throw new EvalError(
      `cannot read the Claude Code version (\`claude --version\` failed: ${messageOf(err)}). ` +
        `Install the CLI, or set ${CLAUDE_CODE_VERSION_ENV} to the version the control baseline is keyed by.`,
    );
  }
  // `claude --version` answers "2.1.261 (Claude Code)".
  const version = reported.trim().split(/\s+/)[0];
  if (version === undefined || version === "") {
    throw new EvalError(`\`claude --version\` printed nothing usable: ${JSON.stringify(reported)}`);
  }
  return version;
}
