// Pure transform over an Anthropic POST /v1/messages request body: replaces the content of
// old, large tool_result blocks with short deterministic stubs. No I/O — the caller owns the
// evicted-id set, the threshold state, and all logging.

export interface EvictionConfig {
  /** N: a tool result becomes eligible once at least this many assistant messages follow it. */
  evictAfterAssistantTurns: number;
  /** K: results inside the last K assistant turns are never touched, regardless of size. */
  protectLastAssistantTurns: number;
  /** Results smaller than this many chars are never stubbed — stubbing them saves nothing. */
  minResultChars: number;
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
  newlyEvictedToolUseIds: string[];
  /** Every id stubbed in this request, previously evicted ones included. */
  stubbedToolUseIds: string[];
  /**
   * The normal pass (age ≥ N) left the request above T, so results aged K..N were evicted
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

interface ResultCandidate {
  messageIndex: number;
  blockIndex: number;
  toolUseId: string;
  contentChars: number;
  assistantTurnsAfter: number;
  alreadyStubShaped: boolean;
}

function collectResultCandidates(messages: unknown[]): ResultCandidate[] {
  const assistantTurnsAfterIndex: number[] = new Array<number>(messages.length).fill(0);
  let assistantsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    assistantTurnsAfterIndex[i] = assistantsSeen;
    const message = messages[i];
    if (isRecord(message) && message.role === "assistant") assistantsSeen++;
  }

  const candidates: ResultCandidate[] = [];
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") return;
      candidates.push({
        messageIndex,
        blockIndex,
        toolUseId: block.tool_use_id,
        contentChars: measureContentChars(block.content),
        assistantTurnsAfter: assistantTurnsAfterIndex[messageIndex] ?? 0,
        alreadyStubShaped: typeof block.content === "string" && block.content.startsWith(STUB_PREFIX),
      });
    });
  });
  return candidates;
}

function sanitizeForStub(text: string): string {
  return text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
}

// Deterministic on purpose: the same request must always produce the same bytes, or the
// stubs themselves would break the prompt-cache prefix they exist to protect.
function buildStubText(info: ToolUseInfo | undefined, originalChars: number): string {
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

interface StubApplication {
  messages: unknown[];
  charsRemoved: number;
  stubbedToolUseIds: string[];
}

function applyStubs(
  messages: unknown[],
  targets: ResultCandidate[],
  toolUseInfoById: Map<string, ToolUseInfo>,
): StubApplication {
  if (targets.length === 0) return { messages, charsRemoved: 0, stubbedToolUseIds: [] };

  const targetsByMessage = new Map<number, Map<number, ResultCandidate>>();
  for (const target of targets) {
    let byBlock = targetsByMessage.get(target.messageIndex);
    if (byBlock === undefined) {
      byBlock = new Map();
      targetsByMessage.set(target.messageIndex, byBlock);
    }
    byBlock.set(target.blockIndex, target);
  }

  let charsRemoved = 0;
  const stubbedToolUseIds: string[] = [];
  const nextMessages = messages.map((message, messageIndex) => {
    const byBlock = targetsByMessage.get(messageIndex);
    if (byBlock === undefined || !isRecord(message) || !Array.isArray(message.content)) return message;
    const nextContent = message.content.map((block, blockIndex) => {
      const target = byBlock.get(blockIndex);
      if (target === undefined || !isRecord(block)) return block;
      const stub = buildStubText(toolUseInfoById.get(target.toolUseId), target.contentChars);
      charsRemoved += Math.max(0, target.contentChars - stub.length);
      stubbedToolUseIds.push(target.toolUseId);
      return { ...block, content: stub };
    });
    return { ...message, content: nextContent };
  });

  return { messages: nextMessages, charsRemoved, stubbedToolUseIds };
}

export function evictToolResults(
  body: unknown,
  alreadyEvictedToolUseIds: ReadonlySet<string>,
  config: EvictionConfig,
): EvictionOutcome {
  const estimatedTokensBefore = estimateTokens(body, config.charsPerToken);
  const passthrough: EvictionOutcome = {
    body,
    bodyChanged: false,
    tripped: false,
    newlyEvictedToolUseIds: [],
    stubbedToolUseIds: [],
    pressure: false,
    charsRemoved: 0,
    newlyEvictedCharsRemoved: 0,
    estimatedTokensBefore,
    estimatedTokensSent: estimatedTokensBefore,
  };
  if (!isRecord(body) || !Array.isArray(body.messages)) return passthrough;

  const messages = body.messages;
  const toolUseInfoById = collectToolUseInfo(messages);
  const candidates = collectResultCandidates(messages).filter((candidate) => !candidate.alreadyStubShaped);

  // Monotonic: an id evicted on any earlier request is stubbed again on every request.
  const existingTargets = candidates.filter((candidate) => alreadyEvictedToolUseIds.has(candidate.toolUseId));
  const afterExisting = applyStubs(messages, existingTargets, toolUseInfoById);
  const estimatedTokensAfterExisting =
    afterExisting.stubbedToolUseIds.length > 0
      ? estimateTokens({ ...body, messages: afterExisting.messages }, config.charsPerToken)
      : estimatedTokensBefore;

  const tripped = estimatedTokensAfterExisting > config.tripThresholdTokens;
  const isNewTarget = (candidate: ResultCandidate, minAge: number): boolean =>
    !alreadyEvictedToolUseIds.has(candidate.toolUseId) &&
    candidate.assistantTurnsAfter >= minAge &&
    candidate.assistantTurnsAfter >= config.protectLastAssistantTurns &&
    candidate.contentChars >= config.minResultChars;
  const newTargets = tripped
    ? candidates.filter((candidate) => isNewTarget(candidate, config.evictAfterAssistantTurns))
    : [];
  const afterNew = applyStubs(afterExisting.messages, newTargets, toolUseInfoById);

  // Pressure pass: a burst of fresh large results can leave the request above T with nothing
  // aged past N yet. Rather than let the client cross its compaction threshold, relax the age
  // gate down to K — the last K turns stay untouchable, everything older is fair game.
  let pressure = false;
  let afterPressure: StubApplication = { messages: afterNew.messages, charsRemoved: 0, stubbedToolUseIds: [] };
  if (tripped) {
    const stillOverThreshold =
      estimateTokens({ ...body, messages: afterNew.messages }, config.charsPerToken) > config.tripThresholdTokens;
    if (stillOverThreshold) {
      const alreadyTargeted = new Set(newTargets.map((target) => target.toolUseId));
      const pressureTargets = candidates.filter(
        (candidate) =>
          !alreadyTargeted.has(candidate.toolUseId) && isNewTarget(candidate, config.protectLastAssistantTurns),
      );
      if (pressureTargets.length > 0) {
        pressure = true;
        afterPressure = applyStubs(afterNew.messages, pressureTargets, toolUseInfoById);
      }
    }
  }

  const newlyEvictedToolUseIds = [...afterNew.stubbedToolUseIds, ...afterPressure.stubbedToolUseIds];
  const stubbedToolUseIds = [...afterExisting.stubbedToolUseIds, ...newlyEvictedToolUseIds];
  if (stubbedToolUseIds.length === 0) return { ...passthrough, tripped };

  const finalBody = { ...body, messages: afterPressure.messages };
  return {
    body: finalBody,
    bodyChanged: true,
    tripped,
    newlyEvictedToolUseIds,
    stubbedToolUseIds,
    pressure,
    charsRemoved: afterExisting.charsRemoved + afterNew.charsRemoved + afterPressure.charsRemoved,
    newlyEvictedCharsRemoved: afterNew.charsRemoved + afterPressure.charsRemoved,
    estimatedTokensBefore,
    estimatedTokensSent: estimateTokens(finalBody, config.charsPerToken),
  };
}
