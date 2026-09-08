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
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...(options.apiKey !== undefined && options.apiKey !== "" ? { "x-api-key": options.apiKey } : {}),
      },
      body: JSON.stringify({ model: SIZING_MODEL, messages }),
    }).catch((err: unknown) => {
      throw new EvalError(`count-tokens at ${url} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    });

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
  };
}
