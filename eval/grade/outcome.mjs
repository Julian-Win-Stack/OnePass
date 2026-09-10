// Turns the grader calls under $GRADE_DIR into the two tables, and prints every reason with its
// citation so a person can open the files and check five of them.
//
//   node outcome.mjs [--reasons] [--md]
//
// A call is Unknown when its result JSON sets is_error, or when the last non-empty line of its
// result is not exactly `Verdict: Yes`, `Verdict: No` or `Verdict: Unknown`. The reason is
// recorded and the call is listed under problems. Nothing is retried here and nothing is guessed.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.GRADE_DIR || join(process.env.HOME, 'onepass-corpus/grade');
const MATERIAL = process.env.GRADE_MATERIAL || join(process.env.HOME, 'onepass-corpus/ab');
const wantReasons = process.argv.includes('--reasons');

const tsv = (f) =>
  readFileSync(join(HERE, f), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t'));

const arms = new Map(tsv('arms.tsv').map(([arm, tok]) => [arm, tok]));
const pairs = tsv('pairs.tsv').map(([pair, kind, a, b]) => ({ pair, kind, a, b }));
const proxied = (arm) => arm.startsWith('head');

function readCall(pair, ord) {
  const d = join(DIR, pair, String(ord));
  const out = join(d, 'call.out');
  if (!existsSync(out)) return { dir: d, missing: true, verdict: 'Unknown', why: 'no call.out' };
  let j;
  try {
    j = JSON.parse(readFileSync(out, 'utf8'));
  } catch (e) {
    return { dir: d, verdict: 'Unknown', why: `unparsable call.out (${e.message})` };
  }
  const text = typeof j.result === 'string' ? j.result : '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const m = /^Verdict:\s*(Yes|No|Unknown)$/.exec(last);
  const call = {
    dir: d,
    session: j.session_id,
    turns: j.num_turns,
    ms: j.duration_ms,
    cost: j.total_cost_usd,
    reasons: lines.slice(0, -1),
    verdict: m ? m[1] : 'Unknown',
    why: null,
  };
  if (j.is_error) { call.verdict = 'Unknown'; call.why = `is_error (${j.subtype || 'unknown'})`; }
  else if (!m) call.why = `no verdict line (last line: ${JSON.stringify(last.slice(0, 60))})`;
  return call;
}

// Call 1 asks "X at least as good as Y?"; call 2 asks "Y at least as good as X?".
function derive(v1, v2) {
  if (v1 === 'Unknown' || v2 === 'Unknown') return 'no clear answer';
  if (v1 === 'Yes' && v2 === 'Yes') return 'same';
  if (v1 === 'No' && v2 === 'No') return 'no clear answer (contradiction)';
  return v1 === 'Yes' ? 'X preferred' : 'Y preferred';
}

function plain(outcome, x, y) {
  if (!outcome.startsWith('X') && !outcome.startsWith('Y')) return outcome;
  const winner = outcome.startsWith('X') ? x : y;
  const loser = outcome.startsWith('X') ? y : x;
  if (proxied(winner) === proxied(loser)) return `${winner} preferred`;
  return proxied(winner) ? 'proxied preferred' : 'control preferred';
}

const rows = [];
const problems = [];
for (const p of pairs) {
  const c1 = readCall(p.pair, 1);
  const c2 = readCall(p.pair, 2);
  for (const [ord, c] of [[1, c1], [2, c2]]) if (c.why) problems.push(`${p.pair}/${ord}: ${c.why}`);
  const raw = derive(c1.verdict, c2.verdict);
  rows.push({ ...p, c1, c2, raw, outcome: plain(raw, p.a, p.b) });
}

console.log('## Pairs\n');
console.log('| pair | kind | call 1 (A / B) | verdict | call 2 (A / B) | verdict | outcome |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows)
  console.log(
    `| ${r.pair} | ${r.kind} | ${r.a} / ${r.b} | ${r.c1.verdict} | ${r.b} / ${r.a} | ${r.c2.verdict} | ${r.outcome} |`,
  );

// Pairs whose two sides share a condition are checks on the grader, not on the arms.
const checks = rows.filter((r) => proxied(r.a) === proxied(r.b));
if (checks.length) {
  console.log('\n## Checks on the grader\n');
  for (const r of checks) {
    const [v1, v2] = [r.c1.verdict, r.c2.verdict];
    let read;
    if (/self-pair/.test(r.kind)) read = r.raw === 'same' ? 'passes: same change, both orderings Yes' : `FAILS: same change on both sides came out ${r.raw}`;
    else if (/positive control \((\w+)\)/.test(r.kind)) {
      const weak = r.kind.match(/positive control \((\w+)\)/)[1];
      const winner = r.raw.startsWith('X') ? r.a : r.raw.startsWith('Y') ? r.b : null;
      read = winner && winner !== weak ? `passes: ${weak} loses, as the tests say it should` : `FAILS: ${weak} did not lose (${r.raw})`;
    } else read = v1 !== v2 ? 'answer follows the arm across the swap' : `both orderings ${v1}: ${r.raw}`;
    console.log(`- ${r.pair} (${r.kind}): ${read}`);
  }
}

console.log('\n## Grader calls\n');
console.log('| pair | ordering | A | B | verdict | turns | wall | cost | session |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows)
  for (const [ord, c, A, B] of [[1, r.c1, r.a, r.b], [2, r.c2, r.b, r.a]])
    console.log(
      `| ${r.pair} | ${ord} | ${A} | ${B} | ${c.verdict} | ${c.turns ?? '—'} | ${
        c.ms ? (c.ms / 1000).toFixed(0) + 's' : '—'
      } | ${c.cost != null ? '$' + c.cost.toFixed(2) : '—'} | ${c.session || '—'} |`,
    );
const graderCost = rows.flatMap((r) => [r.c1.cost, r.c2.cost]).filter((c) => c != null);
console.log(
  `\nGrading cost: $${graderCost.reduce((a, b) => a + b, 0).toFixed(2)} over ${graderCost.length} calls.`,
);

if (problems.length) {
  console.log('\n## Problems\n');
  for (const p of problems) console.log(`- ${p}`);
} else {
  console.log('\nNo problems: every call returned a verdict line and none set is_error.');
}

// The arms' own cost, from the run records step 1 left in the corpus.
const arm = (a) => JSON.parse(readFileSync(join(MATERIAL, `${a}.out`), 'utf8'));
const stamp = (a, which) => readFileSync(join(MATERIAL, `${a}.${which}`), 'utf8').trim();
// A second copy of a finished repo (arms.tsv's self-pair row) is not a run of its own.
const names = [...arms.keys()].filter((a) => existsSync(join(MATERIAL, `${a}.out`)));
const u = {};
for (const a of names) {
  const j = arm(a);
  const g = j.usage || {};
  const t = {
    fresh: g.input_tokens || 0,
    write: g.cache_creation_input_tokens || 0,
    read: g.cache_read_input_tokens || 0,
    out: g.output_tokens || 0,
  };
  const mins = (Date.parse(stamp(a, 'end')) - Date.parse(stamp(a, 'start'))) / 60000;
  u[a] = { ...t, total: t.fresh + t.write + t.read + t.out, cost: j.total_cost_usd, turns: j.num_turns, mins };
}
const n = (x) => x.toLocaleString('en-US');
console.log('\n## Cost, per arm (from the arms\' own run records, not the grader\'s)\n');
console.log(`| | ${names.join(' | ')} |`);
console.log(`|---|${names.map(() => '---').join('|')}|`);
const row = (label, f) => console.log(`| ${label} | ${names.map((a) => f(u[a])).join(' | ')} |`);
row('list price', (x) => '$' + x.cost.toFixed(2));
row('total tokens', (x) => n(x.total));
row('fresh input', (x) => n(x.fresh));
row('cache write', (x) => n(x.write));
row('cache read', (x) => n(x.read));
row('output', (x) => n(x.out));
row('turns', (x) => n(x.turns));
row('wall clock', (x) => x.mins.toFixed(1) + ' min');

console.log('\n### Paired differences, proxied minus control\n');
console.log('| pair | dollars | total tokens | turns | wall clock |');
console.log('|---|---|---|---|---|');
const real = rows.filter((r) => proxied(r.a) !== proxied(r.b));
const acc = { cost: 0, total: 0, turns: 0, mins: 0 };
for (const r of real) {
  const h = proxied(r.a) ? r.a : r.b;
  const c = proxied(r.a) ? r.b : r.a;
  const d = { cost: u[h].cost - u[c].cost, total: u[h].total - u[c].total, turns: u[h].turns - u[c].turns, mins: u[h].mins - u[c].mins };
  for (const k of Object.keys(acc)) acc[k] += d[k];
  console.log(
    `| ${h} − ${c} | ${d.cost >= 0 ? '+' : '−'}$${Math.abs(d.cost).toFixed(2)} | ${d.total >= 0 ? '+' : '−'}${n(Math.abs(d.total))} | ${d.turns >= 0 ? '+' : '−'}${n(Math.abs(d.turns))} | ${d.mins >= 0 ? '+' : '−'}${Math.abs(d.mins).toFixed(1)} min |`,
  );
}
const k = real.length;
console.log(
  `| **mean of ${k}** | ${acc.cost >= 0 ? '+' : '−'}$${Math.abs(acc.cost / k).toFixed(2)} | ${acc.total >= 0 ? '+' : '−'}${n(Math.round(Math.abs(acc.total / k)))} | ${acc.turns >= 0 ? '+' : '−'}${(acc.turns / k).toFixed(1)} | ${acc.mins >= 0 ? '+' : '−'}${Math.abs(acc.mins / k).toFixed(1)} min |`,
);

if (wantReasons) {
  console.log('\n## Every reason, verbatim\n');
  for (const r of rows)
    for (const [ord, c, A, B] of [[1, r.c1, r.a, r.b], [2, r.c2, r.b, r.a]]) {
      console.log(`### ${r.pair}/${ord} — A=${A}, B=${B} — ${c.verdict}\n`);
      for (const line of c.reasons) console.log(line);
      console.log('');
    }
}
