import test from "node:test";
import assert from "node:assert/strict";
import { isScored, parseArgs, USAGE, wantsHelp } from "./args.js";
import { UsageError } from "./errors.js";

test("reads each mode", () => {
  assert.equal(parseArgs(["replay"]).mode, "replay");
  assert.equal(parseArgs(["quick"]).mode, "quick");
  assert.equal(parseArgs(["full"]).mode, "full");
});

test("defaults the optional arguments to null", () => {
  const options = parseArgs(["quick"]);
  assert.equal(options.compareWith, null);
  assert.equal(options.resultsDir, null);
});

test("takes the label of a previous run, either spelling", () => {
  assert.equal(parseArgs(["quick", "--compare", "abc1234-20260906T101112Z"]).compareWith, "abc1234-20260906T101112Z");
  assert.equal(parseArgs(["quick", "--compare=abc1234-20260906T101112Z"]).compareWith, "abc1234-20260906T101112Z");
});

test("takes a results directory", () => {
  assert.equal(parseArgs(["full", "--results-dir", "/tmp/out"]).resultsDir, "/tmp/out");
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

test("recognises a request for the usage text", () => {
  assert.equal(wantsHelp(["--help"]), true);
  assert.equal(wantsHelp(["-h"]), true);
  assert.equal(wantsHelp(["quick"]), false);
});

test("the usage text names every mode and the corpus variable", () => {
  for (const needle of ["replay", "quick", "full", "ONEPASS_EVAL_CORPUS"]) {
    assert.ok(USAGE.includes(needle), `usage does not mention ${needle}`);
  }
});

test("replay is not scored; quick and full are", () => {
  assert.equal(isScored("replay"), false);
  assert.equal(isScored("quick"), true);
  assert.equal(isScored("full"), true);
});
