// Pure transform over an Anthropic POST /v1/messages request body: replaces old, large,
// recoverable context segments with short deterministic stubs. Four segment kinds by rule:
//   - tool_result blocks (recover: re-run the tool / re-read the file, or recall)
//   - tool_use inputs — the calls themselves (recover: the edit already landed on disk and the
//     command already ran, so read the file or re-run it, or recall)
//   - attached file content the harness injects as "<system-reminder>\nResult of calling the
//     Read tool:" user text (recover: read the file from disk, or recall)
//   - "<task-notification>" user text (recover: read the task's output file, or recall)
// A fifth kind exists that no rule may touch: the user's own text. It is evictable only where
// the judge names that exact block, and then only down to what the judge left behind — a
// verbatim quote, a one-line note of its own, or both. Everything else injected — CLAUDE.md
// instructions, skill and agent listings, compaction summaries — stays protected by omission.
// No I/O — the caller owns the evicted-id set, the threshold state, and logging.

import { createHash } from "node:crypto";

export interface EvictionConfig {
  /** N: a segment becomes eligible once at least this many assistant messages follow it. */
  evictAfterAssistantTurns: number;
  /** K: segments inside the last K assistant turns are never touched, regardless of size. */
  protectLastAssistantTurns: number;
  /**
   * A segment is stubbed only when its finished stub is at least this many chars smaller than
   * the content. Replaces a fixed size floor: the stub's own cost decides, so a call whose
   * input is only a path skips itself.
   */
  minSavedChars: number;
  /**
   * T: new ids are evicted only when the estimated request size, measured after re-applying
   * already-evicted stubs, exceeds this. Keeps the message prefix stable between trips so
   * prompt caching survives. Denominated in real tokens via `charsPerToken`.
   */
  tripThresholdTokens: number;
  /**
   * Chars-per-token ratio used to convert body size to tokens. The server calibrates this
   * from the API's reported usage on the previous response; 4 is the uncalibrated fallback.
   * Real code averages ~3.2, so chars ÷ 4 alone under-counts by ~25% — enough to let a
   * session cross the client's compaction threshold while the estimate still looks safe.
   */
  charsPerToken: number;
}

export interface EvictionOutcome {
  /** Transformed body — or the original value, untouched, when nothing applied or parsing failed. */
  body: unknown;
  bodyChanged: boolean;
  /** The size threshold was exceeded on this request (even if nothing new was eligible). */
  tripped: boolean;
  /** Ids evicted for the first time on this request; the caller must add them to its set. */
  newlyEvictedIds: string[];
  /** Every id stubbed in this request, previously evicted ones included. */
  stubbedIds: string[];
  /**
   * The normal pass (age ≥ N) left the request above T, so segments aged K..N were evicted
   * too. Bounds a burst of fresh large reads: only the last K turns are ever untouchable.
   */
  pressure: boolean;
  charsRemoved: number;
  newlyEvictedCharsRemoved: number;
  estimatedTokensBefore: number;
  estimatedTokensSent: number;
}

export const STUB_PREFIX = "[onepass: evicted";
const COMMAND_TRUNCATE_CHARS = 80;

// Wire formats measured from real Claude Code requests (docs/findings.md §13). Prefix-matched
// exactly: any drift in the harness makes the proxy skip the segment, never mis-evict it.
const ATTACHED_FILE_PREFIX = "<system-reminder>\nResult of calling the Read tool:";
const TASK_NOTIFICATION_PREFIX = "<task-notification>";
const READ_INPUT_PREFIX = "<system-reminder>\nCalled the Read tool with the following input:";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Text the judge must never be offered: the three harness-injected shapes the rules already
 * own, plus anything that is already a stub. A pick on one is wasted at best — a read-input
 * marker is not evictable at all, and the other two take the rule's stub whatever the judge
 * says, silently dropping its quote.
 */
export function isRuleOwnedText(text: string): boolean {
  return (
    text.startsWith(READ_INPUT_PREFIX) ||
    text.startsWith(ATTACHED_FILE_PREFIX) ||
    text.startsWith(TASK_NOTIFICATION_PREFIX) ||
    text.startsWith(STUB_PREFIX)
  );
}

