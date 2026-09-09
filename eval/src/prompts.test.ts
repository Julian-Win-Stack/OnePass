import test from "node:test";
import assert from "node:assert/strict";
import { readPrompts } from "./prompts.js";
import { branchOf, model, typed, type Line } from "./transcriptFixture.js";

/** A session driven by three real prompts with Claude Code's own entries mixed in between. */
function session(): Line[] {
  const lines: Line[] = [];
  let parent: string | null = null;
  const add = (line: Line): void => {
    lines.push(line);
    parent = line.uuid as string;
  };
  add(typed("u1", parent, "plan the takehome"));
  add(model("m1", parent));
  add(typed("u2", parent, "[Request interrupted by user]"));
  add(typed("u3", parent, "<command-name>/compact</command-name>\n<command-message>compact</command-message>"));
  add(typed("u4", parent, "<local-command-stdout>Compacted </local-command-stdout>"));
  add(typed("u5", parent, "now write the tests"));
  add(model("m2", parent));
  add(typed("u6", parent, "  "));
  add(typed("u7", parent, "and the README"));
  return lines;
}

test("the prompts are the typed turns a person wrote, in order", () => {
  const list = readPrompts(branchOf(session(), "u7"));

  assert.equal(list.typedTurns, 7);
  assert.deepEqual(
    list.prompts.map((prompt) => prompt.text),
    ["plan the takehome", "now write the tests", "and the README"],
  );
  // Position is what the recording script counts by, so it numbers the prompts it will feed and
  // not the turns of the branch they came from.
  assert.deepEqual(
    list.prompts.map((prompt) => prompt.position),
    [1, 2, 3],
  );
  assert.deepEqual(
    list.prompts.map((prompt) => prompt.uuid),
    ["u1", "u5", "u7"],
  );
});

test("the entries Claude Code writes in the user slot are held back and named", () => {
  const list = readPrompts(branchOf(session(), "u7"));

  assert.deepEqual(
    list.skipped.map((entry) => [entry.uuid, entry.why]),
    [
      ["u2", "interrupted"],
      ["u3", "slash command"],
      ["u4", "command output"],
      ["u6", "empty"],
    ],
  );
  assert.equal(list.prompts.length + list.skipped.length, list.typedTurns);
});

test("a prompt is the text field verbatim, newlines and all", () => {
  const text = "  read src/index.ts\n\nthen tell me what it does  ";
  const [prompt] = readPrompts(branchOf([typed("u1", null, text)], "u1")).prompts;

  assert.equal(prompt?.text, text, "trimming a prompt would change what the session was driven by");
});
