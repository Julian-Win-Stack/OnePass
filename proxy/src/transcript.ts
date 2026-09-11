// Which transcript on disk belongs to the session asking for it.
//
// Recall reads the session's own history back after the proxy has evicted it, so reading the
// wrong session's history is worse than reading none: it answers confidently out of a
// conversation the agent was never in. `claudep` names the session id it started, which is the
// only identifier that cannot be confused between two sessions in one directory. Without one —
// a proxy the user started by hand — the newest transcript in this directory is the best guess
// available, and that is what recall did everywhere before session ids existed.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where Claude Code keeps its sessions. `CLAUDE_CONFIG_DIR` moves the whole directory. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured !== undefined && configured !== "" ? configured : join(homedir(), ".claude");
}

/** Claude Code stores each session under a slug of the cwd with separators replaced by dashes. */
export function transcriptDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), "projects", cwd.replace(/[/.]/g, "-"));
}

/**
 * A transcript by session id. Every project directory is searched rather than the one the cwd
 * slugifies to: the slug rule is Claude Code's and can change, while a session id is unique.
 */
export function findTranscript(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const projects = join(claudeConfigDir(env), "projects");
  let directories: string[];
  try {
    directories = readdirSync(projects);
  } catch {
    return null;
  }
  for (const directory of directories) {
    const path = join(projects, directory, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** The most recently written transcript for this directory, whoever wrote it. */
export function newestTranscript(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = transcriptDir(cwd, env);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const path = join(dir, name);
    const { mtimeMs } = statSync(path);
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest?.path ?? null;
}

export interface ChosenTranscript {
  path: string | null;
  /** Why there is nothing to read, in the words recall gives the agent. Empty when there is. */
  reason: string;
}

/**
 * The transcript this recall server should read. `ONEPASS_SESSION_ID` is set by `claudep`, one
 * value per session, so two sessions in one directory never read each other's history.
 */
export function transcriptForSession(env: NodeJS.ProcessEnv, cwd: string): ChosenTranscript {
  const sessionId = env.ONEPASS_SESSION_ID;
  if (sessionId !== undefined && sessionId !== "") {
    const path = findTranscript(sessionId, env);
    return path !== null
      ? { path, reason: "" }
      : {
          path: null,
          // Normal at the very start: the file appears once the session's first turn is written.
          reason:
            `No transcript yet for session ${sessionId} under ${join(claudeConfigDir(env), "projects")} — ` +
            `it is written as the session runs.`,
        };
  }
  const path = newestTranscript(cwd, env);
  return path !== null ? { path, reason: "" } : { path: null, reason: `No transcript found under ${transcriptDir(cwd, env)}` };
}
