// One grader call: a question, a pair of answers, and Yes, No or Unknown.
//
// Every model call the eval makes for itself goes through here or through count-tokens, so the
// grader is a direct API call rather than a Claude Code session: one HTTP boundary the tests
// can stand a fake in front of, and nothing between the eval and the verdict it counts.
//
// The two answers are shown as A and B in an order chosen at random for the pair, and the
// chosen order is recorded. That is what keeps one call per pair honest: position bias, if
// there is any, shows up in the control-versus-control noise floor drifting off an even split,
// and is paid for there instead of by grading every pair twice.
//
// Unknown carries a weight the other two do not. A call that hit its turn cap and a call whose
// text does not parse are both Unknown, and if that were all the run knew, a grader that gave up
// would be indistinguishable from a grader that looked and could not decide. So a stopped call
// says why, names the tool call it was left waiting on, prints a warning the moment it happens,
// and hands back a problems entry the report prints in full rather than counting.

import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta";
import { graderTools } from "./graderTools.js";
import { EvalError, messageOf } from "./errors.js";
import type { Problem } from "./result.js";

/**
 * Model turns one call may take. A grader that has read forty times and still has no verdict is
 * not one turn from finding one, and the cost of letting it run is paid on every pair.
 */
export const GRADER_TURN_CAP = 40;

/** Room for the reasoning behind a verdict, and nowhere near room to recite a repository. */
const MAX_OUTPUT_TOKENS = 16_000;

/** How much of a pending tool call's arguments the warning quotes before it is enough. */
const MAX_WAITING_ON = 300;

export type Verdict = "Yes" | "No" | "Unknown";

/** Which answer was shown as A and which as B: the order chosen for one pair. */
export interface ShownAs {
  A: string;
  B: string;
}

/** One side of a pair: an answer, and what produced it. */
export interface Answer {
  /** The arm — `proxied`, `control-1`. Recorded as the order, and never shown to the grader. */
  id: string;
  text: string;
}

/** Two answers to the same case, to be compared. */
export interface Pair {
  /** The case both answers answer. */
  case: string;
  /** Names this pairing of the case's answers. */
  id: string;
  answers: readonly [Answer, Answer];
}

export interface GraderQuestion {
  /** Names the question in the result, and in every warning about a call that asked it. */
  id: string;
  /** Asked of the pair, phrased so that Yes is an answer about A. */
  ask: string;
  /** What the grader needs besides the two answers: the history, the plan, the two diffs. */
  context?: string;
}

/** What one call did, whether or not it produced a verdict. */
export interface GraderCall {
  case: string;
  pair: string;
  question: string;
  verdict: Verdict;
  shownAs: ShownAs;
  /** Model turns the call took. */
  turns: number;
  /**
   * The prompt the last turn sent, cached and uncached alike: how full the context was when the
   * call finished. A verdict decided at the top of the window is worth less than one decided with
   * room to spare, and without this the two are counted the same.
   */
  promptTokens: number;
  /** Prompt tokens served from cache across the call. Zero means caching never fired. */
  cacheReadTokens: number;
  /** Prompt tokens written to cache across the call. */
  cacheCreationTokens: number;
  /** Why nothing was decided, or null when the verdict is the grader's own answer. */
  reason: string | null;
  /** The tool call the grader was left waiting on, or null. Several, when it asked for several. */
  waitingOn: string | null;
  /** The run's problems entry, or null when nothing stopped early. */
  problem: Problem | null;
}

export interface GradeOptions {
  /** Pointed at the model API, or at whatever stands in for it. */
  client: Anthropic;
  model: string;
  /** The effort the grader runs at, or undefined for the model's own default. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  question: GraderQuestion;
  pair: Pair;
  /** The repository the answers were written against. The grader's tools see this and no more. */
  repoPath: string;
  /** Model turns this call may take. Defaults to {@link GRADER_TURN_CAP}. */
  maxTurns?: number;
  /** Chooses which answer is shown as A. Injected so a test can pin the order. */
  random?: () => number;
  /** Where a stopped call is announced. Defaults to `console.warn`. */
  warn?: (line: string) => void;
}

/**
 * Asks `question` of `pair` and answers Yes, No or Unknown. Never throws for anything the model
 * or the network did: a run grades hundreds of pairs, and one call that could not be made is a
 * problem to report, not a reason to lose the rest.
 */
