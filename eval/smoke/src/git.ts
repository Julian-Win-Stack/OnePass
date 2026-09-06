// Running git, and seeing what the agent sees.
//
// `agentView` is the single definition of what an agent working in a recorded worktree could
// observe of its own git state. The snapshot tests assert invisibility through it rather than
// listing commands of their own, so there is one list to keep honest rather than one per
// caller. It was shared with the live smoke runner until that runner was deleted; see
// ../README.md.

import { execFileSync } from "node:child_process";

export interface GitOptions {
  /** Stage into this index instead of the repository's own. */
  indexFile?: string;
}

/**
 * Variables through which git picks its repository, work tree and index. They override `-C`, so
 * inheriting one would point a snapshot at a different repository than the one being recorded —
 * or, for `GIT_INDEX_FILE`, make `agentView` read an index that is not the agent's and assert
 * invisibility against the wrong state. Anything spawned from a git hook, a git alias or
 * `git rebase -x` carries them, so they are dropped rather than assumed absent.
 */
const REPOSITORY_SELECTORS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"] as const;

export function git(repo: string, args: string[], options: GitOptions = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REPOSITORY_SELECTORS) delete env[name];
  if (options.indexFile !== undefined) env.GIT_INDEX_FILE = options.indexFile;

  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...env,
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
