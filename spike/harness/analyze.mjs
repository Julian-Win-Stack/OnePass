import { readFileSync } from "node:fs";

const H = process.env.ONEPASS_HARNESS_DIR ?? "/tmp/onepass-harness";
const arm = process.argv[2];
const needle = readFileSync(`${H}/arm-${arm}.needle`, "utf8").trim();
const transcript = readFileSync(`${H}/arm-${arm}.transcript`, "utf8").trim();

const rows = readFileSync(transcript, "utf8")
  .split("\n").filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const blocks = (row) => (Array.isArray(row?.message?.content) ? row.message.content : []);
// CLI prompts are stored as a plain string; tool results and model turns as block arrays.
const rawString = (row) => (typeof row?.message?.content === "string" ? row.message.content : "");
const text = (row) => blocks(row).map((b) =>
  b.type === "text" ? b.text ?? ""
  : b.type === "thinking" ? b.thinking ?? ""
  : b.type === "tool_use" ? `${b.name} ${JSON.stringify(b.input ?? {})}`
  : b.type === "tool_result" ? (typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""))
  : "").join("\n") || rawString(row);

const probeIndex = rows.findIndex((r) => r.type === "user" && rawString(r).includes("build-hash for the 'throttle'"));
if (probeIndex < 0) { console.log(JSON.stringify({ arm, error: "probe turn not found", entries: rows.length })); process.exit(0); }

const isLookup = (name, input) =>
  String(name).includes("recall_") || (name === "Agent" && String(input?.subagent_type) === "librarian");

const uses = new Map();
rows.forEach((row, i) => {
  for (const b of blocks(row)) {
    if (b.type === "tool_use" && i >= probeIndex && isLookup(b.name, b.input)) {
      uses.set(b.id, { index: i, name: b.name, input: b.input, at: row.timestamp, result: null, resultAt: null });
    }
  }
});
rows.forEach((row) => {
  for (const b of blocks(row)) {
    if (b.type === "tool_result" && uses.has(b.tool_use_id)) {
      const use = uses.get(b.tool_use_id);
      use.result = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      use.resultAt = row.timestamp;
    }
  }
});

const EMPTY = /NOT FOUND|No entry contains any of|No match for|no results|No files found/i;
const lookups = [...uses.values()].map((u) => {
  const chars = (u.result ?? "").length;
  return {
    tool: u.name === "Agent" ? "librarian" : u.name.replace("mcp__onepass__", ""),
    query: u.input?.query ?? u.input?.prompt?.slice(0, 160) ?? JSON.stringify(u.input).slice(0, 160),
    seconds: u.resultAt && u.at ? +((Date.parse(u.resultAt) - Date.parse(u.at)) / 1000).toFixed(1) : null,
    chars,
    approxTokens: Math.round(chars / 4),
    foundNeedle: (u.result ?? "").includes(needle),
    empty: EMPTY.test(u.result ?? "") || chars === 0,
  };
});

const finalAnswer = [...rows].slice(probeIndex).reverse()
  .find((r) => r.type === "assistant" && blocks(r).some((b) => b.type === "text" && b.text?.trim()));
const finalText = finalAnswer ? text(finalAnswer).trim() : "";

console.log(JSON.stringify({
  arm,
  needle,
  entries: rows.length,
  compactions: rows.filter((r) => r.isCompactSummary || r.compactMetadata).length,
  lookups: lookups.length,
  emptyLookups: lookups.filter((l) => l.empty).length,
  totalTokensReturned: lookups.reduce((sum, l) => sum + l.approxTokens, 0),
  totalLookupSeconds: +lookups.reduce((sum, l) => sum + (l.seconds ?? 0), 0).toFixed(1),
  correct: finalText.includes(needle),
  detail: lookups,
  finalAnswer: finalText.slice(0, 500),
}, null, 2));
