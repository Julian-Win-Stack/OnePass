// Reading a session transcript.
//
// A transcript file is a tree, not a list, and a session is one branch of it. Three things have
// to be resolved before anything can be counted, and the order they are resolved in is the whole
// design of this module:
//
//  1. **Duplicates.** Entries are rewritten in place, so the same uuid recurs and the last copy
//     written is the authoritative one. The corpus file carries 294 rewrites over 1,879 entries.
//  2. **The walk.** Every entry records its parent. A rewind leaves the abandoned path in the
//     file with nothing marking it as abandoned, and a resumed session copies its ancestor in,
//     so one file holds entries from more than one session id and from conversations that never
//     coexisted. A session is the path from one tip back to a root, and nothing else.
//  3. **The filter.** Only after the walk are conversation entries picked out. Filtering first
//     snaps the chain, because the spine runs through `system` and `attachment` entries that are
//     not conversation: the corpus branch is 918 entries, of which 106 are neither `user` nor
//     `assistant`. Read flat the same file looks like 95 typed turns; walked, the chosen branch
//     is 57.
//
// Compaction needs the same care. Each compaction writes a *new root* — a `system` entry with a
// null parent, with the summary hanging off it — while the conversation spine's parent links run
// straight through the compaction unbroken. So a compaction is usually not an entry on the branch
// being walked, and looking for a compaction summary in the chain finds nothing. What ties the
// boundary back to the spine is its `logicalParentUuid`, which names the last entry it preserved.
// On the spine itself a compaction shows only as a fall in reported usage, and the two are matched
// here: a fall with no boundary straddling it is reported as unexplained rather than assumed to be
// a compaction.
//
// The source file is only ever read. Nothing in this module opens a transcript for writing.

import { readFileSync } from "node:fs";
import { EvalError, messageOf } from "./errors.js";

/** The model an `assistant` entry carries when it is an interrupt or an error notice, not a real API turn. */
export const SYNTHETIC_MODEL = "<synthetic>";

/** What one model turn reported it was shown and produced. */
export interface Usage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** Input plus cache read plus cache creation: how deep the conversation was at that turn. */
  contextTokens: number;
}

/**
 * What a turn is. The four the eval reads are `typed`, `model`, `tool-result` and the usage on a
 * model turn; the rest exist so that a turn which merely looks typed can never be counted as one.
 */
export type TurnKind =
  /** A turn the user typed: not sidechain, not meta, not a compaction summary, no tool result. */
  | "typed"
  /** A `user` entry carrying tool results back to the model. */
  | "tool-result"
  /** A `user` entry the system injected, marked `isMeta`. */
  | "meta"
  /** The summary a compaction wrote in place of what it dropped. */
  | "compact-summary"
  /** A `user` entry belonging to a subagent's conversation, not the user's. */
  | "sidechain"
  /** An `assistant` entry. */
  | "model";

interface TurnBase {
  uuid: string;
  parentUuid: string | null;
  /** Position among this branch's conversation turns, root first. */
  index: number;
  /** Position among every entry on the walked path, including the ones the filter dropped. */
  pathIndex: number;
  timestamp: string | null;
  sessionId: string | null;
  /** The Claude Code version that wrote the entry. */
  version: string | null;
  /**
   * True when the entry belongs to a subagent's conversation rather than the user's. It is read on
   * every kind of turn, not only the `user` entries the typed-turn rule names, because a subagent's
   * model turn reports its own much smaller context and would otherwise enter the trajectory and
   * manufacture a fall that looks like a compaction.
   */
  sidechain: boolean;
  /**
   * The entry's `message.content`, exactly as the transcript stored it. Kept because a case's
   * request body is rebuilt out of these blocks, and a rebuild from anything but the stored
   * bytes would be a request the session never sent.
   */
  content: unknown;
}

export interface UserTurn extends TurnBase {
  kind: Exclude<TurnKind, "model">;
  /** The text blocks of the entry, joined. Empty for a turn that carries only tool results. */
  text: string;
}

export interface ModelTurn extends TurnBase {
  kind: "model";
  model: string | null;
  effort: string | null;
  /** True for an interrupt or error notice, which holds no real usage and is kept out of the trajectory. */
  synthetic: boolean;
  /** True when the turn answered in text and called no tool. */
  textOnly: boolean;
  /** Null on a synthetic turn, which reported nothing worth having. */
  usage: Usage | null;
}

