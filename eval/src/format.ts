// How a run's numbers are written down.
//
// The run prints its case counts to the terminal as it works and the result document states them
// again for a reader who was not there. Two readers, one set of facts — so the sentences are
// written once here and used by both, because a progress line and a committed document disagreeing
// about how many cases a run covered is the kind of drift nobody notices until it matters.
//
// `unrecorded` rather than `0` for a missing token count: a turn that reported nothing and a turn
// that reported nothing *used* are different things, and only one of them is news.

/** `54k`, or `unrecorded` for a count nothing reported. */
export function formatTokens(value: number | null): string {
  return value === null ? "unrecorded" : `${Math.round(value / 1000)}k`;
}

/**
 * The counts a run has to state twice. `CaseSelection` satisfies this, which is the point: the
 * document and the progress lines describe the same object rather than two readings of one.
 */
export interface CaseCounts {
  typedTurns: number;
  eligible: number;
  belowThreshold: number;
  thresholdTokens: number;
  overheadTokens: number;
  answers: { tools: number; text: number; none: number };
}

/** `28 of 50 typed turns are past the 110k trip threshold`. */
export function describeEligibility(counts: CaseCounts): string {
  return (
    `${counts.eligible} of ${counts.typedTurns} typed turns are past the ` +
    `${formatTokens(counts.thresholdTokens)} trip threshold`
  );
}

/** `By recorded answer: 12 used tools, 14 answered in text, 2 have no recorded answer.` */
export function describeAnswerGroups(counts: CaseCounts): string {
  return (
    `By recorded answer: ${counts.answers.tools} used tools, ${counts.answers.text} answered in text, ` +
    `${counts.answers.none} have no recorded answer.`
  );
}

/** How a case's size was arrived at, which a number on its own does not say. */
export function describeSizing(counts: CaseCounts): string {
  return (
    `Sizes are the message list measured with count-tokens, plus ${formatTokens(counts.overheadTokens)} of ` +
    `system prompt and tool definitions read from the first model turn's usage.`
  );
}
