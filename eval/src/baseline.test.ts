import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baselineDirectory,
  CLAUDE_CODE_VERSION_ENV,
  openBaselineStore,
  planningBaselineKey,
  readClaudeCodeVersion,
  tailBaselineKey,
} from "./baseline.js";
import { EvalError } from "./errors.js";

function baselines(): string {
  return mkdtempSync(join(tmpdir(), "onepass-eval-baselines-"));
}

const key = { model: "claude-opus-5", effort: "xhigh", claudeCode: "2.1.261" };

test("records content once and reuses it while the key holds", async () => {
  const dir = baselines();
  let recordings = 0;
  const record = (): { answer: string } => {
    recordings += 1;
    return { answer: `control ${recordings}` };
  };

  const first = await openBaselineStore(dir, key).ensure("planning/case-12", record);
  assert.deepEqual(first, { value: { answer: "control 1" }, reused: false });

  const second = await openBaselineStore(dir, key).ensure("planning/case-12", record);
  assert.deepEqual(second, { value: { answer: "control 1" }, reused: true });
  assert.equal(recordings, 1, "a reused baseline must not be re-recorded");
});

test("re-records when the model, the effort or the Claude Code version changes", async () => {
  const dir = baselines();
  const changed = [
    { ...key, model: "claude-sonnet-5" },
    { ...key, effort: "high" },
    { ...key, claudeCode: "2.1.262" },
  ];
  await openBaselineStore(dir, key).ensure("tails/tail-1", () => ({ answer: "original" }));

  for (const other of changed) {
    const store = openBaselineStore(dir, other);
    assert.equal(store.has("tails/tail-1"), false, `${store.directory} reused another key's content`);
    const result = await store.ensure("tails/tail-1", () => ({ answer: store.directory }));
    assert.deepEqual(result, { value: { answer: store.directory }, reused: false });
  }

  // The original key still has its own content: a changed key is a new world, not a wiped one.
  const back = await openBaselineStore(dir, key).ensure("tails/tail-1", () => ({ answer: "rewritten" }));
  assert.deepEqual(back, { value: { answer: "original" }, reused: true });
});

test("a store reads back what it wrote, and null for what it has not", () => {
  const store = openBaselineStore(baselines(), key);
  assert.equal(store.read("planning/case-1"), null);
  assert.equal(store.has("planning/case-1"), false);
});

test("a key holds nothing until something is recorded under it", async () => {
  const store = openBaselineStore(baselines(), key);
  assert.equal(store.recorded, false);
  await store.ensure("planning/case-1", () => ({ answer: "control" }));
  assert.equal(store.recorded, true);
});

test("the baseline directory says what world it was recorded in", async () => {
  const dir = baselines();
  const store = openBaselineStore(dir, key);
  await store.ensure("planning/case-1", () => ({ answer: "control" }));

  assert.equal(store.directory, "claude-opus-5--xhigh--cc2.1.261");
  assert.equal(store.path, join(dir, store.directory));
  assert.deepEqual(JSON.parse(readFileSync(join(store.path, "key.json"), "utf8")), key);
  assert.ok(existsSync(join(store.path, "planning", "case-1.json")));
});

test("a baseline directory is a single readable path segment", () => {
  const directory = baselineDirectory({ model: "claude-opus-5[1m]", effort: "x high", claudeCode: "2.1.261" });
  assert.equal(directory.includes("/"), false);
  assert.match(directory, /^[A-Za-z0-9._-]+$/);
});

test("refuses an entry name that climbs out of the baseline", () => {
  const store = openBaselineStore(baselines(), key);
  assert.throws(() => store.has("../../escape"), EvalError);
  assert.throws(() => store.has(""), EvalError);
});

test("the planning and tail keys differ by effort alone", () => {
  assert.deepEqual(planningBaselineKey("2.1.261"), { model: "claude-opus-5", effort: "xhigh", claudeCode: "2.1.261" });
  assert.deepEqual(tailBaselineKey("2.1.261"), { model: "claude-opus-5", effort: "high", claudeCode: "2.1.261" });
});

test("the Claude Code version comes from the environment when it is set", () => {
  assert.equal(readClaudeCodeVersion({ [CLAUDE_CODE_VERSION_ENV]: " 2.1.261 " }), "2.1.261");
});
