// Hidden worktree snapshots.
//
// The eval records one implementation session and only afterwards learns where its 110k fork
// point fell, so the files have to be saved at every step the way the transcript already saves
// the conversation at every step. A snapshot is a commit the agent cannot see: staged into a
// temporary index file, written as a tree, committed with `commit-tree`, and pointed at by a
// ref outside `refs/heads`, `refs/tags` and `refs/remotes`. Four git commands, none of which
// touches the agent's own index, HEAD or branches — so its `git status`, `git log` and
// `git diff` behave as they would in a real session.
//
// Every snapshot hangs off the recording's HEAD rather than off the snapshot before it. A
// chain would put the whole run's history into each tail's `git log` once the snapshot is
// checked out; hanging off HEAD leaves one commit on top of the repository's real history.
// HEAD is read per snapshot rather than once, because a recorded agent may commit mid-run: a
// cached base would parent every later snapshot to a stale commit, and the tail materialised
// from it would be missing the agent's own commits.
//
// The temporary index is reused across snapshots on purpose: it keeps git's stat cache warm,
// so a snapshot of a large worktree costs a fraction of a second instead of a full rescan.
// `git add -A` obeys `.gitignore`, so an installed `node_modules` is never recorded.

import { rmSync } from "node:fs";
import { git } from "./git.js";

/** Private: `git log`, `git branch` and `git status` do not read refs under here. */
export const SNAPSHOT_NAMESPACE = "refs/onepass/snapshots";

/** One recorded worktree state. */
export interface Snapshot {
  /** The tool-use id the snapshot was named for — the ref's last segment. */
  toolUseId: string;
  /** The commit holding the recorded tree. */
  commit: string;
  /** The private ref pointing at it. */
  ref: string;
}

export interface SnapshotterOptions {
  /** The worktree being recorded. Every git command runs with `-C` here. */
  repo: string;
  /** Path to the temporary index. Reused across snapshots; never the repository's own index. */
  indexFile: string;
}

export interface Snapshotter {
  /** Record the worktree as it stands, under a ref named by `toolUseId`. */
  snapshot(toolUseId: string): Snapshot;
  /** Delete the temporary index. The snapshots themselves outlive it. */
  dispose(): void;
}

/**
 * A tool-use id lands in a ref name, so it has to be one git will accept. The ids Claude Code
 * issues are `toolu_` plus base62; anything else is a caller bug, not something to sanitise.
 * The dot is excluded deliberately: it is the one character in that class git itself rejects
 * in context, as `..` and a trailing `.lock`, and failing here names the culprit id where
 * `update-ref` would only report a malformed ref.
 */
const SAFE_REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function createSnapshotter(options: SnapshotterOptions): Snapshotter {
  const { repo, indexFile } = options;

  return {
    snapshot(toolUseId: string): Snapshot {
      if (!SAFE_REF_SEGMENT.test(toolUseId)) {
        throw new Error(`tool-use id is not usable as a ref segment: ${JSON.stringify(toolUseId)}`);
      }
      git(repo, ["add", "-A"], { indexFile });
      const tree = git(repo, ["write-tree"], { indexFile }).trim();
      const base = headCommit(repo);
      const parentArgs = base === null ? [] : ["-p", base];
      const commit = git(repo, ["commit-tree", tree, ...parentArgs, "-m", `onepass snapshot ${toolUseId}`]).trim();
      const ref = `${SNAPSHOT_NAMESPACE}/${toolUseId}`;
      git(repo, ["update-ref", ref, commit]);
      return { toolUseId, commit, ref };
    },

    dispose(): void {
      rmSync(indexFile, { force: true });
    },
  };
}

function headCommit(repo: string): string | null {
  try {
    return git(repo, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null; // An unborn branch: every snapshot is a root commit.
  }
}

/**
 * Check a snapshot out as a fresh detached worktree. Each tail gets its own, so the code state
 * matches the conversation state the tail resumes from and no two tails share files.
 */
export function materialiseSnapshot(options: { repo: string; commit: string; destination: string }): void {
  git(options.repo, ["worktree", "add", "--detach", options.destination, options.commit]);
}
