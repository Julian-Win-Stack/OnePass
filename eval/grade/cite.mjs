#!/usr/bin/env node
// Resolve a grader reason's file:line citation back to the actual source lines.
//
// The trust check asks a human to confirm that a reason's citation is real. Opening
// twenty repositories by hand is the reason that check does not get done, so this
// prints the claim and the lines it points at, side by side, and nothing else.
//
//   node cite.mjs list                  every reason, numbered R1..Rn, one line each
//   node cite.mjs show R12 R31          the claim plus every line range it cites
//   node cite.mjs draw 5 --seed 20260909    a reproducible random sample, resolved
//   node cite.mjs draw 1 --seed 7 --pair p7   ... restricted to one pair
//
// Env: GRADE_DIR (default ~/onepass-corpus/grade), CITE_CONTEXT (default 4).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const GRADE_DIR = process.env.GRADE_DIR || path.join(os.homedir(), 'onepass-corpus', 'grade');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CONTEXT = Number(process.env.CITE_CONTEXT || 4);

const tsv = (f) => fs.readFileSync(path.join(HERE, f), 'utf8')
  .split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split('\t'));

const ARM_TOKEN = new Map(tsv('arms.tsv').map((r) => [r[0], r[1]]));
const TOKEN_ARM = new Map([...ARM_TOKEN].map(([a, t]) => [t, a]));
const PAIRS = new Map(tsv('pairs.tsv').map((r) => [r[0], { kind: r[1], a: r[2], b: r[3] }]));

// Ordering 1 shows the drawn A side as A; ordering 2 swaps.
const sides = (pair, ordering) => {
  const p = PAIRS.get(pair);
  return ordering === '1' ? { A: p.a, B: p.b } : { A: p.b, B: p.a };
};

// One reason per bullet in the grader's answer: some calls answer with '- ', some
// with '1. '. Bold run-in headings and the closing weighing paragraph are not
// reasons and carry no citation to check.
const BULLET = /^(?:-\s+|\d+\.\s+)/;
function reasons() {
  const out = [];
  for (const pair of PAIRS.keys()) {
    for (const ordering of ['1', '2']) {
      const file = path.join(GRADE_DIR, pair, ordering, 'call.out');
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) continue;                       // call still running
      const j = JSON.parse(raw);
      const text = j.result || '';
      const verdict = (text.trim().split('\n').filter((l) => l.trim()).pop() || '').trim();
      for (const line of text.split('\n')) {
        if (!BULLET.test(line)) continue;
        out.push({ pair, ordering, ...sides(pair, ordering), verdict, text: line.replace(BULLET, '').trim() });
      }
    }
  }
  return out.map((r, i) => ({ id: 'R' + (i + 1), ...r }));
}

// `A stores/pg/.../index.ts:258`, `q2md/stores/...:87-95`, or an absolute repos/ path.
const CITE = /(?:\b([AB])\s+)?((?:\/Users\/[^\s`]*?\/repos\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|json|md|mdx|sql|yaml|yml)):(\d+)(?:\s*[-–]\s*(\d+))?/g;

function resolve(r) {
  const seen = new Set();
  const out = [];
  for (const m of r.text.matchAll(CITE)) {
    let [, side, p, from, to] = m;
    let arm = null;
    const abs = p.match(/\/repos\/([a-z0-9]+)\/(.*)$/);
    if (abs) { arm = TOKEN_ARM.get(abs[1]); p = abs[2]; }
    else {
      const head = p.split('/')[0];
      if (TOKEN_ARM.has(head)) { arm = TOKEN_ARM.get(head); p = p.split('/').slice(1).join('/'); }
      else if (side) arm = r[side];
    }
    if (!arm || p.includes('...')) continue;   // '.../foo.ts' is prose elision, not a path
    const key = `${arm}:${p}:${from}-${to || from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ arm, file: p, from: Number(from), to: Number(to || from) });
  }
  return out;
}

