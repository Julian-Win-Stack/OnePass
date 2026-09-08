// Whether one path is inside another, answered on resolved paths.
//
// Two places need it and both are refusals rather than conveniences: the corpus has to sit
// outside the repository, and the grader's tools have to stay inside the repository they were
// pointed at. A check like that is only sound once symlinks are followed — a corpus under
// `/tmp` on macOS is really under `/private/tmp`, and a file the grader asks for may be a link
// out of the worktree — so the two live together rather than being written twice.

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

/** True when `path` is `parent` itself or below it. Both are expected to be resolved already. */
export function isInside(parent: string, path: string): boolean {
  const step = relative(parent, path);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

/**
 * `realpathSync` of the deepest part of `path` that exists, with the rest appended. A directory
 * that has not been created yet still has to be checked against its parent, and the check is
 * only sound on resolved paths.
 */
export function resolveThroughSymlinks(path: string): string {
  const missing: string[] = [];
  let head = path;
  for (;;) {
    try {
      return join(realpathSync(head), ...missing.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      missing.push(basename(head));
      head = parent;
    }
  }
}
