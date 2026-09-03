// The judge: a second model reads the whole conversation at a trip and names blocks the rule
// pass cannot recognise as dead — a file read the agent has moved past, a finished sub-task's
// output, the pasted half of a user message. It runs in the background, never in the request
// path, and its verdict is applied on the agent's next request by adding the ids it names to
// the same evicted-id set the rules use. Everything it may touch is retrievable via recall.
//
// No I/O beyond the one upstream call in `callJudge`; the rest is pure.

import * as http from "node:http";
import * as https from "node:https";
import {
  assistantTurnsAfterByMessage,
  callSegmentId,
  isRecord,
  isRuleOwnedText,
  measureContentChars,
  STUB_PREFIX,
  stubbedCharsFor,
  textSegmentId,
} from "./evict.js";

/**
 * Approved verbatim by the user — this is the business rule, not a prompt to tune. Change it
 * only on their say-so.
 */
export const JUDGE_BRIEF = `You are cleaning up the history of a coding agent's session so the agent
can keep working with a smaller context. The agent continues the task
from this history. Anything you remove is replaced by a short pointer,
and the agent can fetch the original with recall_search if needed.

Mark a block for removal only if one of these is true:
1. Superseded: a file read whose file was edited or read again later; a
   command output replaced by a later run of the same or an equivalent
   command; a search whose results the agent never used.
2. Finished sub-task: the block belonged to a piece of work the agent has
   clearly completed, and nothing in the recent turns refers to it.

Never mark:
- Anything the agent is using in its recent turns.
- The user's instructions or decisions. For a user block that mixes
  instructions with pasted material, put the instructions in "keep",
  copied exactly as written, and the paste will be removed.
- Blocks that are already pointers.

If nothing qualifies, return an empty list. Do not remove things to hit
a size target.

Answer with JSON: {"evict": [{"id": "...", "keep": "...", "note": "..."}]}
"keep" and "note" are only for user blocks; use "" for both on anything else.
For a user block, fill in at least one:
- "keep": any instruction or decision in the block, copied exactly as written.
- "note": one line, in your own words, saying what the removed material is
  (e.g. "stack trace from the failing auth test"), so the agent can tell
  whether it needs to fetch it back.
Leaving both empty is an error and the block will not be removed.`;

// Thinking is billed against this same budget: the request omits `thinking`, which on Sonnet 5
// runs adaptive. Measured at 4096 on a 78k-token conversation, the model spent the entire budget
// reasoning and returned a lone empty thinking block — `stop_reason: "max_tokens"`, no verdict,
// no text at all. 16k is the documented floor for a non-streaming call.
const JUDGE_MAX_TOKENS = 16_000;

// `keep` and `note` are required rather than optional because structured-output schemas are not
// documented to accept optional properties; an empty string is the "not given" case below. Both
// empty on a user block is a malfunction, not a decision, and the block survives.
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    evict: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, keep: { type: "string" }, note: { type: "string" } },
        required: ["id", "keep", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["evict"],
  additionalProperties: false,
};

