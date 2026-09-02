// Pure transform over an Anthropic POST /v1/messages request body: replaces old, large,
// recoverable context segments with short deterministic stubs. Four segment kinds:
//   - tool_result blocks (recover: re-run the tool / re-read the file, or recall)
//   - tool_use inputs — the calls themselves (recover: the edit already landed on disk and the
//     command already ran, so read the file or re-run it, or recall)
//   - attached file content the harness injects as "<system-reminder>\nResult of calling the
//     Read tool:" user text (recover: read the file from disk, or recall)
//   - "<task-notification>" user text (recover: read the task's output file, or recall)
// Only that whitelist is ever touched. Other injected text — CLAUDE.md instructions, skill
// and agent listings, compaction summaries — and everything the user typed is protected by
// omission. No I/O — the caller owns the evicted-id set, the threshold state, and logging.

import { createHash } from "node:crypto";

export interface EvictionConfig {
  /** N: a segment becomes eligible once at least this many assistant messages follow it. */
  evictAfterAssistantTurns: number;
  /** K: segments inside the last K assistant turns are never touched, regardless of size. */
  protectLastAssistantTurns: number;
  /** Segments smaller than this many chars are never stubbed — stubbing them saves nothing. */
  minSegmentChars: number;
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
const READ_INPUT_PATH_PATTERN = /"file_path"\s*:\s*"([^"]+)"/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

interface ToolUseInfo {
  name?: string;
  targetKind?: "file" | "command";
  target?: string;
}

function collectToolUseInfo(messages: unknown[]): Map<string, ToolUseInfo> {
  const infoById = new Map<string, ToolUseInfo>();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") continue;
      const info: ToolUseInfo = {};
      if (typeof block.name === "string") info.name = block.name;
      const input = block.input;
      if (isRecord(input)) {
        const filePath =
          typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
        if (filePath !== undefined) {
          info.targetKind = "file";
          info.target = filePath;
        } else if (typeof input.command === "string") {
          info.targetKind = "command";
          info.target =
            input.command.length > COMMAND_TRUNCATE_CHARS
              ? `${input.command.slice(0, COMMAND_TRUNCATE_CHARS)}…`
              : input.command;
        }
      }
      infoById.set(block.id, info);
    }
  }
  return infoById;
}

function sanitizeForStub(text: string): string {
  return text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
}

// Deterministic on purpose: the same request must always produce the same bytes, or the
// stubs themselves would break the prompt-cache prefix they exist to protect.
function buildToolResultStub(info: ToolUseInfo | undefined, originalChars: number): string {
  const resultLabel = info?.name !== undefined ? `${info.name} result` : "tool result";
  const target = info?.target;
  const forPart =
    target === undefined ? "" : info?.targetKind === "command" ? ` for \`${sanitizeForStub(target)}\`` : ` for ${target}`;
  const query = sanitizeForStub(target ?? info?.name ?? "tool output");
  const hint =
    info?.targetKind === "file"
      ? `Re-read the file for current content, or recall_search("${query}") for the output as it was.`
      : info?.targetKind === "command"
        ? `Re-run it for current output, or recall_search("${query}") for the output as it was.`
        : `Use recall_search("${query}") for the output as it was.`;
  return `[onepass: evicted ${resultLabel}${forPart} (${formatThousands(originalChars)} chars). ${hint}]`;
}

function buildToolUseStub(info: ToolUseInfo | undefined, originalChars: number): string {
  const callLabel = info?.name !== undefined ? `${info.name} input` : "tool input";
  const target = info?.target;
  const forPart =
    target === undefined ? "" : info?.targetKind === "command" ? ` for \`${sanitizeForStub(target)}\`` : ` for ${target}`;
  const query = sanitizeForStub(target ?? info?.name ?? "tool input");
  const hint =
    info?.targetKind === "file"
      ? `Read the file for current content, or recall_search("${query}") for the call as it was.`
      : info?.targetKind === "command"
        ? `Re-run it for current output, or recall_search("${query}") for the call as it was.`
        : `Use recall_search("${query}") for the call as it was.`;
  return `[onepass: evicted ${callLabel}${forPart} (${formatThousands(originalChars)} chars). ${hint}]`;
}

// The API rejects a tool_use whose `input` is not an object, so the stub is an object too.
// The path or command stays so the model can still tell which file or command the call was.
function buildToolUseStubInput(info: ToolUseInfo | undefined, stubText: string): Record<string, unknown> {
  if (info?.target === undefined) return { evicted: stubText };
  return info.targetKind === "command"
    ? { command: info.target, evicted: stubText }
    : { file_path: info.target, evicted: stubText };
}

function buildAttachedFileStub(filePath: string | undefined, originalChars: number): string {
  if (filePath === undefined) {
    return (
      `[onepass: evicted attached file content (${formatThousands(originalChars)} chars). ` +
      `Read the file for current content, or recall_search with a phrase from it for the content as it was.]`
    );
  }
  const path = sanitizeForStub(filePath);
  return (
    `[onepass: evicted attached file ${path} (${formatThousands(originalChars)} chars). ` +
    `Read the file for current content, or recall_search("${path}") for the content as it was.]`
  );
}

