// The command, driven the way a person drives it: a process, an environment, an exit code, and
// the two files it leaves behind. Nothing here reaches inside the eval — a test that reads
// internal state would pass while the result document a stranger has to read said nothing.
//
// The one seam is the HTTP boundary to the model API: a fake upstream stands in for it, so a
// whole run costs no key and no money. Replay does not even need that — it sends files off disk
// through a proxy child that forwards to a fake of its own.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
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
 * A planning session small enough to write here and deep enough to hold cases: one large tool
 * result, then a run of turns whose answers report being shown well past the 110,000-token trip
 * threshold. A case's size is what its answer reported, so the fixture sets those numbers directly.
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

/**
 * One recorded request: the same conversation `turnsAfter` assistant turns on. The big tool result
 * is resent in full every time, which is what Claude Code really does, so this is where the proxy
 * has to re-stub what it has already taken rather than take it again.
 */
function recordedBody(turnsAfter: number): string {
  const messages: unknown[] = [
    { role: "user", content: [{ type: "text", text: "read the file" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x".repeat(600_000) }] },
  ];
  for (let turn = 0; turn < turnsAfter; turn += 1) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `thinking about it, ${turn}` }] });
    messages.push({ role: "user", content: [{ type: "text", text: `carry on, ${turn}` }] });
  }
  return JSON.stringify({ model: "claude-opus-5", max_tokens: 1_024, messages });
}

/** How many requests the fixture recording holds. */
const RECORDED_REQUESTS = 12;

/**
 * A dump directory shaped the way the proxy leaves one: a file per request, named for the moment
 * it arrived. The conversation deepens by one assistant turn each time, so the big tool result
 * starts inside the proxy's age gate and comes out the far side of it partway through.
 */
function recordedSession(requests = RECORDED_REQUESTS): string {
  const dir = scratch("onepass-eval-dump-");
  for (let index = 0; index < requests; index += 1) {
    const stamp = `2026-09-08T23-23-${String(index).padStart(2, "0")}-000Z`;
    const sequence = String(index + 1).padStart(6, "0");
    writeFileSync(join(dir, `${stamp}_${sequence}_v1_messages.json`), recordedBody(index + 1), "utf8");
  }
  return dir;
}

