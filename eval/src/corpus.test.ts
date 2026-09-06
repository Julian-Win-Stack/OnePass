import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_ENV, resolveCorpus } from "./corpus.js";
import { EvalError } from "./errors.js";

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("refuses to start when the variable is unset", () => {
  const repo = scratch("onepass-eval-repo-");
  assert.throws(
    () => resolveCorpus({}, repo),
    (err: unknown) => err instanceof EvalError && err.message.includes(CORPUS_ENV),
  );
});

test("refuses to start when the variable is empty or blank", () => {
  const repo = scratch("onepass-eval-repo-");
  for (const value of ["", "   "]) {
    assert.throws(() => resolveCorpus({ [CORPUS_ENV]: value }, repo), EvalError);
  }
});

test("refuses a corpus inside the repository", () => {
  const repo = scratch("onepass-eval-repo-");
  const inside = join(repo, "eval", "corpus");
  assert.throws(
    () => resolveCorpus({ [CORPUS_ENV]: inside }, repo),
    (err: unknown) => err instanceof EvalError && err.message.includes("inside the repository"),
  );
  assert.equal(existsSync(inside), false, "a refused corpus must not be created");
});

test("refuses the repository itself", () => {
  const repo = scratch("onepass-eval-repo-");
  assert.throws(() => resolveCorpus({ [CORPUS_ENV]: repo }, repo), EvalError);
});

test("refuses a corpus that reaches inside the repository through a symlink", () => {
  const repo = scratch("onepass-eval-repo-");
  const outside = scratch("onepass-eval-corpus-");
  mkdirSync(join(repo, "real-corpus"), { recursive: true });
  const link = join(outside, "link");
  symlinkSync(join(repo, "real-corpus"), link);
  assert.throws(() => resolveCorpus({ [CORPUS_ENV]: link }, repo), EvalError);
});

test("creates the layout under a corpus outside the repository", () => {
  const repo = scratch("onepass-eval-repo-");
  const dir = join(scratch("onepass-eval-corpus-"), "corpus");
  const corpus = resolveCorpus({ [CORPUS_ENV]: dir }, repo);

  assert.equal(corpus.dir, dir);
  for (const path of [corpus.transcripts, corpus.baselines, corpus.worktrees, corpus.handLabels, corpus.runs]) {
    assert.ok(existsSync(path), `${path} was not created`);
    assert.ok(path.startsWith(dir), `${path} is not under the corpus`);
  }
});

test("a run directory is created on first use and named by the label", () => {
  const repo = scratch("onepass-eval-repo-");
  const corpus = resolveCorpus({ [CORPUS_ENV]: scratch("onepass-eval-corpus-") }, repo);
  const dir = corpus.runDir("abc1234-20260906T101112Z");
  assert.equal(dir, join(corpus.runs, "abc1234-20260906T101112Z"));
  assert.ok(existsSync(dir));
});

test("trims the value before resolving it", () => {
  const repo = scratch("onepass-eval-repo-");
  const outside = scratch("onepass-eval-corpus-");
  const corpus = resolveCorpus({ [CORPUS_ENV]: `  ${outside}/spaced  ` }, repo);
  assert.equal(corpus.dir, join(outside, "spaced"));
});