const excerpt = (lines, c, note) => {
  const lo = Math.max(1, c.from - CONTEXT);
  const hi = Math.min(lines.length, c.to + CONTEXT);
  const body = [];
  for (let n = lo; n <= hi; n++) {
    const cited = n >= c.from && n <= c.to;
    body.push(`    ${cited ? '>' : ' '} ${String(n).padStart(5)} | ${lines[n - 1]}`);
  }
  return (note ? note + '\n' : '') + body.join('\n');
};

// A handful of citations give the line number in that side's diff rather than in the
// repository file. The location is still real, so fall back to the diff and say so.
function snippet(c, r) {
  const full = path.join(GRADE_DIR, 'repos', ARM_TOKEN.get(c.arm), c.file);
  const head = `  ${c.arm}  ${c.file}:${c.from}${c.to !== c.from ? '-' + c.to : ''}`;
  if (!fs.existsSync(full)) return `${head}\n    *** NO SUCH FILE in ${c.arm} — the citation is wrong ***`;
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  if (c.from <= lines.length) return `${head}\n${excerpt(lines, c)}`;

  const side = r && (r.A === c.arm ? 'A' : r.B === c.arm ? 'B' : null);
  const dfile = side && path.join(GRADE_DIR, r.pair, r.ordering, `${side}.diff`);
  if (dfile && fs.existsSync(dfile)) {
    const d = fs.readFileSync(dfile, 'utf8').split('\n');
    if (c.from <= d.length) {
      return `${head}\n${excerpt(d, c,
        `    *** ${c.file} has only ${lines.length} lines. This number is a line in ` +
        `${side}.diff, not in the file. Showing ${side}.diff instead: ***`)}`;
    }
  }
  return `${head}\n    *** file has only ${lines.length} lines — the citation is wrong ***`;
}

function show(rs) {
  for (const r of rs) {
    const p = PAIRS.get(r.pair);
    console.log(`\n${'='.repeat(78)}`);
    console.log(`${r.id}  —  ${r.pair}/${r.ordering}  (${p.kind})   A = ${r.A}, B = ${r.B}   ${r.verdict}`);
    console.log(`${'='.repeat(78)}\n`);
    console.log('THE CLAIM\n');
    console.log(r.text.replace(/(.{1,96})(\s|$)/g, '  $1\n').trimEnd());
    const cs = resolve(r);
    console.log(`\nWHAT IS ACTUALLY AT THOSE LINES  (${cs.length} citation${cs.length === 1 ? '' : 's'})\n`);
    if (!cs.length) console.log('  (no file:line citation in this sentence)');
    for (const c of cs) console.log(snippet(c, r) + '\n');
  }
}

// Deterministic, so the draw can be re-run and disputed.
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const all = reasons();
const cmd = process.argv[2] || 'list';
const args = process.argv.slice(3);

if (cmd === 'list') {
  for (const r of all) {
    const n = resolve(r).length;
    console.log(`${r.id.padEnd(5)} ${r.pair}/${r.ordering}  A=${r.A.padEnd(8)} B=${r.B.padEnd(8)} ` +
      `${String(n).padStart(2)} cite  ${r.text.replace(/`/g, '').slice(0, 96)}`);
  }
  console.error(`\n${all.length} reasons across ${new Set(all.map((r) => r.pair + r.ordering)).size} calls`);
} else if (cmd === 'show') {
  show(args.map((a) => all.find((r) => r.id.toLowerCase() === a.toLowerCase())).filter(Boolean));
} else if (cmd === 'draw') {
  const n = Number(args[0] || 5);
  const seed = Number(args[args.indexOf('--seed') + 1] || 1);
  const only = args.includes('--pair') ? args[args.indexOf('--pair') + 1].split(',') : null;
  const pool = all.filter((r) => resolve(r).length > 0 && (!only || only.includes(r.pair)));
  const rnd = mulberry32(seed);
  const picked = [];
  const bag = [...pool];
  while (picked.length < n && bag.length) picked.push(bag.splice(Math.floor(rnd() * bag.length), 1)[0]);
  console.log(`# Drawn with seed ${seed}${only ? ' from ' + only.join(',') : ''} — pool of ${pool.length} reasons that carry a citation\n`);
  show(picked.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))));
} else {
  console.error('usage: cite.mjs list | show R1 R2 ... | draw N [--seed S] [--pair pN]');
  process.exit(2);
}
