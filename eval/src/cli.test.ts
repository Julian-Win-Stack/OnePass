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
import { model, toolResult, typed, writeTranscript, type Line } from "./transcriptFixture.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "main.js");
const repoRoot = resolve(here, "..", "..");

let upstream: FakeUpstream;
/** A corpus with a planning session already imported, which is what every run needs. */
let corpus: string;

before(async () => {
  upstream = await startFakeUpstream();
  corpus = await preparedCorpus();
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

/**
 * The one turn of the fixture whose answer calls a tool, so the case list holds both answer groups
 * and not just the one. Its answer is the model turn the loop writes on this iteration, which is
 * the answer to the turn typed on the one before — so the `tools` case is the 5th, not the 6th.
 */
const TOOL_ANSWER_TURN = 5;

/**
 * A planning session small enough to write here and deep enough to be worth replaying: one large
 * tool result, then enough turns after it that the proxy's age gate has let go of it. The fake
 * upstream counts four characters to the token, so 400,000 characters is a prefix past the
 * 110,000-token trip threshold.
 */
function planningTranscript(): Line[] {
  const lines: Line[] = [
    typed("u1", null, "plan the work"),
    model("a1", "u1", { contextTokens: 54_000, textOnly: false }),
    toolResult("t1", "a1", { chars: 400_000 }),
  ];
  let parent = "t1";
  for (let turn = 0; turn < 12; turn += 1) {
    const contextTokens = 130_000 + turn * 1_000;
    if (turn === TOOL_ANSWER_TURN) {
      lines.push(model(`a${turn + 2}`, parent, { textOnly: false, contextTokens }));
      lines.push(toolResult(`t${turn + 2}`, `a${turn + 2}`));
      lines.push(model(`b${turn + 2}`, `t${turn + 2}`, { textOnly: true, contextTokens }));
      lines.push(typed(`u${turn + 2}`, `b${turn + 2}`, `carry on, ${turn}`));
    } else {
      lines.push(model(`a${turn + 2}`, parent, { textOnly: true, contextTokens }));
      lines.push(typed(`u${turn + 2}`, `a${turn + 2}`, `carry on, ${turn}`));
    }
    parent = `u${turn + 2}`;
  }
  lines.push(model("aLast", parent, { textOnly: true, contextTokens: 150_000 }));
  return lines;
}

/** A corpus with that session imported under the name a run reads its cases from. */
async function preparedCorpus(): Promise<string> {
  const dir = scratch("onepass-eval-corpus-");
  const source = writeTranscript(scratch("onepass-projects-"), "62d8de7e.jsonl", planningTranscript());
  const run = await runCli(["import", source, "--name", "planning"], { env: { ONEPASS_EVAL_CORPUS: dir } });
  assert.equal(run.code, 0, run.stderr);
  return dir;
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
        ONEPASS_EVAL_CORPUS: corpus,
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
  assert.deepEqual(result.problems, []);
  assert.ok(result.cases.length > 0, "a quick run lists the eligible cases");

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

test("listing the cases costs nothing: the eval's own calls are count-tokens and no more", async () => {
  const before = upstream.requests.length;
  const run = await runCli(["quick"]);
  assert.equal(run.code, 0, run.stderr);

  const paths = new Set(upstream.requests.slice(before).map((request) => request.url.split("?")[0]));
  assert.deepEqual([...paths], ["/v1/messages/count_tokens"], "sizing a case must not sample a model");
});

test("quick mode takes every second eligible case, and says which ones it took", async () => {
  const result = resultOf(await runCli(["quick"]));
  const selection = result.caseSelection;
  assert.ok(selection !== null);

  // Counted off the fixture rather than recomputed from the answer: 13 turns typed, of which the
  // first is the one before the big tool result and so the only one under the threshold, leaving
  // 12 eligible and every second one of those taken.
  assert.deepEqual(
    { typedTurns: selection.typedTurns, eligible: selection.eligible, belowThreshold: selection.belowThreshold },
    { typedTurns: 13, eligible: 12, belowThreshold: 1 },
  );
  assert.equal(selection.selected, 6);
  assert.deepEqual(
    result.cases.filter((one) => one.selected).map((one) => one.id),
    ["turn-4", "turn-8", "turn-12", "turn-18", "turn-22", "turn-26"],
  );
});

test("the case list records the turn index, the prefix size and the tool label", async () => {
  const run = await runCli(["full"]);
  const result = resultOf(run);

  // The fixture answers one turn with a tool and every other in text, so the list has to hold both
  // groups and put the `tools` label on the right turn. A run that labelled them all the same, or
  // labelled the wrong one, would still be a list of twelve plausible cases.
  assert.deepEqual(result.caseSelection?.answers, { tools: 1, text: 11, none: 0 });
  assert.deepEqual(
    result.cases.map((one) => one.answer),
    ["text", "text", "text", "text", "tools", "text", "text", "text", "text", "text", "text", "text"],
  );
  // Turn indices are indices into the branch, so they are not the case's position in the list and
  // they are not evenly spaced: the tool-answered turn puts three extra entries on the branch.
  assert.deepEqual(
    result.cases.map((one) => one.turnIndex),
    [4, 6, 8, 10, 12, 16, 18, 20, 22, 24, 26, 28],
  );
  for (const record of result.cases) {
    assert.ok(record.prefixTokens > 110_000, `${record.id} is ${record.prefixTokens} tokens, under the threshold`);
  }
  assert.equal(result.caseSelection?.selected, result.cases.length, "full mode takes all of them");

  // Every mode prints the list, not only replay: a scored run is about to spend money on these
  // turns and the person starting it should see which ones without waiting for the document.
  assert.match(run.stdout, /turn-4\s+154k\s+text/);
  assert.match(run.stdout, /turn-12\s+154k\s+tools/, "the tool label is printed, not only recorded");
});

test("the progress lines and the result document count the cases the same way", async () => {
  const run = await runCli(["full"]);

  // Counted by hand from the fixture session: 13 turns typed, and the first sits under the
  // threshold because the 400,000-character tool result lands after it. 80k, not the proxy's 110k,
  // for the reason `TRIP_THRESHOLD_TOKENS` gives. A run states these counts twice — once to whoever
  // started it, once to whoever reads the committed document later — and the two being written in
  // different places is how they come to disagree.
  const counted = "12 of 13 typed turns are past the 80k trip threshold";
  assert.ok(run.stdout.includes(counted), `progress lines do not say "${counted}":\n${run.stdout}`);
  const table = readFileSync(join(run.results, `${resultOf(run).label}.md`), "utf8");
  assert.ok(table.includes(counted), `the document does not say "${counted}":\n${table}`);
});

test("what I typed is printed but never recorded: a result document is committed", async () => {
  const run = await runCli(["quick"]);
  const result = resultOf(run);

  assert.match(run.stdout, /carry on, 0/, "the list reads as a session while it runs");
  const document = readFileSync(join(run.results, `${result.label}.json`), "utf8");
  assert.doesNotMatch(document, /carry on, 0/, "my session's words are corpus content, not repository content");
});

test("comparing a replay with a run that never replayed says so rather than reporting against nothing", async () => {
  const results = scratch("onepass-eval-results-");
  const scored = resultOf(await runCli(["quick"], { results }));

  const replay = resultOf(await runCli(["replay", "--compare", scored.label], { results }));

  assert.equal(replay.replay?.diff.comparedWith, scored.label);
  assert.equal(replay.replay?.diff.totals, null);
  const table = readFileSync(join(results, `${replay.label}.md`), "utf8");
  assert.match(table, new RegExp(`\`${scored.label}\` replayed nothing`));
});

test("a run refuses when no planning session has been imported", async () => {
  const run = await runCli(["quick"], { env: { ONEPASS_EVAL_CORPUS: scratch("onepass-eval-corpus-") } });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /no session filed under planning/);
  assert.match(run.stderr, /onepass-eval import/);
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

/**
 * One replay run, shared by the three tests below that each ask a different question of it. Run
 * with no Claude Code version set, because the check run after every proxy fix has to work with
 * nothing set up but a corpus.
 *
 * Shared because a replay run costs about a second, and these three read the run rather than
 * changing it — but they stay three tests, because "the children get their own upstream" failing
 * and "the run is not scored" failing are different bugs and should be different red lines.
 */
let versionlessReplay: { result: RunResult; upstreamPathsDuring: string[] } | null = null;

async function replayWithoutAVersion(): Promise<{ result: RunResult; upstreamPathsDuring: string[] }> {
  if (versionlessReplay === null) {
    const before = upstream.requests.length;
    const run = await runCli(["replay"], { env: { ONEPASS_EVAL_CLAUDE_CODE_VERSION: "" } });
    assert.equal(run.code, 0, run.stderr);
    versionlessReplay = {
      result: resultOf(run),
      upstreamPathsDuring: upstream.requests.slice(before).map((request) => request.url.split("?")[0]),
    };
  }
  return versionlessReplay;
}

test("replay serves the children an upstream of its own, never the real API", async () => {
  const { result, upstreamPathsDuring } = await replayWithoutAVersion();

  assert.match(result.upstream, /^http:\/\/127\.0\.0\.1:\d+$/, "replay must not reach the real API");
  assert.notEqual(result.upstream, upstream.url, "the children forward to replay's own fake, not the run's");

  // Two upstreams, and only the children's is replay's own. The eval's own sizing calls still go
  // to the run's upstream — which is the real API outside a test — because a replay that measured
  // its cases against a fake would not be listing the cases a scored run covers.
  assert.deepEqual([...new Set(upstreamPathsDuring)], ["/v1/messages/count_tokens"], "the run's upstream sized the cases");
});

test("a replay run is not scored", async () => {
  const { result } = await replayWithoutAVersion();
  assert.equal(result.scored, false);
});

test("a replay run needs no baseline to compare against", async () => {
  const { result } = await replayWithoutAVersion();
  assert.deepEqual(result.baselines, [], "replay has no control to compare against");
});

test("replay pushes every case through a proxy child and reports what came out", async () => {
  const run = await runCli(["replay"]);
  assert.equal(run.code, 0, run.stderr);
  const result = resultOf(run);

  const replay = result.replay;
  assert.ok(replay !== null, "a replay run reports a replay");
  assert.equal(replay.outcomes.length, result.cases.length, "replay is free, so it covers every case");

  // Which cases trip, not merely that some do. The three earliest sit inside the proxy's age gate
  // — too few assistant turns have followed the big tool result for it to be eligible — so they
  // forward what they were given, byte for byte. From turn-10 on it is old enough to go.
  assert.deepEqual(
    replay.outcomes.filter((one) => one.tripped).map((one) => one.caseId),
    ["turn-10", "turn-12", "turn-16", "turn-18", "turn-20", "turn-22", "turn-24", "turn-26", "turn-28"],
  );
  assert.deepEqual(
    { cases: replay.totals.cases, trips: replay.totals.trips, segmentsEvicted: replay.totals.segmentsEvicted },
    { cases: 12, trips: 9, segmentsEvicted: 9 },
    "one segment per trip: there is only the one tool result big enough to be worth a stub",
  );

  // The saving is the tool result minus the stub that replaced it, nine times over — so a stub
  // that kept any of the content, or an eviction that dropped more than the one segment, moves it.
  const stub = "[onepass: evicted 400,000 chars]";
  assert.equal(
    replay.totals.sentBytes - replay.totals.forwardedBytes,
    9 * (400_000 - stub.length),
  );

  // The forwarded bodies are session content, so they live in the corpus and not in the repository.
  const body = replay.outcomes.find((one) => one.segmentsEvicted > 0)?.bodyPath;
  assert.ok(body !== undefined && body.startsWith(result.corpusDir), `${body} is not under the corpus`);
  assert.ok(readFileSync(body, "utf8").includes("[onepass: evicted"));

  const table = readFileSync(join(run.results, `${result.label}.md`), "utf8");
  assert.match(table, /## Cases/);
  assert.match(table, /## Replay/);
  assert.match(run.stdout, /replay 1\/\d+ {2}turn-\d+/, "replay lists each case as it goes");
});

test("a second replay of the same build diffs against the first and finds nothing moved", async () => {
  const results = scratch("onepass-eval-results-");
  const first = resultOf(await runCli(["replay"], { results }));
  const second = resultOf(await runCli(["replay"], { results }));

  const diff = second.replay?.diff;
  assert.equal(diff?.comparedWith, first.label);
  assert.deepEqual(diff?.changes, [], "the same build on the same cases has to come out the same");
  assert.equal(diff?.unchanged, second.replay?.outcomes.length);
  assert.deepEqual(second.problems, [], "an unchanged case list is not a problem");
});

test("session content has a home under the corpus, and the result document is not in the repository", async () => {
  const own = await preparedCorpus();
  const run = await runCli(["quick"], { env: { ONEPASS_EVAL_CORPUS: own } });
  const result = resultOf(run);

  assert.equal(result.corpusDir, realpathSync(own));
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
