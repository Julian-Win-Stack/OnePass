#!/usr/bin/env node
// `claudep` — Claude Code with the eviction proxy in front of it.
//
//   claudep                 instead of `claude`
//   claude                  when you want it off; nothing about a plain session changes
//
// One proxy per session, on a port the operating system picks. That is what keeps sessions
// apart: the proxy remembers what it has evicted, its calibration and its timings in memory,
// and two sessions sharing one proxy would share all three — one session's stubs landing in
// another's request, and one log holding both. A process each is the cheapest way to have
// neither. The proxy is started before Claude Code and killed after it, whatever ends first.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  claudeArgs,
  claudeEnv,
  findTranscript,
  isPassthrough,
  parseBanner,
  proxyEnv,
  reusesExistingSession,
  sessionIdFromArgs,
  summaryLine,
  type Banner,
} from "./launch.js";
import { parseProxyLog, scanTranscript } from "./session.js";

/** Long enough for a cold `node` start on a loaded machine, short enough to fail a launch. */
const PROXY_START_TIMEOUT_MS = 20_000;
const PROXY_STOP_TIMEOUT_MS = 5_000;

const PROXY_ENTRY = fileURLToPath(new URL("./main.js", import.meta.url));

function version(): string {
  return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
}

function note(message: string): void {
  // stderr, not stdout: `claudep -p "..."` is piped into other things, and its output is the
  // agent's answer. Nothing here belongs in that stream.
  process.stderr.write(`${message}\n`);
}

/** Runs Claude Code with no proxy at all — for `claudep mcp list`, `--help`, `--version`. */
function runClaudeAlone(args: string[]): void {
  const child = spawn("claude", args, { stdio: "inherit" });
  child.on("error", (err: NodeJS.ErrnoException) => exitOnClaudeError(err));
  child.on("exit", (code, signal) => process.exit(exitCode(code, signal)));
}

function exitOnClaudeError(err: NodeJS.ErrnoException): never {
  if (err.code === "ENOENT") {
    note("claudep: `claude` is not on your PATH — install Claude Code first (https://claude.com/claude-code)");
    process.exit(127);
  }
  note(`claudep: could not start claude: ${err.message}`);
  process.exit(1);
}

/** A child's exit as an exit code of our own: the shell convention for a signal is 128 + n. */
function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 };
  return 128 + (numbers[signal ?? "SIGTERM"] ?? 15);
}

interface ProxyChild {
  banner: Banner;
  stop(): Promise<void>;
  killNow(): void;
}

/**
 * Starts the proxy and waits for it to say which port it bound and where its log is.
 *
 * `detached` puts it in its own process group. Without that, the Ctrl-C that interrupts a turn
 * in Claude Code goes to every process in the terminal's foreground group, and the proxy would
 * die in the middle of the session it is serving.
 */