function buildTaskNotificationStub(text: string, originalChars: number): string {
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  const outputFile = /<output-file>([^<]+)<\/output-file>/.exec(text)?.[1];
  const forPart = taskId === undefined ? "" : ` for task ${sanitizeForStub(taskId)}`;
  const hint =
    outputFile === undefined
      ? `Use recall_search("${sanitizeForStub(taskId ?? "task-notification")}") for it as it was.`
      : `Read the full output on disk at ${sanitizeForStub(outputFile)}, or recall_search("${sanitizeForStub(
          taskId ?? outputFile,
        )}") for it as it was.`;
  return `[onepass: evicted task notification${forPart} (${formatThousands(originalChars)} chars). ${hint}]`;
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

function textSegmentId(text: string): string {
  return `sha1:${createHash("sha1").update(text).digest("hex")}`;
}

function collectSegments(messages: unknown[]): Segment[] {
  const assistantTurnsAfterIndex: number[] = new Array<number>(messages.length).fill(0);
  let assistantsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    assistantTurnsAfterIndex[i] = assistantsSeen;
    const message = messages[i];
    if (isRecord(message) && message.role === "assistant") assistantsSeen++;
  }

  const toolUseInfoById = collectToolUseInfo(messages);

  // Attached file content and the harness message naming its path arrive as separate
  // segments, content first paired with the nearest preceding unclaimed "Called the Read
  // tool" input. Both are collected in one ordered walk so pairing is by position.
  const readInputPaths: { position: number; path: string; claimed: boolean }[] = [];
  const segments: Segment[] = [];
  let position = 0;

  const classifyText = (text: string, messageIndex: number, blockIndex: number | null): void => {
    let stubText: string;
    if (text.startsWith(READ_INPUT_PREFIX)) {
      const pathMatch = READ_INPUT_PATH_PATTERN.exec(text);
      if (pathMatch?.[1] !== undefined) readInputPaths.push({ position, path: pathMatch[1], claimed: false });
      return;
    }
    if (text.startsWith(ATTACHED_FILE_PREFIX)) {
      let pairedPath: string | undefined;
      for (let i = readInputPaths.length - 1; i >= 0; i--) {
        const candidate = readInputPaths[i];
        if (candidate !== undefined && !candidate.claimed && candidate.position < position) {
          candidate.claimed = true;
          pairedPath = candidate.path;
          break;
        }
      }
      stubText = buildAttachedFileStub(pairedPath, text.length);
    } else if (text.startsWith(TASK_NOTIFICATION_PREFIX)) {
      stubText = buildTaskNotificationStub(text, text.length);
    } else {
      return;
    }
    segments.push({
      id: textSegmentId(text),
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
      // `position` is deliberately not advanced here: it only orders user-side text segments.
      if (!Array.isArray(message.content)) return;
      message.content.forEach((block, blockIndex) => {
        if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") return;
        const input = block.input;
        if (!isRecord(input)) return;
        const contentChars = measureContentChars(input);
        const info = toolUseInfoById.get(block.id);
        const stubText = buildToolUseStub(info, contentChars);
        segments.push({
          id: `call:${block.id}`,
          messageIndex,
          blockIndex,
          contentChars,
          assistantTurnsAfter: assistantTurnsAfterIndex[messageIndex] ?? 0,
          alreadyStubShaped: typeof input.evicted === "string" && input.evicted.startsWith(STUB_PREFIX),
          stubText,
          stubInput: buildToolUseStubInput(info, stubText),
        });
      });
      return;
    }
    if (message.role !== "user") return;
    const content = message.content;
    if (typeof content === "string") {
      classifyText(content, messageIndex, null);
      position++;
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((block, blockIndex) => {
      if (!isRecord(block)) {
        position++;
        return;
      }
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const contentChars = measureContentChars(block.content);
        segments.push({
          id: block.tool_use_id,
          messageIndex,
          blockIndex,
          contentChars,
          assistantTurnsAfter: assistantTurnsAfterIndex[messageIndex] ?? 0,
          alreadyStubShaped: typeof block.content === "string" && block.content.startsWith(STUB_PREFIX),
          stubText: buildToolResultStub(toolUseInfoById.get(block.tool_use_id), contentChars),
        });
      } else if (block.type === "text" && typeof block.text === "string") {
        classifyText(block.text, messageIndex, blockIndex);
      }
      position++;
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
  // A stub no smaller than what it replaces would grow the request, and monotonic eviction
  // would re-pay that every request after. A long path can do it: a call stub names the path
  // three times. Dropping the segment here keeps its id out of the evicted set entirely.
  const candidates = collectSegments(messages).filter(
    (segment) => !segment.alreadyStubShaped && stubbedChars(segment) < segment.contentChars,
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
    segment.assistantTurnsAfter >= config.protectLastAssistantTurns &&
    segment.contentChars >= config.minSegmentChars;
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
