import { readFileSync, readdirSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CALL_LOG = join(homedir(), ".onepass", "recall-calls.log");
const MAX_RESULT_CHARS = 8000;

type Entry = {
  ref: number;
  kind: string;
  timestamp: string;
  toolName?: string;
  filePath?: string;
  body: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Claude Code stores each session under a slug of the cwd with separators replaced by dashes. */
function transcriptDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[/.]/g, "-"));
}

function newestTranscript(cwd: string): string | null {
  const dir = transcriptDir(cwd);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const path = join(dir, name);
    const { mtimeMs } = statSync(path);
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest?.path ?? null;
}

function blockToText(block: Record<string, unknown>): string {
  const type = block.type;
  if (type === "text" && typeof block.text === "string") return block.text;
  if (type === "thinking" && typeof block.thinking === "string") return block.thinking;
  if (type === "tool_use") return JSON.stringify(block.input ?? {});
  if (type === "tool_result") return typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
  return "";
}

function parseTranscript(path: string): Entry[] {
  const entries: Entry[] = [];
  // tool_use carries the name and file path; the matching tool_result only carries an id.
  const toolById = new Map<string, { name: string; filePath?: string }>();

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const message = parsed.message;
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;

    const kind = typeof parsed.type === "string" ? parsed.type : "unknown";
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : "";

    for (const block of content) {
      if (!isRecord(block)) continue;
      const body = blockToText(block);
      if (!body.trim()) continue;

      let toolName: string | undefined;
      let filePath: string | undefined;

      if (block.type === "tool_use") {
        toolName = typeof block.name === "string" ? block.name : undefined;
        const input = block.input;
        if (isRecord(input) && typeof input.file_path === "string") filePath = input.file_path;
        if (typeof block.id === "string") toolById.set(block.id, { name: toolName ?? "?", filePath });
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const origin = toolById.get(block.tool_use_id);
        toolName = origin?.name;
        filePath = origin?.filePath;
      }

      entries.push({
        ref: entries.length,
        kind: block.type === "tool_result" ? "tool_result" : `${kind}:${String(block.type)}`,
        timestamp,
        toolName,
        filePath,
        body,
      });
    }
  }
  return entries;
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n…[truncated ${text.length - MAX_RESULT_CHARS} chars — narrow your query for the rest]`;
}

function logCall(tool: string, args: unknown, outcome: string): void {
  const line = JSON.stringify({ at: new Date().toISOString(), tool, args, outcome });
  try {
    mkdirSync(dirname(CALL_LOG), { recursive: true });
    appendFileSync(CALL_LOG, `${line}\n`);
  } catch {
    // the log is spike instrumentation; never fail a recall because it could not be written
  }
  process.stderr.write(`[onepass-spike] ${line}\n`);
}

function loadEntries(): { entries: Entry[]; error?: string } {
  const path = newestTranscript(process.cwd());
  if (!path) return { entries: [], error: `No transcript found under ${transcriptDir(process.cwd())}` };
  return { entries: parseTranscript(path) };
}

const server = new McpServer({ name: "onepass-recall", version: "0.0.0" });

server.registerTool(
  "recall_search",
  {
    title: "Search the original conversation",
    description:
      "Search the ORIGINAL, unmodified session history on disk — including turns that were removed from your context by compaction or tool-result clearing. " +
      "Use this whenever you are about to state something about earlier work that you cannot actually see anymore: a file's contents, a command's output, a decision, or something that was tried and failed. " +
      "The query is split on whitespace and each term matched separately — an entry matching only some terms is still returned, ranked below entries matching more. " +
      "So throw several words at it rather than guessing one exact phrase. " +
      "Returns matching entries with a `ref` — pass that ref to recall_get for the full content. " +
      "Blocks marked `[onepass: evicted N chars]` were removed from your context by the Onepass proxy; the original is on disk and this tool finds it. " +
      "A tool call whose `input` is an empty object was evicted the same way — its arguments are gone. " +
      "To find one, search the path in the `call evicted, <path>` note on its result's stub, or the file names and error text around it. " +
      "For an attached file, search the path from the `Called the Read tool` line beside it. " +
      "For a task notification, search the task id. " +
      "When you need the current state rather than what it was, read the file or re-run the command instead.",
    inputSchema: {
      query: z.string().describe("Words to look for, e.g. a filename, error message, or function name. Multiple words are matched independently, not as a phrase."),
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum matches to return"),
    },
  },
  async ({ query, limit }) => {
    const { entries, error } = loadEntries();
    if (error) {
      logCall("recall_search", { query, limit }, "error");
      return { content: [{ type: "text", text: error }] };
    }
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
    if (!terms.length) {
      logCall("recall_search", { query, limit }, "empty query");
      return { content: [{ type: "text", text: "Empty query — pass at least one word." }] };
    }

    const scored = entries
      .map((entry) => {
        const haystack = `${entry.body}\n${entry.filePath ?? ""}`.toLowerCase();
        return { entry, hits: terms.filter((term) => haystack.includes(term)) };
      })
      .filter(({ hits }) => hits.length > 0)
      .sort((a, b) => b.hits.length - a.hits.length || b.entry.ref - a.entry.ref)
      .slice(0, limit);

    const matches = scored.map(({ entry, hits }) => {
      // Anchor the snippet on the longest matched term: short terms like "ok" match everywhere
      // and would centre the snippet on noise.
      const anchor = hits.reduce((longest, term) => (term.length > longest.length ? term : longest));
      const at = entry.body.toLowerCase().indexOf(anchor);
      const from = Math.max(0, at - 100);
      const snippet = entry.body.slice(from, from + 300).replace(/\s+/g, " ");
      const label = [entry.kind, entry.toolName, entry.filePath].filter(Boolean).join(" ");
      return `ref=${entry.ref}  ${label}  ${entry.timestamp}\n  matched ${hits.length}/${terms.length}: ${hits.join(", ")}\n  …${snippet}…`;
    });

    logCall("recall_search", { query, limit }, `${matches.length} matches of ${entries.length} entries`);
    return {
      content: [
        {
          type: "text",
          text: matches.length
            ? `${matches.length} match(es) in the original history, best first:\n\n${matches.join("\n\n")}`
            : `No entry contains any of: ${terms.join(", ")} (searched ${entries.length} original entries).`,
        },
      ],
    };
  },
);

server.registerTool(
  "recall_get",
  {
    title: "Fetch one original entry",
    description:
      "Fetch the full, original content of one entry by its `ref` (from recall_search). This is the unmodified text as it was at the time — not a summary.",
    inputSchema: { ref: z.number().int().min(0).describe("The ref returned by recall_search") },
  },
  async ({ ref }) => {
    const { entries, error } = loadEntries();
    if (error) {
      logCall("recall_get", { ref }, "error");
      return { content: [{ type: "text", text: error }] };
    }
    const entry = entries[ref];
    if (!entry) {
      logCall("recall_get", { ref }, "not found");
      return { content: [{ type: "text", text: `No entry at ref=${ref}. Valid range 0..${entries.length - 1}.` }] };
    }
    logCall("recall_get", { ref }, `${entry.kind} ${entry.body.length} chars`);
    const label = [entry.kind, entry.toolName, entry.filePath].filter(Boolean).join(" ");
    return { content: [{ type: "text", text: `ref=${ref}  ${label}  ${entry.timestamp}\n\n${truncate(entry.body)}` }] };
  },
);

await server.connect(new StdioServerTransport());
