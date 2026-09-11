// The recall server as a client actually meets it: a real process, spoken to over stdio in
// MCP's own protocol. The planted decoy is the point — a newer transcript sits beside this
// session's in the same directory, and a search must never answer out of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { transcriptDir } from "./transcript.js";

const MINE = "1e4f1b2c-1111-4222-8333-444455556666";
const THEIRS = "2e4f1b2c-1111-4222-8333-444455556666";

function transcriptLine(text: string): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { content: [{ type: "text", text }] },
  })}\n`;
}

interface Response {
  id?: number;
  result?: { tools?: { name: string }[]; content?: { type: string; text: string }[] };
}

/** Sends requests to a freshly spawned recall server and collects the responses to each id. */
async function speak(env: NodeJS.ProcessEnv, cwd: string, requests: unknown[]): Promise<Map<number, Response>> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./recall.js", import.meta.url))], {
    env: { ...process.env, ...env },
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const answers = new Map<number, Response>();
  let buffer = "";
  const done = new Promise<void>((resolve) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        const message = JSON.parse(line) as Response;
        if (message.id !== undefined) answers.set(message.id, message);
      }
      if (answers.size === requests.filter((request) => (request as { id?: number }).id !== undefined).length) {
        resolve();
      }
    });
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await done;
  child.kill();
  return answers;
}

test("recall serves its two tools and searches the session it was given, not the newest", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "onepass-config-"));
  // A real directory: the server is a real process, and a process needs somewhere to start.
  const cwd = mkdtempSync(join(tmpdir(), "onepass-cwd-"));
  const env = { CLAUDE_CONFIG_DIR: configDir, ONEPASS_SESSION_ID: MINE };
  const dir = transcriptDir(cwd, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${MINE}.jsonl`), transcriptLine("the tuna sandwich was in my session"));
  writeFileSync(join(dir, `${THEIRS}.jsonl`), transcriptLine("the tuna sandwich was in another session"));
  const older = new Date(Date.now() - 60_000);
  utimesSync(join(dir, `${MINE}.jsonl`), older, older);

  const answers = await speak(env, cwd, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recall_search", arguments: { query: "tuna" } } },
  ]);

  assert.deepEqual(
    (answers.get(2)?.result?.tools ?? []).map((tool) => tool.name).sort(),
    ["recall_get", "recall_search"],
  );
  const text = answers.get(3)?.result?.content?.[0]?.text ?? "";
  assert.match(text, /in my session/);
  assert.doesNotMatch(text, /in another session/);
});
