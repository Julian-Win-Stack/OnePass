// Rebuilding the request a session sent at one of its turns.
//
// A case is a request prefix cut at a turn, and this is where that prefix is put back together
// out of the transcript. Two things make it more than a filter over the turns.
//
// **Entries are not messages.** Claude Code writes one transcript entry per content block, so a
// single answer that said something and then called a tool is two `assistant` entries, and a turn
// handing back three tool results is three `user` entries. The API saw one message each time.
// Rebuilding without merging them inflates the assistant-message count, and the proxy's age gate
// is counted in assistant messages — a rebuild that does not merge would trip eviction at a depth
// no real session ever reached, and every number measured off it would be measuring the rebuild.
//
// **History does not start at the root.** A compaction throws away everything before it and puts
// its summary in the place of it, so a turn typed after a compaction was sent with the summary and
// the turns since, and nothing else. The branch's parent links run straight through the boundary,
// so walking back from the turn would sweep up history that request never carried. History
// therefore starts at the last compaction the case sits past, opening with that compaction's
// summary — which hangs off the boundary's own root and is never on the branch itself.
//
// The one thing not rebuilt here is the system prompt and the tool definitions. They are not in
// the transcript, and the two callers do not need them: replay sends a placeholder because
// eviction acts on messages alone, and case sizing adds the fixed overhead the first model turn's
// usage reports.

import { isRealModelTurn, type Branch, type Compaction, type Turn } from "./transcript.js";

/** One message of the request, in the shape the Anthropic API takes. */
export interface CaseMessage {
  role: "user" | "assistant";
  content: unknown[];
}

/** Where a case's history begins, and what opened it. */
export interface HistoryStart {
  /** The first turn of the branch that the request carried. */
  fromIndex: number;
  /** The compaction the history opens after, or null when it opens at the branch's root. */
  compaction: Compaction | null;
  /**
   * Whether the request opened with a compaction summary. False at the branch's root, and false
   * for a compaction whose summary the file does not hold — which is reported rather than filled
   * in, because standing anything in for a summary would be inventing the model's history.
   */
  opensWithCompactionSummary: boolean;
}

/**
 * Where the history of a case cut at `turnIndex` begins: after the last compaction at or before
 * that turn, or at the branch's root when no compaction precedes it.
 */
export function historyStart(branch: Branch, turnIndex: number): HistoryStart {
  let latest: Compaction | null = null;
  for (const compaction of branch.compactions) {
    if (compaction.afterIndex > turnIndex) continue;
    if (latest === null || compaction.afterIndex >= latest.afterIndex) latest = compaction;
  }
  return {
    fromIndex: latest === null ? 0 : latest.afterIndex + 1,
    compaction: latest,
    opensWithCompactionSummary: latest?.summary != null,
  };
}

/**
 * The messages of the request that answered the turn at `turnIndex`, the turn itself last.
 *
 * Sidechain turns are another conversation and were never in this request; synthetic entries are
 * interrupts and error notices Claude Code wrote for itself and were never sent at all.
 */
export function buildMessages(branch: Branch, turnIndex: number): CaseMessage[] {
  const start = historyStart(branch, turnIndex);
  const messages: CaseMessage[] = [];

  const summary = start.compaction?.summary ?? null;
  if (summary !== null) append(messages, "user", contentBlocks(summary.content));

  for (const turn of branch.turns) {
    if (turn.index < start.fromIndex || turn.index > turnIndex) continue;
    if (!carriedInRequest(turn)) continue;
    append(messages, turn.kind === "model" ? "assistant" : "user", contentBlocks(turn.content));
  }
  return messages;
}

/** Whether a turn was part of the request at all, as against part of the transcript around it. */
function carriedInRequest(turn: Turn): boolean {
  if (turn.sidechain) return false;
  return turn.kind !== "model" || isRealModelTurn(turn);
}

/** Adds blocks to the message being built, opening a new one only when the role changes. */
function append(messages: CaseMessage[], role: CaseMessage["role"], blocks: unknown[]): void {
  if (blocks.length === 0) return;
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === role) last.content.push(...blocks);
  else messages.push({ role, content: [...blocks] });
}

/**
 * An entry's stored content as the blocks a message carries. A `user` entry the user typed holds
 * a bare string, which the API takes as one text block; everything else is already a block list.
 * An empty entry contributes nothing rather than an empty block, which the API refuses.
 */
function contentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}
