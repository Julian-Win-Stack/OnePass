// The command, driven the way a person drives it: a process, an environment, an exit code, and
// the two files it leaves behind. Nothing here reaches inside the eval — a test that reads
// internal state would pass while the result document a stranger has to read said nothing.
//
// The one seam is the HTTP boundary to the model API: a fake upstream stands in for it, so a
// whole run costs no key and no money.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";
import type { RunResult } from "./result.js";
import { model, typed, writeTranscript } from "./transcriptFixture.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "main.js");
const repoRoot = resolve(here, "..", "..");

let upstream: FakeUpstream;

before(async () => {
  upstream = await startFakeUpstream();
});

after(async () => {
  await upstream.close();
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  /** Reuse another run's results directory, which is how one run is compared with another. */
  results?: string;
}

/** Runs the command with a corpus and a results directory of its own. */
async function runCli(args: string[], options: RunOptions = {}): Promise<Run & { results: string }> {
  const { env = {}, results = scratch("onepass-eval-results-") } = options;
  // Only a run writes a result document, so only a run is given somewhere to put one.
  const isRun = !args.includes("--help") && args[0] !== "import";
  const full = isRun ? [...args, "--results-dir", results] : [...args];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...full], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ONEPASS_EVAL_CORPUS: scratch("onepass-eval-corpus-"),
        ONEPASS_EVAL_CLAUDE_CODE_VERSION: "2.1.261",
        ONEPASS_EVAL_UPSTREAM: upstream.url,
        ...env,
      },
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr, results };
  } catch (err: unknown) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", results };
  }
}

function resultOf(run: Run & { results: string }): RunResult {
  const label = /\[onepass-eval\] (\S+): /.exec(run.stdout)?.[1];
  assert.ok(label !== undefined, `no label in:\n${run.stdout}${run.stderr}`);
  return JSON.parse(readFileSync(join(run.results, `${label}.json`), "utf8")) as RunResult;
}

test("a scored run writes a result document and a table, labelled by the build and the time", async () => {
  const run = await runCli(["quick"]);
  assert.equal(run.code, 0, run.stderr);

  const result = resultOf(run);
  assert.equal(result.mode, "quick");
  assert.equal(result.scored, true);
  assert.match(result.label, /^[0-9a-f]{7,}(-dirty)?-\d{8}T\d{6}Z$/);
  assert.ok(result.label.startsWith(result.proxy.shortSha));
  assert.equal(result.upstream, upstream.url);
  assert.deepEqual(result.cases, []);
  assert.deepEqual(result.problems, []);

  const table = readFileSync(join(run.results, `${result.label}.md`), "utf8");
  assert.match(table, new RegExp(`# Onepass eval — ${result.label}`));
  assert.match(table, /quick mode, scored/);
  assert.ok(run.stdout.includes(join(run.results, `${result.label}.json`)));
  assert.ok(run.stdout.includes(join(run.results, `${result.label}.md`)));
});

test("a judge key in the environment around the run does not reach the proxy children", async () => {
  const run = await runCli(["quick"], { env: { ONEPASS_JUDGE_API_KEY: "sk-should-be-dropped" } });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(resultOf(run).proxy.judge, "off");
});

