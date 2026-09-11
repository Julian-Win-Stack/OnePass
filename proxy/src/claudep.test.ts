// What `claudep` decides, and one real launch against a fake `claude` and a fake upstream.
//
// The end-to-end test is the one that proves what nothing else can: the session really goes
// through a proxy this process started, that proxy is gone afterwards, and the summary lands on
// stderr rather than in the answer the user piped somewhere.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
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
  upstreamWarning,
} from "./launch.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("a subcommand or an information flag skips the proxy", () => {
  assert.equal(isPassthrough(["mcp", "list"]), true);
  assert.equal(isPassthrough(["--version"]), true);
  assert.equal(isPassthrough(["doctor"]), true);
  // A prompt that happens to read like a subcommand is still a session.
  assert.equal(isPassthrough(["-p", "doctor"]), false);
  assert.equal(isPassthrough([]), false);
});

test("resuming leaves the session id to the user", () => {
  assert.equal(reusesExistingSession(["-c"]), true);
  assert.equal(reusesExistingSession(["--resume=1e4f1b2c-1111-4222-8333-444455556666"]), true);
  assert.equal(reusesExistingSession(["--session-id", "1e4f1b2c-1111-4222-8333-444455556666"]), true);
  assert.equal(reusesExistingSession(["hello"]), false);
});

test("the session id is read back out of the user's own flags", () => {
  const id = "1e4f1b2c-1111-4222-8333-444455556666";
  assert.equal(sessionIdFromArgs(["--session-id", id]), id);
  assert.equal(sessionIdFromArgs([`--resume=${id}`]), id);
  // `--resume` with no id opens a picker: nothing to name.
  assert.equal(sessionIdFromArgs(["--resume"]), null);
  assert.equal(sessionIdFromArgs(["-c"]), null);
});

test("the user's arguments are passed through unchanged, ours first", () => {
  const id = "1e4f1b2c-1111-4222-8333-444455556666";
  assert.deepEqual(claudeArgs(["-p", "hi"], id), ["--session-id", id, "-p", "hi"]);
  assert.deepEqual(claudeArgs(["-p", "hi"], null), ["-p", "hi"]);
});

test("Claude Code is pointed at the proxy, at the full window, without gzip", () => {
  const env = claudeEnv({ PATH: "/bin", CLAUDE_CODE_GZIP_REQUEST_BODIES: "1" }, 4242);
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4242");
  assert.equal(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, "1");
  // A gzipped body is forwarded untouched, so leaving this set would evict nothing at all.
  assert.equal(env.CLAUDE_CODE_GZIP_REQUEST_BODIES, undefined);
  assert.equal(env.PATH, "/bin");
});

test("the proxy child picks its own port and never chains through another proxy", () => {
  const env = proxyEnv({ ANTHROPIC_BASE_URL: "http://localhost:3777", ONEPASS_TRIP_TOKENS: "90000" });
  assert.equal(env.ONEPASS_PORT, "0");
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ONEPASS_TRIP_TOKENS, "90000");
});