/** A corpus with that session imported, and a recording for replay to send. */
async function preparedCorpus(): Promise<string> {
  const dir = scratch("onepass-eval-corpus-");
  const source = writeTranscript(scratch("onepass-projects-"), "62d8de7e.jsonl", planningTranscript());
  const imported = await runCli(["import", source, "--name", "planning"], { env: { ONEPASS_EVAL_CORPUS: dir } });
  assert.equal(imported.code, 0, imported.stderr);

  const recorded = await runCli(["import-recordings", recordedSession()], { env: { ONEPASS_EVAL_CORPUS: dir } });
  assert.equal(recorded.code, 0, recorded.stderr);
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
  const isRun = !["--help", "import", "import-recordings", "prompts"].some((one) => args.includes(one));
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

test("listing the cases costs nothing at all: the eval makes no call of its own", async () => {
  const before = upstream.requests.length;
  const run = await runCli(["quick"]);
  assert.equal(run.code, 0, run.stderr);

  // Not even a count-tokens call. A case is sized by what the model turn that answered it reported
  // being shown, which is already in the transcript, so listing the cases needs no key and no
  // network — and a run that started sizing again would show up here as a request nobody asked for.
  assert.deepEqual(upstream.requests.slice(before), []);
});

test("quick mode takes every second eligible case, and says which ones it took", async () => {
  const result = resultOf(await runCli(["quick"]));
  const selection = result.caseSelection;
  assert.ok(selection !== null);

  // Counted off the fixture rather than recomputed from the answer: 13 turns typed, of which the
  // first was answered at 54k and so is the only one under the threshold, leaving 12 eligible and
  // every second one of those taken.
  assert.deepEqual(
    {
      typedTurns: selection.typedTurns,
      eligible: selection.eligible,
      belowThreshold: selection.belowThreshold,
      unanswered: selection.unanswered,
      notPrompts: selection.notPrompts,
    },
    { typedTurns: 13, eligible: 12, belowThreshold: 1, unanswered: 0, notPrompts: 0 },
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
  assert.deepEqual(result.caseSelection?.answers, { tools: 1, text: 11 });
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
  assert.match(run.stdout, /turn-4\s+131k\s+text/);
  assert.match(run.stdout, /turn-12\s+135k\s+tools/, "the tool label is printed, not only recorded");
});

test("the progress lines and the result document count the cases the same way", async () => {
  const run = await runCli(["full"]);

  // Counted by hand from the fixture session: 13 prompts, and the first was answered at 54k so it
  // sits under the threshold. The threshold is the proxy's own 110k, which the eval can use
  // directly now that a case is sized by what the API reported rather than by a rebuild. A run
  // states these counts twice — once to whoever started it, once to whoever reads the committed
  // document later — and the two being written in different places is how they come to disagree.
  const counted = "12 of 13 prompts are past the 110k trip threshold";
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

test("replay serves the child an upstream of its own and never reaches the network", async () => {
  const { result, upstreamPathsDuring } = await replayWithoutAVersion();

  assert.match(result.upstream, /^http:\/\/127\.0\.0\.1:\d+$/, "replay must not reach the real API");
  assert.notEqual(result.upstream, upstream.url, "the child forwards to replay's own fake, not the run's");
  assert.deepEqual(upstreamPathsDuring, [], "a replay makes no call outside its own fake");
});

test("a replay run is not scored", async () => {
  const { result } = await replayWithoutAVersion();
  assert.equal(result.scored, false);
});

test("a replay run needs no baseline to compare against", async () => {
  const { result } = await replayWithoutAVersion();
  assert.deepEqual(result.baselines, [], "replay has no control to compare against");
});

test("replay sends every recorded request through one proxy child and reports what came out", async () => {
  const run = await runCli(["replay"]);
  assert.equal(run.code, 0, run.stderr);
  const result = resultOf(run);

  const replay = result.replay;
  assert.ok(replay !== null, "a replay run reports a replay");
  assert.equal(replay.outcomes.length, RECORDED_REQUESTS, "replay is free, so it sends the whole recording");
  assert.deepEqual(replay.recording, {
    name: "planning",
    dir: join(result.corpusDir, "recordings", "planning"),
    requests: RECORDED_REQUESTS,
    messages: RECORDED_REQUESTS,
    countTokens: 0,
    realCharsPerToken: 0,
  });

  // The state carried across the sequence, which is the whole reason there is one child. The tool
  // result is inside the proxy's age gate at first — too few assistant turns have followed it — and
  // once it is old enough it is taken **once**. Every request after that re-stubs it rather than
  // taking it again, which a fresh child per request could not show.
  const took = replay.outcomes.filter((one) => one.newlyEvicted > 0).map((one) => one.id);
  assert.equal(took.length, 1, `taken on ${took.join(", ")}: a block is evicted once and stays evicted`);
  assert.equal(replay.totals.newlyEvicted, 1);
  assert.ok(
    replay.totals.stubbed > 1,
    `stubbed ${replay.totals.stubbed}: every request after the first re-sends the stub`,
  );

  // Over the line with nothing eligible: the requests before the tool result aged out. Counting
  // the proxy's trip entries reads these as small quiet requests, which is the opposite of what
  // happened, so replay counts them in their own right.
  assert.ok(
    replay.totals.overThresholdNothingEvicted > 0,
    "the fixture's early requests are over the threshold with nothing old enough to take",
  );
  assert.equal(
    replay.totals.overThresholdNothingEvicted,
    replay.outcomes.filter((one) => one.overThreshold && one.newlyEvicted === 0).length,
  );

  // The forwarded bodies are session content, so they live in the corpus and not in the repository
  // — and only for the requests the report covers, since a whole session's worth would be gigabytes.
  const stubbed = replay.outcomes.find((one) => one.stubbed > 0 && one.bodyPath !== null);
  assert.ok(stubbed?.bodyPath != null && stubbed.bodyPath.startsWith(result.corpusDir), `${stubbed?.bodyPath} is not under the corpus`);
  assert.ok(readFileSync(stubbed.bodyPath, "utf8").includes("[onepass: evicted"));

  const table = readFileSync(join(run.results, `${result.label}.md`), "utf8");
  assert.match(table, /## Cases/);
  assert.match(table, /## Replay/);
  assert.match(table, /### The \d+ deepest requests/);
  assert.match(table, /over it with nothing evicted/);
  assert.match(run.stdout, /replay \d+\/12 {2}req-\d+/, "replay says where it has got to");
});

test("the report covers the deepest requests, and the JSON holds every one of them", async () => {
  const result = resultOf(await runCli(["replay"]));
  const replay = result.replay;
  assert.ok(replay !== null);

  // Twelve recorded, thirty reported on: fewer than the cap, so every one is in the table. What is
  // pinned here is that the two are separate — the sequence is what the diff is over, the subset is
  // what a person reads — and that only the reported ones keep a body.
  assert.equal(replay.reported.length, RECORDED_REQUESTS);
  assert.equal(
    replay.outcomes.filter((one) => one.bodyPath !== null).length,
    replay.reported.length,
  );
  assert.deepEqual(
    replay.outcomes.map((one) => one.position),
    Array.from({ length: RECORDED_REQUESTS }, (_, index) => index + 1),
    "the sequence is reported in the order the session sent it",
  );
});

test("a second replay of the same build diffs against the first and finds nothing moved", async () => {
  const results = scratch("onepass-eval-results-");
  const first = resultOf(await runCli(["replay"], { results }));
  const second = resultOf(await runCli(["replay"], { results }));

  const diff = second.replay?.diff;
  assert.equal(diff?.comparedWith, first.label);
  assert.deepEqual(diff?.changes, [], "the same build on the same recording has to come out the same");
  assert.equal(diff?.unchanged, second.replay?.outcomes.length);
});

/** The shared corpus with a second, shorter recording filed beside `planning` under `other`. */
let otherRecording: Promise<void> | null = null;

function withOtherRecording(): Promise<void> {
  otherRecording ??= runCli(["import-recordings", recordedSession(5), "--name", "other"]).then((run) => {
    assert.equal(run.code, 0, run.stderr);
  });
  return otherRecording;
}

test("replay --recording sends the recording filed under that name", async () => {
  await withOtherRecording();
  const result = resultOf(await runCli(["replay", "--recording", "other"]));

  assert.equal(result.replay?.recording.name, "other");
  assert.equal(result.replay?.outcomes.length, 5);
});

test("the result records what the proxy child evicted by, as the environment around the run set it", async () => {
  const run = await runCli(["replay"], { env: { ONEPASS_TRIP_TOKENS: "30000", ONEPASS_BATCH_MIN_TOKENS: "15000" } });
  assert.equal(run.code, 0, run.stderr);
  const result = resultOf(run);

  assert.deepEqual(result.proxy.settings, {
    evictAfterTurns: 8,
    protectLastTurns: 4,
    tripTokens: 30_000,
    batchMinTokens: 15_000,
  });
  assert.match(readFileSync(join(run.results, `${result.label}.md`), "utf8"), /T = 30,000 tokens/);
});

test("--compare refuses a run whose proxy evicted by a different T, and names both", async () => {
  const results = scratch("onepass-eval-results-");
  const first = resultOf(await runCli(["replay"], { results, env: { ONEPASS_TRIP_TOKENS: "110000" } }));

  const second = await runCli(["replay", "--compare", first.label], { results, env: { ONEPASS_TRIP_TOKENS: "30000" } });

  assert.equal(second.code, 1);
  assert.match(second.stderr, /T = 110,000/);
  assert.match(second.stderr, /T = 30,000/);
});

test("--compare takes a run at another batch minimum, because that is the comparison, and says so", async () => {
  const results = scratch("onepass-eval-results-");
  const off = resultOf(await runCli(["replay"], { results, env: { ONEPASS_BATCH_MIN_TOKENS: "0" } }));

  const on = await runCli(["replay", "--compare", off.label], { results, env: { ONEPASS_BATCH_MIN_TOKENS: "20000" } });

  assert.equal(on.code, 0, on.stderr);
  const result = resultOf(on);
  assert.equal(result.replay?.diff.comparedWith, off.label);
  assert.ok(
    result.notes.some((note) => /batch minimum off/.test(note) && /batch minimum 20,000 tokens/.test(note)),
    `a note names both minimums: ${JSON.stringify(result.notes)}`,
  );
});

test("--compare refuses a replay of a different recording", async () => {
  await withOtherRecording();
  const results = scratch("onepass-eval-results-");
  const first = resultOf(await runCli(["replay"], { results }));

  const second = await runCli(["replay", "--recording", "other", "--compare", first.label], { results });

  assert.equal(second.code, 1);
  assert.match(second.stderr, /replayed `planning`/);
  assert.match(second.stderr, /`other`/);
});

test("with no --compare, a replay is reported against the last one of the same recording at the same settings", async () => {
  const results = scratch("onepass-eval-results-");
  const at110 = resultOf(await runCli(["replay"], { results, env: { ONEPASS_TRIP_TOKENS: "110000" } }));
  const at30 = resultOf(await runCli(["replay"], { results, env: { ONEPASS_TRIP_TOKENS: "30000" } }));
  const again = resultOf(await runCli(["replay"], { results, env: { ONEPASS_TRIP_TOKENS: "110000" } }));

  assert.equal(at30.replay?.diff.comparedWith, null, "the only earlier replay ran at another T");
  assert.equal(again.replay?.diff.comparedWith, at110.label, "the latest replay, at30, ran at another T");
});

test("a replay refuses when nothing has been recorded, and says how to record one", async () => {
  const bare = scratch("onepass-eval-corpus-");
  const source = writeTranscript(scratch("onepass-projects-"), "62d8de7e.jsonl", planningTranscript());
  const imported = await runCli(["import", source, "--name", "planning"], { env: { ONEPASS_EVAL_CORPUS: bare } });
  assert.equal(imported.code, 0, imported.stderr);

  const run = await runCli(["replay"], { env: { ONEPASS_EVAL_CORPUS: bare } });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /no recording filed under planning/);
  assert.match(run.stderr, /record\.sh/);
});

test("import-recordings files the bodies and says how many, how deep, and of what kind", async () => {
  const dir = scratch("onepass-eval-corpus-");
  const run = await runCli(["import-recordings", recordedSession()], { env: { ONEPASS_EVAL_CORPUS: dir } });

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Recorded requests: 12/);
  assert.match(run.stdout, /a model answered\s+12/);
  assert.match(run.stdout, /counted only\s+0/);
  assert.match(run.stdout, /biggest body\s+[\d,]+ bytes/);
  assert.equal(existsSync(join(realpathSync(dir), "recordings", "planning.import.json")), true);
});

test("prompts writes the session's prompts to a directory, and leaves out what nobody typed", async () => {
  const dir = scratch("onepass-eval-corpus-");
  const source = writeTranscript(scratch("onepass-projects-"), "62d8de7e.jsonl", [
    typed("u1", null, "plan the work"),
    model("a1", "u1", { contextTokens: 120_000 }),
    typed("u2", "a1", "[Request interrupted by user]"),
    typed("u3", "u2", "carry on"),
  ]);
  const imported = await runCli(["import", source, "--name", "planning"], { env: { ONEPASS_EVAL_CORPUS: dir } });
  assert.equal(imported.code, 0, imported.stderr);

  const out = join(scratch("onepass-eval-prompts-"), "prompts");
  const run = await runCli(["prompts", out], { env: { ONEPASS_EVAL_CORPUS: dir } });
  assert.equal(run.code, 0, run.stderr);

  // A file per prompt, named so that name order is session order, and each holding the text field
  // exactly. A driver feeds these with `claude -p < file`, so anything that reworded one would be
  // recording a session nobody had.
  assert.equal(readFileSync(join(out, "0001.txt"), "utf8"), "plan the work");
  assert.equal(readFileSync(join(out, "0002.txt"), "utf8"), "carry on");
  assert.equal(existsSync(join(out, "0003.txt")), false, "the interrupt notice is not a prompt");
  assert.match(run.stdout, /prompts to feed\s+2/);
  assert.match(run.stdout, /interrupted\s+1/);
});

test("session content has a home under the corpus, and the result document is not in the repository", async () => {
  const own = await preparedCorpus();
  const run = await runCli(["quick"], { env: { ONEPASS_EVAL_CORPUS: own } });
  const result = resultOf(run);

  assert.equal(result.corpusDir, realpathSync(own));
  for (const name of ["transcripts", "baselines", "worktrees", "hand-labels", "recordings", "runs"]) {
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
