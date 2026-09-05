// The smoke check of issue #4: prove the mechanisms the eval is built on before any eval code
// is written. Six criteria, printed pass or fail, with what was observed under each.
//
//   1  a transcript copied into a different worktree's project directory resumes by session id
//   2  a resume-at fork at a model turn, given the recorded user turn, produces exactly one turn
//   3  after that fork the parent transcript is byte-identical
//   4  a hidden snapshot leaves the agent's git status, diff, log and index showing nothing
//   5  that snapshot materialises afterwards as a worktree carrying the recorded file state
//   6  the note records the version, the commands and the output  (this script's own output)
//
// Criteria 1 to 3 need a live `claude` and cost model calls, which is why they are here and not
// in the test suite. They run on a throwaway two-turn session with tools disabled: the fork
// mechanics do not depend on the model or on tool use, and a cheap model keeps the bill near
// nothing. Criteria 4 and 5 need no model; `snapshot.test.ts` covers them in more detail.
//
// Nothing here writes to a transcript. The copy of criterion 1 is a new file under a new
// session id, and every session this script creates is its own.

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentView, applyAgentEdits, git, initThrowawayRepo } from "./git.js";
import { createSnapshotter, materialiseSnapshot } from "./snapshot.js";
import { projectDirFor, readTranscript, readTurns, type Turn } from "./transcript.js";

const SMOKE_DIR = process.env.ONEPASS_SMOKE_DIR ?? "/tmp/onepass-smoke";
const MODEL = process.env.ONEPASS_SMOKE_MODEL ?? "haiku";

interface Check {
  id: number;
  criterion: string;
  passed: boolean;
  /** What was seen. Printed under the verdict, and the reason when it failed. */
  observed: string[];
}

const checks: Check[] = [];

function record(id: number, criterion: string, passed: boolean, observed: string[]): void {
  checks.push({ id, criterion, passed, observed });
  process.stdout.write(`  check ${id}: ${passed ? "PASS" : "FAIL"}  ${criterion}\n`);
  for (const line of observed) process.stdout.write(`      ${line}\n`);
}

function countLines(output: string): number {
  return output.trim() === "" ? 0 : output.trim().split("\n").length;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

interface TurnResult {
  sessionId: string;
  text: string;
  numTurns: number;
  isError: boolean;
  /** Why the turn ended badly — the result subtype — or null when it succeeded. */
  failure: string | null;
}

/** One `claude` turn through the Agent SDK, with tools and filesystem settings off. */
async function runTurn(prompt: string, options: Options): Promise<TurnResult> {
  const messages: SDKMessage[] = [];
  for await (const message of query({
    prompt,
    options: {
      model: MODEL,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 3,
      ...options,
    },
  })) {
    messages.push(message);
  }
  const text = messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (Array.isArray(message.message.content) ? message.message.content : []))
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  const result = messages.find((message) => message.type === "result");
  if (result === undefined) throw new Error("the SDK produced no result message");
  return {
    sessionId: result.session_id,
    text,
    numTurns: result.num_turns,
    isError: result.is_error,
    failure: result.subtype === "success" ? null : result.subtype,
  };
}

/** A repository with one commit, plus a second worktree standing in for a case worktree. */
function prepareRepos(): { repo: string; caseWorktree: string } {
  rmSync(SMOKE_DIR, { recursive: true, force: true });
  const repo = initThrowawayRepo(join(SMOKE_DIR, "repo"));
  const caseWorktree = join(SMOKE_DIR, "case-worktree");
  git(repo, ["worktree", "add", "--detach", "--quiet", caseWorktree, "HEAD"]);
  return { repo, caseWorktree };
}

/** The two turns the fixture must have recorded, so the fork has one to keep and one to drop. */
function keptAndDropped(turns: Turn[]): { kept: Turn; dropped: Turn } {
  const [kept, dropped] = turns;
  if (kept === undefined || dropped === undefined || turns.length !== 2) {
    throw new Error(`expected the fixture to record two turns, got ${turns.length}`);
  }
  return { kept, dropped };
}