test("a base URL that would be lost is called out, and one that would not is left alone", () => {
  assert.match(
    upstreamWarning({ ANTHROPIC_BASE_URL: "https://gateway.internal" }) ?? "",
    /ignoring ANTHROPIC_BASE_URL=https:\/\/gateway\.internal/,
  );
  // Already forwarded there: saying so would be noise on every launch.
  assert.equal(upstreamWarning({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/" }), null);
  // The user has already said where to forward.
  assert.equal(
    upstreamWarning({ ANTHROPIC_BASE_URL: "https://gateway.internal", ONEPASS_UPSTREAM: "https://gateway.internal" }),
    null,
  );
  assert.equal(upstreamWarning({}), null);
});

test("the banner is read for the port and the log, and needs both", () => {
  const banner =
    "[onepass] eviction proxy listening on http://localhost:51234\n[onepass] log: /tmp/proxy.log.jsonl\n";
  assert.deepEqual(parseBanner(banner), { port: 51234, logFilePath: "/tmp/proxy.log.jsonl" });
  assert.equal(parseBanner("[onepass] eviction proxy listening on http://localhost:51234\n"), null);
});

test("a transcript is found by session id, in whichever project directory holds it", () => {
  const configDir = mkdtempSync(join(tmpdir(), "onepass-config-"));
  const id = "1e4f1b2c-1111-4222-8333-444455556666";
  mkdirSync(join(configDir, "projects", "-some-other-project"), { recursive: true });
  mkdirSync(join(configDir, "projects", "-a-project"), { recursive: true });
  writeFileSync(join(configDir, "projects", "-a-project", `${id}.jsonl`), "");
  assert.equal(
    findTranscript(id, { CLAUDE_CONFIG_DIR: configDir }),
    join(configDir, "projects", "-a-project", `${id}.jsonl`),
  );
  assert.equal(findTranscript("2e4f1b2c-1111-4222-8333-444455556666", { CLAUDE_CONFIG_DIR: configDir }), null);
});

test("the summary says what it knows and no more", () => {
  assert.equal(
    summaryLine({ transcript: null, segmentsEvicted: 0, tokensEvicted: 0, peakSentTokens: 96_000 }),
    "onepass: no eviction (peak ~96,000 tokens)",
  );
  assert.equal(
    summaryLine({
      transcript: { compactions: 0, recallResults: 2, peakContextTokens: 140_253 },
      segmentsEvicted: 12,
      tokensEvicted: 44_000,
      peakSentTokens: 96_000,
    }),
    "onepass: evicted 12 segments (~44,000 tokens), recalled 2, compactions 0 (peak ~140,253 tokens)",
  );
  // No transcript: zero recalls would be a claim, and this one has no evidence for it.
  assert.equal(
    summaryLine({ transcript: null, segmentsEvicted: 12, tokensEvicted: 44_000, peakSentTokens: 96_000 }),
    "onepass: evicted 12 segments (~44,000 tokens) — no transcript found, so recalls and compactions are unknown",
  );
});

// --- end to end ------------------------------------------------------------------------------

/**
 * Stands in for Claude Code: records what it was run with, writes a transcript under the session
 * id it was given, sends one request to whatever `ANTHROPIC_BASE_URL` it was handed, and exits 7.
 * Plain CommonJS — it lives in a directory with no package.json of its own.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const argv = process.argv.slice(2);
fs.writeFileSync(
  process.env.FAKE_CLAUDE_RECORD,
  JSON.stringify({
    argv,
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
    firstParty: process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL ?? null,
    gzip: process.env.CLAUDE_CODE_GZIP_REQUEST_BODIES ?? null,
  }),
);
if (argv.includes("--version")) {
  process.stdout.write("9.9.9 (fake claude)\\n");
  process.exit(0);
}

const id = argv[argv.indexOf("--session-id") + 1];
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "-a-project");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, id + ".jsonl"),
  JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 }, content: [] },
  }) + "\\n",
);

const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
const request = http.request(
  process.env.ANTHROPIC_BASE_URL + "/v1/messages",
  { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
  (response) => {
    response.resume();
    response.on("end", () => process.exit(7));
  },
);
request.end(body);
`;

const upstreamRequests: string[] = [];
const upstream = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    upstreamRequests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "message", content: [], usage: { input_tokens: 9, output_tokens: 1 } }));
  });
});

after(() => upstream.close());

interface LaunchResult {
  code: number | null;
  stdout: string;
  stderr: string;
  record: { argv: string[]; baseUrl: string | null; firstParty: string | null; gzip: string | null };
  home: string;
}

/** One `claudep` run with a fake `claude` first on PATH and a fake upstream behind the proxy. */
async function launch(args: string[], upstreamUrl: string): Promise<LaunchResult> {
  const home = mkdtempSync(join(tmpdir(), "onepass-home-"));
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, "claude");
  writeFileSync(fakeClaude, FAKE_CLAUDE);
  chmodSync(fakeClaude, 0o755);
  const recordPath = join(home, "record.json");

  const child = spawn(process.execPath, [fileURLToPath(new URL("./claudep.js", import.meta.url)), ...args], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ONEPASS_UPSTREAM: upstreamUrl,
      FAKE_CLAUDE_RECORD: recordPath,
      ANTHROPIC_BASE_URL: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  if (!existsSync(recordPath)) throw new Error(`the fake claude never ran:\n${stderr}`);
  return { code, stdout, stderr, record: JSON.parse(readFileSync(recordPath, "utf8")), home };
}

test("a session runs through a proxy of its own, which does not outlive it", async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  upstreamRequests.length = 0;

  const result = await launch(["-p", "hi"], upstreamUrl);

  assert.equal(result.code, 7, `claudep did not pass the session's exit code through:\n${result.stderr}`);
  // The session talked to a proxy on the loopback interface, not to the API.
  assert.match(result.record.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(result.record.firstParty, "1");
  assert.equal(result.record.gzip, null);
  assert.equal(result.record.argv[0], "--session-id");
  assert.match(result.record.argv[1] as string, UUID);
  assert.deepEqual(result.record.argv.slice(2), ["-p", "hi"]);
  // And the proxy really forwarded it.
  assert.deepEqual(upstreamRequests, ["/v1/messages"]);

  // The summary is on stderr, found by session id — the peak is the transcript's 5,010, which
  // only the transcript knows; the proxy's own log would report a request of a few hundred.
  assert.match(result.stderr, /onepass: no eviction \(peak ~5,010 tokens\)/);
  assert.equal(result.stdout, "");
  // One log per session, under this run's own home.
  const logs = readdirSync(join(result.home, ".onepass")).filter((name) => name.startsWith("proxy.log."));
  assert.equal(logs.length, 1);

  // Nothing is left listening: the proxy died with the session.
  const port = Number(/:(\d+)$/.exec(result.record.baseUrl ?? "")?.[1]);
  const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    const probe = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST" }, () => resolve(null));
    probe.on("error", resolve);
    probe.end();
  });
  assert.equal(error?.code, "ECONNREFUSED");
});

test("--version answers without starting a proxy", async () => {
  const result = await launch(["--version"], "http://127.0.0.1:1");
  assert.equal(result.code, 0);
  assert.match(result.stderr, /claudep \(onepass-proxy \d+\.\d+\.\d+\)/);
  assert.match(result.stdout, /9\.9\.9 \(fake claude\)/);
  // Passed through as it was typed: no session id was invented for it.
  assert.deepEqual(result.record.argv, ["--version"]);
  assert.equal(result.record.baseUrl, null);
  assert.equal(existsSync(join(result.home, ".onepass")), false);
});