/** One block as the judge sees it. `onepass_id` is absent on anything it may not evict. */
export interface RenderedBlock {
  type: string;
  onepass_id?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

export interface RenderedMessage {
  role: string;
  content: RenderedBlock[];
}

/** A block the rules have already replaced with a stub. Tagging it would invite a wasted pick. */
function isAlreadyStubbed(block: Record<string, unknown>): boolean {
  if (block.type === "tool_use") {
    // A stubbed call's input is emptied, so emptiness is the tell. A real call with no
    // arguments reads the same and is worth no pick either: stubbing it would save nothing.
    return isRecord(block.input) && Object.keys(block.input).length === 0;
  }
  return typeof block.content === "string" && block.content.startsWith(STUB_PREFIX);
}

/** User text the judge may name: its own, never the harness-injected shapes the rules own. */
function isJudgeableUserText(role: unknown, text: string): boolean {
  return role === "user" && !isRuleOwnedText(text);
}

/**
 * The conversation as the judge reads it: every block it may evict tagged with the very id the
 * eviction pass uses, so a verdict needs no mapping table. `offerableIds` decides what carries
 * one, so the menu cannot drift from the guards. Everything else is still shown — the judge
 * needs assistant text and recent turns to tell what is finished — but untagged, and thinking
 * is dropped outright.
 */
export function renderConversationForJudge(
  messages: unknown[],
  protectLastAssistantTurns: number,
  minSavedChars: number,
): RenderedMessage[] {
  const offerable = offerableIds(messages, protectLastAssistantTurns, minSavedChars);
  const rendered: RenderedMessage[] = [];
  for (const message of messages) {
    if (!isRecord(message) || typeof message.role !== "string") continue;
    const content = message.content;
    if (typeof content === "string") {
      const block: RenderedBlock = { type: "text", text: content };
      const id = textSegmentId(content);
      if (offerable.has(id)) block.onepass_id = id;
      rendered.push({ role: message.role, content: [block] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const blocks: RenderedBlock[] = [];
    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== "string") continue;
      if (block.type === "thinking" || block.type === "redacted_thinking") continue;
      if (block.type === "text" && typeof block.text === "string") {
        const out: RenderedBlock = { type: "text", text: block.text };
        const id = textSegmentId(block.text);
        if (offerable.has(id)) out.onepass_id = id;
        blocks.push(out);
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const out: RenderedBlock = {
          type: "tool_use",
          ...(typeof block.name === "string" ? { name: block.name } : {}),
          input: block.input,
        };
        const id = callSegmentId(block.id);
        if (offerable.has(id)) out.onepass_id = id;
        blocks.push(out);
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const out: RenderedBlock = { type: "tool_result", content: block.content };
        if (offerable.has(block.tool_use_id)) out.onepass_id = block.tool_use_id;
        blocks.push(out);
      } else {
        blocks.push({ type: block.type });
      }
    }
    rendered.push({ role: message.role, content: blocks });
  }
  return rendered;
}

export function buildJudgeRequest(
  messages: unknown[],
  model: string,
  protectLastAssistantTurns: number,
  minSavedChars: number,
): Record<string, unknown> {
  const conversation = renderConversationForJudge(messages, protectLastAssistantTurns, minSavedChars);
  return {
    model,
    max_tokens: JUDGE_MAX_TOKENS,
    system: JUDGE_BRIEF,
    output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
    messages: [{ role: "user", content: JSON.stringify(conversation) }],
  };
}

/**
 * One block the judge asked to remove. On a user block, `keep` is a verbatim quote to leave
 * behind and `note` is the judge's own one-line description of what goes; at least one must be
 * non-empty. Both are "" on every other kind of block.
 */
export interface JudgePick {
  id: string;
  keep: string;
  note: string;
}

export interface JudgeUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** A judge response: the picks it made, and its own token spend — its bill, not the agent's. */
export interface JudgeResponse {
  picks: JudgePick[];
  usage: JudgeUsage;
}

/**
 * Pull the verdict out of a judge response body, in one parse of it. `output_config.format`
 * guarantees the JSON arrives as a text block, so this reads the first one. Null means the
 * response was not a verdict at all — the caller retries, then fails open.
 */
export function parseJudgeResponse(responseText: string): JudgeResponse | null {
  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch {
    return null;
  }
  if (!isRecord(response) || !Array.isArray(response.content)) return null;
  const textBlock = response.content.find(
    (block): block is { type: "text"; text: string } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string",
  );
  if (textBlock === undefined) return null;
  let verdict: unknown;
  try {
    verdict = JSON.parse(textBlock.text);
  } catch {
    return null;
  }
  if (!isRecord(verdict) || !Array.isArray(verdict.evict)) return null;
  const picks: JudgePick[] = [];
  for (const entry of verdict.evict) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    picks.push({
      id: entry.id,
      keep: typeof entry.keep === "string" ? entry.keep : "",
      note: typeof entry.note === "string" ? entry.note : "",
    });
  }
  const usage: JudgeUsage = {};
  if (isRecord(response.usage)) {
    if (typeof response.usage.input_tokens === "number") usage.inputTokens = response.usage.input_tokens;
    if (typeof response.usage.output_tokens === "number") usage.outputTokens = response.usage.output_tokens;
  }
  return { picks, usage };
}

type JudgeBlockKind = "tool_result" | "tool_use" | "user_text";

interface IndexedBlock {
  kind: JudgeBlockKind;
  contentChars: number;
  /** The exact text of a user_text block — what a `keep` quote must be a substring of. */
  text?: string;
  /** Chars the stub would cost. Left 0 for user_text, whose stub size depends on the pick. */
  stubbedChars: number;
  assistantTurnsAfter: number;
}

interface JudgeBlockIndex {
  blocksById: Map<string, IndexedBlock>;
  /** Hashes of assistant text. Same hash as an identical user block, so it is checked first. */
  assistantTextIds: Set<string>;
}

function indexJudgeBlocks(messages: unknown[]): JudgeBlockIndex {
  const assistantTurnsAfterIndex = assistantTurnsAfterByMessage(messages);

  const blocksById = new Map<string, IndexedBlock>();
  const assistantTextIds = new Set<string>();
  // The same text can appear at two ages — a file re-read, a phrase pasted twice. Keep the
  // youngest, so the protected-window guard refuses an id whose content is still in play.
  const record = (id: string, block: IndexedBlock): void => {
    const existing = blocksById.get(id);
    if (existing === undefined || block.assistantTurnsAfter < existing.assistantTurnsAfter) {
      blocksById.set(id, block);
    }
  };

  messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) return;
    const assistantTurnsAfter = assistantTurnsAfterIndex[messageIndex] ?? 0;
    const content = message.content;
    if (typeof content === "string" && isJudgeableUserText(message.role, content)) {
      record(textSegmentId(content), {
        kind: "user_text",
        contentChars: content.length,
        text: content,
        stubbedChars: 0,
        assistantTurnsAfter,
      });
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        if (message.role === "assistant") assistantTextIds.add(textSegmentId(block.text));
        else if (isJudgeableUserText(message.role, block.text)) {
          record(textSegmentId(block.text), {
            kind: "user_text",
            contentChars: block.text.length,
            text: block.text,
            stubbedChars: 0,
            assistantTurnsAfter,
          });
        }
      } else if (block.type === "tool_use" && typeof block.id === "string" && !isAlreadyStubbed(block)) {
        record(callSegmentId(block.id), {
          kind: "tool_use",
          contentChars: measureContentChars(block.input),
          stubbedChars: stubbedCharsFor({ kind: "tool_use", input: block.input }),
          assistantTurnsAfter,
        });
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string" && !isAlreadyStubbed(block)) {
        record(block.tool_use_id, {
          kind: "tool_result",
          contentChars: measureContentChars(block.content),
          stubbedChars: stubbedCharsFor({ kind: "tool_result", content: block.content }),
          assistantTurnsAfter,
        });
      }
    }
  });
  return { blocksById, assistantTextIds };
}