export type Turn = UserTurn | ModelTurn;

/** One point of the token trajectory: how deep the conversation was at one real model turn. */
export interface TrajectoryPoint {
  index: number;
  uuid: string;
  contextTokens: number;
  timestamp: string | null;
}

/** A fall in reported context between two consecutive model turns. */
export interface UsageDrop {
  fromIndex: number;
  fromUuid: string;
  fromTokens: number;
  toIndex: number;
  toUuid: string;
  toTokens: number;
}

export interface Compaction {
  uuid: string;
  /** `manual` when the user typed `/compact`, `auto` when the window forced it. */
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  timestamp: string | null;
  /** The last entry the compaction preserved, which is what ties it back to the spine. */
  logicalParentUuid: string | null;
  /** The turn the boundary sits after, or -1 when it precedes every turn on the branch. */
  afterIndex: number;
  /** The fall in reported usage this boundary explains, or null when none straddles it. */
  drop: UsageDrop | null;
  /**
   * The summary the compaction wrote, which hangs off the boundary and so is never on the branch
   * itself. It is what the conversation after the boundary actually opened with, so rebuilding a
   * request from that point has to start here. Null when the file holds no summary for it.
   */
  summary: CompactionSummary | null;
}

/** The compaction summary, read off the boundary's own root rather than out of the branch. */
export interface CompactionSummary {
  uuid: string;
  /** The `message.content` of the summary entry, as stored. */
  content: unknown;
  /** How big the summary is, so a manifest can say so without carrying the whole of it. */
  chars: number;
}

/** A run of turns between two compactions, or between a compaction and an end of the branch. */
export interface Stretch {
  index: number;
  fromIndex: number;
  toIndex: number;
  /** The compaction that opened the stretch, or null for the branch's first. */
  openedBy: string | null;
  turns: number;
  typedTurns: number;
  modelTurns: number;
  /** What the stretch was recorded on, commonest first. A stretch may carry more than one of each. */
  models: Tally[];
  efforts: Tally[];
  firstContextTokens: number | null;
  peakContextTokens: number | null;
  lastContextTokens: number | null;
}

export interface Tally {
  name: string;
  count: number;
}

export interface TurnCounts {
  typed: number;
  toolResult: number;
  meta: number;
  compactSummary: number;
  sidechain: number;
  /** Real model turns. Synthetic entries are counted on their own and are not in here. */
  model: number;
  modelTextOnly: number;
  modelToolUse: number;
  synthetic: number;
}

/** What the file held, as against what the chosen branch held. */
export interface FileShape {
  lines: number;
  /** Lines that were not JSON. Passed over, never a parse failure. */
  unreadableLines: number;
  /** Distinct uuids, after rewrites are resolved. */
  entries: number;
  /** Entries rewritten in place, where an earlier copy was replaced by a later one. */
  duplicateWrites: number;
  /** Entry types that carry no uuid and so cannot link the chain, passed over. */
  linkless: Tally[];
  /** Entries with a null parent: the original root, plus one per compaction. */
  roots: number;
  /** Branch tips — entries nothing else claims as a parent. One per abandoned rewind, plus the live one. */
  branches: number;
  sessionIds: string[];
  /** Every entry on the walked path, whatever its type. */
  pathLength: number;
  pathTypes: Tally[];
  /** Entries in the file that the chosen branch does not pass through. */
  entriesOffPath: number;
}

/** One branch of one transcript: the turn model the rest of the eval reads. */
export interface Branch {
  /** The file this was read from. Never opened for writing. */
  source: string;
  tipUuid: string;
  /** Whether the tip was named on the command line or defaulted to the last entry written. */
  tipChosen: "named" | "default";
  sessionIds: string[];
  turns: Turn[];
  counts: TurnCounts;
  trajectory: TrajectoryPoint[];
  peakContextTokens: number | null;
  compactions: Compaction[];
  /** Falls in reported usage that no compaction boundary explains. Reported, never assumed. */
  unexplainedDrops: UsageDrop[];
  stretches: Stretch[];
  file: FileShape;
}

/** A turn the user typed, narrowed so callers stop re-testing what they have already filtered. */
export function isTypedTurn(turn: Turn): turn is UserTurn {
  return turn.kind === "typed";
}

