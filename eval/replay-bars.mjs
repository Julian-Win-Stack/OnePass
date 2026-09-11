#!/usr/bin/env node
// The batch-minimum replay check (docs/plans/batch-minimum.md §3.2), run after every change to
// proxy/src/evict.ts alongside `npm test`. At each T it replays one recording with the minimum off,
// then on and compared with the first, and checks the bars. No model calls: replay serves its own
// upstream.
//
//   ONEPASS_EVAL_CORPUS=~/onepass-corpus node replay-bars.mjs [--min 20000] [--t 110000,30000] [--recording harbor-make-mips]
//
// Commit first: an uncommitted build's labels carry `-dirty`. Exits 1 when a bar fails.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const minimum = Number(option("min", "20000"));
const thresholds = option("t", "110000,30000").split(",").map(Number);
const recording = option("recording", "harbor-make-mips");

// Harbor's own log of the make-mips run at T=30k with no minimum: the replay must land within ±5.
const HARBOR_TRIPS_AT_30K = 112;
const FAITHFUL_WITHIN = 5;

function replay(tripTokens, batchMinTokens, compareWith) {
  const args = ["dist/main.js", "replay", "--recording", recording];
  if (compareWith !== null) args.push("--compare", compareWith);
  const run = spawnSync("node", args, {
    cwd: here,
    encoding: "utf8",
    env: { ...process.env, ONEPASS_TRIP_TOKENS: String(tripTokens), ONEPASS_BATCH_MIN_TOKENS: String(batchMinTokens) },
  });
  if (run.status !== 0) {
    process.stderr.write(run.stdout + run.stderr);
    throw new Error(`replay at T=${tripTokens}, min=${batchMinTokens} exited ${run.status}`);
  }
  const label = /^\[onepass-eval\] (\S+): replay mode/m.exec(run.stdout)?.[1];
  if (label === undefined) throw new Error(`no label in the replay's output:\n${run.stdout.slice(-2000)}`);
  const result = JSON.parse(readFileSync(join(here, "results", `${label}.json`), "utf8"));
  // The totals the result document already carries, rather than a second copy of the same
  // arithmetic over `outcomes`: two copies would have to be kept in step by hand, and this one
  // silently produced NaN whenever a request logged no size estimate.
  const totals = result.replay.totals;
  return {
    label,
    requests: totals.requests,
    trips: totals.trips,
    peak: totals.peakEstimatedTokensSent,
    evicted: totals.newlyEvictedTokens,
    heldBack: totals.heldBack,
    alarm: totals.aboveAlarmLine,
  };
}

const k = (n) => (n === null ? "n/a" : `${Math.round(n / 1000)}k`);
let failed = false;
const lines = [
  `recording \`${recording}\`, minimum ${minimum.toLocaleString("en-US")} tokens`,
  "",
  "| T | min | label | requests | trips | trips/100 | peak sent | evicted first time | held back | above alarm |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
const verdicts = [];
for (const tripTokens of thresholds) {
  const off = replay(tripTokens, 0, null);
  const on = replay(tripTokens, minimum, off.label);
  for (const [min, run] of [[0, off], [minimum, on]]) {
    lines.push(
      `| ${k(tripTokens)} | ${k(min)} | ${run.label} | ${run.requests} | ${run.trips} | ` +
        `${((100 * run.trips) / run.requests).toFixed(1)} | ${k(run.peak)} | ${run.evicted.toLocaleString("en-US")} | ` +
        `${run.heldBack} | ${run.alarm} |`,
    );
  }
  const bar = (holds, text) => {
    if (!holds) failed = true;
    verdicts.push(`- T=${k(tripTokens)}: ${holds ? "pass" : "FAIL"} — ${text}`);
  };
  // Reported, and deliberately not counted as a failure. A ratio bar needs a baseline with a
  // passing value in it: at 4 trips or fewer, 0.2 × trips is under 1, so nothing but evicting
  // nothing at all could pass, and a run that evicted nothing is not the outcome being asked for.
  // That is a degenerate denominator, not a regression — see docs/findings.md §21, which records
  // which recordings hit it. The bar itself is unchanged, and a baseline of 5 or more is judged.
  const notEvaluable = (text) => verdicts.push(`- T=${k(tripTokens)}: not evaluable — ${text}`);
  if (tripTokens === 30_000) {
    bar(
      Math.abs(off.trips - HARBOR_TRIPS_AT_30K) <= FAITHFUL_WITHIN,
      `min=0 reproduces Harbor's ${HARBOR_TRIPS_AT_30K} trips ±${FAITHFUL_WITHIN}: ${off.trips}`,
    );
  }
  if (0.2 * off.trips < 1) {
    notEvaluable(
      `trips: the baseline trips ${off.trips} time(s), so 0.2 × ${off.trips} = ` +
        `${(0.2 * off.trips).toFixed(1)} leaves no passing value. The minimum held ${on.heldBack} ` +
        `request(s) back and left ${on.trips} trip(s)`,
    );
  } else {
    bar(on.trips <= 0.2 * off.trips, `trips ${on.trips} ≤ 0.2 × ${off.trips} = ${(0.2 * off.trips).toFixed(1)}`);
  }
  if (on.peak === null || off.peak === null) {
    notEvaluable("peak: one of the two runs logged no size estimate at all");
  } else {
    bar(on.peak <= off.peak + 20_000, `peak ${k(on.peak)} ≤ ${k(off.peak)} + 20k`);
  }
  bar(
    on.evicted >= off.evicted - 20_000,
    `evicted ${on.evicted.toLocaleString("en-US")} ≥ ${off.evicted.toLocaleString("en-US")} − 20,000`,
  );
}
console.log([...lines, "", ...verdicts].join("\n"));
process.exit(failed ? 1 : 0);