/**
 * For each message, how many assistant messages follow it. Every age gate here and in the
 * judge reads this one function, so the two can never drift apart on what "old" means.
 */
export function assistantTurnsAfterByMessage(messages: unknown[]): number[] {
  const turnsAfter: number[] = new Array<number>(messages.length).fill(0);
  let assistantsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    turnsAfter[i] = assistantsSeen;
    const message = messages[i];
    if (isRecord(message) && message.role === "assistant") assistantsSeen++;
  }
  return turnsAfter;
}

export function formatThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function estimateTokens(value: unknown, charsPerToken = 4): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Math.round(json.length / charsPerToken);
  } catch {
    return 0;
  }
}

export function measureContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (content === undefined || content === null) return 0;
  try {
    const json = JSON.stringify(content);
    return json === undefined ? 0 : json.length;
  } catch {
    return 0;
  }
}

function sanitizeForStub(text: string): string {
  return text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
}

// Deterministic on purpose: the same request must always produce the same bytes, or the
// stubs themselves would break the prompt-cache prefix they exist to protect.
//
// The stub names nothing: what a tool block was is already in the request beside it. A result
// is preceded by its own tool_use, which keeps its name and its path or command whether it is
// live or stubbed, and how to get any of it back is one sentence in the recall tool's
// description (spike/src/server.ts). Naming the target made the stubs the largest thing in the
// request they exist to shrink: 12% of the measured peak (docs/findings.md §15).
function buildEvictedStub(originalChars: number): string {
  return `${STUB_PREFIX} ${formatThousands(originalChars)} chars]`;
}

// The API rejects a tool_use whose `input` is not an object, so the stub is an object too.
// The path or command stays so the model can still tell which file or command the call was.
function buildToolUseStubInput(input: Record<string, unknown>, stubText: string): Record<string, unknown> {
  const filePath =
    typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
  if (filePath !== undefined) return { file_path: filePath, evicted: stubText };
  if (typeof input.command !== "string") return { evicted: stubText };
  const command =
    input.command.length > COMMAND_TRUNCATE_CHARS
      ? `${input.command.slice(0, COMMAND_TRUNCATE_CHARS)}…`
      : input.command;
  return { command, evicted: stubText };
}

// Names no path either: the "Called the Read tool with the following input" marker beside the
// attachment carries it, and that marker is never evicted.
function buildAttachedFileStub(originalChars: number): string {
  return `${STUB_PREFIX} attached file, ${formatThousands(originalChars)} chars]`;
}

/** What the judge decided to leave behind for one user-text block; at least one is non-empty. */
export interface JudgeDecision {
  /** A verbatim quote from the block. Checked to be a substring of it before it reaches here. */
  keep: string;
  /** The judge's own words describing what was removed. Unverifiable, so the stub labels it. */
  note: string;
}

// Unverified text from a second model, entering the agent's context. Capped so a malfunctioning
// judge can put a sentence there, not paragraphs.
const NOTE_MAX_CHARS = 200;

// The one stub not derived from the block alone. `keep` is the judge's verbatim quote of the
// instructions inside a block that also carried a paste, already checked character-for-character.
// `note` is the judge's own description, attributed in the stub so the agent never reads it as
// something the user wrote.
function buildUserTextStub(decision: JudgeDecision, originalChars: number, query: string): string {
  const cleaned = sanitizeForStub(decision.note);
  const note = cleaned.length > NOTE_MAX_CHARS ? `${cleaned.slice(0, NOTE_MAX_CHARS)}…` : cleaned;
  const summary = note === "" ? "" : ` onepass's summary: ${note}.`;
  const pointer =
    `${STUB_PREFIX} ${formatThousands(originalChars)} chars of user text.${summary} ` +
    `recall_search("${query}") for the original]`;
  return decision.keep === "" ? pointer : `${decision.keep}\n${pointer}`;
}

const RECALL_QUERY_WORDS = 8;

function recallQueryFromText(text: string): string {
  return sanitizeForStub(text).split(" ").slice(0, RECALL_QUERY_WORDS).join(" ");
}