async function main(): Promise<void> {
  const hostVersion = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  process.stdout.write(`onepass smoke check — issue #4\n`);
  process.stdout.write(`  host claude:  ${hostVersion}\n`);
  process.stdout.write(`  model:        ${MODEL}\n`);
  process.stdout.write(`  corpus dir:   ${SMOKE_DIR}\n\n`);

  const { repo, caseWorktree } = prepareRepos();

  // --- record the fixture session -------------------------------------------------------
  // Two typed turns, so there is a turn to keep and a turn to drop. The release tag is what
  // proves a resume loaded the recorded history rather than starting fresh. It is phrased as
  // an ordinary fact about the work: a "remember this codeword, now recall it" pair reads as
  // a conditioning test and a model may decline it, which would make the fixture flaky.
  const codeword = `RELEASE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const recordedId = randomUUID();
  const secondPrompt = "What release tag did I give you? Reply with the tag and nothing else.";

  process.stdout.write(`recording a two-turn session ${recordedId} in ${repo}\n`);
  await runTurn(
    `The release tag for this project is ${codeword}. Reply with exactly: ACK`,
    { cwd: repo, sessionId: recordedId },
  );
  const recordedSecond = await runTurn(secondPrompt, { cwd: repo, resume: recordedId });
  process.stdout.write(`  recorded answer to turn 2: ${JSON.stringify(recordedSecond.text.trim())}\n\n`);

  const recordedFile = join(projectDirFor(repo), `${recordedId}.jsonl`);
  const recordedEntries = readTranscript(recordedFile);
  const recordedTurns = readTurns(recordedEntries);
  const writerVersion = String(recordedEntries.find((entry) => entry.version !== undefined)?.version ?? "unknown");
  process.stdout.write(`  transcript:   ${recordedFile}\n`);
  process.stdout.write(`  written by:   Claude Code ${writerVersion}\n`);
  process.stdout.write(`  turns:        ${recordedTurns.length}\n\n`);
  const { kept: keptTurn, dropped: droppedTurn } = keptAndDropped(recordedTurns);

  // --- criterion 1 ----------------------------------------------------------------------
  // The eval places a copy of a stored transcript under a NEW session id in the case
  // worktree's project directory. The copy is byte-for-byte the original, so its internal
  // `sessionId` still names the original — only the filename is new. Nothing else on this
  // machine holds that id, so a resume that recalls the codeword read this copy.
  const copiedId = randomUUID();
  const copiedFile = join(projectDirFor(caseWorktree), `${copiedId}.jsonl`);
  mkdirSync(projectDirFor(caseWorktree), { recursive: true });
  copyFileSync(recordedFile, copiedFile);
  const recordedHashBefore = sha256(recordedFile);
  const copiedHashBefore = sha256(copiedFile);

  const plainResume = await runTurn(secondPrompt, {
    cwd: caseWorktree,
    resume: copiedId,
    forkSession: true,
  });
  record(
    1,
    "a transcript copied into a different worktree's project directory resumes by session id",
    plainResume.text.includes(codeword),
    [
      `copied ${recordedId}.jsonl -> ${copiedFile}`,
      `its entries still carry sessionId ${recordedId}; only the filename is new`,
      `resumed ${copiedId} with cwd ${caseWorktree}`,
      `answer: ${JSON.stringify(plainResume.text.trim())}`,
      `release tag ${codeword} ${plainResume.text.includes(codeword) ? "recalled" : "NOT recalled"}`,
    ],
  );

  // --- criterion 2 ----------------------------------------------------------------------
  // Fork at the kept turn's last chain entry, declaring the dropped turn's prompt so the CLI
  // validates the truncation, and send the recorded user turn verbatim as the prompt.
  const fork = await runTurn(droppedTurn.promptText, {
    cwd: caseWorktree,
    resume: copiedId,
    forkSession: true,
    resumeSessionAt: keptTurn.lastUuid,
    resumeDropsTurn: droppedTurn.promptUuid,
  });
  const forkFile = join(projectDirFor(caseWorktree), `${fork.sessionId}.jsonl`);
  const forkBytes = readFileSync(forkFile, "utf8");
  const forkTurns = readTurns(readTranscript(forkFile));
  const newTurns = forkTurns.slice(1);
  const keptPrefixIntact =
    forkTurns[0]?.promptText === keptTurn.promptText && forkTurns[0]?.answerText === keptTurn.answerText;
  const exactlyOneTurn = newTurns.length === 1 && newTurns[0]?.promptText === droppedTurn.promptText;
  // Evidence that needs no turn parser, so a bug in `readTurns` cannot make the truncation
  // look right on both sides of the comparison. A fork keeps the parent's uuids for the
  // entries it kept and mints fresh ones past the fork point, so the fork point's own uuid is
  // in its bytes and the dropped turn's prompt uuid is not.
  const forkPointKept = forkBytes.includes(keptTurn.lastUuid);
  const droppedTurnGone = !forkBytes.includes(droppedTurn.promptUuid);
  record(
    2,
    "a resume-at fork at a model turn, given the recorded user turn, produces exactly one turn",
    exactlyOneTurn && keptPrefixIntact && forkPointKept && droppedTurnGone && !fork.isError,
    [
      `resumeSessionAt ${keptTurn.lastUuid} (last chain entry of turn 1)`,
      `resumeDropsTurn ${droppedTurn.promptUuid} (the discarded turn's prompt)`,
      `prompt sent verbatim: ${JSON.stringify(droppedTurn.promptText)}`,
      `fork session ${fork.sessionId} -> ${forkFile}`,
      `fork transcript holds ${forkTurns.length} turns: ${newTurns.length} past the fork point`,
      `kept prefix ${keptPrefixIntact ? "matches" : "DIFFERS FROM"} the parent's turn 1`,
      `in the fork's raw bytes: fork point ${forkPointKept ? "present" : "MISSING"}, dropped prompt uuid ${droppedTurnGone ? "absent" : "STILL THERE"}`,
      `result: is_error=${fork.isError} num_turns=${fork.numTurns}${fork.failure === null ? "" : ` (${fork.failure})`}`,
      `answer: ${JSON.stringify(fork.text.trim())}`,
    ],
  );

  // --- criterion 3 ----------------------------------------------------------------------
  // Both the copy the fork resumed from and the recording it came from. The eval reuses one
  // copy across every arm, so the copy has to survive a fork as much as the original does.
  const recordedHashAfter = sha256(recordedFile);
  const copiedHashAfter = sha256(copiedFile);
  record(
    3,
    "after that fork the parent transcript is byte-identical to what it was before",
    recordedHashBefore === recordedHashAfter && copiedHashBefore === copiedHashAfter,
    [
      `resumed copy   ${copiedHashBefore === copiedHashAfter ? "unchanged" : "CHANGED"}  sha256 ${copiedHashBefore.slice(0, 16)} -> ${copiedHashAfter.slice(0, 16)}`,
      `source session ${recordedHashBefore === recordedHashAfter ? "unchanged" : "CHANGED"}  sha256 ${recordedHashBefore.slice(0, 16)} -> ${recordedHashAfter.slice(0, 16)}`,
      `two forks ran against the copy; neither appended to it`,
    ],
  );

  // --- criteria 4 and 5 -----------------------------------------------------------------
  applyAgentEdits(repo);
  const snapshotter = createSnapshotter({ repo, indexFile: join(SMOKE_DIR, "snapshot-index") });

  // Each snapshot is compared against the view taken immediately before it. Comparing across
  // the agent's own edit in between would fail on `git diff` for the honest reason.
  const beforeFirst = agentView(repo);
  const early = snapshotter.snapshot("toolu_smoke01");
  const afterFirst = agentView(repo);
  writeFileSync(join(repo, "tracked.txt"), "a later state the tail must not see\n");
  const beforeSecond = agentView(repo);
  snapshotter.snapshot("toolu_smoke02");
  const afterSecond = agentView(repo);
  snapshotter.dispose();

  const changed = [
    ...Object.keys(beforeFirst).filter((command) => beforeFirst[command] !== afterFirst[command]),
    ...Object.keys(beforeSecond).filter((command) => beforeSecond[command] !== afterSecond[command]),
  ];
  record(
    4,
    "a hidden snapshot leaves the agent's git status, git diff, git log and index showing nothing",
    changed.length === 0,
    [
      `two snapshots written under ${early.ref.split("/").slice(0, -1).join("/")}/`,
      `commands compared across each snapshot: ${Object.keys(beforeFirst).join(", ")}`,
      changed.length === 0 ? "all identical before and after each" : `CHANGED: ${changed.join(", ")}`,
      `git log --oneline still shows ${countLines(git(repo, ["log", "--oneline"]))} commit(s)`,
      // Named rather than hidden: `--all` means every ref under refs/, this namespace included.
      `note: git log --all --oneline shows ${countLines(git(repo, ["log", "--all", "--oneline"]))} commit(s)`,
    ],
  );

  const tail = join(SMOKE_DIR, "tail");
  materialiseSnapshot({ repo, commit: early.commit, destination: tail });
  const tracked = readFileSync(join(tail, "tracked.txt"), "utf8");
  const untracked = readFileSync(join(tail, "untracked.txt"), "utf8");
  const tailClean = git(tail, ["status", "--porcelain"]) === "";
  record(
    5,
    "that snapshot materialises afterwards as a worktree carrying the recorded file state",
    tracked === "edited by the agent\n" && untracked === "written by the agent\n" && tailClean,
    [
      `git worktree add --detach ${tail} ${early.commit.slice(0, 10)}`,
      `tracked.txt   = ${JSON.stringify(tracked)}  (the agent's edit, not the later state)`,
      `untracked.txt = ${JSON.stringify(untracked)}  (never committed by the agent)`,
      `the tail's own git status is ${tailClean ? "clean" : "DIRTY"}`,
    ],
  );

  // --- report ---------------------------------------------------------------------------
  const failed = checks.filter((check) => !check.passed);
  const report = {
    ranAt: new Date().toISOString(),
    hostClaudeVersion: hostVersion,
    transcriptWriterVersion: writerVersion,
    model: MODEL,
    smokeDir: SMOKE_DIR,
    recordedSession: recordedFile,
    copiedSession: copiedFile,
    forkSession: forkFile,
    checks,
  };
  const reportFile = join(SMOKE_DIR, "smoke-report.json");
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.stdout.write(failed.length === 0 ? " (criterion 6 is this output)\n" : `; failed: ${failed.map((check) => check.id).join(", ")}\n`);
  process.stdout.write(`report: ${reportFile}\n`);
  process.stdout.write(`sessions this run created are under ${projectDirFor(repo)} and ${projectDirFor(caseWorktree)}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`smoke check could not finish: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 2;
});
