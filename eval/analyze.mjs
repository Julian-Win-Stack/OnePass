// Scans a run's session transcript for the numbers the reporter does not carry: stub-shape
// imitations, tool-call mix, redundant reads, and recall usage.
//
// Usage: node analyze.mjs <transcript.jsonl>[=<label>] ...
//
// The imitation count here is the shape-specific one — a tool_use whose input carries an
// `evicted` key. It is only valid against builds that put that key in the stub; findings.md §18
// explains why a build that removes the key needs a shape-agnostic count instead. The
// InputValidationError tally below is the harness's own ground truth either way, so a scan that
// disagrees with it is measuring the wrong thing.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const IMITATION_SAMPLE = 12;
const TARGET_PREVIEW_CHARS = 80;

async function scan(path, label) {
  const tools = new Map();
  const errors = new Map();
  const reads = new Map();
  const imitations = [];
  let assistantTurns = 0;
  let recallCalls = 0;

  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "assistant") assistantTurns++;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block === null || typeof block !== "object") continue;

      if (block.type === "tool_use") {
        const name = block.name;
        tools.set(name, (tools.get(name) ?? 0) + 1);
        const input = block.input;
        if (input !== null && typeof input === "object" && !Array.isArray(input)) {
          if ("evicted" in input) {
            const target = String(input.file_path ?? input.command).slice(0, TARGET_PREVIEW_CHARS);
            imitations.push({ name, target });
          }
          if (name === "Read" && typeof input.file_path === "string") {
            reads.set(input.file_path, (reads.get(input.file_path) ?? 0) + 1);
          }
        }
        if (typeof name === "string" && name.includes("recall")) recallCalls++;
      }

      if (block.type === "tool_result" && block.is_error === true) {
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        const kind = text?.includes("InputValidationError") === true ? "InputValidationError" : "other";
        errors.set(kind, (errors.get(kind) ?? 0) + 1);
      }
    }
  }

  const readCounts = [...reads.values()];
  const repeatedFiles = readCounts.filter((count) => count > 1);
  const redundantReads = repeatedFiles.reduce((total, count) => total + count - 1, 0);

  console.log(`== ${label}`);
  console.log(`   assistant turns: ${assistantTurns}`);
  console.log(`   tool calls: ${JSON.stringify(Object.fromEntries(tools))}`);
  console.log(`   recall calls: ${recallCalls}`);
  console.log(`   stub-shape imitations (input carries 'evicted'): ${imitations.length}`);
  for (const { name, target } of imitations.slice(0, IMITATION_SAMPLE)) console.log(`        ${name}  ${target}`);
  console.log(`   error tool_results: ${JSON.stringify(Object.fromEntries(errors))}`);
  console.log(`   files read >1x: ${repeatedFiles.length} of ${reads.size}; redundant reads: ${redundantReads}`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node analyze.mjs <transcript.jsonl>[=<label>] ...");
  process.exit(1);
}
for (const arg of args) {
  const [path, label] = arg.includes("=") ? arg.split("=", 2) : [arg, arg];
  await scan(path, label);
}
