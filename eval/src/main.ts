#!/usr/bin/env node
// The one entry command. Everything it can refuse, it refuses with a message and no stack: the
// person running it wants to know what to change, not where in the eval it noticed.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseArgs, USAGE, wantsHelp } from "./args.js";
import { EvalError, messageOf, UsageError } from "./errors.js";
import { runEval } from "./run.js";

async function main(argv: string[]): Promise<number> {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot();
  const { result, written } = await runEval({ options, env: process.env, repoRoot });

  console.log(`[onepass-eval] ${result.label}: ${result.mode} mode against ${result.upstream}`);
  console.log(`[onepass-eval] corpus:  ${result.corpusDir}`);
  console.log(`[onepass-eval] result:  ${written.jsonPath}`);
  console.log(`[onepass-eval] table:   ${written.markdownPath}`);
  return 0;
}

/** The repository this eval is part of, found from the package rather than the caller's cwd. */
function repositoryRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err: unknown) {
  console.error(`[onepass-eval] ${messageOf(err)}`);
  if (err instanceof UsageError) console.error(`\n${USAGE}`);
  else if (!(err instanceof EvalError)) console.error(err);
  process.exitCode = 1;
}
