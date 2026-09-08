// How big a request prefix is, measured rather than estimated.
//
// The eval cannot estimate this. A planning session carries pasted screenshots, and 1.8M chars of
// base64 image data on the corpus branch price out at a few thousand tokens — so a chars-per-token
// estimate reads the deepest stretch as three times the size the model actually saw, and the case
// list drawn from it would be a list of turns that never existed at those depths. The count-tokens
// endpoint is the only thing that gets images right, and it is free, which is why case extraction
// runs in replay mode too.
//
// It goes over the same HTTP seam as every other model call the eval makes, so the tests stand the
// fake upstream in front of it and a whole run costs no key.

import { EvalError } from "./errors.js";
import type { CaseMessage } from "./messages.js";

/** The model the arms answer under, and so the tokenizer a case's size is measured with. */
export const SIZING_MODEL = "claude-opus-5";

const ANTHROPIC_VERSION = "2023-06-01";

/** The environment variable holding the key. Used for count-tokens and the graders, nothing else. */
export const API_KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * How many times a sizing call is tried again after the first.
 *
 * A run sizes every typed turn of the branch before it covers a single case, and the deep ones are
 * megabytes over one connection. Those connections drop: three runs against the corpus died on a
 * bare `fetch failed` at three different turns, each after thirty-odd calls had already succeeded,
 * and each discarded the lot. Retrying is not leniency — what is retried is deliberately narrow.
 */
const SIZING_ATTEMPTS = 4;

const RETRY_BACKOFF_MS = 500;

/**
 * The only statuses tried again: the endpoint saying it was busy, not the endpoint saying no.
 *
 * A 400 is a malformed request, which means a bug in the rebuild, and retrying one would turn the
 * single loudest signal this eval has into a slow run. The tool-reference bug above was found
 * exactly because a 400 stopped everything the first time it happened.
 */
const RETRIED_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Measures one message list. Injected, so callers can be driven without a key. */
export type TokenCounter = (messages: readonly CaseMessage[]) => Promise<number>;

export interface TokenCounterOptions {
  /** Where to send it. The fake upstream in the tests; the API otherwise. */
  baseUrl: string;
  apiKey?: string | undefined;
}

export function createTokenCounter(options: TokenCounterOptions): TokenCounter {
  const url = `${options.baseUrl.replace(/\/$/, "")}/v1/messages/count_tokens`;

  return async (messages) => {
    const body = JSON.stringify({ model: SIZING_MODEL, messages, ...toolsFor(messages) });
    const headers = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      ...(options.apiKey !== undefined && options.apiKey !== "" ? { "x-api-key": options.apiKey } : {}),
    };

    let transportFailure = "";
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, { method: "POST", headers, body }).catch((err: unknown) => {
        transportFailure = err instanceof Error ? err.message : String(err);
        return null;
      });

      if (response === null || RETRIED_STATUSES.has(response.status)) {
        const what = response === null ? `could not be reached: ${transportFailure}` : `answered ${response.status}`;
        if (attempt > SIZING_ATTEMPTS) {
          throw new EvalError(`count-tokens at ${url} ${what}, on all ${SIZING_ATTEMPTS + 1} attempts`);
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * attempt));
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        const hint =
          response.status === 401 || response.status === 403
            ? ` Case sizes are measured with the count-tokens endpoint, which needs ${API_KEY_ENV} set.`
            : "";
        throw new EvalError(`count-tokens at ${url} answered ${response.status}: ${text.trim()}.${hint}`);
      }
      const tokens = (JSON.parse(text) as { input_tokens?: unknown }).input_tokens;
      if (typeof tokens !== "number" || !Number.isFinite(tokens)) {
        throw new EvalError(`count-tokens at ${url} answered without an input_tokens count: ${text.trim()}`);
      }
      return tokens;
    }
  };
}

/**
 * The `tools` a message list cannot be sized without.
 *
 * A session that loaded a deferred tool carries a `tool_reference` block naming it, and the API
 * resolves that name against the request's `tools`. Sizing sends no real tool definitions — they
 * are not in the transcript, which is the whole reason the overhead is measured separately — so a
 * reference to a tool nothing declares is refused, and the request is refused whole. On the corpus
 * branch that took out the eight deepest turns and nothing else, which is the worst possible eight
 * to lose: the case list came back shorter and shallower with no sign anything had gone missing.
 *
 * So every referenced name is declared, as a stub with no schema. The stub is not the tool the
 * session had, and it is not meant to be: it makes the name resolve, and the definitions it stands
 * in for are already counted in the overhead. Declaring any tools at all costs a fixed ~324 tokens
 * against a 110k threshold, which is under half a percent and is not corrected for — a correction
 * would be a second estimate laid over a measurement.
 */
function toolsFor(messages: readonly CaseMessage[]): { tools?: ToolStub[] } {
  const names = new Set<string>();
  collectToolReferences(messages, names);
  if (names.size === 0) return {};
  return {
    tools: [...names].map((name) => ({ name, description: "", input_schema: { type: "object", properties: {} } })),
  };
}

interface ToolStub {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, never> };
}

/** Walks the whole list, because a `tool_reference` sits inside a `tool_result`'s content. */
function collectToolReferences(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolReferences(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record["type"] === "tool_reference" && typeof record["tool_name"] === "string") {
    into.add(record["tool_name"]);
  }
  for (const nested of Object.values(record)) collectToolReferences(nested, into);
}
