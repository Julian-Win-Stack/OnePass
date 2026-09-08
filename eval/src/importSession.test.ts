// Importing is the one place the eval touches a real session, so what these tests are mostly
// about is that it touches it only to read: the source is byte-identical afterwards, and an
// import of a file no process could write to still succeeds.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCorpus, CORPUS_ENV, type Corpus } from "./corpus.js";
import { EvalError } from "./errors.js";
import { importSession, renderImport } from "./importSession.js";
import {
  compactBoundary,
  compactSummary,
  linkless,
  model,
  synthetic,
  systemEntry,
  toolResult,
  typed,
  writeTranscript,
  type Line,
} from "./transcriptFixture.js";

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function corpusIn(): Corpus {
  return resolveCorpus({ [CORPUS_ENV]: scratch("onepass-corpus-") }, scratch("onepass-repo-"));
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A session with everything an import has to report: two branches, a compaction, a rewrite. */
function session(): Line[] {
  return [
    linkless("custom-title", { customTitle: "planning" }),
    typed("u1", null, "plan the work", { sessionId: "ancestor" }),
    model("a1", "u1", { contextTokens: 90_000, sessionId: "ancestor", textOnly: false }),
    toolResult("r1", "a1", { sessionId: "ancestor" }),
    model("a2", "r1", { contextTokens: 172_630, sessionId: "ancestor" }),
    systemEntry("s1", "a2", "stop_hook_summary", { sessionId: "ancestor" }),
    compactBoundary("k1", "s1", { trigger: "manual", preTokens: 173_285, postTokens: 8_031 }),
    compactSummary("cs1", "k1"),
    typed("u2", "s1", "carry on"),
    model("a3", "u2", { contextTokens: 57_284 }),
    synthetic("y1", "a3"),
    typed("u3a", "y1", "the branch that was rewound out of"),
    model("a4a", "u3a", { contextTokens: 70_000 }),
    // The same entry written a second time, further down the file. Entries are rewritten in place
    // rather than edited, so the same uuid recurs and the last copy is the authoritative one.
    typed("u2", "s1", "carry on, the later copy"),
    typed("u3b", "y1", "the branch written last"),
    model("a4b", "u3b", { contextTokens: 65_000 }),
  ];
}

test("copies the transcript into the corpus byte for byte, beside a manifest", () => {
  const source = writeTranscript(scratch("onepass-projects-"), "62d8de7e.jsonl", session());
  const before = hash(source);
  const corpus = corpusIn();

  const imported = importSession(corpus, source, { tip: "a4a" });

  assert.equal(imported.transcriptPath, join(corpus.transcripts, "62d8de7e.jsonl"));
  assert.equal(hash(imported.transcriptPath), before, "the copy is not the same bytes as the source");
  assert.equal(imported.manifestPath, join(corpus.transcripts, "62d8de7e.import.json"));
  assert.ok(existsSync(imported.manifestPath), "no manifest was written beside the copy");
});

test("leaves the source transcript untouched: bytes, mode and mtime", () => {
  const source = writeTranscript(scratch("onepass-projects-"), "62d8de7e.jsonl", session());
  const before = hash(source);
  // Mode and mtime as well as content. `importSession` chmods the copy on the line below the one
  // that makes it, so `chmodSync(source, ...)` for `chmodSync(transcriptPath, ...)` is a one-word
  // slip that changes no bytes and no hash can see. The source is not the eval's to touch at all.
  const beforeStat = statSync(source);

  importSession(corpusIn(), source, { tip: "a4a" });

  const afterStat = statSync(source);
  assert.equal(hash(source), before, "the source transcript was modified");
  assert.equal(afterStat.mode, beforeStat.mode, "the source transcript's permissions were changed");
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "the source transcript's mtime was changed");
});

test("imports a transcript nothing could write to, which is the only proof it opened it to read", () => {
  const source = writeTranscript(scratch("onepass-projects-"), "readonly.jsonl", session());
  chmodSync(source, 0o444);
  try {
    const imported = importSession(corpusIn(), source, { tip: "a4b" });
    assert.equal(imported.branch.counts.typed, 3);
    // A copy of a read-only source is read-only too, and later stages have to be able to work
    // with it, so the copy is left readable and writable by its owner.
    assert.equal(statSync(imported.transcriptPath).mode & 0o200, 0o200);
  } finally {
    chmodSync(source, 0o644);
  }
});