export async function gradePair(options: GradeOptions): Promise<GraderCall> {
  const { client, model, effort, question, pair, repoPath } = options;
  // A cap below one is not a cap: the runner treats a falsy `max_iterations` as no limit, so a
  // caller who passed zero meaning "none" would get an uncapped call rather than a refusal.
  const cap = options.maxTurns ?? GRADER_TURN_CAP;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new EvalError(`a grader call has to be capped at one model turn or more, not ${cap}.`);
  }
  const random = options.random ?? Math.random;
  const warn = options.warn ?? ((line: string) => console.warn(line));

  const [first, second] = pair.answers;
  const swap = random() >= 0.5;
  const [a, b] = swap ? [second, first] : [first, second];
  const shownAs: ShownAs = { A: a.id, B: b.id };

  let turns = 0;
  let last: BetaMessage | null = null;
  let failure: string | null = null;
  let cacheRead = 0;
  let cacheCreation = 0;
  try {
    const runner = client.beta.messages.toolRunner({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: false,
      max_iterations: cap,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          // The breakpoint sits here rather than on the tools because caching has a minimum size
          // and system plus tool schemas is 465 tokens, well under it: a breakpoint there would be
          // silently ignored. Question and answers carry the prefix over the line, and nothing
          // above this point changes across the call's turns, so every turn after the first reads
          // it back. The tool results accumulating below are not covered — moving a breakpoint
          // down them each turn means `setMessagesParams`, which drops the runner's tool cache.
          content: [{ type: "text", text: askFor(question, a, b), cache_control: { type: "ephemeral" } }],
        },
      ],
      tools: graderTools(repoPath),
      ...(effort === undefined ? {} : { output_config: { effort } }),
    });
    for await (const message of runner) {
      turns += 1;
      last = message;
      cacheRead += message.usage.cache_read_input_tokens ?? 0;
      cacheCreation += message.usage.cache_creation_input_tokens ?? 0;
    }
  } catch (err: unknown) {
    failure = `the call failed after ${turns} model turn${turns === 1 ? "" : "s"}: ${messageOf(err)}`;
  }

  const outcome = outcomeOf({ cap, turns, last, failure });
  const call: GraderCall = {
    case: pair.case,
    pair: pair.id,
    question: question.id,
    verdict: outcome.verdict,
    shownAs,
    turns,
    promptTokens: last === null ? 0 : promptSizeOf(last),
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reason: outcome.reason,
    waitingOn: outcome.waitingOn,
    problem: outcome.reason === null ? null : problemOf(pair, question, outcome, shownAs),
  };
  if (call.problem !== null) warn(warningOf(call.problem));
  return call;
}

interface Outcome {
  verdict: Verdict;
  /** Null exactly when the verdict is the grader's own answer rather than a call that stopped. */
  reason: string | null;
  waitingOn: string | null;
}

/**
 * What the call came to. A finished call ends its turn with a verdict and no tool call pending;
 * a capped one ends on a `tool_use` the runner never got to send back. That difference — the
 * final message's stop reason, and whether a tool call was left unanswered — is the whole of
 * how the two are told apart, and it is why the cap is enforced by the runner rather than by
 * counting requests here.
 *
 * The runner answers every tool call it sends, an unknown tool name included, so the cap is the
 * only thing that leaves one unanswered. The reason says which turn of which cap it stopped on
 * rather than asserting the cap was reached, so it stays true if that ever stops being so.
 */
function outcomeOf(state: { cap: number; turns: number; last: BetaMessage | null; failure: string | null }): Outcome {
  if (state.failure !== null) return { verdict: "Unknown", reason: state.failure, waitingOn: null };
  if (state.last === null) {
    return { verdict: "Unknown", reason: "the call ended without a message from the model.", waitingOn: null };
  }

  const pending = unanswered(state.last);
  if (pending.length > 0) {
    const waitingOn = pending.map(describe).join(", ");
    const reason =
      `the call stopped with a tool call unanswered on model turn ${state.turns} ` +
      `of its cap of ${state.cap} (stop reason ${state.last.stop_reason}).`;
    return { verdict: "Unknown", reason, waitingOn };
  }

  const said = textOf(state.last);
  const verdict = parseVerdict(said);
  if (verdict === null) {
    return {
      verdict: "Unknown",
      reason:
        `the grader's final message carries no verdict line (stop reason ${state.last.stop_reason}). ` +
        `It ended: ${quote(said)}`,
      waitingOn: null,
    };
  }
  return { verdict, reason: null, waitingOn: null };
}

/**
 * The tool calls the grader was left waiting on, or an empty list when it was not waiting on
 * any. A final message that still asks for one is a call that stopped rather than finished. All
 * of them are kept: a model asking for two files at once was waiting on both, and naming one
 * would send whoever reads the warning after half the reason it stopped.
 */
function unanswered(message: BetaMessage): BetaToolUseBlock[] {
  if (message.stop_reason !== "tool_use") return [];
  return message.content.filter((block): block is BetaToolUseBlock => block.type === "tool_use");
}

