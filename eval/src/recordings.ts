// The recorded requests: what a real Claude Code session actually sent.
//
// This replaces rebuilding request bodies from a transcript, and it exists because the transcript
// does not hold what was sent. Claude Code writes injected content — attached files, task
// notifications, the reminders it wraps them in — as records of its own rather than as the text it
// renders them into, so a request put back together from a transcript is missing the very text
// three of the proxy's rules are keyed on. A session recorded through the proxy is missing nothing:
// the proxy writes every body it is handed to disk, untouched, before it changes anything.
//
// So a recording is a directory of raw bodies and this module is the record of what is in it.
// Nothing here parses a body or rebuilds anything; the bodies are opaque bytes that go back through
// a proxy exactly as they arrived.
//
// Order is the one property that has to survive. Eviction is monotonic — what the proxy does at
// request 400 depends on everything it took at requests 1 to 399 — so the sequence is replayed as
// it was recorded. The proxy names each dump for the moment it arrived, so the order is the name
// order, and it is read back that way rather than from the filesystem's own idea of order.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Corpus } from "./corpus.js";
import { EvalError, messageOf } from "./errors.js";
import { formatTokens } from "./format.js";
import { resolveThroughSymlinks } from "./paths.js";

/** The schema of the manifest written beside a recording, bumped when its shape changes. */
export const RECORDINGS_SCHEMA = "onepass-eval/recordings@1";

/** What the recording of the planning session is filed under, the way `planning` names its transcript. */
export const PLANNING_RECORDING = "planning";

/**
 * How many characters the proxy reads as one token before any real usage has taught it otherwise.
 * Used here only to put a recorded body's size in the same unit as the threshold it will be judged
 * against, so a reader can see at a glance whether a recording is deep enough to be worth having.
 * Replay reports the proxy's own calibrated estimate instead.
 */
const FALLBACK_CHARS_PER_TOKEN = 3.2;

/** A recorded body's size in the unit the threshold is written in. The one place that division lives. */
export function approximateTokens(bytes: number): number {
  return Math.round(bytes / FALLBACK_CHARS_PER_TOKEN);
}

/** One recorded request. The body is on disk; nothing here has read it. */
export interface Recording {
  /** Names it in the replay report and in the diff against the previous build. */
  id: string;
  /** The dump file, relative to the recording's directory. */
  file: string;
  /** The endpoint it was sent to: `/v1/messages` or `/v1/messages/count_tokens`. */
  path: string;
  /** When the proxy received it, read from the name the proxy gave the dump. */
  receivedAt: string;
  bytes: number;
}

export interface RecordingSet {
  name: string;
  /** The directory holding the bodies. */
  dir: string;
  manifestPath: string;
  /** Every recorded request, in the order the session sent them. */
  requests: Recording[];
}

export interface ImportRecordingsOptions {
  /** What the recording is filed under in the corpus. Defaults to `planning`. */
  name?: string | null;
}

/**
 * Files a directory of dumped bodies into the corpus under `name`, and writes down what is in it.
 *
 * The recording script points the proxy's dump directory straight at the corpus, so the usual case
 * copies nothing: the bodies are already where they belong and this only reads and records them. A
 * directory from anywhere else is copied in, because a run must not depend on a path outside the
 * corpus that anything could delete.
 */
export function importRecordings(corpus: Corpus, dumpDir: string, options: ImportRecordingsOptions = {}): RecordingSet {
  const name = recordingName(options.name ?? null);
  const source = resolveThroughSymlinks(resolve(dumpDir));
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new EvalError(`${dumpDir} is not a directory, so there are no recorded bodies to import.`);
  }

  const dir = join(corpus.recordings, name);
  if (source !== resolveThroughSymlinks(dir)) {
    if (existsSync(dir) && dumpFiles(dir).length > 0) {
      throw new EvalError(
        `${dir} already holds a recording filed under ${name}. Delete it, or import under another ` +
          `name, rather than mixing two sessions into one ordered sequence.`,
      );
    }
    mkdirSync(dir, { recursive: true });
    for (const file of dumpFiles(source)) copyFileSync(join(source, file), join(dir, file));
  }

  const requests = readDumps(dir);
  if (requests.length === 0) {
    throw new EvalError(
      `${dir} holds no dumped request bodies. The proxy writes them only when ONEPASS_DUMP_DIR is ` +
        `set, so a session recorded without it leaves nothing behind.`,
    );
  }

  const manifestPath = join(corpus.recordings, `${name}.import.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest(name, dir, source, requests), null, 2)}\n`, "utf8");
  return { name, dir, manifestPath, requests };
}

/** The recording filed under `name`, read back from the corpus. */
export function readRecordings(corpus: Corpus, name: string): RecordingSet {
  const dir = join(corpus.recordings, name);
  const manifestPath = join(corpus.recordings, `${name}.import.json`);
  if (!existsSync(manifestPath)) {
    throw new EvalError(
      `no recording filed under ${name} in ${corpus.recordings}. Record one first:\n` +
        `  eval/record.sh\n` +
        `then import what it captured:\n` +
        `  onepass-eval import-recordings <dump-dir> --name ${name}`,
    );
  }
  // The bodies are read from the directory rather than from the manifest's list: the manifest says
  // what was found at import, and the directory is what replay will actually send. If they have
  // drifted apart, the directory is the truth and the count in the report will say so.
  return { name, dir, manifestPath, requests: readDumps(dir) };
}

/** The bytes of one recorded body, exactly as the proxy received them. */
export function bodyOf(set: RecordingSet, recording: Recording): string {
  try {
    return readFileSync(join(set.dir, recording.file), "utf8");
  } catch (err: unknown) {
    throw new EvalError(`the recorded body ${recording.file} of ${set.name} is unreadable: ${messageOf(err)}`);
  }
}

