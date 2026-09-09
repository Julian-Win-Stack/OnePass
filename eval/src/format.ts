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
  notPrompts: number;
  eligible: number;
  belowThreshold: number;
  unanswered: number;
  thresholdTokens: number;
  answers: { tools: number; text: number };
}

/** `28 of 50 prompts are past the 110k trip threshold`. */
export function describeEligibility(counts: CaseCounts): string {
  return (
    `${counts.eligible} of ${counts.typedTurns - counts.notPrompts} prompts are past the ` +
    `${formatTokens(counts.thresholdTokens)} trip threshold`
  );
}

/** `By recorded answer: 12 used tools, 14 answered in text.` */
export function describeAnswerGroups(counts: CaseCounts): string {
  return `By recorded answer: ${counts.answers.tools} used tools, ${counts.answers.text} answered in text.`;
}

/** How a case's size was arrived at, which a number on its own does not say. */
export function describeSizing(counts: CaseCounts): string {
  return (
    `A case's size is what the model turn that answered it reported being shown — the whole request, ` +
    `system prompt and tools included, as the API counted it. Nothing is rebuilt or estimated.`
  );
}

/** What the branch held that is not a case, which a bare eligible count leaves unexplained. */
export function describeNonCases(counts: CaseCounts): string {
  return (
    `${counts.belowThreshold} prompt(s) sat under the threshold, ${counts.unanswered} were never answered, ` +
    `and ${counts.notPrompts} of the ${counts.typedTurns} typed turns are entries Claude Code wrote in the ` +
    `user slot itself.`
  );
}
