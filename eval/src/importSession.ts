// Importing a session into the corpus.
//
// Two things happen, in this order: the transcript is read as one branch, and the file is copied
// into the corpus. The copy is what every later stage forks from; the original under the projects
// directory is the source of truth and is only ever opened for reading, because a bug in the eval
// must not be able to corrupt the sessions it reads. Nothing here writes to `source`, and the copy
// is made with `copyFile`, which reads one and writes the other.
//
// What is printed is the whole point of the command: the turn counts, the compaction points and
// the token trajectory, plus what the file held that the chosen branch does not — how many
// branches are in it, how many entries were left off the path, and which session ids it mixes.
// Read flat, one file mixes conversations that never coexisted, so the numbers only mean anything
// beside the branch they were measured on.

import { chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Corpus } from "./corpus.js";
import { EvalError } from "./errors.js";
import { readTranscript, type Branch, type Stretch, type Tally } from "./transcript.js";

/** The schema of the manifest written beside a transcript copy, bumped when its shape changes. */
export const IMPORT_SCHEMA = "onepass-eval/import@1";

export interface ImportedSession {
  branch: Branch;
  /** The copy in the corpus, which is what later stages fork. */
  transcriptPath: string;
  /** The record of what was imported and what was measured. */
  manifestPath: string;
}

export interface ImportOptions {
  /** The branch tip to walk back from. Defaults to the last entry written. */
  tip?: string | null;
  /** What the copy is filed under in the corpus. Defaults to the source file's name. */
  name?: string | null;
}

/** Copies a transcript into the corpus and returns the branch it holds. */
export function importSession(corpus: Corpus, source: string, options: ImportOptions = {}): ImportedSession {
  const branch = readTranscript(source, { tip: options.tip ?? null });
  const name = sessionName(options.name ?? null, source);

  const transcriptPath = join(corpus.transcripts, `${name}.jsonl`);
  copyFileSync(source, transcriptPath);
  // A transcript in the projects directory is often mode 600, and a copy inherits it. The corpus
  // copy is read by later stages and by whoever is looking at a result, so it is left readable.
  chmodSync(transcriptPath, 0o644);

  const manifestPath = join(corpus.transcripts, `${name}.import.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest(branch, transcriptPath), null, 2)}\n`, "utf8");

  return { branch, transcriptPath, manifestPath };
}

/**
 * What the import recorded. The turn model itself is not written out — it is derived from the copy
 * whenever it is wanted, and a second copy of it would be one more thing to keep in step.
 */
function manifest(branch: Branch, transcriptPath: string): unknown {
  return {
    schema: IMPORT_SCHEMA,
    importedAt: new Date().toISOString(),
    source: branch.source,
    transcript: transcriptPath,
    tip: { uuid: branch.tipUuid, chosen: branch.tipChosen },
    sessionIds: branch.sessionIds,
    counts: branch.counts,
    peakContextTokens: branch.peakContextTokens,
    compactions: branch.compactions,
    unexplainedDrops: branch.unexplainedDrops,
    stretches: branch.stretches,
    file: branch.file,
    trajectory: branch.trajectory,
  };
}

function sessionName(name: string | null, source: string): string {
  const chosen = (name ?? basename(source).replace(/\.jsonl$/, "")).trim();
  if (chosen === "" || chosen.includes("/") || chosen.includes("\\") || chosen.startsWith(".")) {
    throw new EvalError(`${chosen || "an empty name"} is not a name a transcript copy can be filed under.`);
  }
  return chosen;
}

