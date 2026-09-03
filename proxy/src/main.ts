#!/usr/bin/env node
import { createRequire } from "node:module";
import { createProxyServer } from "./server.js";
import { newProxyLogPath } from "./log.js";

if (process.argv.includes("--version")) {
  const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };
  console.log(packageJson.version);
  process.exit(0);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`[onepass] ${name} must be a non-negative integer, got: ${raw}`);
    process.exit(1);
  }
  return value;
}

const port = envInt("ONEPASS_PORT", 3777);
// No key means no judge: the proxy evicts by the rules alone, exactly as it did before.
// Deliberately not ANTHROPIC_API_KEY — a `claudep` launched from the proxy's own shell would
// then bill Claude Code to the key instead of the user's subscription.
const judgeApiKey = process.env.ONEPASS_JUDGE_API_KEY;
const judgeModel = process.env.ONEPASS_JUDGE_MODEL ?? "claude-sonnet-5";
const config = {
  upstreamUrl: process.env.ONEPASS_UPSTREAM ?? "https://api.anthropic.com",
  evictAfterAssistantTurns: envInt("ONEPASS_EVICT_AFTER_TURNS", 8),
  protectLastAssistantTurns: envInt("ONEPASS_PROTECT_LAST_TURNS", 4),
  tripThresholdTokens: envInt("ONEPASS_TRIP_TOKENS", 110_000),
  minSavedChars: envInt("ONEPASS_MIN_SAVED_CHARS", 50),
  logFilePath: newProxyLogPath(),
  ...(judgeApiKey !== undefined && judgeApiKey !== ""
    ? { judge: { apiKey: judgeApiKey, model: judgeModel } }
    : {}),
  ...(process.env.ONEPASS_DUMP_DIR !== undefined && process.env.ONEPASS_DUMP_DIR !== ""
    ? { dumpDir: process.env.ONEPASS_DUMP_DIR }
    : {}),
};

const server = createProxyServer(config);
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[onepass] port ${port} is already in use — is another onepass-proxy running?`);
    process.exit(1);
  }
  throw err;
});
server.listen(port, () => {
  console.log(`[onepass] eviction proxy listening on http://localhost:${port}`);
  console.log(`[onepass] upstream: ${config.upstreamUrl}`);
  console.log(
    `[onepass] evict after N=${config.evictAfterAssistantTurns} assistant turns, ` +
      `protect last K=${config.protectLastAssistantTurns}, trip over T=${config.tripThresholdTokens} real tokens (live-calibrated), ` +
      `min chars saved per stub ${config.minSavedChars}`,
  );
  console.log(
    config.judge === undefined
      ? "[onepass] judge: off — set ONEPASS_JUDGE_API_KEY to let a second model pick blocks the rules cannot"
      : `[onepass] judge: on, ${config.judge.model} (fires at each trip, runs in the background)`,
  );
  console.log(`[onepass] log: ${config.logFilePath}`);
  // The flag keeps native-1M models at 1M: Claude Code caps them at 200k behind a non-api.anthropic.com host.
  console.log(
    `[onepass] point Claude Code at it:  ` +
      `ANTHROPIC_BASE_URL=http://localhost:${port} _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 claude`,
  );
});
