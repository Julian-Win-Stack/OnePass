// The planning cases: which turns of the corpus session a scored run covers.
//
// A case is a prompt I typed whose request was past the proxy's trip threshold. Below that
// threshold the proxy evicts nothing, the two arms send byte-identical requests, and the model call
// buys no information — so a turn below it is not worth paying for.
//
// **How deep a turn was is read, not rebuilt.** Every model turn records what the API told it it
// was shown, so the turn that answered a prompt reports the size of the request that prompt
// produced: the messages, the system prompt, the tool definitions, the injected attachments, all of
// it, as the API counted it. That is the whole prefix and it is free to read. The eval used to
// rebuild the request from the transcript and measure it with count-tokens instead, which is
// where the cut-at-80k workaround came from: the transcript does not store what was sent, so the
// rebuild came out 17k short on the shallowest corpus case and 54k on the deepest, and the
// threshold was lowered to stop that silently dropping turns. Reading the answer's own usage has
// no shortfall to work around, so the threshold is the proxy's own 110k again.
//
// A prompt with no answer after it has no depth to read — it was interrupted, or it is the last
// thing on the branch — and is not a case. That is also the right answer for a different reason:
// there is nothing to compare a fork's answer against.
//
// The rule for what counts as a turn I typed is spelled out rather than left to look obvious,
// because getting it wrong is silently destructive. Counting compaction summaries and injected meta
// entries as typed turns is what produced the earlier figure of 140 turns against the real 122; and
// a compaction summary *selected as a case* would send a system-written message to the fork as
// though I had typed it, and the run would look normal while measuring nothing. Seven typed turns
// on the corpus branch are entries Claude Code wrote in the user slot itself — see prompts.ts —
// and those are held out here too.
//
// There is no manifest. Eligibility is recomputed on every run and the list is recorded in the
// result document, so a drift in the rule shows up as a run whose case list differs from the last
// one's rather than as a stale file nobody re-reads.

import type { Mode } from "./args.js";
import { readPrompts } from "./prompts.js";
import {
  isRealModelTurn,
  isTypedTurn,
  type Branch,
  type ModelTurn,
  type Stretch,
  type UserTurn,
} from "./transcript.js";

/**
 * The prefix size a turn has to reach to be worth covering: the proxy's own trip threshold. Held
 * here rather than imported because the eval measures a proxy it builds from source and must not
 * silently follow a threshold that build changed.
 */
export const TRIP_THRESHOLD_TOKENS = 110_000;

/** What the recorded answer to a case did. The report shows the two groups apart. */
export type AnswerLabel =
  /** The recorded answer called at least one tool. */
  | "tools"
  /** The recorded answer was text and called none. */
  | "text";

export interface PlanningCase {
  /** Names the case in the result document. */
  id: string;
  /** Where the case was cut, as an index into the branch's turns. */
  turnIndex: number;
  /** Which prompt of the session this is, counting from the start of the branch. */
  promptIndex: number;
  uuid: string;
  timestamp: string | null;
  /**
   * The first line of what I typed. Printed while a run works, so the list reads as a session
   * rather than as numbers, and never recorded: a result document is committed and this is corpus
   * content.
   */
  text: string;
  /** The stretch the turn sits in, which is what says what it was recorded on. */
  stretchIndex: number;
  /** True when the request opened with a compaction summary rather than with the session's start. */
  opensWithCompactionSummary: boolean;
  /** The whole request, as the model turn that answered it reported being shown. */
  prefixTokens: number;
  answer: AnswerLabel;
}

export interface CaseList {
  /** Every turn I typed on the branch, cases and non-cases alike. */
  typedTurns: number;
  /** Typed turns that are Claude Code's own entries rather than prompts: never cases. */
  notPrompts: number;
  /** Eligible cases, in session order. */
  cases: PlanningCase[];
  /** Prompts whose request did not reach the threshold. */
  belowThreshold: number;
  /** Prompts with no model turn after them, so no recorded depth and nothing to compare against. */
  unanswered: number;
  thresholdTokens: number;
  /** How many cases fall in each group. */
  answers: Record<AnswerLabel, number>;
}