/**
 * The ids worth showing the judge: every indexed block that clears the guards
 * `validateJudgePicks` applies on age and size. Anything else can only produce a rejected pick.
 *
 * A user_text block is indexed with `stubbedChars` 0, because its stub is only as big as the
 * quote and note the judge chooses — unknown until it answers. Zero makes this the loosest
 * honest test: a block that cannot clear the saving even against a free stub never will.
 */
function offerableIds(messages: unknown[], protectLastAssistantTurns: number, minSavedChars: number): Set<string> {
  const { blocksById, assistantTextIds } = indexJudgeBlocks(messages);
  const protectedTurns = Math.max(protectLastAssistantTurns, 1);
  const offerable = new Set<string>();
  for (const [id, block] of blocksById) {
    if (assistantTextIds.has(id)) continue;
    if (block.assistantTurnsAfter < protectedTurns) continue;
    if (block.contentChars - block.stubbedChars < minSavedChars) continue;
    offerable.add(id);
  }
  return offerable;
}

/** Why picks were thrown away. Each counter is a distinct diagnosis, not a severity. */
export interface JudgeRejectionCounts {
  /** Named a block this request does not contain, or one the judge was never offered. */
  unknownId: number;
  /** Named a block inside the last K assistant turns — measured now, not when the judge read it. */
  protectedWindow: number;
  /** The stub replacing the block would not be enough smaller than it to be worth sending. */
  tooSmall: number;
  /** The `keep` quote is not a character-for-character substring of the block. */
  keepMismatch: number;
  /** A user block with neither a quote nor a note — a malfunction, not a decision. */
  noKeepOrNote: number;
  /** Named assistant text, which is never evictable. */
  assistantText: number;
  /** Put a `keep` or `note` on a block that is not the user's own text. */
  keepOnNonUserBlock: number;
}

export const NO_REJECTIONS: JudgeRejectionCounts = {
  unknownId: 0,
  protectedWindow: 0,
  tooSmall: 0,
  keepMismatch: 0,
  noKeepOrNote: 0,
  assistantText: 0,
  keepOnNonUserBlock: 0,
};

/** An accepted pick, tagged with what kind of block it turned out to name. */
export interface AcceptedPick extends JudgePick {
  kind: JudgeBlockKind;
}

export interface ValidatedVerdict {
  accepted: AcceptedPick[];
  rejected: JudgeRejectionCounts;
  /** Chars the accepted blocks would actually shed — each block's size less the stub replacing it. */
  charsRemovedEstimate: number;
}

/**
 * The guards. The judge proposes; this decides. Everything is checked against the request being
 * rewritten now — a block the judge saw as old may have been re-read since, and the protected
 * window has to be measured against what is actually going upstream.
 */
