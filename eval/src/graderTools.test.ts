// The three tools, driven the way the runner drives them: parse the model's arguments, run,
// and answer with text. What matters most is what they refuse — a grader that can read outside
// the repository the answer was written against is grading something else.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Every file under `dir` with its bytes, so the repository can be compared before and after. */
function treeOf(dir: string): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [below, text] of Object.entries(treeOf(path))) tree[`${entry.name}/${below}`] = text;
    } else if (entry.isFile()) {
      tree[entry.name] = readFileSync(path, "utf8");
    }
  }
  return tree;
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

test("search takes a regular expression, not a literal string", async () => {
  const repo = aRepo();
  assert.match(await call(repo, "search", { pattern: "ev(ict|ade)" }), /^src\/evict\.ts:1:/m);
});

test("search says so when nothing matched", async () => {
  const repo = aRepo();
  assert.equal(await call(repo, "search", { pattern: "compaction" }), "No match for compaction.");
});

test("a pattern that is not a regular expression is said so, rather than thrown", async () => {
  const repo = aRepo();
  const out = await call(repo, "search", { pattern: "ev(ict" });
  assert.match(out, /^ev\(ict is not a regular expression: /);
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

test("search refuses a directory outside the repository, rather than searching it", async () => {
  // Search checks its path argument the way read_file does, and nothing below it would: the walk
  // only skips symlinks, and a directory reached by `..` is an ordinary directory it would read
  // to the end. Take that check away and this is the test that notices.
  const repo = aRepo();
  const outside = mkdtempSync(join(tmpdir(), "onepass-eval-elsewhere-"));
  writeFileSync(join(outside, "secret.txt"), "not the grader's business\n");

  for (const path of [outside, "..", "src/../.."]) {
    assert.equal(
      await call(repo, "search", { pattern: "grader's business", path }),
      `${path} is outside the repository being graded. Ask for a path inside it.`,
    );
  }
});

test("list refuses a directory outside the repository, however it is reached", async () => {
  // Named outright, and reached through a link that looks like an ordinary directory from inside
  // the repository. A check written on the path as it was typed would refuse the first and allow
  // the second, and the grader would be handed the names of another arm's files.
  const repo = aRepo();
  const outside = mkdtempSync(join(tmpdir(), "onepass-eval-elsewhere-"));
  writeFileSync(join(outside, "secret.txt"), "not the grader's business\n");
  symlinkSync(outside, join(repo, "escape"));

  for (const path of [outside, "escape"]) {
    assert.equal(
      await call(repo, "list", { path }),
      `${path} is outside the repository being graded. Ask for a path inside it.`,
    );
  }
});

test("read_file refuses a file reached through a symlinked directory", async () => {
  // The link is a directory here, not the file itself, so every part of the path the grader
  // asked for is spelled like something inside the repository. Only resolving the whole path
  // through its links before the check tells this apart from a file that really is inside.
  const repo = aRepo();
  const outside = mkdtempSync(join(tmpdir(), "onepass-eval-elsewhere-"));
  writeFileSync(join(outside, "secret.txt"), "not the grader's business\n");
  symlinkSync(outside, join(repo, "escape"));

  assert.equal(
    await call(repo, "read_file", { path: "escape/secret.txt" }),
    "escape/secret.txt is outside the repository being graded. Ask for a path inside it.",
  );
});

test("a repository reached through a symlink still contains its own files", async () => {
  // The other side of the same rule, and the one that would go unnoticed: if the root is not
  // resolved too, every path under it resolves past the link and lands outside a root that is
  // still spelled with it, so the grader is refused its own repository and grades on nothing.
  // Every other test here is handed a real path, which leaves this free to break in silence.
  const real = aRepo();
  const link = join(mkdtempSync(join(tmpdir(), "onepass-eval-link-")), "repo");
  symlinkSync(real, link);

  assert.equal(await call(link, "read_file", { path: "src/keep.ts" }), "1\texport const keep = true;\n2\t");
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
  assert.equal(await call(repo, "read_file", { path: "src/nowhere.ts" }), "There is no file at src/nowhere.ts.");
});

test("a directory that is not there is said so, rather than thrown", async () => {
  const repo = aRepo();
  assert.equal(await call(repo, "list", { path: "nowhere" }), "There is no directory at nowhere.");
});

test("nothing the tools do writes to the repository", async () => {
  const repo = aRepo();
  const before = treeOf(repo);

  await call(repo, "read_file", { path: "src/evict.ts" });
  await call(repo, "list", {});
  await call(repo, "search", { pattern: "evict" });
  // A refusal, a miss and a bad pattern each run their own code, and any of the three could
  // leave something behind on the way to answering with text.
  await call(repo, "read_file", { path: "../secret.txt" });
  await call(repo, "read_file", { path: "src/nowhere.ts" });
  await call(repo, "list", { path: "nowhere" });
  await call(repo, "search", { pattern: "ev(ict" });

  assert.deepEqual(treeOf(repo), before, "a tool changed the repository it was grading");
});

test("no tool takes an argument that could name something to write", () => {
  // The schemas are the second guarantee, and the one the model is bound by: a tool it cannot
  // ask to write is one it cannot be talked into writing with.
  for (const tool of graderTools(aRepo())) {
    const properties = Object.keys((tool.input_schema as { properties?: object }).properties ?? {});
    assert.deepEqual(
      properties.filter((name) => /content|text|write|data/.test(name)),
      [],
      `${tool.name} takes something to write`,
    );
  }
});