/** Lists the eligible cases of a branch, in session order. Reads the transcript and nothing else. */
export function extractCases(branch: Branch): CaseList {
  const { typedTurns, prompts, skipped } = readPrompts(branch);
  const cases: PlanningCase[] = [];
  let belowThreshold = 0;
  let unanswered = 0;

  for (const prompt of prompts) {
    const turn = branch.turns[prompt.turnIndex];
    if (turn === undefined || !isTypedTurn(turn)) continue;
    const answer = answerTo(branch, turn);
    if (answer === null) {
      unanswered += 1;
      continue;
    }
    if (answer.prefixTokens <= TRIP_THRESHOLD_TOKENS) {
      belowThreshold += 1;
      continue;
    }
    cases.push({
      id: `turn-${turn.index}`,
      turnIndex: turn.index,
      promptIndex: prompt.position,
      uuid: turn.uuid,
      timestamp: turn.timestamp,
      text: firstLine(turn.text),
      stretchIndex: stretchOf(branch, turn).index,
      opensWithCompactionSummary: opensWithCompactionSummary(branch, turn.index),
      prefixTokens: answer.prefixTokens,
      answer: answer.label,
    });
  }

  return {
    typedTurns,
    notPrompts: skipped.length,
    cases,
    belowThreshold,
    unanswered,
    thresholdTokens: TRIP_THRESHOLD_TOKENS,
    answers: {
      tools: cases.filter((planningCase) => planningCase.answer === "tools").length,
      text: cases.filter((planningCase) => planningCase.answer === "text").length,
    },
  };
}

interface RecordedAnswer {
  /** What the first model turn after the prompt reported it was shown: the whole request. */
  prefixTokens: number;
  label: AnswerLabel;
}

/**
 * What answered a prompt, and how big the request it answered was.
 *
 * Depth comes from the *first* model turn after the prompt, because that is the one whose request
 * was the prompt's own prefix; later turns of the same answer carry the tool results the answer
 * itself produced. Whether tools were used is read over the whole answer, since that is a label
 * about what the turn did rather than about how big it was.
 *
 * Null when nothing answered, or when the answer reported no usage — both mean there is no size to
 * read, and guessing one would put a turn in the case list at a depth nobody measured.
 */
function answerTo(branch: Branch, prompt: UserTurn): RecordedAnswer | null {
  const answer: ModelTurn[] = [];
  for (const turn of branch.turns.slice(prompt.index + 1)) {
    if (isTypedTurn(turn)) break;
    if (isRealModelTurn(turn)) answer.push(turn);
  }
  const first = answer[0];
  if (first === undefined || first.usage === null) return null;
  return {
    prefixTokens: first.usage.contextTokens,
    label: answer.some((turn) => !turn.textOnly) ? "tools" : "text",
  };
}

/**
 * Whether the request at `turnIndex` opened with a compaction summary rather than the session's own
 * start. A compaction throws away everything before it and puts its summary in the place of it, so
 * a turn typed after one sat on a history that begins there. It is a label on the case, not a
 * measurement: both arms inherit the same prefix either way.
 */
function opensWithCompactionSummary(branch: Branch, turnIndex: number): boolean {
  let latest = null;
  for (const compaction of branch.compactions) {
    if (compaction.afterIndex > turnIndex) continue;
    if (latest === null || compaction.afterIndex >= latest.afterIndex) latest = compaction;
  }
  return latest?.summary != null;
}

/**
 * The stretch a turn sits in. Every turn of a branch is in one, so a turn that is in none is a bug
 * in the reader rather than anything the caller can put right — and guessing a stretch would
 * mislabel what the case was recorded on, which is the one thing the stretch is read for.
 */
function stretchOf(branch: Branch, turn: UserTurn): Stretch {
  const stretch = branch.stretches.find(
    (candidate) => turn.index >= candidate.fromIndex && turn.index <= candidate.toIndex,
  );
  if (stretch === undefined) {
    throw new Error(
      `turn ${turn.index} of ${branch.source} is in none of the branch's ${branch.stretches.length} stretches`,
    );
  }
  return stretch;
}

/**
 * The cases a mode covers. Quick takes every second one, which spreads the subset over the whole
 * session with no seed to record and no run to reproduce. Replay does not use this at all: it
 * replays a recording, not a case list.
 */
export function selectCases(cases: readonly PlanningCase[], mode: Mode): PlanningCase[] {
  return mode === "quick" ? cases.filter((_, index) => index % 2 === 0) : [...cases];
}

/**
 * The first line of what I typed, trimmed to something a progress line can hold. It is printed as
 * the run works and never written to a result document: a result document is committed, and the
 * words of my session are corpus content, which the corpus directory exists to keep out of git.
 */
function firstLine(text: string, limit = 72): string {
  const line = (text.split("\n").find((candidate) => candidate.trim() !== "") ?? "").trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}
