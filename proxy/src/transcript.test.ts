// Choosing a transcript. The case that matters is two sessions in one directory: recall
// answering out of the other one is worse than recall answering nothing, because it is
// confident and wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTranscript, newestTranscript, transcriptDir, transcriptForSession } from "./transcript.js";

const MINE = "1e4f1b2c-1111-4222-8333-444455556666";
const THEIRS = "2e4f1b2c-1111-4222-8333-444455556666";
const CWD = "/tmp/a/project";

/** A config directory holding two sessions of the same project, theirs written most recently. */
function twoSessions(): { env: NodeJS.ProcessEnv; mine: string; theirs: string } {
  const configDir = mkdtempSync(join(tmpdir(), "onepass-config-"));
  const env = { CLAUDE_CONFIG_DIR: configDir };
  const dir = transcriptDir(CWD, env);
  mkdirSync(dir, { recursive: true });
  const mine = join(dir, `${MINE}.jsonl`);
  const theirs = join(dir, `${THEIRS}.jsonl`);
  writeFileSync(mine, "");
  writeFileSync(theirs, "");
  const older = new Date(Date.now() - 60_000);
  utimesSync(mine, older, older);
  return { env, mine, theirs };
}

test("a session id reads that session's transcript, not the one written most recently", () => {
  const { env, mine, theirs } = twoSessions();
  assert.equal(newestTranscript(CWD, env), theirs);
  assert.equal(transcriptForSession({ ...env, ONEPASS_SESSION_ID: MINE }, CWD).path, mine);
});

test("without a session id the newest transcript is still the best guess available", () => {
  const { env, theirs } = twoSessions();
  assert.equal(transcriptForSession(env, CWD).path, theirs);
});

test("a session whose transcript has not been written yet says so", () => {
  const { env } = twoSessions();
  const chosen = transcriptForSession({ ...env, ONEPASS_SESSION_ID: "3e4f1b2c-1111-4222-8333-444455556666" }, CWD);
  assert.equal(chosen.path, null);
  assert.match(chosen.reason, /No transcript yet for session 3e4f1b2c/);
});

test("nothing at all to read is reported against the directory that was searched", () => {
  const configDir = mkdtempSync(join(tmpdir(), "onepass-config-"));
  const chosen = transcriptForSession({ CLAUDE_CONFIG_DIR: configDir }, CWD);
  assert.equal(chosen.path, null);
  assert.match(chosen.reason, /No transcript found under .*-tmp-a-project/);
});

test("a transcript is found by id in whichever project directory holds it", () => {
  const configDir = mkdtempSync(join(tmpdir(), "onepass-config-"));
  const env = { CLAUDE_CONFIG_DIR: configDir };
  mkdirSync(join(configDir, "projects", "-some-other-project"), { recursive: true });
  mkdirSync(join(configDir, "projects", "-a-project"), { recursive: true });
  writeFileSync(join(configDir, "projects", "-a-project", `${MINE}.jsonl`), "");
  assert.equal(findTranscript(MINE, env), join(configDir, "projects", "-a-project", `${MINE}.jsonl`));
  assert.equal(findTranscript(THEIRS, env), null);
});
