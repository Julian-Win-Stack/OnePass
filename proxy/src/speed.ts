// The speed gauge: reads the API's reported usage off a response, and decides whether a
// request made Anthropic re-read the conversation (a "rebuild") instead of serving it from
// cache. A rebuild costs seconds on that one turn, so an unexplained one is a bug worth
// seeing. No I/O — the caller owns the per-session bookkeeping this reads.

export interface ResponseUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * Pull the usage numbers out of an Anthropic response — the first `usage` object in the body
 * (message_start for SSE, top level for JSON). Brace-matched rather than regexed whole: usage
 * contains nested objects (`cache_creation`, `server_tool_use`).
 */
export function extractUsage(responseText: string): ResponseUsage | null {
  const keyIndex = responseText.indexOf('"usage"');
  if (keyIndex === -1) return null;
  const openIndex = responseText.indexOf("{", keyIndex);
  if (openIndex === -1) return null;
  let depth = 0;
  let closeIndex = -1;
  for (let i = openIndex; i < responseText.length; i++) {
    const ch = responseText[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return null;
  const usageSlice = responseText.slice(openIndex, closeIndex + 1);
  // The leading quote matters: without it `"input_tokens"` would also match the tail of
  // `"cache_creation_input_tokens"` and of the nested `cache_creation` ephemeral counters.
  const read = (wireName: string): number => {
    const match = new RegExp(`"${wireName}"\\s*:\\s*(\\d+)`).exec(usageSlice);
    return match === null ? 0 : Number(match[1]);
  };
  const usage: ResponseUsage = {
    inputTokens: read("input_tokens"),
    cacheCreationInputTokens: read("cache_creation_input_tokens"),
    cacheReadInputTokens: read("cache_read_input_tokens"),
  };
  return totalContextTokens(usage) > 0 ? usage : null;
}

/** Everything Anthropic read for this request, however it got there. */
export function totalContextTokens(usage: ResponseUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

/**
 * `first`      — the session's first request; nothing was cached yet.
 * `after-trip` — the proxy swapped segments for stubs, so the conversation changed.
 * `after-idle` — the cache entry expired while the user was away.
 * `unexpected` — none of the above explain it. Something is changing the request every turn.
 */
export type RebuildKind = "first" | "after-trip" | "after-idle" | "unexpected";

export interface RebuildInput {
  /** No earlier /v1/messages request has gone through this proxy run. */
  firstMessagesRequest: boolean;
  /** A trip landed on this request, or on a count_tokens request since the previous one. */
  tripped: boolean;
  /** Gap since the previous /v1/messages request; null on the first. */
  secondsSincePrevious: number | null;
  cacheCreationInputTokens: number;
  /** input + cache_creation + cache_read for this request. */
  contextTotal: number;
}

// Claude Code makes several kinds of /v1/messages call — the conversation itself, plus small
// side calls (title generation, warm-ups) that carry their own separate cache prefix. Only the
// conversation is gauged: mixing the side calls in makes the session's real first request look
// like an unexplained rebuild, and a rebuild this small costs no measurable time anyway.
export const GAUGE_MIN_ESTIMATED_TOKENS = 20_000;

// A turn always writes a little fresh cache (the new user message and tool results), so a
// rebuild is a share of the whole context, not any non-zero creation count.
const REBUILD_SHARE_OF_CONTEXT = 0.2;
// Anthropic's ephemeral cache entries expire after 5 minutes of not being read.
const CACHE_TTL_SECONDS = 300;

export function classifyRebuild(input: RebuildInput): RebuildKind | null {
  if (input.contextTotal <= 0) return null;
  if (input.cacheCreationInputTokens / input.contextTotal <= REBUILD_SHARE_OF_CONTEXT) return null;
  if (input.firstMessagesRequest) return "first";
  if (input.tripped) return "after-trip";
  if (input.secondsSincePrevious !== null && input.secondsSincePrevious > CACHE_TTL_SECONDS) return "after-idle";
  return "unexpected";
}

/** "after-trip" -> "after trip"; used in the stdout line and the report. */
export function describeRebuild(rebuild: RebuildKind): string {
  return rebuild.replace("-", " ");
}

export function formatDuration(milliseconds: number): string {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${milliseconds}ms`;
}