/**
 * A model turn of this branch that was a real API turn: not a subagent's, and not an interrupt or
 * error notice Claude Code wrote for itself. Everything that reads the token trajectory or asks
 * what answered a turn wants this one, so it is written once.
 */
export function isRealModelTurn(turn: Turn): turn is ModelTurn {
  return turn.kind === "model" && !turn.sidechain && !turn.synthetic;
}

export interface ReadOptions {
  /** The branch tip to walk back from. Defaults to the last entry written. */
  tip?: string | null;
}

/** A transcript entry, as far as this module commits to its shape. Everything else is passed over. */
interface Entry {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  logicalParentUuid?: unknown;
  subtype?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  version?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  effort?: unknown;
  compactMetadata?: unknown;
  message?: unknown;
}

/**
 * Reads one branch of a transcript. Throws `EvalError` when the file cannot be read or the named
 * tip is not in it; an entry type it does not recognise is passed over, never a failure, because
 * entry types vary by Claude Code version and the reader takes transcripts from more than one.
 */
export function readTranscript(path: string, options: ReadOptions = {}): Branch {
  const text = readSource(path);
  const lines = text.split("\n").filter((line) => line.trim() !== "");

  // 1. Duplicates. Last copy of a uuid wins, and the order entries were written in is kept so the
  //    default tip can be the last one.
  const byUuid = new Map<string, Entry>();
  const linkless = new Map<string, number>();
  let unreadableLines = 0;
  let duplicateWrites = 0;
  let lastWritten: string | null = null;
  for (const line of lines) {
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      unreadableLines += 1;
      continue;
    }
    if (entry === null || typeof entry !== "object") {
      unreadableLines += 1;
      continue;
    }
    const uuid = stringOr(entry.uuid, null);
    if (uuid === null) {
      // `custom-title`, `mode`, `bridge-session`, `atis-latch` and the like: session metadata with
      // no place in the tree. Counted so an import says what it passed over, then ignored.
      const type = stringOr(entry.type, "<untyped>");
      linkless.set(type, (linkless.get(type) ?? 0) + 1);
      continue;
    }
    if (byUuid.has(uuid)) duplicateWrites += 1;
    byUuid.set(uuid, entry);
    lastWritten = uuid;
  }

  if (byUuid.size === 0) {
    throw new EvalError(`${path} holds no entries that link a conversation. Is it a session transcript?`);
  }

  const tipChosen = options.tip ? "named" : "default";
  const tipUuid = options.tip ?? (lastWritten as string);
  if (!byUuid.has(tipUuid)) {
    throw new EvalError(
      `no entry ${tipUuid} in ${path}. The tip names the last entry of the branch to import; ` +
        `leave it off to walk back from the last entry written.`,
    );
  }

  // 2. The walk. Every entry type links, whatever it is, because the spine runs through entries
  //    that are not conversation and dropping them here would snap the chain.
  const walked = walk(byUuid, tipUuid);

  // 3. The filter, and only now.
  const turns = buildTurns(walked);
  const trajectory = buildTrajectory(turns);
  const drops = findDrops(trajectory);
  const { compactions, unexplained } = locateCompactions(byUuid, walked, turns, drops);
  const stretches = buildStretches(turns, compactions);

  return {
    source: path,
    tipUuid,
    tipChosen,
    sessionIds: distinct(walked.map((entry) => stringOr(entry.sessionId, null))),
    turns,
    counts: countTurns(turns),
    trajectory,
    peakContextTokens: trajectory.length === 0 ? null : Math.max(...trajectory.map((point) => point.contextTokens)),
    compactions,
    unexplainedDrops: unexplained,
    stretches,
    file: {
      lines: lines.length,
      unreadableLines,
      entries: byUuid.size,
      duplicateWrites,
      linkless: tally(linkless),
      roots: [...byUuid.values()].filter((entry) => stringOr(entry.parentUuid, null) === null).length,
      branches: countBranches(byUuid),
      sessionIds: distinct([...byUuid.values()].map((entry) => stringOr(entry.sessionId, null))),
      pathLength: walked.length,
      pathTypes: tally(countBy(walked.map((entry) => stringOr(entry.type, "<untyped>")))),
      entriesOffPath: byUuid.size - walked.length,
    },
  };
}

function readSource(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err: unknown) {
    throw new EvalError(`cannot read the transcript at ${path}: ${messageOf(err)}`);
  }
}

