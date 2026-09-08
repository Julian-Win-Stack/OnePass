// The planning cases: which turns of the corpus session a run covers.
//
// A case is a turn I typed whose full prefix exceeds the proxy's trip threshold. Below that
// threshold the proxy evicts nothing, the two arms send byte-identical requests, and the model
// call buys no information — so a turn below it is not worth paying for.
//
// The rule for what counts as a turn I typed is spelled out rather than left to look obvious,
// because getting it wrong is silently destructive in two different ways. Counting compaction
// summaries and injected meta entries as typed turns is what produced the earlier figure of 140
// turns against the real 122; and a compaction summary *selected as a case* would send a
// system-written message to the fork as though I had typed it, and the run would look normal while
// measuring nothing. The reader already classifies every turn, so this asks it rather than
// re-deriving the rule: a case is a turn of kind `typed`, and nothing else can be one.
//
// Size is measured, never estimated. See countTokens.ts for why: the corpus branch carries 1.8M
// chars of pasted screenshots, which a chars-per-token estimate reads as three times the tokens
// the model was really shown.
//
// There is no manifest. Eligibility is recomputed on every run and the list is recorded in the
// result document, so a drift in the rule shows up as a run whose case list differs from the last
// one's rather than as a stale file nobody re-reads.

import type { Mode } from "./args.js";
import { EvalError } from "./errors.js";
import { buildMessages, historyStart, type CaseMessage } from "./messages.js";
import { isRealModelTurn, isTypedTurn, type Branch, type ModelTurn, type Stretch, type UserTurn } from "./transcript.js";

/**
 * T, the proxy's default trip threshold. A turn whose prefix is under this evicts nothing, so both
 * arms would send the same bytes. Held here rather than imported because the eval measures a proxy
 * it builds from source and must not silently follow a threshold that build changed.
 */
export const TRIP_THRESHOLD_TOKENS = 110_000;

/** What the recorded answer to a case did. The two groups the report separates are the first two. */
export type AnswerLabel =
  /** The recorded answer called at least one tool. */
  | "tools"
  /** The recorded answer was text and called none. */
  | "text"
  /** Nothing was recorded: the turn was interrupted, or it is the last thing on the branch. */
  | "none";

export interface PlanningCase {
  /** Names the case in the result document and in the diff against the previous build. */
  id: string;
  /** Where the case was cut, as an index into the branch's turns. */
  turnIndex: number;
  /** Which of my typed turns this is, counting from the start of the branch. */
  typedIndex: number;
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
  /** Count-tokens over the message list alone. */
  messageTokens: number;
  /** The message list plus the fixed system-and-tools overhead: the whole prefix. */
  prefixTokens: number;
  answer: AnswerLabel;
  /** The request's messages. Held for replay and the arms; never written to a result document. */
  messages: CaseMessage[];
}

export interface CaseList {
  /** Every turn I typed on the branch, cases and non-cases alike. */
  typedTurns: number;
  /** Eligible cases, in session order. */
  cases: PlanningCase[];
  /** Typed turns whose prefix did not reach the threshold. */
  belowThreshold: number;
  thresholdTokens: number;
  /**
   * The system prompt and tool definitions, which are the same on every request and are not in the
   * transcript. Read from what the first model turn reported it was shown, less the messages that
   * turn was shown — so it is one number for the whole branch, and approximate by however much the
   * system prompt moved during the session.
   */
  overheadTokens: number;
  /** How many cases fall in each group. */
  answers: Record<AnswerLabel, number>;
}

export interface ExtractOptions {
  /** Overrides the overhead read from the first model turn. Tests pin it; runs do not set it. */
  overheadTokens?: number;
}

/**
 * Lists the eligible cases of a branch, in session order, sizing each with `countTokens`.
 *
 * One call per typed turn plus one for the overhead. The endpoint is free, so this runs in replay
 * mode too — which is what makes replay a look at what a scored run would cover.
 */
export async function extractCases(
  branch: Branch,
  countTokens: (messages: readonly CaseMessage[]) => Promise<number>,
  options: ExtractOptions = {},
): Promise<CaseList> {
  const overheadTokens = options.overheadTokens ?? (await measureOverhead(branch, countTokens));

  const typedTurns = branch.turns.filter(isTypedTurn);
  const cases: PlanningCase[] = [];
  let belowThreshold = 0;

  for (const [typedIndex, turn] of typedTurns.entries()) {
    const messages = buildMessages(branch, turn.index);
    const messageTokens = await countTokens(messages);
    const prefixTokens = messageTokens + overheadTokens;
    if (prefixTokens <= TRIP_THRESHOLD_TOKENS) {
      belowThreshold += 1;
      continue;
    }
    cases.push({
      id: `turn-${turn.index}`,
      turnIndex: turn.index,
      typedIndex,
      uuid: turn.uuid,
      timestamp: turn.timestamp,
      text: firstLine(turn.text),
      stretchIndex: stretchOf(branch, turn).index,
      opensWithCompactionSummary: historyStart(branch, turn.index).opensWithCompactionSummary,
      messageTokens,
      prefixTokens,
      answer: labelAnswer(branch, turn),
      messages,
    });
  }

  return {
    typedTurns: typedTurns.length,
    cases,
    belowThreshold,
    thresholdTokens: TRIP_THRESHOLD_TOKENS,
    overheadTokens,
    answers: {
      tools: cases.filter((planningCase) => planningCase.answer === "tools").length,
      text: cases.filter((planningCase) => planningCase.answer === "text").length,
      none: cases.filter((planningCase) => planningCase.answer === "none").length,
    },
  };
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
    throw new Error(`turn ${turn.index} of ${branch.source} is in none of the branch's ${branch.stretches.length} stretches`);
  }
  return stretch;
}

/**
 * The system prompt and tool definitions, in tokens: what the first model turn reported it was
 * shown, less the messages it was shown. Neither is in the transcript, and they are the same on
 * every request, so one number stands for all of them.
 */
async function measureOverhead(
  branch: Branch,
  countTokens: (messages: readonly CaseMessage[]) => Promise<number>,
): Promise<number> {
  const first = branch.turns.filter(isRealModelTurn).find((turn) => turn.usage !== null);
  if (first === undefined || first.usage === null) {
    throw new EvalError(
      `${branch.source} has no model turn reporting usage on this branch, so the fixed ` +
        `system-and-tools overhead cannot be read and no case can be sized.`,
    );
  }
  const shown = buildMessages(branch, first.index - 1);
  return Math.max(0, first.usage.contextTokens - (await countTokens(shown)));
}

/**
 * What the recorded answer to the turn at `turnIndex` did: the model turns between it and the next
 * typed turn. Whether tools were used does not decide eligibility — it is a label, and the report
 * shows the two groups apart, so a proxy that hurts one kind more than the other is visible.
 */
function labelAnswer(branch: Branch, typedTurn: UserTurn): AnswerLabel {
  const answer: ModelTurn[] = [];
  for (const turn of branch.turns.slice(typedTurn.index + 1)) {
    if (isTypedTurn(turn)) break;
    if (isRealModelTurn(turn)) answer.push(turn);
  }
  if (answer.length === 0) return "none";
  return answer.some((turn) => !turn.textOnly) ? "tools" : "text";
}

/**
 * The cases a mode covers. Quick takes every second one, which spreads the subset over the whole
 * session with no seed to record and no run to reproduce. Replay makes no model calls, so it costs
 * nothing to cover every case and it is more useful when it does.
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