export function validateJudgePicks(
  picks: readonly JudgePick[],
  messages: unknown[],
  protectLastAssistantTurns: number,
  minSavedChars: number,
): ValidatedVerdict {
  const { blocksById, assistantTextIds } = indexJudgeBlocks(messages);
  const accepted: AcceptedPick[] = [];
  const rejected: JudgeRejectionCounts = { ...NO_REJECTIONS };
  let charsRemovedEstimate = 0;
  // The newest assistant turn is off-limits to the judge even where the operator set K to 0:
  // the rules gate their own picks on age as well, and the judge has no such second gate.
  const protectedTurns = Math.max(protectLastAssistantTurns, 1);

  for (const pick of picks) {
    // Checked before the id lookup: identical user and assistant text share a hash, and a
    // collision must fail closed.
    if (assistantTextIds.has(pick.id)) {
      rejected.assistantText++;
      continue;
    }
    const block = blocksById.get(pick.id);
    if (block === undefined) {
      rejected.unknownId++;
      continue;
    }
    if (block.assistantTurnsAfter < protectedTurns) {
      rejected.protectedWindow++;
      continue;
    }
    if (block.kind === "user_text") {
      if (pick.keep === "" && pick.note === "") {
        rejected.noKeepOrNote++;
        continue;
      }
      if (pick.keep !== "" && block.text?.includes(pick.keep) !== true) {
        rejected.keepMismatch++;
        continue;
      }
    } else if (pick.keep !== "" || pick.note !== "") {
      rejected.keepOnNonUserBlock++;
      continue;
    }
    // Measured last, because a user_text stub is only as big as the quote and note this pick
    // leaves behind, and both have just been checked.
    const stubbedChars =
      block.kind === "user_text"
        ? stubbedCharsFor({ kind: "user_text", text: block.text ?? "", decision: { keep: pick.keep, note: pick.note } })
        : block.stubbedChars;
    const saved = block.contentChars - stubbedChars;
    if (saved < minSavedChars) {
      rejected.tooSmall++;
      continue;
    }
    accepted.push({ ...pick, kind: block.kind });
    charsRemovedEstimate += saved;
  }
  return { accepted, rejected, charsRemovedEstimate };
}

export interface JudgeConfig {
  /** The user's own API key. Absent means the judge is off and the proxy behaves as before. */
  apiKey: string;
  model: string;
}

export interface JudgeCallResult {
  picks: JudgePick[] | null;
  /** Set when the call failed after its one retry; `picks` is null then. */
  error?: string;
  usage?: JudgeUsage;
}

// Long on purpose: the judge reads the whole conversation and nothing is waiting on it. Not an
// env var — plan.md §6 rules out a config system beyond the documented variables. It has to
// outlast JUDGE_MAX_TOKENS at the observed ~70 output tokens/sec, or raising that budget would
// only trade an unparseable answer for a timed-out one.
export const JUDGE_TIMEOUT_MS = 300_000;

function postToMessagesApi(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const url = new URL("/v1/messages", upstreamUrl);
  const isHttps = url.protocol === "https:";
  const requestModule = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const request = requestModule.request(
      {
        host: url.hostname,
        port: url.port !== "" ? Number(url.port) : isHttps ? 443 : 80,
        path: url.pathname,
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`judge call timed out after ${timeoutMs}ms`)));
    request.on("error", reject);
    request.end(body);
  });
}

/**
 * One judge call, retried once. Only the judge's own credentials go on the wire: Claude Code's
 * `authorization` header is a subscription credential and reusing it for anything but Claude
 * Code is against Anthropic's terms, so nothing is copied from the incoming request.
 */
export async function callJudge(
  messages: unknown[],
  options: {
    upstreamUrl: string;
    judge: JudgeConfig;
    protectLastAssistantTurns: number;
    minSavedChars: number;
    timeoutMs?: number;
  },
): Promise<JudgeCallResult> {
  const request = buildJudgeRequest(
    messages,
    options.judge.model,
    options.protectLastAssistantTurns,
    options.minSavedChars,
  );
  const body = JSON.stringify(request);
  const headers = {
    "content-type": "application/json",
    "x-api-key": options.judge.apiKey,
    "anthropic-version": "2023-06-01",
  };

  let lastError = "judge call failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await postToMessagesApi(
        options.upstreamUrl,
        headers,
        body,
        options.timeoutMs ?? JUDGE_TIMEOUT_MS,
      );
      if (response.status < 200 || response.status >= 300) {
        lastError = `judge call returned ${response.status}`;
        continue;
      }
      const parsed = parseJudgeResponse(response.text);
      if (parsed === null) {
        lastError = "judge response was not a verdict";
        continue;
      }
      return { picks: parsed.picks, usage: parsed.usage };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { picks: null, error: lastError };
}