/**
 * The path from `tip` back to a root, root first. A parent that is not in the file ends the walk —
 * a transcript can be truncated — and a cycle ends it too rather than hanging.
 */
function walk(byUuid: Map<string, Entry>, tip: string): Entry[] {
  const path: Entry[] = [];
  const seen = new Set<string>();
  let current = byUuid.get(tip);
  while (current !== undefined) {
    const uuid = stringOr(current.uuid, null);
    if (uuid === null || seen.has(uuid)) break;
    seen.add(uuid);
    path.push(current);
    const parent = stringOr(current.parentUuid, null);
    if (parent === null) break;
    current = byUuid.get(parent);
  }
  return path.reverse();
}

/** Entries nothing else claims as a parent. One per abandoned rewind, plus the live tip. */
function countBranches(byUuid: Map<string, Entry>): number {
  const claimed = new Set<string>();
  for (const entry of byUuid.values()) {
    const parent = stringOr(entry.parentUuid, null);
    if (parent !== null) claimed.add(parent);
  }
  let tips = 0;
  for (const uuid of byUuid.keys()) if (!claimed.has(uuid)) tips += 1;
  return tips;
}

/** Picks the conversation entries out of the walked path and classifies each one. */
function buildTurns(path: Entry[]): Turn[] {
  const turns: Turn[] = [];
  path.forEach((entry, pathIndex) => {
    const type = stringOr(entry.type, null);
    if (type !== "user" && type !== "assistant") return;
    const base = {
      uuid: stringOr(entry.uuid, ""),
      parentUuid: stringOr(entry.parentUuid, null),
      index: turns.length,
      pathIndex,
      timestamp: stringOr(entry.timestamp, null),
      sessionId: stringOr(entry.sessionId, null),
      version: stringOr(entry.version, null),
      sidechain: entry.isSidechain === true,
      content: messageContent(entry),
    };
    turns.push(type === "user" ? readUserTurn(entry, base) : readModelTurn(entry, base));
  });
  return turns;
}

/**
 * The counting rule, in the order the spec states it: a typed turn is a `user` entry that is not
 * sidechain, not `isMeta`, not a compaction summary, and carries no `tool_result` block. Everything
 * excluded keeps a kind of its own, so a compaction summary or an injected meta entry is
 * distinguishable from a typed turn and can never be counted as one.
 */
function readUserTurn(entry: Entry, base: TurnBase): UserTurn {
  const content = messageContent(entry);
  const kind: UserTurn["kind"] = base.sidechain
    ? "sidechain"
    : entry.isMeta === true
      ? "meta"
      : entry.isCompactSummary === true
        ? "compact-summary"
        : hasBlock(content, "tool_result")
          ? "tool-result"
          : "typed";
  return { ...base, kind, text: textOf(content) };
}

function readModelTurn(entry: Entry, base: TurnBase): ModelTurn {
  const message = asRecord(entry.message);
  const model = stringOr(message?.model, null);
  const synthetic = model === SYNTHETIC_MODEL;
  const content = messageContent(entry);
  return {
    ...base,
    kind: "model",
    model,
    effort: stringOr(entry.effort, null),
    synthetic,
    textOnly: !hasBlock(content, "tool_use"),
    // A synthetic entry reports zeroes for everything: it is an interrupt or an error notice, not
    // an API turn, and letting its zeroes into the trajectory would read as the context collapsing.
    usage: synthetic ? null : readUsage(message?.usage),
  };
}

function readUsage(value: unknown): Usage | null {
  const usage = asRecord(value);
  if (usage === null) return null;
  const inputTokens = numberOr(usage.input_tokens, 0);
  const cacheReadTokens = numberOr(usage.cache_read_input_tokens, 0);
  const cacheCreationTokens = numberOr(usage.cache_creation_input_tokens, 0);
  return {
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens: numberOr(usage.output_tokens, 0),
    contextTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
  };
}

function buildTrajectory(turns: Turn[]): TrajectoryPoint[] {
  const points: TrajectoryPoint[] = [];
  for (const turn of turns) {
    if (turn.kind !== "model" || turn.sidechain || turn.synthetic || turn.usage === null) continue;
    points.push({
      index: turn.index,
      uuid: turn.uuid,
      contextTokens: turn.usage.contextTokens,
      timestamp: turn.timestamp,
    });
  }
  return points;
}

