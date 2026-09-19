#!/usr/bin/env node
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { createProxyServer, DEFAULT_HEADROOM_TOKENS, DEFAULT_TRIP_TOKENS } from "./server.js";
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

// 0 asks the operating system for a free port. The eval starts a proxy child per case and per
// tail, several at once, so it uses 0 and reads the port the child reports below.
const port = envInt("ONEPASS_PORT", 3777);
// Loopback only. Every request through here carries the user's Claude Code credentials upstream,
// so a proxy bound to every interface is an open relay for anyone on the same café wifi.
const host = process.env.ONEPASS_HOST ?? "127.0.0.1";
const config = {
  upstreamUrl: process.env.ONEPASS_UPSTREAM ?? "https://api.anthropic.com",
  evictAfterAssistantTurns: envInt("ONEPASS_EVICT_AFTER_TURNS", 8),
  protectLastAssistantTurns: envInt("ONEPASS_PROTECT_LAST_TURNS", 4),
  // Automatic unless pinned: the floor the first conversation request reports, plus headroom.
  // A fixed T fits one prefix size only — 80k over a 63k prefix left 17k of room and the agent
  // with its last K turns (docs/findings.md §23). Below T the proxy is inert, so T is what
  // decides when it starts; the headroom is what decides how much room it leaves.
  tripThresholdTokens:
    process.env.ONEPASS_TRIP_TOKENS === undefined || process.env.ONEPASS_TRIP_TOKENS === ""
      ? ("auto" as const)
      : envInt("ONEPASS_TRIP_TOKENS", DEFAULT_TRIP_TOKENS),
  headroomTokens: envInt("ONEPASS_HEADROOM_TOKENS", DEFAULT_HEADROOM_TOKENS),
  batchMinTokens: envInt("ONEPASS_BATCH_MIN_TOKENS", 20_000),
  minSavedChars: envInt("ONEPASS_MIN_SAVED_CHARS", 50),
  logFilePath: newProxyLogPath(),
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
server.listen(port, host, () => {
  // The requested port may be 0; what a caller has to connect to is the one that got bound.
  const boundPort = (server.address() as AddressInfo).port;
  console.log(`[onepass] eviction proxy listening on http://${host}:${boundPort}`);
  console.log(`[onepass] upstream: ${config.upstreamUrl}`);
  const threshold =
    config.tripThresholdTokens === "auto"
      ? `T=auto (floor + ${config.headroomTokens} headroom; ${DEFAULT_TRIP_TOKENS} until the floor is measured)`
      : `T=${config.tripThresholdTokens}`;
  console.log(
    `[onepass] evict after N=${config.evictAfterAssistantTurns} assistant turns, ` +
      `protect last K=${config.protectLastAssistantTurns}, trip over ${threshold} real tokens (live-calibrated), ` +
      `min chars saved per stub ${config.minSavedChars}, batch min ${config.batchMinTokens} tokens`,
  );
  console.log(`[onepass] log: ${config.logFilePath}`);
  // The flag keeps native-1M models at 1M: Claude Code caps them at 200k behind a non-api.anthropic.com host.
  console.log(
    `[onepass] point Claude Code at it:  ` +
      `ANTHROPIC_BASE_URL=http://${host}:${boundPort} _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 claude`,
  );
});
