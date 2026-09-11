// The decisions `claudep` makes before anything starts: what Claude Code is run with, which
// transcript belongs to the session that just ended, and what the one-line summary says.
//
// Separated from `claudep.ts` so every decision here is testable without spawning anything.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatThousands } from "./evict.js";

/**
 * Claude Code's own subcommands. `claudep mcp list` is a question about the installation, not a
 * session: starting a proxy for it would be pointless, and `--session-id` would be rejected.
 * A subcommand is always the first argument, so a prompt that happens to read "doctor" is safe.
 */
const CLAUDE_SUBCOMMANDS = new Set([
  "agents",
  "attach",
  "auth",
  "auto-mode",
  "doctor",
  "gateway",
  "import",
  "install",
  "kill",
  "logs",
  "mcp",
  "plugin",
  "plugins",
  "project",
  "respawn",
  "rm",
  "setup-token",
  "stop",
  "ultrareview",
  "update",
  "upgrade",
]);

/** Flags that answer and exit. Same reasoning as a subcommand: no session, so no proxy. */
const INFO_FLAGS = new Set(["-v", "--version", "-h", "--help"]);

/** Flags that mean the conversation already exists, so `claudep` must not name a new one. */
const EXISTING_SESSION_FLAGS = new Set(["-c", "--continue", "-r", "--resume", "--session-id"]);

/** True when these arguments ask Claude Code something instead of starting a session. */
export function isPassthrough(args: string[]): boolean {
  const first = args[0];
  if (first === undefined) return false;
  return CLAUDE_SUBCOMMANDS.has(first) || INFO_FLAGS.has(first);
}

/** True when the user is resuming: the session id is theirs to decide, not ours. */
export function reusesExistingSession(args: string[]): boolean {
  return args.some(
    (arg) => EXISTING_SESSION_FLAGS.has(arg) || arg.startsWith("--resume=") || arg.startsWith("--session-id="),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session id the user named, when they named one. `--resume` with no value opens a picker
 * and `--continue` names nothing, so both leave this null and the exit line says what it can.
 */
export function sessionIdFromArgs(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    for (const flag of ["--session-id", "--resume"]) {
      if (arg === flag && UUID.test(args[index + 1] ?? "")) return args[index + 1] as string;
      if (arg.startsWith(`${flag}=`)) {
        const value = arg.slice(flag.length + 1);
        if (UUID.test(value)) return value;
      }
    }
  }
  return null;
}

/** Claude Code's arguments: ours first, then the user's, unchanged. */
export function claudeArgs(userArgs: string[], sessionId: string | null): string[] {
  return sessionId === null ? [...userArgs] : ["--session-id", sessionId, ...userArgs];
}

/**
 * Claude Code's environment. The base URL is the proxy child; the first-party flag keeps a
 * natively-1M model at 1M, which a non-`api.anthropic.com` base URL otherwise caps at 200k
 * (README, "Known Claude Code interactions"). Gzip is dropped rather than overridden: a
 * compressed body is forwarded untouched, so leaving it set would silently disable eviction.
 */
export function claudeEnv(base: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
  };
  delete env.CLAUDE_CODE_GZIP_REQUEST_BODIES;
  return env;
}

/**
 * The proxy child's environment. `ONEPASS_*` settings pass through, so a user who wants a
 * different threshold sets it in their shell as before. `ANTHROPIC_BASE_URL` is dropped: in a
 * shell that already has one, keeping it would chain this proxy through another one.
 */
export function proxyEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ONEPASS_PORT: "0" };
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

export interface Banner {
  port: number;
  logFilePath: string;
}

/** The two lines of the child's banner `claudep` needs. Absent either, it is not ready yet. */
export function parseBanner(text: string): Banner | null {
  const port = /listening on http:\/\/localhost:(\d+)/.exec(text);
  const log = /^\[onepass\] log: (.+)$/m.exec(text);
  if (port === null || log === null) return null;
  return { port: Number(port[1]), logFilePath: (log[1] as string).trim() };
}

/** Where Claude Code keeps its sessions. `CLAUDE_CONFIG_DIR` moves the whole directory. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured !== undefined && configured !== "" ? configured : join(homedir(), ".claude");
}

/**
 * This session's transcript, by id. Every project directory is searched rather than the one the
 * cwd slugifies to: the slug rule is Claude Code's and can change, while a session id is unique.
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

export interface SessionSummary {
  /** Null when no transcript was found: recalls and compactions are then unknowable, not zero. */
  transcript: { compactions: number; recallResults: number; peakContextTokens: number } | null;
  segmentsEvicted: number;
  tokensEvicted: number;
  /** The proxy's own estimate of the largest request it sent, used when there is no transcript. */
  peakSentTokens: number;
}

/**
 * The line printed after the session ends. One line, because it appears under a session the user
 * has already finished reading; `onepass-report` is where the detail lives.
 */
export function summaryLine(summary: SessionSummary): string {
  const { transcript, segmentsEvicted, tokensEvicted, peakSentTokens } = summary;
  const peak = transcript?.peakContextTokens ?? peakSentTokens;
  if (segmentsEvicted === 0) {
    return `onepass: no eviction (peak ~${formatThousands(peak)} tokens)`;
  }
  const evicted = `onepass: evicted ${segmentsEvicted} segments (~${formatThousands(tokensEvicted)} tokens)`;
  if (transcript === null) {
    return `${evicted} — no transcript found, so recalls and compactions are unknown`;
  }
  return (
    `${evicted}, recalled ${transcript.recallResults}, compactions ${transcript.compactions} ` +
    `(peak ~${formatThousands(peak)} tokens)`
  );
}
