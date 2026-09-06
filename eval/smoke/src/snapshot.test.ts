// Acceptance criteria 4 and 5 of issue #4, against a throwaway git repository: a snapshot is
// invisible to the agent working in the repo, and it can be materialised afterwards as a
// worktree carrying the recorded file state.
//
// This is the half of the smoke check that needs no model and no live `claude`, so it survives
// as an ordinary test. The live half — criteria 1, 2 and 3 — was a one-time instrument and was
// deleted once it had answered; see README.md for its recorded output. Invisibility is asserted
// here through `agentView`, which is the single definition of what the agent can see.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentView, applyAgentEdits, git, initThrowawayRepo } from "./git.js";
import { createSnapshotter, listSnapshots, materialiseSnapshot, SNAPSHOT_NAMESPACE } from "./snapshot.js";

/** A repository with one commit, one ignored path, and the agent's uncommitted work on top. */
function recordingRepo(): string {
  const repo = initThrowawayRepo(mkdtempSync(join(tmpdir(), "onepass-snapshot-")));
  applyAgentEdits(repo);
  return repo;
}

function indexFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "onepass-index-")), name);
}

test("a snapshot leaves the agent's git status, diff, log, index and branches unchanged", () => {
  const repo = recordingRepo();
  const before = agentView(repo);

  const snapshotter = createSnapshotter({ repo, indexFile: indexFile("a") });
  snapshotter.snapshot("toolu_01");
  writeFileSync(join(repo, "untracked.txt"), "changed again\n");
  snapshotter.snapshot("toolu_02");
  snapshotter.dispose();

  assert.deepEqual(agentView(repo), before);
});

test("a snapshot records the worktree, tracked edits and untracked files alike", () => {
  const repo = recordingRepo();
  const snapshotter = createSnapshotter({ repo, indexFile: indexFile("b") });
  const snapshot = snapshotter.snapshot("toolu_01");

  const files = git(repo, ["ls-tree", "-r", "--name-only", snapshot.commit]).trim().split("\n").sort();
  assert.deepEqual(files, [".gitignore", "tracked.txt", "untracked.txt"]);
  assert.equal(git(repo, ["show", `${snapshot.commit}:tracked.txt`]), "edited by the agent\n");
});

test("a snapshot does not record ignored paths, so an installed node_modules costs nothing", () => {
  const repo = recordingRepo();
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");

  const snapshotter = createSnapshotter({ repo, indexFile: indexFile("c") });
  const snapshot = snapshotter.snapshot("toolu_01");

  const files = git(repo, ["ls-tree", "-r", "--name-only", snapshot.commit]);
  assert.ok(!files.includes("node_modules/"), `an ignored path was recorded:\n${files}`);
});

test("snapshots are stored under the private ref namespace, one ref per tool-use id", () => {
  const repo = recordingRepo();
  const snapshotter = createSnapshotter({ repo, indexFile: indexFile("d") });
  const first = snapshotter.snapshot("toolu_01");
  writeFileSync(join(repo, "tracked.txt"), "second state\n");
  const second = snapshotter.snapshot("toolu_02");

  assert.equal(first.ref, `${SNAPSHOT_NAMESPACE}/toolu_01`);
  assert.deepEqual(
    listSnapshots({ repo }).map((snapshot) => snapshot.toolUseId),
    ["toolu_01", "toolu_02"],
  );
  assert.notEqual(first.commit, second.commit);
});

test("a snapshot whose worktree did not change since the last one still gets its own ref", () => {
  const repo = recordingRepo();
  const snapshotter = createSnapshotter({ repo, indexFile: indexFile("e") });
  snapshotter.snapshot("toolu_01");
  const unchanged = snapshotter.snapshot("toolu_02");

  // Same tree, different commit: the eval looks a snapshot up by tool-use id, so every id
  // has to resolve even when the tool changed nothing.
  assert.equal(listSnapshots({ repo }).length, 2);
  assert.equal(git(repo, ["show", `${unchanged.commit}:tracked.txt`]), "edited by the agent\n");
});