// The one stub that still names its target: nothing else in the request carries the task id or
// the path its output was written to.
function buildTaskNotificationStub(text: string, originalChars: number): string {
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  const outputFile = /<output-file>([^<]+)<\/output-file>/.exec(text)?.[1];
  const idPart = taskId === undefined ? "" : ` ${sanitizeForStub(taskId)}`;
  const outputPart = outputFile === undefined ? "" : `; output at ${sanitizeForStub(outputFile)}`;
  return `${STUB_PREFIX} task notification${idPart}, ${formatThousands(originalChars)} chars${outputPart}]`;
}

interface Segment {
  /**
   * tool_use_id for tool results; "call:<tool_use_id>" for tool_use inputs (a distinct id, so
   * stubbing a big call never drags its small result along); "sha1:<hex>" for text segments.
   */
  id: string;
  messageIndex: number;
  /** Block position for array content; null when the segment is the message's whole string content. */
  blockIndex: number | null;
  contentChars: number;
  assistantTurnsAfter: number;
  alreadyStubShaped: boolean;
  stubText: string;
  /** Replacement `input` object for tool_use segments; the other kinds stub with `stubText`. */
  stubInput?: Record<string, unknown>;
}

/** Chars the segment costs once stubbed — the replacement input for calls, the stub string otherwise. */
function stubbedChars(segment: Segment): number {
  return segment.stubInput === undefined ? segment.stubText.length : measureContentChars(segment.stubInput);
}

/** A block about to be stubbed, in whichever shape the size of its stub depends on. */
export type StubTarget =
  | { kind: "tool_result"; content: unknown }
  | { kind: "tool_use"; input: unknown }
  | { kind: "user_text"; text: string; decision: JudgeDecision };

/**
 * Chars the block will cost once stubbed. The judge gates its picks on the saving this implies,
 * so it can never accept an id the eviction pass then refuses for saving too little.
 */
export function stubbedCharsFor(target: StubTarget): number {
  if (target.kind === "user_text") {
    return buildUserTextStub(target.decision, target.text.length, recallQueryFromText(target.text)).length;
  }
  if (target.kind === "tool_result") return buildEvictedStub(measureContentChars(target.content)).length;
  const inputChars = measureContentChars(target.input);
  // A non-object input is passed through untouched, so stubbing it would save nothing.
  if (!isRecord(target.input)) return inputChars;
  return measureContentChars(buildToolUseStubInput(target.input, buildEvictedStub(inputChars)));
}

/** Segment id for a text block: a content hash, so it re-matches when the client resends it. */
export function textSegmentId(text: string): string {
  return `sha1:${createHash("sha1").update(text).digest("hex")}`;
}

/** Segment id for a tool_use input — distinct from the result's own `tool_use_id`. */
export function callSegmentId(toolUseId: string): string {
  return `call:${toolUseId}`;
}

