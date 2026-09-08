// What a grader is allowed to do.
//
// A verdict about code is only worth counting if the grader checked it against the code, so it
// is given the repository the answer was written against: the case worktree at the nearest
// earlier commit for planning, the finished tail worktrees for implementation. Three tools —
// read a file, search, list a directory — and nothing else. There is no tool that writes,
// because a grader that can change the thing it is grading is grading something it made.
//
// Every path is resolved through symlinks and checked against the repository root before
// anything is opened. The worktrees are throwaway copies of real repositories, so a link out of
// one is ordinary rather than suspicious, and following it would quietly hand the grader a file
// from another arm.

import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isInside, resolveThroughSymlinks } from "./paths.js";

/** The whole of the grader's reach, in the order the tools are given to it. */
export const GRADER_TOOL_NAMES = ["read_file", "search", "list"] as const;

/**
 * A grader tool: an ordinary custom tool, plus the `run` and `parse` the tool runner calls.
 * `betaTool` types what it builds as any tool that runs on the client, memory and bash among
 * them; these are all plain custom tools, and saying so is what lets a caller read the schema
 * and see for itself that nothing here takes something to write.
 */
export type GraderTool = BetaTool & Pick<BetaRunnableTool, "run" | "parse">;

/** Longer than any file worth reading whole, short enough that one call cannot fill the window. */
const MAX_LINES = 2_000;
/** A search that matched this much has told the grader what it needed and then some. */
const MAX_MATCHES = 100;
/** Files above this are not searched: at this size they are data, not code someone wrote. */
const MAX_SEARCHABLE_BYTES = 1_000_000;
/** Directories that are never walked or listed: neither is code the answer was written against. */
const SKIPPED = new Set([".git", "node_modules"]);

/**
 * The three tools, reading `repoPath` and nothing outside it. `repoPath` is resolved once here,
 * so a repository that is itself reached through a symlink still contains its own files.
 */
export function graderTools(repoPath: string): GraderTool[] {
  const root = resolveThroughSymlinks(resolve(repoPath));

  const tools = [
    betaTool({
      name: "read_file",
      description:
        "Read a file from the repository. Answers with the file's lines, each numbered, so a " +
        "line can be quoted back. Paths are relative to the repository root.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the repository root." } },
        required: ["path"],
        additionalProperties: false,
      },
      run: ({ path }) => readWithin(root, path),
    }),
    betaTool({
      name: "search",
      description:
        "Search the repository for a JavaScript regular expression. Answers with one line per " +
        "match: the file's path, the line number and the line.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "A JavaScript regular expression." },
          path: {
            type: "string",
            description: "Search only under this directory. Defaults to the whole repository.",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      run: ({ pattern, path }) => searchWithin(root, pattern, path ?? "."),
    }),
    betaTool({
      name: "list",
      description:
        "List a directory in the repository. Answers with one entry per line, directories marked " +
        "with a trailing slash. Defaults to the repository root.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the repository root." } },
        additionalProperties: false,
      },
      run: ({ path }) => listWithin(root, path ?? "."),
    }),
  ];
  return tools as GraderTool[];
}

/**
 * `path` resolved under `root`, or the refusal to answer with. Anything the grader cannot have
 * comes back as text it can read rather than as a thrown error, because a tool that throws ends
 * the grader's turn on a stack trace instead of letting it ask for something else.
 */
function within(root: string, path: string): { resolved: string } | { refused: string } {
  const resolved = resolveThroughSymlinks(resolve(root, path));
  if (resolved !== root && !isInside(root, resolved)) {
    return { refused: `${path} is outside the repository being graded. Ask for a path inside it.` };
  }
  return { resolved };
}

function readWithin(root: string, path: string): string {
  const found = within(root, path);
  if ("refused" in found) return found.refused;

  let text: string;
  try {
    if (statSync(found.resolved).isDirectory()) return `${path} is a directory. Use list to see what is in it.`;
    text = readFileSync(found.resolved, "utf8");
  } catch {
    return `There is no file at ${path}.`;
  }

  const lines = text.split("\n");
  const shown = lines.slice(0, MAX_LINES).map((line, index) => `${index + 1}\t${line}`);
  if (lines.length > MAX_LINES) {
    shown.push(`… ${lines.length - MAX_LINES} more lines. Use search to find what you need in them.`);
  }
  return shown.join("\n");
}

function listWithin(root: string, path: string): string {
  const found = within(root, path);
  if ("refused" in found) return found.refused;

  let entries;
  try {
    entries = readdirSync(found.resolved, { withFileTypes: true });
  } catch {
    return `There is no directory at ${path}.`;
  }

  const named = entries
    .filter((entry) => !SKIPPED.has(entry.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
  return named.length === 0 ? `${path} is empty.` : named.join("\n");
}

function searchWithin(root: string, pattern: string, path: string): string {
  const found = within(root, path);
  if ("refused" in found) return found.refused;

  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch (err: unknown) {
    return `${pattern} is not a regular expression: ${err instanceof Error ? err.message : String(err)}`;
  }

  const matches: string[] = [];
  for (const file of filesUnder(found.resolved)) {
    let text: string;
    try {
      if (statSync(file).size > MAX_SEARCHABLE_BYTES) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // A file with a NUL byte in it is not something a line-and-number answer says anything
    // useful about, and its bytes would be spent out of the grader's window for nothing.
    if (text.includes("\u0000")) continue;

    const name = relative(root, file).split(sep).join("/");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!expression.test(lines[index] as string)) continue;
      matches.push(`${name}:${index + 1}:${lines[index]}`);
      if (matches.length >= MAX_MATCHES) {
        matches.push(`… stopped at ${MAX_MATCHES} matches. Narrow the pattern or give a path.`);
        return matches.join("\n");
      }
    }
  }
  return matches.length === 0 ? `No match for ${pattern}${path === "." ? "" : ` under ${path}`}.` : matches.join("\n");
}

/** Every file under `dir`, depth first, skipping what is not code the answer was written against. */
function* filesUnder(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED.has(entry.name)) continue;
    // Not `isDirectory`, which follows nothing: a symlink is left alone rather than followed,
    // so a link back up the tree cannot walk the same files forever or reach outside the root.
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}