/** The `/v1/messages` requests, which are the ones a model answered. */
export function conversationRequests(requests: readonly Recording[]): Recording[] {
  return requests.filter((request) => request.path === "/v1/messages");
}

/**
 * How many of the recorded requests a report covers.
 *
 * Replay sends every recorded request, because eviction is stateful and a subset would give the
 * proxy a history that never happened. It reports a subset, because a table of several hundred
 * near-identical rows is one nobody reads. The biggest are the ones worth reading: eviction only
 * does anything near the threshold, so the shallow requests all say the same thing.
 */
export const REPORTED_REQUESTS = 30;

/** The {@link REPORTED_REQUESTS} biggest requests, or as many as asked for, back in sequence order. */
export function deepest(requests: readonly Recording[], count: number): Recording[] {
  const chosen = new Set(
    [...requests]
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, count)
      .map((request) => request.id),
  );
  return requests.filter((request) => chosen.has(request.id));
}

/**
 * The dumps in a directory, in the order the proxy wrote them.
 *
 * The proxy names each one for the moment it arrived, so name order is arrival order. Sorting by
 * name rather than trusting `readdir` is what makes that true: the filesystem's order is its own
 * business, and a sequence read in the wrong order would hand the proxy a state history the session
 * never had.
 */
function readDumps(dir: string): Recording[] {
  return dumpFiles(dir).map((file, index) => ({
    id: `req-${String(index + 1).padStart(4, "0")}`,
    file,
    path: pathOf(file),
    receivedAt: receivedAtOf(file),
    bytes: statSync(join(dir, file)).size,
  }));
}

function dumpFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".json") && name.includes("_v1_messages")).sort();
}

/**
 * The endpoint a dump was sent to, read off its name. The proxy builds the name from the path with
 * every character that is not a letter or a digit replaced by an underscore, so there are exactly
 * two of them and this recognises both rather than guessing from the body.
 */
function pathOf(file: string): string {
  return file.endsWith("_v1_messages_count_tokens.json") ? "/v1/messages/count_tokens" : "/v1/messages";
}

/**
 * When the proxy received a dump, read off its name. The proxy writes an ISO timestamp with the
 * colons and the dot replaced by dashes, followed by the sequence it wrote the body in, so this
 * takes the timestamp and puts the punctuation back. A name that does not read as one is handed
 * back whole, because a name is a label here and never something a run depends on.
 */
function receivedAtOf(file: string): string {
  const stamp = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(file);
  if (stamp === null) return file;
  const [, date, hour, minute, second, millis] = stamp;
  return `${date}T${hour}:${minute}:${second}.${millis}Z`;
}

function recordingName(name: string | null): string {
  const chosen = (name ?? PLANNING_RECORDING).trim();
  if (chosen === "" || chosen.includes("/") || chosen.includes("\\") || chosen.startsWith(".")) {
    throw new EvalError(`${chosen || "an empty name"} is not a name a recording can be filed under.`);
  }
  return chosen;
}

function manifest(name: string, dir: string, source: string, requests: readonly Recording[]): unknown {
  const conversation = conversationRequests(requests);
  return {
    schema: RECORDINGS_SCHEMA,
    name,
    importedAt: new Date().toISOString(),
    source,
    dir,
    counts: {
      requests: requests.length,
      messages: conversation.length,
      countTokens: requests.length - conversation.length,
    },
    bytes: {
      total: requests.reduce((sum, request) => sum + request.bytes, 0),
      largest: Math.max(...requests.map((request) => request.bytes)),
      smallest: Math.min(...requests.map((request) => request.bytes)),
    },
    firstReceivedAt: requests[0]?.receivedAt ?? null,
    lastReceivedAt: requests[requests.length - 1]?.receivedAt ?? null,
    requests,
  };
}

/** What the import command prints: how much was recorded, how deep it got, and of what kind. */
export function renderRecordingsImport(set: RecordingSet): string {
  const lines: string[] = [];
  const say = (line = ""): void => void lines.push(line);
  const conversation = conversationRequests(set.requests);
  const bytes = set.requests.map((request) => request.bytes);

  say(`Imported the recording filed under ${set.name}`);
  say(`  bodies    ${set.dir}`);
  say(`  manifest  ${set.manifestPath}`);
  say();
  say(`Recorded requests: ${set.requests.length}`);
  say(`  a model answered      ${conversation.length}  (/v1/messages)`);
  say(`  counted only          ${set.requests.length - conversation.length}  (/v1/messages/count_tokens)`);
  say(`  first                 ${set.requests[0]?.receivedAt ?? "none"}`);
  say(`  last                  ${set.requests[set.requests.length - 1]?.receivedAt ?? "none"}`);
  say();
  say(`How deep they got`);
  say(`  biggest body          ${describeDepth(Math.max(...bytes))}`);
  say(`  smallest body         ${describeDepth(Math.min(...bytes))}`);
  say(`  all of them together  ${describeDepth(bytes.reduce((sum, size) => sum + size, 0))}`);
  say();
  say(`The ${REPORTED_REQUESTS} biggest, which are the ones replay reports on`);
  for (const request of deepest(set.requests, REPORTED_REQUESTS)) {
    say(`  ${request.id}  ${describeDepth(request.bytes).padEnd(22)}  ${request.path}  ${request.receivedAt}`);
  }
  return lines.join("\n");
}

/** A body's size in bytes and in roughly the tokens it stands for, which is what the threshold is in. */
function describeDepth(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes ≈ ${formatTokens(approximateTokens(bytes))}`;
}