/** What the command prints: the branch first, then what the file held around it. */
export function renderImport(imported: ImportedSession): string {
  const { branch } = imported;
  const lines: string[] = [];
  const say = (line = ""): void => void lines.push(line);

  say(`Imported ${branch.source}`);
  say(`  copy      ${imported.transcriptPath}`);
  say(`  manifest  ${imported.manifestPath}`);
  say(`  tip       ${branch.tipUuid} (${branch.tipChosen})`);
  say();

  const c = branch.counts;
  say(`Turns on the branch: ${branch.turns.length}`);
  say(`  typed by the user     ${c.typed}`);
  say(`  model, text only      ${c.modelTextOnly}`);
  say(`  model, called a tool  ${c.modelToolUse}`);
  say(`  tool results          ${c.toolResult}`);
  say(`  compaction summaries  ${c.compactSummary}`);
  say(`  injected meta         ${c.meta}`);
  say(`  sidechain             ${c.sidechain}`);
  say(`  synthetic, no usage   ${c.synthetic}`);
  say();

  say(`Compactions on the branch: ${branch.compactions.length}`);
  for (const compaction of branch.compactions) {
    const drop =
      compaction.drop === null
        ? "no usage drop lines up with it"
        : `usage ${tokens(compaction.drop.fromTokens)} → ${tokens(compaction.drop.toTokens)}`;
    say(
      `  after turn ${compaction.afterIndex}  trigger ${compaction.trigger ?? "unrecorded"}  ` +
        `recorded ${tokens(compaction.preTokens)} → ${tokens(compaction.postTokens)}  ${drop}`,
    );
  }
  if (branch.unexplainedDrops.length > 0) {
    say(`  unexplained usage drops: ${branch.unexplainedDrops.length} — a fall no compaction accounts for`);
    for (const drop of branch.unexplainedDrops) {
      say(`    turn ${drop.fromIndex} → ${drop.toIndex}  ${tokens(drop.fromTokens)} → ${tokens(drop.toTokens)}`);
    }
  }
  say();

  say(`Stretches: ${branch.stretches.length}`);
  for (const stretch of branch.stretches) say(`  ${describeStretch(stretch)}`);
  say();

  say(`Token trajectory over ${branch.trajectory.length} model turns, peak ${tokens(branch.peakContextTokens)}`);
  if (branch.trajectory.length > 0) {
    say(`  ${sparkline(branch.trajectory.map((point) => point.contextTokens))}`);
    say(`  ${tokens(branch.trajectory[0]?.contextTokens ?? null)} at the first turn, ` +
      `${tokens(branch.trajectory[branch.trajectory.length - 1]?.contextTokens ?? null)} at the last`);
  }
  say();

  const file = branch.file;
  say(`The file around the branch`);
  say(`  branches in the file  ${file.branches}`);
  say(`  entries off the path  ${file.entriesOffPath} of ${file.entries}`);
  say(`  session ids present   ${file.sessionIds.join(", ")}`);
  say(`  entries on the path   ${file.pathLength} (${describeTally(file.pathTypes)})`);
  say(`  rewritten in place    ${file.duplicateWrites}`);
  if (file.linkless.length > 0) say(`  passed over, no uuid  ${describeTally(file.linkless)}`);
  if (file.unreadableLines > 0) say(`  unreadable lines      ${file.unreadableLines}`);
  return lines.join("\n");
}

function describeStretch(stretch: Stretch): string {
  const opened = stretch.openedBy === null ? "from the start" : "after a compaction";
  const range =
    stretch.firstContextTokens === null
      ? "no model turn"
      : `${tokens(stretch.firstContextTokens)} → ${tokens(stretch.lastContextTokens)}, peak ${tokens(stretch.peakContextTokens)}`;
  return (
    `${stretch.index}: turns ${stretch.fromIndex}–${stretch.toIndex} ${opened}, ` +
    `${stretch.typedTurns} typed, ${stretch.modelTurns} model — ` +
    `${describeTally(stretch.models)} at ${describeTally(stretch.efforts)}; ${range}`
  );
}

/** `a 12, b 3`, commonest first, so a stretch recorded on more than one model says both. */
function describeTally(tally: readonly Tally[]): string {
  if (tally.length === 0) return "none";
  if (tally.length === 1) return tally[0]?.name as string;
  return tally.map((entry) => `${entry.name} ${entry.count}`).join(", ");
}

const BARS = "▁▂▃▄▅▆▇█";
const SPARK_WIDTH = 60;

/** The shape of the trajectory in one line: each column the peak of its slice of the turns. */
function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const peak = Math.max(...values, 1);
  const columns = Math.min(SPARK_WIDTH, values.length);
  const perColumn = values.length / columns;
  let out = "";
  for (let column = 0; column < columns; column += 1) {
    const slice = values.slice(Math.floor(column * perColumn), Math.max(Math.floor((column + 1) * perColumn), Math.floor(column * perColumn) + 1));
    const height = Math.max(...slice) / peak;
    out += BARS[Math.min(BARS.length - 1, Math.max(0, Math.ceil(height * BARS.length) - 1))];
  }
  return out;
}

function tokens(value: number | null): string {
  return value === null ? "unrecorded" : `${Math.round(value / 1000)}k`;
}
