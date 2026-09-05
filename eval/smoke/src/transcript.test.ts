// Unit tests for reading a stored session: the project-directory slug, and the turn cut that
// gives the fork point and the dropped turn's prompt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirFor, readTurns, type TranscriptEntry } from "./transcript.js";

const slugCases: { scenario: string; worktree: string; expected: string }[] = [
  {
    scenario: "slashes become dashes, leading slash included",
    worktree: "/tmp/onepass-smoke/repo-a",
    expected: "/home/me/.claude/projects/-tmp-onepass-smoke-repo-a",
  },
  {
    scenario: "a dot becomes a dash too, so a dotdir doubles the dash",
    worktree: "/Users/me/.proliferate/root",
    expected: "/home/me/.claude/projects/-Users-me--proliferate-root",
  },
  {
    scenario: "case is kept",
    worktree: "/Users/me/Project/ProJect/Onepass",
    expected: "/home/me/.claude/projects/-Users-me-Project-ProJect-Onepass",
  },
];

for (const { scenario, worktree, expected } of slugCases) {
  test(`projectDirFor ${scenario}`, () => {
    assert.equal(projectDirFor(worktree, "/home/me"), expected);
  });
}

test("projectDirFor slugs the resolved path, so a symlinked corpus dir lands where Claude Code looks", () => {
  const real = mkdtempSync(join(tmpdir(), "onepass-real-"));
  const link = join(mkdtempSync(join(tmpdir(), "onepass-link-")), "worktree");
  symlinkSync(real, link);

  // Claude Code files a session under the working directory it resolved, not the one it was
  // handed. On macOS this is what makes /tmp/x land under -private-tmp-x.
  assert.equal(projectDirFor(link, "/home/me"), projectDirFor(realpathSync(real), "/home/me"));
  assert.notEqual(projectDirFor(link, "/home/me"), join("/home/me/.claude/projects", link.replace(/[^A-Za-z0-9]/g, "-")));
});

/** A two-turn text session with a tool call in the second turn, in the shape the CLI writes. */
const twoTurns: TranscriptEntry[] = [
  { type: "summary", summary: "no uuid, not part of the chain" },
  {
    uuid: "u1",
    parentUuid: null,
    type: "user",
    promptSource: "cli",
    message: { role: "user", content: "remember the codeword" },
  },
  {
    uuid: "a1",
    parentUuid: "u1",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "noted" }] },
  },
  {
    uuid: "u2",
    parentUuid: "a1",
    type: "user",
    promptSource: "cli",
    message: { role: "user", content: [{ type: "text", text: "what was it" }] },
  },
  {
    uuid: "a2",
    parentUuid: "u2",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
  },
  {
    uuid: "r2",
    parentUuid: "a2",
    type: "user",
    toolUseResult: { stdout: "" },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  },
  {
    uuid: "a3",
    parentUuid: "r2",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "the codeword" }] },
  },
  {
    uuid: "s1",
    parentUuid: "a3",
    type: "attachment",
    attachment: { type: "whatever" },
  },
];

test("readTurns opens a turn at each typed prompt and not at a tool result", () => {
  const turns = readTurns(twoTurns);
  assert.deepEqual(
    turns.map((turn) => turn.promptUuid),
    ["u1", "u2"],
  );
});

test("readTurns reads the prompt text whether content is a string or a block array", () => {
  const turns = readTurns(twoTurns);
  assert.deepEqual(
    turns.map((turn) => turn.promptText),
    ["remember the codeword", "what was it"],
  );
});

test("readTurns ends a turn at the entry before the next prompt, not at its last assistant message", () => {
  const turns = readTurns(twoTurns);
  assert.equal(turns[0]?.lastUuid, "a1");
  // The trailing attachment is the second turn's last chain entry: forking at a3 would leave
  // it in the discarded range, which is what the SDK's fork-point guidance warns about.
  assert.equal(turns[1]?.lastUuid, "s1");
});

test("readTurns concatenates the assistant text of a turn and ignores tool_use blocks", () => {
  const turns = readTurns(twoTurns);
  assert.equal(turns[1]?.answerText, "the codeword");
});

test("readTurns ignores sidechain entries, which are a subagent's chain and not the session's", () => {
  const withSidechain: TranscriptEntry[] = [
    ...twoTurns,
    {
      uuid: "sc1",
      parentUuid: "a3",
      type: "user",
      isSidechain: true,
      promptSource: "cli",
      message: { role: "user", content: "a subagent prompt" },
    },
  ];
  assert.deepEqual(
    readTurns(withSidechain).map((turn) => turn.promptUuid),
    ["u1", "u2"],
  );
});