function collectSegments(messages: unknown[], judgeDecisionById: ReadonlyMap<string, JudgeDecision>): Segment[] {
  const assistantTurnsAfterIndex = assistantTurnsAfterByMessage(messages);
  const segments: Segment[] = [];

  const classifyText = (text: string, messageIndex: number, blockIndex: number | null): void => {
    // Never a segment: this marker is what names the path for the attached-file stub next to
    // it, so evicting it would take the attachment's only remaining pointer with it.
    if (text.startsWith(READ_INPUT_PREFIX)) return;
    const id = textSegmentId(text);
    let stubText: string;
    if (text.startsWith(ATTACHED_FILE_PREFIX)) {
      stubText = buildAttachedFileStub(text.length);
    } else if (text.startsWith(TASK_NOTIFICATION_PREFIX)) {
      stubText = buildTaskNotificationStub(text, text.length);
    } else {
      // The user's own text. Off-limits to the rules; evictable only where the judge named
      // this exact block, and then only down to what it chose to leave behind.
      const decision = judgeDecisionById.get(id);
      if (decision === undefined) return;
      stubText = buildUserTextStub(decision, text.length, recallQueryFromText(text));
    }
    segments.push({
      id,
      messageIndex,
      blockIndex,
      contentChars: text.length,
      assistantTurnsAfter: assistantTurnsAfterIndex[messageIndex] ?? 0,
      alreadyStubShaped: text.startsWith(STUB_PREFIX),
      stubText,
    });
  };

  messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) return;
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) return;
      message.content.forEach((block, blockIndex) => {
        if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") return;
        const input = block.input;
        if (!isRecord(input)) return;
        const contentChars = measureContentChars(input);
        const stubText = buildEvictedStub(contentChars);
        segments.push({
          id: callSegmentId(block.id),
          messageIndex,
          blockIndex,
          contentChars,
          assistantTurnsAfter: assistantTurnsAfterIndex[messageIndex] ?? 0,
          alreadyStubShaped: typeof input.evicted === "string" && input.evicted.startsWith(STUB_PREFIX),
          stubText,
          stubInput: buildToolUseStubInput(input, stubText),
        });
      });
      return;
    }
    if (message.role !== "user") return;
    const content = message.content;
    if (typeof content === "string") {
      classifyText(content, messageIndex, null);
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((block, blockIndex) => {
      if (!isRecord(block)) return;
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const contentChars = measureContentChars(block.content);
        segments.push({
          id: block.tool_use_id,
          messageIndex,
          blockIndex,
          contentChars,
          assistantTurnsAfter: assistantTurnsAfterIndex[messageIndex] ?? 0,
          alreadyStubShaped: typeof block.content === "string" && block.content.startsWith(STUB_PREFIX),
          stubText: buildEvictedStub(contentChars),
        });
      } else if (block.type === "text" && typeof block.text === "string") {
        classifyText(block.text, messageIndex, blockIndex);
      }
    });
  });
  return segments;
}

interface StubApplication {
  messages: unknown[];
  charsRemoved: number;
  stubbedIds: string[];
}

function applyStubs(messages: unknown[], targets: Segment[]): StubApplication {
  if (targets.length === 0) return { messages, charsRemoved: 0, stubbedIds: [] };

  const targetsByMessage = new Map<number, Segment[]>();
  for (const target of targets) {
    const forMessage = targetsByMessage.get(target.messageIndex);
    if (forMessage === undefined) targetsByMessage.set(target.messageIndex, [target]);
    else forMessage.push(target);
  }

  let charsRemoved = 0;
  const stubbedIds: string[] = [];
  const nextMessages = messages.map((message, messageIndex) => {
    const forMessage = targetsByMessage.get(messageIndex);
    if (forMessage === undefined || !isRecord(message)) return message;

    const wholeString = forMessage.find((target) => target.blockIndex === null);
    if (wholeString !== undefined && typeof message.content === "string") {
      charsRemoved += wholeString.contentChars - stubbedChars(wholeString);
      stubbedIds.push(wholeString.id);
      return { ...message, content: wholeString.stubText };
    }
    if (!Array.isArray(message.content)) return message;

    const targetByBlock = new Map<number, Segment>();
    for (const target of forMessage) {
      if (target.blockIndex !== null) targetByBlock.set(target.blockIndex, target);
    }
    const nextContent = message.content.map((block, blockIndex) => {
      const target = targetByBlock.get(blockIndex);
      if (target === undefined || !isRecord(block)) return block;
      stubbedIds.push(target.id);
      charsRemoved += target.contentChars - stubbedChars(target);
      // tool_result blocks carry the stub in `content`; tool_use blocks in a replacement `input`
      // object; text blocks in `text`.
      if (target.stubInput !== undefined) return { ...block, input: target.stubInput };
      return block.type === "tool_result" ? { ...block, content: target.stubText } : { ...block, text: target.stubText };
    });
    return { ...message, content: nextContent };
  });

  return { messages: nextMessages, charsRemoved, stubbedIds };
}