async function startProxy(): Promise<ProxyChild> {
  if (!existsSync(PROXY_ENTRY)) {
    note(`claudep: the proxy is not built — no ${PROXY_ENTRY}. Run \`npm run build\` in proxy/.`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [PROXY_ENTRY], {
    env: proxyEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const output: string[] = [];
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => output.push(chunk));

  const banner = await new Promise<Banner>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: Banner): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err !== null) reject(err);
      else resolve(value as Banner);
    };
    const timer = setTimeout(
      () => finish(new Error(`the proxy said nothing usable in ${PROXY_START_TIMEOUT_MS}ms:\n${output.join("")}`)),
      PROXY_START_TIMEOUT_MS,
    );
    child.stdout?.on("data", (chunk: string) => {
      output.push(chunk);
      const parsed = parseBanner(output.join(""));
      if (parsed !== null) finish(null, parsed);
    });
    child.on("error", (err: Error) => finish(new Error(`the proxy would not start: ${err.message}`)));
    child.on("exit", (code, signal) =>
      finish(new Error(`the proxy exited (code ${code}, signal ${signal}):\n${output.join("").trim()}`)),
    );
  }).catch((err: unknown) => {
    child.kill("SIGKILL");
    note(`claudep: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

  // Past the banner its per-request lines would land on top of the session's own display, but a
  // pipe nobody reads fills up and blocks the writer, so they are read and dropped. Everything
  // they carry is in the JSONL log, which `onepass-report` reads.
  child.stdout?.removeAllListeners("data");
  child.stdout?.resume();
  child.stderr?.removeAllListeners("data");
  child.stderr?.resume();
  let stopping = false;
  child.on("exit", (code) => {
    if (!stopping) {
      note(`claudep: the proxy exited early (code ${code}) — this session can no longer reach the API.`);
    }
  });

  return {
    banner,
    killNow: () => {
      stopping = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
    stop: async () => {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const giveUp = setTimeout(() => child.kill("SIGKILL"), PROXY_STOP_TIMEOUT_MS);
        child.once("exit", () => {
          clearTimeout(giveUp);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
}

/** What the session did, as one line. Never throws: the session has already ended well. */
async function summarize(logFilePath: string, sessionId: string | null): Promise<string> {
  try {
    const { requests, trips } = existsSync(logFilePath)
      ? parseProxyLog(logFilePath)
      : { requests: [], trips: [] };
    const transcriptPath = sessionId === null ? null : findTranscript(sessionId);
    const stats = transcriptPath === null ? null : await scanTranscript(transcriptPath);
    return summaryLine({
      transcript:
        stats === null
          ? null
          : {
              compactions: stats.compactionCount,
              recallResults: stats.recallResultCount,
              peakContextTokens: stats.realUsagePeak,
            },
      segmentsEvicted: trips.reduce((total, trip) => total + trip.addedToolUseIds.length, 0),
      tokensEvicted: Math.round(trips.reduce((total, trip) => total + trip.charsRemoved, 0) / 4),
      peakSentTokens: Math.max(0, ...requests.map((request) => request.estimatedTokensSent ?? 0)),
    });
  } catch (err: unknown) {
    return `onepass: could not read this session's numbers (${err instanceof Error ? err.message : String(err)})`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--version" || args[0] === "-v") note(`claudep (onepass-proxy ${version()})`);
  if (isPassthrough(args)) {
    runClaudeAlone(args);
    return;
  }

  if (process.env.ANTHROPIC_BASE_URL !== undefined && process.env.ONEPASS_UPSTREAM === undefined) {
    note(
      `claudep: ignoring ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL} — the proxy forwards to ` +
        `api.anthropic.com. Set ONEPASS_UPSTREAM to send it somewhere else.`,
    );
  }

  const proxy = await startProxy();
  // A resumed conversation already has an id, and Claude Code rejects a second one. Its own id
  // is used for the exit line when the user named it; `--continue` names nothing, so that line
  // says what the log alone can say.
  const resuming = reusesExistingSession(args);
  const sessionId = resuming ? sessionIdFromArgs(args) : randomUUID();
  const claude = spawn("claude", claudeArgs(args, resuming ? null : sessionId), {
    stdio: "inherit",
    env: claudeEnv(process.env, proxy.banner.port),
  });

  // Ctrl-C belongs to the session: Claude Code interrupts the turn, and `claudep` must not take
  // the terminal down around it. Ending is Claude Code's to decide, and we follow it out.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => claude.kill("SIGTERM"));
  process.on("SIGHUP", () => claude.kill("SIGHUP"));
  // Whatever else happens, the proxy does not outlive this process.
  process.on("exit", () => proxy.killNow());

  claude.on("error", (err: NodeJS.ErrnoException) => {
    proxy.killNow();
    exitOnClaudeError(err);
  });
  claude.on("exit", (code, signal) => {
    void (async (): Promise<void> => {
      await proxy.stop();
      note(await summarize(proxy.banner.logFilePath, sessionId));
      process.exit(exitCode(code, signal));
    })();
  });
}

await main();
