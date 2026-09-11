import test from "node:test";
import assert from "node:assert/strict";
import { isScored, parseArgs, USAGE, wantsHelp, type ImportCommand, type RunCommand } from "./args.js";
import { UsageError } from "./errors.js";

/** Narrows to a run, so a test that means to read a mode fails loudly when it did not get one. */
function run(argv: string[]): RunCommand {
  const command = parseArgs(argv);
  assert.equal(command.kind, "run");
  return command as RunCommand;
}

function imported(argv: string[]): ImportCommand {
  const command = parseArgs(argv);
  assert.equal(command.kind, "import");
  return command as ImportCommand;
}

test("import-recordings takes the recording proxy's log, to read the ratios the real API reported", () => {
  assert.deepEqual(parseArgs(["import-recordings", "/tmp/bodies", "--name", "x", "--proxy-log", "/tmp/proxy.log.jsonl"]), {
    kind: "import-recordings",
    dumpDir: "/tmp/bodies",
    name: "x",
    proxyLog: "/tmp/proxy.log.jsonl",
  });
  assert.equal((parseArgs(["import-recordings", "/tmp/bodies"]) as { proxyLog: unknown }).proxyLog, null);
  assert.match(USAGE, /--proxy-log/);
});

test("reads each mode", () => {
  assert.equal(run(["replay"]).mode, "replay");
  assert.equal(run(["quick"]).mode, "quick");
  assert.equal(run(["full"]).mode, "full");
});

test("defaults the optional arguments to null", () => {
  const options = run(["quick"]);
  assert.equal(options.compareWith, null);
  assert.equal(options.resultsDir, null);
});

test("takes the label of a previous run, either spelling", () => {
  assert.equal(run(["quick", "--compare", "abc1234-20260906T101112Z"]).compareWith, "abc1234-20260906T101112Z");
  assert.equal(run(["quick", "--compare=abc1234-20260906T101112Z"]).compareWith, "abc1234-20260906T101112Z");
});

test("takes a results directory", () => {
  assert.equal(run(["full", "--results-dir", "/tmp/out"]).resultsDir, "/tmp/out");
});

test("replay takes the recording to send, and defaults to the planning one", () => {
  assert.equal(run(["replay", "--recording", "harbor-make-mips"]).recording, "harbor-make-mips");
  assert.equal(run(["replay"]).recording, null);
});

test("a scored run refuses a recording: it does not replay one", () => {
  assert.throws(
    () => parseArgs(["quick", "--recording", "harbor-make-mips"]),
    (err: unknown) => err instanceof UsageError && /--recording is for replay/.test(err.message),
  );
});

test("refuses a missing mode", () => {
  assert.throws(() => parseArgs([]), (err: unknown) => err instanceof UsageError && /no mode given/.test(err.message));
});

test("refuses an unknown mode", () => {
  assert.throws(() => parseArgs(["cheap"]), (err: unknown) => err instanceof UsageError && /unknown mode: cheap/.test(err.message));
});

test("refuses a second mode", () => {
  assert.throws(() => parseArgs(["quick", "full"]), (err: unknown) => err instanceof UsageError && /unexpected argument: full/.test(err.message));
});

test("refuses an unknown option", () => {
  assert.throws(() => parseArgs(["quick", "--seed", "4"]), (err: unknown) => err instanceof UsageError && /unknown option: --seed/.test(err.message));
});

test("refuses an option with no value", () => {
  assert.throws(() => parseArgs(["quick", "--compare"]), (err: unknown) => err instanceof UsageError && /--compare needs a value/.test(err.message));
  assert.throws(
    () => parseArgs(["quick", "--compare", "--results-dir", "/tmp"]),
    (err: unknown) => err instanceof UsageError && /--compare needs a value/.test(err.message),
  );
});

test("import takes a transcript, and a tip and a name are optional", () => {
  const bare = imported(["import", "/tmp/session.jsonl"]);
  assert.equal(bare.transcript, "/tmp/session.jsonl");
  assert.equal(bare.tip, null);
  assert.equal(bare.name, null);

  const named = imported(["import", "/tmp/session.jsonl", "--tip", "b788171", "--name=planning"]);
  assert.equal(named.tip, "b788171");
  assert.equal(named.name, "planning");
});

test("import refuses without a transcript, and refuses a second one", () => {
  assert.throws(
    () => parseArgs(["import"]),
    (err: unknown) => err instanceof UsageError && /needs the path of a transcript/.test(err.message),
  );
  assert.throws(
    () => parseArgs(["import", "a.jsonl", "b.jsonl"]),
    (err: unknown) => err instanceof UsageError && /unexpected argument: b.jsonl/.test(err.message),
  );
});

test("import refuses a run's options, and a run refuses import's", () => {
  assert.throws(() => parseArgs(["import", "a.jsonl", "--compare", "x"]), UsageError);
  assert.throws(() => parseArgs(["quick", "--tip", "x"]), UsageError);
});

test("recognises a request for the usage text", () => {
  assert.equal(wantsHelp(["--help"]), true);
  assert.equal(wantsHelp(["-h"]), true);
  assert.equal(wantsHelp(["quick"]), false);
});

test("the usage text names every mode, the import command and the corpus variable", () => {
  for (const needle of ["replay", "quick", "full", "import", "--tip", "ONEPASS_EVAL_CORPUS"]) {
    assert.ok(USAGE.includes(needle), `usage does not mention ${needle}`);
  }
});

test("replay is not scored; quick and full are", () => {
  assert.equal(isScored("replay"), false);
  assert.equal(isScored("quick"), true);
  assert.equal(isScored("full"), true);
});
