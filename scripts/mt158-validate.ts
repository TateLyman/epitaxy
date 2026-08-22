/**
 * MT158 validation — fit the selection rule on block A, apply it UNCHANGED to block B.
 *
 * The decision rule was frozen in the ledger before this file ran, and it is deliberately not the
 * one that closed MT127-RESULT, MT154 and MT157. Those were closed on the top-1% share, because a
 * positive mean living entirely in its extreme tail is not a tradeable edge. THAT TEST WOULD BEG
 * THE QUESTION HERE: the operator's strategy is explicitly a tail strategy — hold only the extreme
 * thirty-second runners — so tail-heaviness is the design, not the defect.
 *
 * The real failure mode of a lottery mean is that it is UNESTIMABLE. MT154 watched one cell read
 * +2,128, +537 and +170 across three corpora of the same population. So the gate is STABILITY:
 *
 *   (a) selected subset NET mean on block B exceeds zero
 *   (b) its 95% day-clustered lower bound exceeds zero
 *   (c) the block B mean sits within a FACTOR OF THREE of the block A mean
 *   (d) at least 100 pools survive selection on block B
 *
 * Median, percent positive and top-1% share are reported and do NOT gate.
 *
 * THE SEARCH IS PRINTED IN FULL so the multiple testing is auditable. Twenty-six candidate rules
 * are scored on block A — top and bottom quintile of each of eleven features, plus four binary
 * splits — and the best is taken. That inflates the fit-side number by construction, which is
 * exactly why the decision lives entirely on block B.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { readFileSync, existsSync } from 'node:fs';

interface Row {
  pool: string; creator: string; bornSlot: number; ts: number; ret: number;
  nTrades: number; buyers: number; bundle: number; buySol: number; maxBuySol: number;
  topShare: number; buyShare: number; moveBps: number; depthSol: number; feeBps: number; prior: number;
}

const load = (tag: string): Row[] => {
  const f = `data/panel/runner-${tag}.jsonl`;
  if (!existsSync(f)) { console.log(`missing ${f}`); return []; }
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Row);
};
/**
 * FRESH-GRADUATION FILTER, and it is a DATA-QUALITY filter rather than a strategy choice.
 *
 * The first run of this test selected "fewest trades in the first four slots", which replicated as
 * the top-ranked rule on BOTH blocks. It was an artifact. Block B precedes block A on chain, so a
 * pool "born" in block A that already traded in block B was never newborn — and 30.8% of the
 * selected bucket failed that check against 1.5% of everything else, a twentyfold enrichment. The
 * birth detection cannot see a pool that was dormant before the block, and a dormant pool is
 * silent for four slots by definition, so it lands in the low-trade-count bucket every time.
 *
 * A pump.fun token graduates onto PumpSwap with roughly 79 SOL of liquidity, and the uncontaminated
 * population sits right on that at a median of 85. The contaminated bucket sits at 23 with a tenth
 * percentile of zero. Requiring depth at entry above a floor therefore removes dormant pools using
 * a mechanism INDEPENDENT of any outcome, which is what makes it legitimate to apply after the
 * fact. It is declared here rather than folded in silently.
 */
const MIN_DEPTH = Number(process.argv.find((a) => a.startsWith('--min-depth='))?.slice(12) ?? '0');
const A = load('A').filter((r) => r.depthSol >= MIN_DEPTH);
const B = load('B').filter((r) => r.depthSol >= MIN_DEPTH);
if (MIN_DEPTH > 0) console.log(`fresh-graduation filter: depth at entry >= ${MIN_DEPTH} SOL`);
console.log(`block A ${A.length.toLocaleString()} pools   block B ${B.length.toLocaleString()} pools`);
if (A.length === 0 || B.length === 0) process.exit(1);

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const topShareOf = (x: number[]): number => {
  if (x.length < 50) return NaN;
  const s = [...x].sort((a, b) => b - a); const k = Math.max(1, Math.floor(s.length * 0.01));
  const tot = s.reduce((a, b) => a + b, 0);
  return tot === 0 ? NaN : s.slice(0, k).reduce((a, b) => a + b, 0) / tot;
};
function boot(items: Row[]): [number, number] {
  const byDay = new Map<number, number[]>();
  for (const it of items) { const d = Math.floor(it.ts / 86400); const a = byDay.get(d) ?? []; a.push(it.ret); byDay.set(d, a); }
  const days = [...byDay.values()];
  if (days.length < 2) return [NaN, NaN];
  let seed = 20260822;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ms: number[] = [];
  for (let r = 0; r < 2000; r += 1) {
    const pick: number[] = [];
    for (let i = 0; i < days.length; i += 1) { const dd = days[Math.floor(rnd() * days.length)]; if (dd) pick.push(...dd); }
    if (pick.length) ms.push(mean(pick));
  }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(0.025 * ms.length)] ?? NaN, ms[Math.floor(0.975 * ms.length)] ?? NaN];
}

const FEATURES: [string, (r: Row) => number][] = [
  ['nTrades', (r) => r.nTrades],
  ['buyers', (r) => r.buyers],
  ['buySol', (r) => r.buySol],
  ['maxBuySol', (r) => r.maxBuySol],
  ['topShare', (r) => r.topShare],
  ['buyShare', (r) => r.buyShare],
  ['moveBps', (r) => r.moveBps],
  ['depthSol', (r) => r.depthSol],
  ['feeBps', (r) => r.feeBps],
  ['prior', (r) => r.prior],
  ['solPerBuyer', (r) => (r.buyers > 0 ? r.buySol / r.buyers : 0)],
];

