// The proxy build under test, and the children the eval runs it as.
//
// The proxy runs compiled `dist/`, so a build the author forgot to make is a run that measures
// the previous one. The eval therefore builds it itself rather than trusting whatever is on
// disk, and never uses the globally running `onepass-proxy`: a child is started per planning
// case and per tail, on a port the operating system picks, and torn down after. Restarting per
// case is what makes each replay fresh — a child that has already evicted something has state
// the next case did not put there.
//
// The child reports its own port, log file and judge on startup, so nothing here has to guess
// at any of them. The judge is held off in every arm, so the eval measures the eviction rules
// alone; a child that reports it on is a bug and stops the run rather than quietly biasing it.

import { execFile, execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { EvalError, messageOf } from "./errors.js";

const execFileAsync = promisify(execFile);

/** The build a run is of. Its short SHA and dirtiness are half of the run's label. */
export interface ProxyBuild {
  dir: string;
  entry: string;
  /** The repository's short SHA at the time of the build. */
  shortSha: string;
  /** Uncommitted changes under `proxy/`, which make the short SHA a lie about what ran. */
  dirty: boolean;
  /** The version the built proxy reports for itself. */
  version: string;
}

export interface ProxyChild {
  baseUrl: string;
  port: number;
  /** The proxy's own log for this child: trips, rebuilds and first-byte latency. */
  logFilePath: string;
  /** What the child said about its judge. Every arm expects "off". */
  judge: string;
  stop(): Promise<void>;
}

export interface ProxyChildOptions {
  /** Where the child sends what it forwards. */
  upstreamUrl: string;
  /** Extra environment for the child, on top of a cleaned copy of this process's. */
  env?: NodeJS.ProcessEnv;
}

/** Long enough for a cold `node` start under a loaded CI runner, short enough to fail a run. */
const START_TIMEOUT_MS = 20_000;

/**
 * Compiles `proxy/` and reads what identifies the build. Refuses with the compiler's own output
 * when it does not build, since that is the only useful thing to say.
 */
export async function buildProxyUnderTest(repoRoot: string): Promise<ProxyBuild> {
  const dir = join(repoRoot, "proxy");
  if (!existsSync(join(dir, "package.json"))) {
    throw new EvalError(`no proxy package at ${dir}`);
  }
  try {
    await execFileAsync("npm", ["run", "build"], { cwd: dir, encoding: "utf8" });
  } catch (err: unknown) {
    const output = compilerOutput(err);
    throw new EvalError(`the proxy under test does not build:\n${output.trim()}`);
  }
  const entry = join(dir, "dist", "main.js");
  const version = (await execFileAsync(process.execPath, [entry, "--version"], { encoding: "utf8" })).stdout.trim();
  return { dir, entry, shortSha: shortSha(repoRoot), dirty: hasUncommittedProxyChanges(repoRoot), version };
}

/**
 * Starts one proxy child and waits until it reports its port, its log and its judge. Rejects,
 * with everything the child printed, when it exits early, reports its judge on, or says nothing
 * in time.
 */
export async function startProxyChild(build: ProxyBuild, options: ProxyChildOptions): Promise<ProxyChild> {
  const child: ProxyProcess = spawn(process.execPath, [build.entry], {
    env: childEnv(options),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => output.push(chunk));
  child.stderr.on("data", (chunk: string) => output.push(chunk));

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const giveUp = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => {
        clearTimeout(giveUp);
        resolve();
      });
      child.kill("SIGTERM");
    });
  };

  const banner = await waitForBanner(child, output, START_TIMEOUT_MS).catch(async (err: unknown) => {
    await stop();
    throw err;
  });

  // The second of two: `childEnv` has already dropped the judge key, so this fires only if a
  // future proxy learns to turn its judge on some other way. Cheap, and what it guards against
  // is every number in the run quietly measuring a second model as well as the rules.
  if (banner.judge !== "off") {
    await stop();
    throw new EvalError(
      `the proxy child reported its judge ${banner.judge}. Every arm runs with the judge held off, ` +
        `so the eval measures the eviction rules alone. Unset ONEPASS_JUDGE_API_KEY.`,
    );
  }

  return {
    baseUrl: `http://127.0.0.1:${banner.port}`,
    port: banner.port,
    logFilePath: banner.logFilePath,
    judge: banner.judge,
    stop,
  };
}

/** Starts a child, runs `body` against it, and tears it down however `body` ends. */
export async function withProxyChild<T>(
  build: ProxyBuild,
  options: ProxyChildOptions,
  body: (child: ProxyChild) => Promise<T>,
): Promise<T> {
  const child = await startProxyChild(build, options);
  try {
    return await body(child);
  } finally {
    await child.stop();
  }
}

/** A child started with its input closed and both output streams piped back here. */
type ProxyProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Everything `npm run build` said when it failed, which is the only useful thing to report. */
function compilerOutput(err: unknown): string {
  if (err instanceof Error && "stdout" in err && "stderr" in err) {
    return `${String((err as { stdout: unknown }).stdout)}${String((err as { stderr: unknown }).stderr)}`;
  }
  return String(err);
}

interface Banner {
  port: number;
  logFilePath: string;
  judge: string;
}

function waitForBanner(child: ProxyProcess, output: string[], timeoutMs: number): Promise<Banner> {
  return new Promise<Banner>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, banner?: Banner): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err !== null) reject(err);
      else resolve(banner as Banner);
    };
    const timer = setTimeout(
      () => finish(new EvalError(`the proxy child said nothing usable in ${timeoutMs}ms:\n${output.join("").trim()}`)),
      timeoutMs,
    );
    const read = (): void => {
      const banner = parseBanner(output.join(""));
      if (banner !== null) finish(null, banner);
    };
    child.stdout.on("data", read);
    child.on("error", (err: Error) => finish(new EvalError(`the proxy child would not start: ${err.message}`)));
    child.on("exit", (code, signal) =>
      finish(new EvalError(`the proxy child exited (code ${code}, signal ${signal}):\n${output.join("").trim()}`)),
    );
    read();
  });
}

/** The three lines the child prints about itself. Absent any one of them, it is not ready. */
function parseBanner(text: string): Banner | null {
  const port = /listening on http:\/\/localhost:(\d+)/.exec(text);
  const log = /^\[onepass\] log: (.+)$/m.exec(text);
  const judge = /^\[onepass\] judge: (\w+)/m.exec(text);
  if (port === null || log === null || judge === null) return null;
  return { port: Number(port[1]), logFilePath: (log[1] as string).trim(), judge: judge[1] as string };
}

/**
 * The child's environment. Two variables are dropped rather than overridden: a judge key would
 * put a second model in the path of every arm, and an inherited `ANTHROPIC_BASE_URL` — set in
 * any shell that runs `claudep` — would chain this child through the proxy the author already
 * has running, which is the one thing the eval never uses.
 */
function childEnv(options: ProxyChildOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  delete env.ONEPASS_JUDGE_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  return { ...env, ONEPASS_PORT: "0", ONEPASS_UPSTREAM: options.upstreamUrl };
}

function shortSha(repoRoot: string): string {
  return git(repoRoot, ["rev-parse", "--short", "HEAD"]).trim();
}

/** Tracked or untracked changes under `proxy/`: what makes the built dist differ from the SHA. */
function hasUncommittedProxyChanges(repoRoot: string): boolean {
  return git(repoRoot, ["status", "--porcelain", "--", "proxy"]).trim() !== "";
}

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  } catch (err: unknown) {
    throw new EvalError(`git ${args.join(" ")} failed in ${repoRoot}: ${messageOf(err)}`);
  }
}