/**
 * The whole prompt a message was answered from: what was sent uncached, plus what the cache
 * served, plus what it wrote. `input_tokens` alone is only the uncached part, so it *falls* as
 * caching starts working — reading it by itself would make a call look smaller the better the
 * cache did, and would quietly stop a size threshold from ever firing.
 */
function promptSizeOf(message: BetaMessage): number {
  return (
    message.usage.input_tokens +
    (message.usage.cache_read_input_tokens ?? 0) +
    (message.usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Above this many prompt tokens, a call is big enough that caching should have fired. The API
 * declines to cache prompts under about 1024 tokens and says nothing when it does, so the
 * threshold sits clear of that line: under it, no cache read is correct rather than broken.
 */
export const CACHE_EXPECTED_ABOVE = 2_000;

/**
 * The run's caching problem, or null when there is nothing to say.
 *
 * Misconfigured caching is worse than none — a cache write costs more than an ordinary token, so
 * a prefix that changes every call pays a premium to store something never read. Nothing in a
 * run's numbers looks wrong when that happens: the verdicts are fine and only the bill moves.
 *
 * Asked once for the whole run rather than per call. If caching is broken it is broken for every
 * call, and a warning printed a hundred times is one nobody reads. One read anywhere is enough to
 * say it works; a single call missing is an expired entry, not a broken configuration.
 */
export function cachingProblem(calls: readonly GraderCall[]): Problem | null {
  const big = calls.filter((call) => call.promptTokens > CACHE_EXPECTED_ABOVE);
  if (big.length === 0) return null;
  if (big.some((call) => call.cacheReadTokens > 0)) return null;

  const written = big.reduce((total, call) => total + call.cacheCreationTokens, 0);
  return {
    what: `caching never fired across ${big.length} grader call${big.length === 1 ? "" : "s"}`,
    detail:
      `Every one of them sent more than ${CACHE_EXPECTED_ABOVE} prompt tokens and not one read ` +
      `from the cache, so the breakpoint is misplaced or the prefix is not stable. ` +
      `${written} tokens were written to the cache and none were read back, which costs more than ` +
      `sending them uncached.`,
  };
}

function textOf(message: BetaMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * The verdict `text` ends on, or null. The last verdict line wins: the grader reasons before it
 * answers, and reasoning that mentions the word Yes is not the answer.
 */
export function parseVerdict(text: string): Verdict | null {
  const found = [...text.matchAll(/^\s*verdict:\s*(yes|no|unknown)\b/gim)].at(-1);
  if (found === undefined) return null;
  const word = (found[1] as string).toLowerCase();
  return word === "yes" ? "Yes" : word === "no" ? "No" : "Unknown";
}

function describe(call: BetaToolUseBlock): string {
  const args = JSON.stringify(call.input ?? {});
  return `${call.name}(${args.length > MAX_WAITING_ON ? `${args.slice(0, MAX_WAITING_ON)}…` : args})`;
}

function quote(text: string): string {
  const tail = text.slice(-200).trim();
  return tail === "" ? "with no text at all." : JSON.stringify(tail);
}

/** The one place a stopped call is put into words, so the warning and the report cannot differ. */
function problemOf(
  pair: Pair,
  question: GraderQuestion,
  outcome: Outcome,
  shownAs: ShownAs,
): Problem {
  return {
    what: `grader Unknown: case ${pair.case}, pair ${pair.id}, question ${question.id}`,
    detail:
      `${outcome.reason} Waiting on ${outcome.waitingOn ?? "nothing"}. ` +
      `Shown as A: ${shownAs.A}, as B: ${shownAs.B}.`,
  };
}

function warningOf(problem: Problem): string {
  return `[onepass-eval] ${problem.what} — ${problem.detail}`;
}

const SYSTEM = `You are grading two answers to the same question. They are shown to you as A and B in an
order chosen at random, and nothing in this prompt says which came from where. Judge the answers,
not the order.

You have three read-only tools over the repository the answers were written against: read_file,
search and list. Use them. A claim about the code is worth crediting only once you have checked it
against the code.

End your final message with one line, and nothing after it:

Verdict: Yes
Verdict: No
Verdict: Unknown

Yes and No answer the question exactly as it was asked. Unknown is for when you have looked and
still cannot decide; it is a real answer, not a way out of a hard one. Never guess.`;

function askFor(question: GraderQuestion, a: Answer, b: Answer): string {
  const parts = [`<question>\n${question.ask}\n</question>`];
  if (question.context !== undefined && question.context.trim() !== "") {
    parts.push(`<context>\n${question.context}\n</context>`);
  }
  parts.push(`<answer id="A">\n${a.text}\n</answer>`, `<answer id="B">\n${b.text}\n</answer>`);
  return parts.join("\n\n");
}