interface Rule { label: string; apply: (rows: Row[]) => Row[] }
const rules: Rule[] = [];
for (const [name, f] of FEATURES) {
  rules.push({
    label: `${name} TOP quintile`,
    apply: (rows) => { const s = [...rows].sort((a, b) => f(a) - f(b)); return s.slice(Math.floor(0.8 * s.length)); },
  });
  rules.push({
    label: `${name} BOTTOM quintile`,
    apply: (rows) => { const s = [...rows].sort((a, b) => f(a) - f(b)); return s.slice(0, Math.ceil(0.2 * s.length)); },
  });
}
rules.push({ label: 'bundle == 1', apply: (rows) => rows.filter((r) => r.bundle === 1) });
rules.push({ label: 'bundle == 0', apply: (rows) => rows.filter((r) => r.bundle === 0) });
rules.push({ label: 'prior == 0 (first ever)', apply: (rows) => rows.filter((r) => r.prior === 0) });
rules.push({ label: 'prior >= 1', apply: (rows) => rows.filter((r) => r.prior >= 1) });

console.log('');
console.log(`BASELINE — no selection`);
for (const [tag, rows] of [['A', A], ['B', B]] as [string, Row[]][]) {
  const v = rows.map((r) => r.ret);
  console.log(`  block ${tag}  n=${String(v.length).padStart(5)}  mean ${mean(v).toFixed(0).padStart(7)}  median ${med(v).toFixed(0).padStart(7)}  %pos ${(100 * v.filter((x) => x > 0).length / v.length).toFixed(1)}%`);
}

console.log('');
console.log('THE SEARCH, ON BLOCK A ONLY — all 26 candidates printed so the multiple testing is visible');
console.log('  rule                              n     mean    median    %pos');
const scored = rules.map((r) => {
  const g = r.apply(A);
  return { rule: r, n: g.length, m: g.length >= 50 ? mean(g.map((x) => x.ret)) : NaN, g };
});
for (const s of [...scored].sort((a, b) => (Number.isNaN(b.m) ? -1e18 : b.m) - (Number.isNaN(a.m) ? -1e18 : a.m))) {
  const v = s.g.map((x) => x.ret);
  if (s.g.length < 50) { console.log(`  ${s.rule.label.padEnd(30)} ${String(s.n).padStart(6)}   (under 50 — not scored)`); continue; }
  console.log(`  ${s.rule.label.padEnd(30)} ${String(s.n).padStart(6)} ${s.m.toFixed(0).padStart(8)} ${med(v).toFixed(0).padStart(9)} ${(100 * v.filter((x) => x > 0).length / v.length).toFixed(1).padStart(7)}%`);
}

const best = [...scored].filter((s) => s.g.length >= 50 && Number.isFinite(s.m)).sort((a, b) => b.m - a.m)[0];
if (best === undefined) { console.log('no scorable rule'); process.exit(0); }

console.log('');
console.log('='.repeat(96));
console.log(`SELECTED ON BLOCK A: "${best.rule.label}"   fit mean ${best.m.toFixed(0)} bps on ${best.n} pools`);
console.log('APPLIED UNCHANGED TO BLOCK B — this is the decision');
console.log('');
const gb = best.rule.apply(B);
const vb = gb.map((r) => r.ret);
const [lo, hi] = boot(gb);
const clusters = new Set(gb.map((r) => Math.floor(r.ts / 86400))).size;
console.log(`  n                     ${vb.length}`);
console.log(`  MEAN                  ${mean(vb).toFixed(0)} bps   [95% day-clustered ${lo.toFixed(0)}, ${hi.toFixed(0)}]  over ${clusters} clusters`);
console.log(`  median                ${med(vb).toFixed(0)} bps`);
console.log(`  %positive             ${(100 * vb.filter((x) => x > 0).length / vb.length).toFixed(1)}%`);
console.log(`  top-1% share of mean  ${(100 * topShareOf(vb)).toFixed(0)}%   (reported, does NOT gate)`);
console.log('');
const ratio = Math.abs(best.m) > 0 ? mean(vb) / best.m : NaN;
const gateA = mean(vb) > 0;
const gateB = lo > 0;
const gateC = Number.isFinite(ratio) && ratio > 1 / 3 && ratio < 3;
const gateD = vb.length >= 100;
console.log('FROZEN GATES');
console.log(`  (a) validation mean > 0                      ${gateA ? 'PASS' : 'FAIL'}   ${mean(vb).toFixed(0)} bps`);
console.log(`  (b) 95% day-clustered lower bound > 0        ${gateB ? 'PASS' : 'FAIL'}   ${lo.toFixed(0)} bps`);
console.log(`  (c) B mean within a factor of 3 of A mean    ${gateC ? 'PASS' : 'FAIL'}   ratio ${Number.isFinite(ratio) ? ratio.toFixed(2) : 'n/a'}  (A ${best.m.toFixed(0)} -> B ${mean(vb).toFixed(0)})`);
console.log(`  (d) at least 100 pools survive on B          ${gateD ? 'PASS' : 'FAIL'}   ${vb.length}`);
console.log('');
console.log(`VERDICT: ${gateA && gateB && gateC && gateD ? 'PASS — all four gates' : 'FAIL'}`);
console.log('');
console.log('  A rule fitted on eleven features and taken as the best of twenty-six is inflated on the');
console.log('  fit side by construction. Only the block B column is evidence.');
