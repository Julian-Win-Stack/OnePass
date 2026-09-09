// Transcript fixtures for the tests.
//
// A real transcript is megabytes of one person's session, so the reader is tested against small
// files built here. What a fixture has to be able to say is exactly what makes transcripts hard:
// an abandoned branch left in the file with nothing marking it, an entry rewritten in place under
// the same uuid, a spine running through entries that are not conversation, a compaction written
// as a root of its own, and entry types from a Claude Code version that did not exist yet.

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript, type Branch } from "./transcript.js";

export type Line = Record<string, unknown>;

const VERSION = "2.1.222";

interface Common {
  sessionId?: string;
  timestamp?: string;
  version?: string;
}

function common(options: Common): Line {
  return {
    isSidechain: false,
    userType: "external",
    cwd: "/tmp/project",
    sessionId: options.sessionId ?? "session-1",
    timestamp: options.timestamp ?? "2026-08-11T00:00:00.000Z",
    version: options.version ?? VERSION,
    gitBranch: "main",
  };
}

/** A turn the user typed. */
export function typed(uuid: string, parentUuid: string | null, text: string, extra: Line & Common = {}): Line {
  return {
    ...common(extra),
    type: "user",
    uuid,
    parentUuid,
    message: { role: "user", content: text },
    ...extra,
  };
}

export interface ToolResultOptions extends Common {
  /** How big the result is. A case only trips the proxy when its prefix is large. */
  chars?: number;
  /** The call this answers. Set it to pair a result with a `model` entry's `toolUseId`. */
  toolUseId?: string;
}

/** A `user` entry carrying tool results back to the model. */
export function toolResult(uuid: string, parentUuid: string | null, extra: Line & ToolResultOptions = {}): Line {
  const { chars, toolUseId, ...rest } = extra;
  return {
    ...common(extra),
    type: "user",
    uuid,
    parentUuid,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId ?? `tool-${uuid}`,
          content: chars === undefined ? "ok" : "x".repeat(chars),
        },
      ],
    },
    ...rest,
  };
}

export interface ModelOptions extends Common {
  /** What the turn reported it was shown: input plus cache read plus cache creation. */
  contextTokens?: number;
  model?: string;
  effort?: string;
  /** True when the turn answered in text and called no tool. */
  textOnly?: boolean;
  /** True when the turn belongs to a subagent's conversation rather than the user's. */
  isSidechain?: boolean;
  /** The id of the `tool_use` block, for pairing it with the `toolResult` that answers it. */
  toolUseId?: string;
}

export function model(uuid: string, parentUuid: string | null, options: ModelOptions = {}): Line {
  const context = options.contextTokens ?? 1_000;
  const content = options.textOnly === false
    ? [{ type: "tool_use", id: options.toolUseId ?? `tool-${uuid}`, name: "Read", input: { file_path: "/tmp/a" } }]
    : [{ type: "text", text: "answer" }];
  return {
    ...common(options),
    isSidechain: options.isSidechain ?? false,
    type: "assistant",
    uuid,
    parentUuid,
    effort: options.effort ?? "xhigh",
    requestId: `req-${uuid}`,
    message: {
      role: "assistant",
      model: options.model ?? "claude-fable-5",
      content,
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: Math.max(context - 2, 0),
        cache_creation_input_tokens: 0,
        output_tokens: 100,
      },
    },
  };
}

/** An interrupt or an error notice: no real usage, and it must never enter the trajectory. */
export function synthetic(uuid: string, parentUuid: string | null, extra: Common = {}): Line {
  return {
    ...common(extra),
    type: "assistant",
    uuid,
    parentUuid,
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: "No response requested." }],
      usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
    },
  };
}

/** A `system` entry on the spine — a hook summary, say. Not conversation, but it links the chain. */
export function systemEntry(uuid: string, parentUuid: string | null, subtype = "stop_hook_summary", extra: Common = {}): Line {
  return { ...common(extra), type: "system", uuid, parentUuid, subtype, level: "info" };
}

/** An `attachment` entry on the spine. Not conversation, but it links the chain. */
export function attachment(uuid: string, parentUuid: string | null, extra: Common = {}): Line {
  return { ...common(extra), type: "attachment", uuid, parentUuid, attachment: { type: "file", path: "/tmp/a" } };
}

export interface CompactionOptions extends Common {
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
}

/**
 * A compaction boundary: a root of its own, with a null parent, tied back to the spine only by the
 * `logicalParentUuid` naming the last entry it preserved.
 */
export function compactBoundary(uuid: string, logicalParentUuid: string, options: CompactionOptions = {}): Line {
  return {
    ...common(options),
    type: "system",
    uuid,
    parentUuid: null,
    logicalParentUuid,
    subtype: "compact_boundary",
    isMeta: true,
    content: "Conversation compacted",
    level: "info",
    compactMetadata: {
      trigger: options.trigger ?? "manual",
      preTokens: options.preTokens ?? 170_000,
      postTokens: options.postTokens ?? 8_000,
    },
  };
}

/** The summary a compaction wrote, hanging off the boundary rather than off the spine. */
export function compactSummary(uuid: string, parentUuid: string, extra: Common = {}): Line {
  return {
    ...common(extra),
    type: "user",
    uuid,
    parentUuid,
    isCompactSummary: true,
    message: { role: "user", content: "This session is being continued from a previous conversation..." },
  };
}

/** Session metadata with no uuid, so it cannot link the chain and is passed over. */
export function linkless(type: string, extra: Line = {}): Line {
  return { type, sessionId: "session-1", ...extra };
}

/** Writes the lines as JSONL and returns the path. */
export function writeTranscript(dir: string, name: string, lines: readonly Line[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
}

/**
 * The branch these lines hold, read the way a run reads one: written to a real file and walked
 * back from `tip`. The reader takes a path and nothing else, so a fixture that skipped the file
 * would be testing a function that does not exist.
 */
export function branchOf(lines: readonly Line[], tip: string): Branch {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "onepass-fixture-")));
  return readTranscript(writeTranscript(dir, "session.jsonl", lines), { tip });
}