test("the spine spends nothing: no request of its own reaches the model API", async () => {
  const before = upstream.requests.length;
  const run = await runCli(["quick"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(upstream.requests.slice(before), [], "a run with no cases must call no model");
});

test("the result names the control baseline for both kinds of arm", async () => {
  const result = resultOf(await runCli(["full"]));
  assert.deepEqual(
    result.baselines.map((baseline) => [baseline.purpose, baseline.key.effort, baseline.key.claudeCode, baseline.recorded]),
    [
      ["planning", "xhigh", "2.1.261", false],
      ["tails", "high", "2.1.261", false],
    ],
  );
  assert.equal(result.baselines[0]?.directory, "claude-opus-5--xhigh--cc2.1.261");
});

test("replay serves its own upstream, is not scored, and needs nothing pointed at it", async () => {
  // No upstream and no Claude Code version: the check run after every proxy fix has to work
  // with nothing set up but a corpus.
  const run = await runCli(["replay"], { env: { ONEPASS_EVAL_UPSTREAM: "", ONEPASS_EVAL_CLAUDE_CODE_VERSION: "" } });
  assert.equal(run.code, 0, run.stderr);

  const result = resultOf(run);
  assert.equal(result.scored, false);
  assert.match(result.upstream, /^http:\/\/127\.0\.0\.1:\d+$/, "replay must not reach the real API");
  assert.deepEqual(result.baselines, [], "replay has no control to compare against");
});

test("session content has a home under the corpus, and the result document is not in the repository", async () => {
  const corpus = scratch("onepass-eval-corpus-");
  const run = await runCli(["quick"], { env: { ONEPASS_EVAL_CORPUS: corpus } });
  const result = resultOf(run);

  assert.equal(result.corpusDir, realpathSync(corpus));
  for (const name of ["transcripts", "baselines", "worktrees", "hand-labels", "runs"]) {
    assert.ok(existsSync(join(result.corpusDir, name)), `the corpus has no ${name}`);
  }
  assert.ok(existsSync(join(result.corpusDir, "runs", result.label)), "the run has nowhere to put session content");
  assert.equal(existsSync(join(repoRoot, "eval", "results", `${result.label}.json`)), false);
});

test("it refuses to start without a corpus directory", async () => {
  const run = await runCli(["quick"], { env: { ONEPASS_EVAL_CORPUS: "" } });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /ONEPASS_EVAL_CORPUS is unset/);
});

test("it refuses a corpus directory inside the repository", async () => {
  const run = await runCli(["quick"], { env: { ONEPASS_EVAL_CORPUS: join(repoRoot, "eval", "corpus") } });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /inside the repository/);
});

test("it refuses an unknown mode, and says what the modes are", async () => {
  const run = await runCli(["cheap"]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /unknown mode: cheap/);
  assert.match(run.stderr, /replay, quick, full/);
});

test("it refuses to compare against a run that was never written", async () => {
  const run = await runCli(["quick", "--compare", "deadbee-20260101T000000Z"]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /no run labelled deadbee-20260101T000000Z/);
});

test("it compares against a run that was", async () => {
  const results = scratch("onepass-eval-results-");
  const previous = resultOf(await runCli(["quick"], { results }));

  const second = await runCli(["quick", "--compare", previous.label], { results });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(resultOf(second).comparedWith, previous.label);
});

test("import copies a transcript into the corpus and prints the branch it holds", async () => {
  const corpus = scratch("onepass-eval-corpus-");
  const source = writeTranscript(scratch("onepass-projects-"), "62d8de7e.jsonl", [
    typed("u1", null, "plan the work"),
    model("a1", "u1", { contextTokens: 120_000 }),
    typed("u2a", "a1", "the branch that was rewound out of"),
    model("a2a", "u2a", { contextTokens: 150_000 }),
    typed("u2b", "a1", "the branch written last"),
    model("a2b", "u2b", { contextTokens: 130_000 }),
  ]);

  const run = await runCli(["import", source, "--tip", "a2a"], { env: { ONEPASS_EVAL_CORPUS: corpus } });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /typed by the user\s+2/);
  assert.match(run.stdout, /branches in the file\s+2/);
  assert.match(run.stdout, /entries off the path\s+2 of 6/);
  assert.match(run.stdout, /peak 150k/);

  const copy = join(realpathSync(corpus), "transcripts", "62d8de7e.jsonl");
  assert.equal(readFileSync(copy, "utf8"), readFileSync(source, "utf8"), "the copy is not the source's bytes");
});

test("import refuses without a corpus, and says what it cannot read", async () => {
  const missingCorpus = await runCli(["import", "/tmp/nowhere.jsonl"], { env: { ONEPASS_EVAL_CORPUS: "" } });
  assert.equal(missingCorpus.code, 1);
  assert.match(missingCorpus.stderr, /ONEPASS_EVAL_CORPUS is unset/);

  const missingFile = await runCli(["import", join(scratch("onepass-projects-"), "nowhere.jsonl")]);
  assert.equal(missingFile.code, 1);
  assert.match(missingFile.stderr, /cannot read the transcript/);
  assert.doesNotMatch(missingFile.stderr, /at Object\./, "a refusal prints a message, not a stack");
});

test("--help prints the usage and runs nothing", async () => {
  const run = await runCli(["--help"], { env: { ONEPASS_EVAL_CORPUS: "" } });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /onepass-eval <replay\|quick\|full>/);
  assert.match(run.stdout, /ONEPASS_EVAL_CORPUS/);
});
