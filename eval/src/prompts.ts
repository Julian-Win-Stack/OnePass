// The prompts a session was driven by: what the user typed, in order.
//
// This is what the recording script feeds to a fresh Claude Code session, and it is a plain read
// of one text field per typed turn. It is deliberately not a request rebuild — nothing here
// reconstructs history, merges entries or looks at a compaction. Replay used to rebuild request
// bodies from the transcript and that is exactly what this replaces: Claude Code builds the real
// request when it is given the real prompt, and the proxy writes down what it was handed.
//
// Three shapes sit in the user slot that nobody typed. Claude Code writes them there itself, and
// feeding one back to a session is nonsense — `[Request interrupted by user]` asks a model to
// answer an interruption, and a slash command's echo asks it to answer the transcript's own
// bookkeeping. They are named here rather than filtered by eye because the recording script runs
// unattended: an unrecognised one becomes a paid turn that measures nothing.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EvalError } from "./errors.js";
import { isTypedTurn, type Branch, type UserTurn } from "./transcript.js";

/** One prompt to feed, and where on the branch it came from. */
export interface Prompt {
  /** The turn's index on the branch, which is what names it in a report. */
  turnIndex: number;
  /** Which prompt this is, counting the ones that will be fed, from 1. */
  position: number;
  uuid: string;
  timestamp: string | null;
  /** The text field, verbatim. Never trimmed or reworded: it is what the session was driven by. */
  text: string;
}

/** A typed turn that is not a prompt, and which of the three shapes it is. */
export interface SkippedTurn {
  turnIndex: number;
  uuid: string;
  why: "interrupted" | "slash command" | "command output" | "empty";
}

export interface PromptList {
  /** Every typed turn on the branch, prompts and non-prompts alike. */
  typedTurns: number;
  prompts: Prompt[];
  skipped: SkippedTurn[];
}

const INTERRUPTED = "[Request interrupted by user]";

/**
 * The prompts of a branch, in session order, with the entries Claude Code wrote in the user slot
 * held back and named.
 */
export function readPrompts(branch: Branch): PromptList {
  const typedTurns = branch.turns.filter(isTypedTurn);
  const prompts: Prompt[] = [];
  const skipped: SkippedTurn[] = [];

  for (const turn of typedTurns) {
    const why = whyNotAPrompt(turn.text);
    if (why !== null) {
      skipped.push({ turnIndex: turn.index, uuid: turn.uuid, why });
      continue;
    }
    prompts.push({
      turnIndex: turn.index,
      position: prompts.length + 1,
      uuid: turn.uuid,
      timestamp: turn.timestamp,
      text: turn.text,
    });
  }
  return { typedTurns: typedTurns.length, prompts, skipped };
}

/** Why a typed turn is not something a person typed, or null when it is. */
export function whyNotAPrompt(text: string): SkippedTurn["why"] | null {
  const trimmed = text.trim();
  if (trimmed === "") return "empty";
  if (trimmed.startsWith(INTERRUPTED)) return "interrupted";
  // A slash command is written as an echo of the command and, separately, of whatever it printed.
  // Both are `user` entries with no `isMeta`, so the typed-turn rule admits them.
  if (trimmed.startsWith("<command-name>") || trimmed.startsWith("<command-message>")) return "slash command";
  if (trimmed.startsWith("<local-command-stdout>") || trimmed.startsWith("<local-command-stderr>")) {
    return "command output";
  }
  return null;
}

/**
 * Writes one file per prompt into `outDir`, named so that name order is session order.
 *
 * Files rather than arguments, and one prompt per file rather than one big one. A prompt runs to
 * several paragraphs and carries quotes, backticks, newlines and pasted code; passing that through
 * a shell as an argument is a quoting bug waiting to happen, and a driver that mangles one prompt
 * has recorded a session nobody had. A file is fed with `claude -p < file` and nothing can touch it
 * on the way.
 */
export function writePrompts(list: PromptList, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const existing = readdirSync(outDir).filter((name) => name.endsWith(".txt"));
  if (existing.length > 0) {
    throw new EvalError(
      `${outDir} already holds ${existing.length} prompt file(s). Writing over them would leave a ` +
        `driver feeding a mix of two sessions; delete it, or name another directory.`,
    );
  }
  return list.prompts.map((prompt) => {
    const path = join(outDir, `${String(prompt.position).padStart(4, "0")}.txt`);
    writeFileSync(path, prompt.text, "utf8");
    return path;
  });
}

/** What the prompts command prints: how many will be fed, and what was held back. */
export function renderPrompts(list: PromptList, outDir: string): string {
  const lines = [
    `Wrote ${list.prompts.length} prompt(s) to ${outDir}`,
    `  typed turns on the branch  ${list.typedTurns}`,
    `  prompts to feed            ${list.prompts.length}`,
    `  Claude Code's own entries  ${list.skipped.length}`,
  ];
  const reasons = new Map<string, number>();
  for (const entry of list.skipped) reasons.set(entry.why, (reasons.get(entry.why) ?? 0) + 1);
  for (const [why, count] of reasons) lines.push(`    ${why.padEnd(22)} ${count}`);
  return lines.join("\n");
}
