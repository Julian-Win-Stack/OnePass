// Where session content lives.
//
// Transcript copies, recorded request bodies, replay output, fork and grader outputs, hand labels,
// the control baseline and every case and tail worktree are written under one directory named by an
// environment variable. It has to resolve outside this repository: the material is other people's
// code and my own sessions, and the one rule that keeps it uncommittable is that the eval cannot
// write it anywhere git is watching. A directory inside the repository is refused rather than
// gitignored, because a gitignore is a rule someone can edit and this is not.

import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { EvalError } from "./errors.js";
import { isInside, resolveThroughSymlinks } from "./paths.js";

export const CORPUS_ENV = "ONEPASS_EVAL_CORPUS";

export interface Corpus {
  /** The resolved directory itself, symlinks followed. */
  dir: string;
  /** Copies of session transcripts, one per imported session. */
  transcripts: string;
  /** The control baseline, one directory per model, effort and Claude Code version. */
  baselines: string;
  /** Case and tail worktrees. */
  worktrees: string;
  /** Hand labels for grader calibration. */
  handLabels: string;
  /** Raw request bodies a proxy wrote while a real session ran, one directory per recording. */
  recordings: string;
  /** Everything one run produced: replay bodies, fork outputs, grader outputs. */
  runs: string;
  /** The run directory for a label, created on first use. */
  runDir(label: string): string;
}

/**
 * Reads the corpus directory from the environment and creates its layout. Refuses when the
 * variable is unset or when the directory would sit inside `repoRoot`.
 *
 * Both paths are resolved through symlinks before they are compared, because a corpus under
 * `/tmp` on macOS is really under `/private/tmp` and a repository checked out below a symlinked
 * home directory would otherwise never look like an ancestor of anything.
 */
export function resolveCorpus(env: NodeJS.ProcessEnv, repoRoot: string): Corpus {
  const raw = env[CORPUS_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new EvalError(
      `${CORPUS_ENV} is unset. Point it at a directory outside this repository — the eval writes ` +
        `transcripts, worktrees and model output there, and none of it may be committed.`,
    );
  }

  const wanted = resolveThroughSymlinks(resolve(raw.trim()));
  const repo = realpathSync(repoRoot);
  if (wanted === repo || isInside(repo, wanted)) {
    throw new EvalError(
      `${CORPUS_ENV} resolves to ${wanted}, which is inside the repository at ${repo}. ` +
        `Session content has to live outside it. Try a directory under your home or /tmp.`,
    );
  }

  const dir = wanted;
  const corpus: Corpus = {
    dir,
    transcripts: join(dir, "transcripts"),
    baselines: join(dir, "baselines"),
    worktrees: join(dir, "worktrees"),
    handLabels: join(dir, "hand-labels"),
    recordings: join(dir, "recordings"),
    runs: join(dir, "runs"),
    runDir(label: string): string {
      const path = join(dir, "runs", label);
      mkdirSync(path, { recursive: true });
      return path;
    },
  };
  for (const path of [
    corpus.transcripts,
    corpus.baselines,
    corpus.worktrees,
    corpus.handLabels,
    corpus.recordings,
    corpus.runs,
  ]) {
    mkdirSync(path, { recursive: true });
  }
  return corpus;
}
