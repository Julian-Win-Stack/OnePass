// How a token count is written down.
//
// Four places print one — the import's summary, the run's own progress lines, the case table and
// the replay totals — and a result read beside a run's output should not have them written two
// different ways. `unrecorded` rather than `0` for a missing count: a turn that reported nothing
// and a turn that reported nothing *used* are different things, and only one of them is news.

/** `54k`, or `unrecorded` for a count nothing reported. */
export function formatTokens(value: number | null): string {
  return value === null ? "unrecorded" : `${Math.round(value / 1000)}k`;
}