/**
 * Every fall in reported context between consecutive real model turns — every one, with no floor
 * under it. A floor would be a size below which a fall is neither matched to a compaction nor
 * reported as unmatched, and a fall nobody is told about is the one thing this must not produce.
 * Measured on the corpus branch, context never falls at all except at the two compactions, so
 * there is nothing for a floor to suppress but a real surprise.
 */
function findDrops(trajectory: TrajectoryPoint[]): UsageDrop[] {
  const drops: UsageDrop[] = [];
  for (let i = 1; i < trajectory.length; i += 1) {
    const from = trajectory[i - 1] as TrajectoryPoint;
    const to = trajectory[i] as TrajectoryPoint;
    if (to.contextTokens >= from.contextTokens) continue;
    drops.push({
      fromIndex: from.index,
      fromUuid: from.uuid,
      fromTokens: from.contextTokens,
      toIndex: to.index,
      toUuid: to.uuid,
      toTokens: to.contextTokens,
    });
  }
  return drops;
}

/**
 * Finds the compactions this branch passed through, and matches each to the fall in usage it
 * caused.
 *
 * A compaction is a `system` entry with subtype `compact_boundary` and a null parent — a root of
 * its own, off the branch — so it is found by scanning the whole file rather than the walked chain,
 * and never by looking for a compaction summary. Its `logicalParentUuid` names the last entry it
 * preserved, and that entry *is* on the spine; that is the only link between the two.
 *
 * A fall with no boundary straddling it is returned unexplained rather than called a compaction.
 * A boundary with no fall keeps `drop: null`. Neither is an error: depth is read from recorded
 * usage, which is absolute, so a boundary in the wrong place mislabels a report line and nothing
 * more.
 */
function locateCompactions(
  byUuid: Map<string, Entry>,
  path: Entry[],
  turns: Turn[],
  drops: UsageDrop[],
): { compactions: Compaction[]; unexplained: UsageDrop[] } {
  const pathPosition = new Map<string, number>();
  path.forEach((entry, index) => {
    const uuid = stringOr(entry.uuid, null);
    if (uuid !== null) pathPosition.set(uuid, index);
  });

  const compactions: Compaction[] = [];
  for (const entry of byUuid.values()) {
    if (stringOr(entry.type, null) !== "system" || stringOr(entry.subtype, null) !== "compact_boundary") continue;
    const logicalParentUuid = stringOr(entry.logicalParentUuid, null);
    if (logicalParentUuid === null) continue;
    const position = pathPosition.get(logicalParentUuid);
    if (position === undefined) continue; // A compaction on some other branch of the same file.
    const metadata = asRecord(entry.compactMetadata);
    compactions.push({
      uuid: stringOr(entry.uuid, ""),
      trigger: stringOr(metadata?.trigger, null),
      preTokens: numberOrNull(metadata?.preTokens),
      postTokens: numberOrNull(metadata?.postTokens),
      timestamp: stringOr(entry.timestamp, null),
      logicalParentUuid,
      afterIndex: lastTurnAtOrBefore(turns, position),
      drop: null,
      summary: summaryOf(byUuid, stringOr(entry.uuid, "")),
    });
  }
  compactions.sort((a, b) => a.afterIndex - b.afterIndex);

  const claimed = new Set<UsageDrop>();
  for (const compaction of compactions) {
    // The fall the boundary explains is the one whose two model turns it sits between: the last
    // turn it preserved on one side, the first turn after the compaction on the other.
    const drop = drops.find(
      (candidate) =>
        !claimed.has(candidate) && candidate.fromIndex <= compaction.afterIndex && compaction.afterIndex < candidate.toIndex,
    );
    if (drop !== undefined) {
      compaction.drop = drop;
      claimed.add(drop);
    }
  }
  return { compactions, unexplained: drops.filter((drop) => !claimed.has(drop)) };
}

/**
 * The compaction summary hanging off a boundary. It is a `user` entry whose parent is the boundary
 * and which says so with `isCompactSummary`, and it is found by scanning the file rather than the
 * branch, because the branch runs past the boundary and never through the summary.
 */
function summaryOf(byUuid: Map<string, Entry>, boundaryUuid: string): CompactionSummary | null {
  for (const entry of byUuid.values()) {
    if (stringOr(entry.parentUuid, null) !== boundaryUuid || entry.isCompactSummary !== true) continue;
    const content = messageContent(entry);
    return { uuid: stringOr(entry.uuid, ""), content, chars: measureChars(content) };
  }
  return null;
}