export function evictContextSegments(
  body: unknown,
  alreadyEvictedIds: ReadonlySet<string>,
  config: EvictionConfig,
  /** Judge verdicts for user-text blocks only: block id -> what to leave behind. */
  judgeDecisionById: ReadonlyMap<string, JudgeDecision> = new Map(),
): EvictionOutcome {
  const estimatedTokensBefore = estimateTokens(body, config.charsPerToken);
  const passthrough: EvictionOutcome = {
    body,
    bodyChanged: false,
    tripped: false,
    newlyEvictedIds: [],
    stubbedIds: [],
    pressure: false,
    charsRemoved: 0,
    newlyEvictedCharsRemoved: 0,
    estimatedTokensBefore,
    estimatedTokensSent: estimatedTokensBefore,
  };
  if (!isRecord(body) || !Array.isArray(body.messages)) return passthrough;

  const messages = body.messages;
  // A stub that saves too little is not worth the trip, and one no smaller than what it
  // replaces would grow the request — with monotonic eviction re-paying that on every request
  // after. A Read call is the case: its input is nothing but the path the stub keeps anyway.
  // Dropping the segment here keeps its id out of the evicted set entirely.
  const candidates = collectSegments(messages, judgeDecisionById).filter(
    (segment) =>
      !segment.alreadyStubShaped && segment.contentChars - stubbedChars(segment) >= config.minSavedChars,
  );

  // Monotonic: an id evicted on any earlier request is stubbed again on every request.
  // The protected-window guard matters for text segments only: content re-attached after a
  // fresh Read has the same hash, and stubbing the young copy would break the stub's own
  // "read the file for current content" recovery path. (A tool_use_id never re-ages into
  // the window, so the guard is a no-op for tool results.)
  const existingTargets = candidates.filter(
    (segment) =>
      alreadyEvictedIds.has(segment.id) &&
      segment.assistantTurnsAfter >= config.protectLastAssistantTurns,
  );
  const afterExisting = applyStubs(messages, existingTargets);
  const estimatedTokensAfterExisting =
    afterExisting.stubbedIds.length > 0
      ? estimateTokens({ ...body, messages: afterExisting.messages }, config.charsPerToken)
      : estimatedTokensBefore;

  const tripped = estimatedTokensAfterExisting > config.tripThresholdTokens;
  const isNewTarget = (segment: Segment, minAge: number): boolean =>
    !alreadyEvictedIds.has(segment.id) &&
    segment.assistantTurnsAfter >= minAge &&
    segment.assistantTurnsAfter >= config.protectLastAssistantTurns;
  const newTargets = tripped
    ? candidates.filter((segment) => isNewTarget(segment, config.evictAfterAssistantTurns))
    : [];
  const afterNew = applyStubs(afterExisting.messages, newTargets);

  // Pressure pass: a burst of fresh large results can leave the request above T with nothing
  // aged past N yet. Rather than let the client cross its compaction threshold, relax the age
  // gate down to K — the last K turns stay untouchable, everything older is fair game.
  let pressure = false;
  let afterPressure: StubApplication = { messages: afterNew.messages, charsRemoved: 0, stubbedIds: [] };
  if (tripped) {
    const stillOverThreshold =
      estimateTokens({ ...body, messages: afterNew.messages }, config.charsPerToken) > config.tripThresholdTokens;
    if (stillOverThreshold) {
      const alreadyTargeted = new Set(newTargets.map((target) => target.id));
      const pressureTargets = candidates.filter(
        (segment) => !alreadyTargeted.has(segment.id) && isNewTarget(segment, config.protectLastAssistantTurns),
      );
      if (pressureTargets.length > 0) {
        pressure = true;
        afterPressure = applyStubs(afterNew.messages, pressureTargets);
      }
    }
  }

  const newlyEvictedIds = [...afterNew.stubbedIds, ...afterPressure.stubbedIds];
  const stubbedIds = [...afterExisting.stubbedIds, ...newlyEvictedIds];
  if (stubbedIds.length === 0) return { ...passthrough, tripped };

  const finalBody = { ...body, messages: afterPressure.messages };
  return {
    body: finalBody,
    bodyChanged: true,
    tripped,
    newlyEvictedIds,
    stubbedIds,
    pressure,
    charsRemoved: afterExisting.charsRemoved + afterNew.charsRemoved + afterPressure.charsRemoved,
    newlyEvictedCharsRemoved: afterNew.charsRemoved + afterPressure.charsRemoved,
    estimatedTokensBefore,
    estimatedTokensSent: estimateTokens(finalBody, config.charsPerToken),
  };
}
