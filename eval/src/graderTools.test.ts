// The three tools, driven the way the runner drives them: parse the model's arguments, run,
// and answer with text. What matters most is what they refuse — a grader that can read outside
// the repository the answer was written against is grading something else.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graderTools } from "./graderTools.js";

/** A small repository to read: two files, one of them a directory down. */
function aRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "onepass-eval-repo-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "README.md"), "Onepass\n=======\n");
  writeFileSync(join(dir, "src", "evict.ts"), "export function evict(): void {\n  // evicts a tool result\n}\n");
  writeFileSync(join(dir, "src", "keep.ts"), "export const keep = true;\n");
  return dir;
}

/** Runs a tool by name the way the runner does, through its own parse. */
async function call(repo: string, name: string, input: unknown): Promise<string> {
  const tool = graderTools(repo).find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `no tool named ${name}`);
  const output = await tool.run(tool.parse(input));
  return typeof output === "string" ? output : JSON.stringify(output);
}

test("the grader gets read file, search and list, and nothing else", () => {
  const repo = aRepo();
  assert.deepEqual(
    graderTools(repo).map((tool) => tool.name),
    ["read_file", "search", "list"],
  );
});

test("read_file answers with the file's lines, numbered", async () => {
  const repo = aRepo();
  const out = await call(repo, "read_file", { path: "src/evict.ts" });
  assert.match(out, /1\texport function evict\(\): void \{/);
  assert.match(out, /2\t {2}\/\/ evicts a tool result/);
});

test("list answers with a directory's entries, directories marked", async () => {
  const repo = aRepo();
  const root = await call(repo, "list", {});
  assert.match(root, /^README\.md$/m);
  assert.match(root, /^src\/$/m);

  const src = await call(repo, "list", { path: "src" });
  assert.match(src, /^evict\.ts$/m);
  assert.doesNotMatch(src, /README/);
});

test("search answers with the file, the line number and the line", async () => {
  const repo = aRepo();
  const out = await call(repo, "search", { pattern: "tool result" });
  assert.match(out, /^src\/evict\.ts:2:\s+\/\/ evicts a tool result$/m);
  assert.doesNotMatch(out, /keep\.ts/);
});

test("search takes a regular expression, and says so when nothing matched", async () => {
  const repo = aRepo();
  assert.match(await call(repo, "search", { pattern: "ev(ict|ade)" }), /src\/evict\.ts:1:/);
  assert.match(await call(repo, "search", { pattern: "compaction" }), /no match/i);
});

test("a path outside the repository is refused, not read", async () => {
  const repo = aRepo();
  const outside = mkdtempSync(join(tmpdir(), "onepass-eval-elsewhere-"));
  writeFileSync(join(outside, "secret.txt"), "not the grader's business\n");

  for (const path of ["../secret.txt", join(outside, "secret.txt"), "src/../../secret.txt"]) {
    const out = await call(repo, "read_file", { path });
    assert.match(out, /outside the repository/, `${path} was not refused`);
    assert.doesNotMatch(out, /not the grader's business/);
  }
  assert.match(await call(repo, "list", { path: ".." }), /outside the repository/);
});

test("a symlink pointing out of the repository is refused too", async () => {
  const repo = aRepo();
  const outside = mkdtempSync(join(tmpdir(), "onepass-eval-elsewhere-"));
  writeFileSync(join(outside, "secret.txt"), "not the grader's business\n");
  symlinkSync(join(outside, "secret.txt"), join(repo, "escape.txt"));

  const out = await call(repo, "read_file", { path: "escape.txt" });
  assert.match(out, /outside the repository/);
  assert.doesNotMatch(out, /not the grader's business/);
});

test("search does not follow a symlink out of the repository either", async () => {
  // The refusal on read_file is a check on an argument; search takes no path to the file it
  // reads, so nothing refuses on its behalf and only the walk keeps it inside.
  const repo = aRepo();
  const outside = mkdtempSync(join(tmpdir(), "onepass-eval-elsewhere-"));
  writeFileSync(join(outside, "secret.txt"), "a tool result nobody may grade\n");
  symlinkSync(join(outside, "secret.txt"), join(repo, "escape.txt"));
  symlinkSync(outside, join(repo, "escape"));

  const out = await call(repo, "search", { pattern: "nobody may grade" });
  assert.match(out, /no match/i);
});

test("neither .git nor node_modules is code the answer was written against", async () => {
  const repo = aRepo();
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "// evicts a tool result\n");
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "COMMIT_EDITMSG"), "evicts a tool result\n");

  const found = await call(repo, "search", { pattern: "evicts a tool result" });
  assert.match(found, /^src\/evict\.ts:2:/m);
  assert.doesNotMatch(found, /node_modules/);
  assert.doesNotMatch(found, /COMMIT_EDITMSG/);

  const listed = await call(repo, "list", {});
  assert.doesNotMatch(listed, /node_modules/);
  assert.doesNotMatch(listed, /\.git/);
});

test("a file that is not there is said so, rather than thrown", async () => {
  const repo = aRepo();
  assert.match(await call(repo, "read_file", { path: "src/nowhere.ts" }), /no file at src\/nowhere\.ts/);
  assert.match(await call(repo, "list", { path: "nowhere" }), /no directory at nowhere/);
});

test("nothing the tools do writes to the repository", async () => {
  const repo = aRepo();
  // The tools take no argument that could name something to write, which is what makes them
  // read-only: the schema is the guarantee, not a check inside run.
  for (const tool of graderTools(repo)) {
    const properties = Object.keys((tool.input_schema as { properties?: object }).properties ?? {});
    assert.deepEqual(
      properties.filter((name) => /content|text|write|data/.test(name)),
      [],
      `${tool.name} takes something to write`,
    );
  }
});
