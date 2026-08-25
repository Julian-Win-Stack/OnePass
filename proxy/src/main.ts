import { createProxyServer } from "./server.js";
import { defaultProxyLogPath } from "./log.js";

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
const config = {
  upstreamUrl: process.env.ONEPASS_UPSTREAM ?? "https://api.anthropic.com",
  evictAfterAssistantTurns: envInt("ONEPASS_EVICT_AFTER_TURNS", 8),
  protectLastAssistantTurns: envInt("ONEPASS_PROTECT_LAST_TURNS", 4),
  tripThresholdTokens: envInt("ONEPASS_TRIP_TOKENS", 150_000),
  minResultChars: 2000,
  logFilePath: defaultProxyLogPath,
};

createProxyServer(config).listen(port, () => {
  console.log(`[onepass] eviction proxy listening on http://localhost:${port}`);
  console.log(`[onepass] upstream: ${config.upstreamUrl}`);
  console.log(
    `[onepass] evict after N=${config.evictAfterAssistantTurns} assistant turns, ` +
      `protect last K=${config.protectLastAssistantTurns}, trip over T=${config.tripThresholdTokens} est tokens, ` +
      `min result size ${config.minResultChars} chars`,
  );
  console.log(`[onepass] log: ${config.logFilePath}`);
  console.log(`[onepass] point Claude Code at it:  ANTHROPIC_BASE_URL=http://localhost:${port} claude`);
});