test("the tip decides which branch is imported", () => {
  const source = writeTranscript(scratch("onepass-projects-"), "session.jsonl", session());
  const corpus = corpusIn();

  const byDefault = importSession(corpus, source);
  assert.equal(byDefault.branch.tipUuid, "a4b");
  assert.equal(byDefault.branch.tipChosen, "default");

  const named = importSession(corpus, source, { tip: "a4a" });
  assert.equal(named.branch.tipChosen, "named");
  assert.ok(
    named.branch.turns.some((turn) => turn.kind === "typed" && turn.text.includes("rewound out of")),
    "the named branch was not the one imported",
  );
});

test("a rewrite further down the file is the copy that is imported", () => {
  const source = writeTranscript(scratch("onepass-projects-"), "session.jsonl", session());
  const imported = importSession(corpusIn(), source, { tip: "a4b" });

  // The three hazards at once, in the order they have to be resolved: `u2` was written twice, the
  // file forks at `y1`, and the spine runs through the `system` entry `s1`. Resolve them in any
  // other order and this branch does not come out: keep the first copy of `u2` and the text is the
  // draft, filter before walking and `s1` is gone and everything above it with it.
  assert.deepEqual(
    imported.branch.turns.filter((turn) => turn.kind === "typed").map((turn) => (turn as { text: string }).text),
    ["plan the work", "carry on, the later copy", "the branch written last"],
  );
  assert.equal(imported.branch.file.duplicateWrites, 1);
  assert.equal(imported.branch.file.entries, 14, "a rewrite is not a fifteenth entry");
});

test("the manifest records the branch, not just the copy", () => {
  const source = writeTranscript(scratch("onepass-projects-"), "session.jsonl", session());
  const imported = importSession(corpusIn(), source, { tip: "a4b" });
  const manifest = JSON.parse(readFileSync(imported.manifestPath, "utf8")) as Record<string, any>;

  assert.equal(manifest.source, source);
  assert.equal(manifest.transcript, imported.transcriptPath);
  assert.equal(manifest.tip.uuid, "a4b");
  assert.equal(manifest.counts.typed, 3);
  assert.equal(manifest.compactions.length, 1);
  assert.equal(manifest.compactions[0].trigger, "manual");
  // Three tips: the branch that was rewound out of, the one that was kept, and the compaction
  // summary hanging off its own root.
  assert.equal(manifest.file.branches, 3);
  assert.deepEqual(manifest.sessionIds, ["ancestor", "session-1"]);
  assert.ok(manifest.trajectory.length > 0);
});

test("what it prints is the turn counts, the compaction points and the trajectory", () => {
  const source = writeTranscript(scratch("onepass-projects-"), "session.jsonl", session());
  const printed = renderImport(importSession(corpusIn(), source, { tip: "a4b" }));

  assert.match(printed, /typed by the user\s+3/);
  assert.match(printed, /Compactions on the branch: 1/);
  assert.match(printed, /trigger manual/);
  assert.match(printed, /Token trajectory over 4 model turns, peak 173k/);
  // What the file held around the branch, without which the counts mean nothing.
  assert.match(printed, /branches in the file\s+3/);
  assert.match(printed, /entries off the path\s+4 of 14/);
  assert.match(printed, /session ids present\s+ancestor, session-1/);
  assert.match(printed, /rewritten in place\s+1/);
  assert.match(printed, /passed over, no uuid\s+custom-title/);
});

test("refuses a name that would put the copy somewhere other than the corpus", () => {
  const source = writeTranscript(scratch("onepass-projects-"), "session.jsonl", session());
  const corpus = corpusIn();
  for (const name of ["../escape", "a/b", ".hidden", "  "]) {
    assert.throws(
      () => importSession(corpus, source, { name }),
      (err: unknown) => err instanceof EvalError && /is not a name a transcript copy can be filed under/.test(err.message),
      `${name} was not refused`,
    );
  }
});
