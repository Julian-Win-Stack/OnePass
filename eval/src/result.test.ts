import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeLabel, readRunResult, renderRunResult, RESULT_SCHEMA, runLabel, writeRunResult, type RunResult } from "./result.js";
import { EvalError } from "./errors.js";
import { writeFileSync } from "node:fs";

function aResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schema: RESULT_SCHEMA,
    label: "a001c2b-20260906T101112Z",
    mode: "quick",
    scored: true,
    startedAt: "2026-09-06T10:11:12.000Z",
    finishedAt: "2026-09-06T10:11:20.000Z",
    durationMs: 8000,
    comparedWith: null,
    proxy: { shortSha: "a001c2b", dirty: false, version: "0.2.0", judge: "off", logs: ["/tmp/proxy.log.jsonl"] },
    corpusDir: "/tmp/corpus",
    upstream: "https://api.anthropic.com",
    baselines: [
      {
        purpose: "planning",
        key: { model: "claude-opus-5", effort: "xhigh", claudeCode: "2.1.261" },
        directory: "claude-opus-5--xhigh--cc2.1.261",
        recorded: false,
      },
    ],
    cases: [],
    arms: [],
    problems: [],
    notes: [],
    ...overrides,
  };
}

test("a label is the proxy's short SHA and the time the run started", () => {
  assert.equal(runLabel("a001c2b", false, new Date("2026-09-06T10:11:12.345Z")), "a001c2b-20260906T101112Z");
});

test("two runs of the same build do not collide", () => {
  const first = runLabel("a001c2b", false, new Date("2026-09-06T10:11:12Z"));
  const second = runLabel("a001c2b", false, new Date("2026-09-06T10:11:13Z"));
  assert.notEqual(first, second);
});

test("a build with uncommitted changes says so in its label", () => {
  assert.equal(runLabel("a001c2b", true, new Date("2026-09-06T10:11:12Z")), "a001c2b-dirty-20260906T101112Z");
});

test("the pair of files is written under the label and reads back", () => {
  const dir = mkdtempSync(join(tmpdir(), "onepass-eval-results-"));
  const result = aResult();
  const written = writeRunResult(dir, result);

  assert.equal(written.jsonPath, join(dir, "a001c2b-20260906T101112Z.json"));
  assert.equal(written.markdownPath, join(dir, "a001c2b-20260906T101112Z.md"));
  assert.deepEqual(readRunResult(dir, result.label), result);
  assert.equal(readRunResult(dir, "never-ran"), null);
});

test("a label already written is stepped past, so one run never overwrites another", () => {
  const dir = mkdtempSync(join(tmpdir(), "onepass-eval-results-"));
  assert.equal(freeLabel(dir, "a001c2b-20260906T101112Z"), "a001c2b-20260906T101112Z");

  writeRunResult(dir, aResult());
  assert.equal(freeLabel(dir, "a001c2b-20260906T101112Z"), "a001c2b-20260906T101112Z-2");

  writeRunResult(dir, aResult({ label: "a001c2b-20260906T101112Z-2" }));
  assert.equal(freeLabel(dir, "a001c2b-20260906T101112Z"), "a001c2b-20260906T101112Z-3");
});

test("a result document that will not parse is a refusal, not a missing run", () => {
  const dir = mkdtempSync(join(tmpdir(), "onepass-eval-results-"));
  writeFileSync(join(dir, "corrupt-20260906T101112Z.json"), "{ half a document");
  assert.throws(() => readRunResult(dir, "corrupt-20260906T101112Z"), EvalError);
});

test("the rendered table names the build, the baseline and the corpus without reading the JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "onepass-eval-results-"));
  writeRunResult(dir, aResult());
  const table = readFileSync(join(dir, "a001c2b-20260906T101112Z.md"), "utf8");

  assert.match(table, /# Onepass eval — a001c2b-20260906T101112Z/);
  assert.match(table, /quick mode, scored/);
  assert.match(table, /claude-opus-5/);
  assert.match(table, /2\.1\.261/);
  assert.match(table, /\/tmp\/corpus/);
  assert.match(table, /judge \| off/);
});

test("an uncommitted build is called out in the table, not only in the label", () => {
  const table = renderRunResult(aResult({ proxy: { ...aResult().proxy, dirty: true } }));
  assert.match(table, /uncommitted changes/);
});

test("problems are printed in full, never as a count", () => {
  const table = renderRunResult(
    aResult({ problems: [{ what: "case 12", detail: "the fork ended without text" }] }),
  );
  assert.match(table, /case 12/);
  assert.match(table, /the fork ended without text/);
});

test("a replay run renders as not scored", () => {
  const table = renderRunResult(aResult({ mode: "replay", scored: false }));
  assert.match(table, /replay mode, not scored/);
});
