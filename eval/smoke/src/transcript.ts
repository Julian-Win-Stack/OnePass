// Reading a stored session: where Claude Code keeps it, and how to cut it into turns.
//
// The eval forks a recorded session at a turn boundary, so it has to name two entries: the
// last chain entry of the turn it keeps (the fork point) and the prompt of the turn it drops.
// Both come from `readTurns`. Nothing here writes — a transcript is read-only (CLAUDE.md).

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One line of a `.jsonl` transcript. Only the fields this module reads are named. */
export interface TranscriptEntry {
  uuid?: string;
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  /** Present on a user entry that carries a tool result rather than something the user typed. */
  toolUseResult?: unknown;
  message?: { role?: string; content?: unknown };
  /** The Claude Code version that wrote the entry. */
  version?: string;
  [key: string]: unknown;
}

/** One user turn and everything the session recorded in answer to it. */
export interface Turn {
  /** The user entry that opened the turn. */
  promptUuid: string;
  /** What the user typed, as text. */
  promptText: string;
  /**
   * The turn's last chain entry — the fork point that keeps the whole turn. The SDK's
   * `resumeSessionAt` takes any chain uuid, and its guidance is to fork at the kept turn's
   * last entry rather than at its last assistant message.
   */
  lastUuid: string;
  /** What the assistant answered, concatenated over the turn's assistant entries. */
  answerText: string;
}

/**
 * The directory Claude Code keeps a working directory's sessions in. Every character outside
 * `[A-Za-z0-9]` becomes a dash, so `/Users/me/.foo/bar` slugs to `-Users-me--foo-bar`.
 *
 * The slug is taken from the *resolved* path: a session run in `/tmp/x` on macOS is filed
 * under `-private-tmp-x`, because `/tmp` is a symlink. A corpus directory reached through a
 * symlink would otherwise have its copies placed where nothing looks for them. A path that
 * does not exist yet cannot be resolved and is slugged as given.
 */
export function projectDirFor(worktree: string, home: string = homedir()): string {
  let resolved = worktree;
  try {
    resolved = realpathSync(worktree);
  } catch {
    // Not on disk: the caller is naming a directory it has not created yet.
  }
  return join(home, ".claude", "projects", resolved.replace(/[^A-Za-z0-9]/g, "-"));
}

/** Parse a transcript. Unparsable lines are skipped: the format is internal and moving. */
export function readTranscript(file: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

/** Text of a message's content, whether it is a bare string or a block array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => {
      return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
    })
    .map((block) => block.text)
    .join("");
}

/** A user entry the human typed, as opposed to one carrying a tool result or a system note. */
function isTypedPrompt(entry: TranscriptEntry): boolean {
  if (entry.type !== "user" || entry.isMeta === true || entry.toolUseResult !== undefined) return false;
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((block) => (block as { type?: unknown })?.type === "tool_result")) {
    return false;
  }
  return true;
}

/**
 * Cut a transcript into turns. The chain is the file's own order over entries that carry a
 * uuid and are not sidechain (subagent) entries; a turn opens at each typed prompt and runs
 * to the entry before the next one.
 */
export function readTurns(entries: TranscriptEntry[]): Turn[] {
  const chain = entries.filter((entry): entry is TranscriptEntry & { uuid: string } => {
    return typeof entry.uuid === "string" && entry.isSidechain !== true;
  });
  const turns: Turn[] = [];
  for (const entry of chain) {
    if (isTypedPrompt(entry)) {
      turns.push({
        promptUuid: entry.uuid,
        promptText: textOf(entry.message?.content),
        lastUuid: entry.uuid,
        answerText: "",
      });
      continue;
    }
    const turn = turns[turns.length - 1];
    if (turn === undefined) continue; // Anything before the first typed prompt belongs to no turn.
    turn.lastUuid = entry.uuid;
    if (entry.type === "assistant") turn.answerText += textOf(entry.message?.content);
  }
  return turns;
}