function measureChars(content: unknown): number {
  try {
    return JSON.stringify(content)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** The last conversation turn at or before a position on the walked path, or -1 if there is none. */
function lastTurnAtOrBefore(turns: Turn[], pathIndex: number): number {
  let found = -1;
  for (const turn of turns) {
    if (turn.pathIndex > pathIndex) break;
    found = turn.index;
  }
  return found;
}

/** The runs of turns between compactions, each with what it was recorded on. */
function buildStretches(turns: Turn[], compactions: Compaction[]): Stretch[] {
  if (turns.length === 0) return [];
  const cuts = compactions.map((compaction) => compaction.afterIndex).filter((index) => index >= 0 && index < turns.length - 1);
  const stretches: Stretch[] = [];
  let from = 0;
  // A boundary at -1 precedes every turn, which is what a branch forked from just after a
  // compaction looks like: it cuts nothing, but it is what opened the first stretch, and saying
  // "from the start" of history that opens with a compaction summary would be a lie.
  let openedBy: string | null = compactions.find((compaction) => compaction.afterIndex === -1)?.uuid ?? null;
  for (const cut of [...cuts, turns.length - 1]) {
    if (from <= cut) stretches.push(buildStretch(turns, stretches.length, from, cut, openedBy));
    const compaction = compactions.find((candidate) => candidate.afterIndex === cut);
    openedBy = compaction?.uuid ?? null;
    from = cut + 1;
  }
  return stretches;
}

function buildStretch(turns: Turn[], index: number, from: number, to: number, openedBy: string | null): Stretch {
  const slice = turns.slice(from, to + 1);
  const models = new Map<string, number>();
  const efforts = new Map<string, number>();
  const contexts: number[] = [];
  let typedTurns = 0;
  let modelTurns = 0;
  for (const turn of slice) {
    if (turn.kind === "typed") typedTurns += 1;
    if (turn.kind !== "model" || turn.sidechain || turn.synthetic) continue;
    modelTurns += 1;
    models.set(turn.model ?? "<unrecorded>", (models.get(turn.model ?? "<unrecorded>") ?? 0) + 1);
    efforts.set(turn.effort ?? "<unrecorded>", (efforts.get(turn.effort ?? "<unrecorded>") ?? 0) + 1);
    if (turn.usage !== null) contexts.push(turn.usage.contextTokens);
  }
  return {
    index,
    fromIndex: from,
    toIndex: to,
    openedBy,
    turns: slice.length,
    typedTurns,
    modelTurns,
    models: tally(models),
    efforts: tally(efforts),
    firstContextTokens: contexts[0] ?? null,
    peakContextTokens: contexts.length === 0 ? null : Math.max(...contexts),
    lastContextTokens: contexts[contexts.length - 1] ?? null,
  };
}

function countTurns(turns: Turn[]): TurnCounts {
  const counts: TurnCounts = {
    typed: 0,
    toolResult: 0,
    meta: 0,
    compactSummary: 0,
    sidechain: 0,
    model: 0,
    modelTextOnly: 0,
    modelToolUse: 0,
    synthetic: 0,
  };
  for (const turn of turns) {
    // A subagent's turn is counted as one whatever its entry type, so the branch's own model turns
    // and the trajectory over them mean the same thing.
    if (turn.sidechain) counts.sidechain += 1;
    else if (turn.kind === "model") {
      if (turn.synthetic) counts.synthetic += 1;
      else {
        counts.model += 1;
        if (turn.textOnly) counts.modelTextOnly += 1;
        else counts.modelToolUse += 1;
      }
    } else if (turn.kind === "typed") counts.typed += 1;
    else if (turn.kind === "tool-result") counts.toolResult += 1;
    else if (turn.kind === "meta") counts.meta += 1;
    else counts.compactSummary += 1;
  }
  return counts;
}

function messageContent(entry: Entry): unknown {
  return asRecord(entry.message)?.content;
}

function hasBlock(content: unknown, type: string): boolean {
  return Array.isArray(content) && content.some((block) => asRecord(block)?.type === type);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" ? stringOr(record.text, "") : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringOr<T extends string | null>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function tally(counts: Map<string, number>): Tally[] {
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function distinct(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}
