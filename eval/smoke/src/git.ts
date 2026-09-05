// Running git, seeing what the agent sees, and building the repository the checks run against.
//
// `agentView` lives here and not in either caller because the live check and the test both
// assert the same claim — that a snapshot is invisible — and two copies of that list would
// drift into asserting different things.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitOptions {
  /** Stage into this index instead of the repository's own. */
  indexFile?: string;
}

export function git(repo: string, args: string[], options: GitOptions = {}): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.indexFile === undefined ? {} : { GIT_INDEX_FILE: options.indexFile }),
      // Set explicitly so a repository with no configured identity — a detached worktree of
      // someone else's clone, say — can still be snapshotted.
      GIT_AUTHOR_NAME: "Onepass eval",
      GIT_AUTHOR_EMAIL: "eval@onepass.invalid",
      GIT_COMMITTER_NAME: "Onepass eval",
      GIT_COMMITTER_EMAIL: "eval@onepass.invalid",
    },
  });
}

/**
 * Everything the agent working in the repository could see of its own git state. `status` and
 * `diff` are the two the spec names (§ implementation corpus, user story 18); the rest are the
 * places a stray commit, ref or index write would otherwise surface.
 */
export function agentView(repo: string): Record<string, string> {
  const commands = [
    ["status", "--porcelain"],
    ["diff"],
    ["log", "--oneline"],
    ["ls-files", "--stage"],
    ["branch", "--list"],
    ["stash", "list"],
    ["reflog"],
    ["rev-parse", "HEAD"],
  ];
  const view: Record<string, string> = {};
  for (const args of commands) view[`git ${args.join(" ")}`] = git(repo, args);
  return view;
}

/** A repository with one commit and one ignored path, on a fresh branch. */
export function initThrowawayRepo(repo: string): string {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "--quiet", "--initial-branch", "main"]);
  git(repo, ["config", "user.email", "smoke@example.invalid"]);
  git(repo, ["config", "user.name", "Onepass Smoke"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}

/** What a recorded session's agent would leave behind: one tracked edit, one new file. */
export function applyAgentEdits(repo: string): void {
  writeFileSync(join(repo, "tracked.txt"), "edited by the agent\n");
  writeFileSync(join(repo, "untracked.txt"), "written by the agent\n");
}