test("a snapshot can be materialised afterwards as a worktree carrying the recorded state", () => {
  const repo = recordingRepo();
  const snapshotter = createSnapshotter({ repo, indexFile: indexFile("f") });
  const early = snapshotter.snapshot("toolu_01");
  writeFileSync(join(repo, "tracked.txt"), "a later state the tail must not see\n");
  writeFileSync(join(repo, "later.txt"), "also later\n");
  snapshotter.snapshot("toolu_02");

  const destination = join(mkdtempSync(join(tmpdir(), "onepass-tail-")), "tail");
  materialiseSnapshot({ repo, commit: early.commit, destination });

  assert.equal(readFileSync(join(destination, "tracked.txt"), "utf8"), "edited by the agent\n");
  assert.equal(readFileSync(join(destination, "untracked.txt"), "utf8"), "written by the agent\n");
  assert.throws(() => readFileSync(join(destination, "later.txt"), "utf8"));
  // The tail's own worktree is clean, so the agent running there sees no pending changes.
  assert.equal(git(destination, ["status", "--porcelain"]), "");
});

test("a materialised worktree carries one snapshot commit, not the whole run's chain", () => {
  const repo = recordingRepo();
  const snapshotter = createSnapshotter({ repo, indexFile: indexFile("g") });
  snapshotter.snapshot("toolu_01");
  writeFileSync(join(repo, "tracked.txt"), "second state\n");
  snapshotter.snapshot("toolu_02");
  const third = snapshotter.snapshot("toolu_03");

  const destination = join(mkdtempSync(join(tmpdir(), "onepass-tail-")), "tail");
  materialiseSnapshot({ repo, commit: third.commit, destination });

  // Every snapshot hangs off the recording's HEAD, so a tail's history is the repository's own
  // plus exactly one commit. Chaining them would show the tail every snapshot taken before it.
  const log = git(destination, ["log", "--oneline"]).trim().split("\n");
  assert.equal(log.length, 2);
  assert.match(log[0] ?? "", /onepass snapshot toolu_03/);
  assert.match(log[1] ?? "", /base/);
});

test("materialising a snapshot leaves the recording worktree's own git state alone", () => {
  const repo = recordingRepo();
  const snapshotter = createSnapshotter({ repo, indexFile: indexFile("h") });
  const snapshot = snapshotter.snapshot("toolu_01");
  const before = agentView(repo);

  const destination = join(mkdtempSync(join(tmpdir(), "onepass-tail-")), "tail");
  materialiseSnapshot({ repo, commit: snapshot.commit, destination });

  assert.deepEqual(agentView(repo), before);
});

// A process spawned from a git hook, a git alias or `git rebase -x` carries GIT_DIR and friends,
// and git lets them override `-C`. Both of these fail loudly if `git()` ever spreads the ambient
// environment through unfiltered again.

test("an inherited GIT_DIR does not redirect a snapshot into another repository", () => {
  const repo = recordingRepo();
  const stranger = initThrowawayRepo(mkdtempSync(join(tmpdir(), "onepass-stranger-")));
  const inherited = process.env.GIT_DIR;
  process.env.GIT_DIR = join(stranger, ".git");
  try {
    const snapshotter = createSnapshotter({ repo, indexFile: indexFile("f") });
    const snapshot = snapshotter.snapshot("toolu_01");
    snapshotter.dispose();

    assert.deepEqual(listSnapshots({ repo }).map((s) => s.commit), [snapshot.commit]);
    assert.deepEqual(listSnapshots({ repo: stranger }), []);
    assert.equal(git(repo, ["show", `${snapshot.commit}:tracked.txt`]), "edited by the agent\n");
  } finally {
    if (inherited === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = inherited;
  }
});

test("an inherited GIT_INDEX_FILE does not become the index agentView reads", () => {
  const repo = recordingRepo();
  const clean = agentView(repo);
  const inherited = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = indexFile("g");
  try {
    // Without filtering, this would stage the agent's work into the ambient index and agentView
    // would then report it as staged — passing the invisibility check against the wrong state.
    const snapshotter = createSnapshotter({ repo, indexFile: indexFile("h") });
    snapshotter.snapshot("toolu_01");
    snapshotter.dispose();

    assert.deepEqual(agentView(repo), clean);
  } finally {
    if (inherited === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = inherited;
  }
});
