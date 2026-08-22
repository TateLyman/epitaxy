/**
 * MT158 confirmation — the frozen rule, on a third corpus with a REAL cluster count.
 *
 * MT158 passed all four preregistered gates fitting on block A and validating on block B, and it
 * survived four adversarial checks: it is not degenerate (median 18 distinct buyers in the selected
 * bucket, only 5 of 177 with none), it is not a single-outlier artifact (dropping the best five of
 * 177 still leaves +181 and the MEDIAN is +53), it replicates when the split is reversed (fitting
 * on B puts the same family top and it validates on A at +1,205), and it is LESS contaminated by
 * misclassified pools than the population it is drawn from, 2.3% against 3.0%.
 *
 * ONE WEAKNESS REMAINS AND IT IS THE ONE THIS PROGRAMME KEEPS TRIPPING OVER. Both blocks are three
 * days long, so every interval quoted rests on THREE day clusters against the ten-cluster floor
 * MT108 set. MT152 and MT153 were both quoted below that floor and MT154 had to walk them back.
 * The eighteen staggered daily windows give EIGHTEEN clusters and are independent of both blocks.
 *
 * NOTHING IS REFITTED HERE. The rule — bottom quintile of top-buyer share, among pools with at
 * least 40 SOL of depth at entry, entering at delay 4 and holding 30 seconds — is applied exactly
 * as block A produced it. The only thing this file decides is whether it survives.
 *
 * THE SLICED CORPUS CARRIES A KNOWN WEAKNESS OF ITS OWN, declared rather than buried: a 2.2-hour
 * window cannot establish a pool's true birth, so a 300-slot burn-in and the 40 SOL depth floor
 * stand in for the two-pass detection the continuous blocks get. Residual contamination is
 * possible and would work against a rule that MT158 showed is contamination-averse.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { readFileSync, existsSync } from 'node:fs';

interface Row {
  pool: string; creator: string; bornSlot: number; ts: number; ret: number;
  nTrades: number; buyers: number; bundle: number; buySol: number; maxBuySol: number;
  topShare: number; buyShare: number; moveBps: number; depthSol: number; feeBps: number; prior: number;
}
const MIN_DEPTH = 40;
const load = (tag: string): Row[] => {
  const f = `data/panel/runner-${tag}.jsonl`;
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Row).filter((r) => r.depthSol >= MIN_DEPTH);
};
/** THE FROZEN RULE. Bottom quintile of top-buyer share. Not refitted. */
const RULE = (rows: Row[]): Row[] => {
  const s = [...rows].sort((a, b) => a.topShare - b.topShare);
  return s.slice(0, Math.ceil(0.2 * s.length));
};

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const dropTop = (x: number[], k: number): number[] => { const s = [...x].sort((a, b) => b - a); return s.slice(k); };
function boot(items: Row[]): [number, number, number] {
  const byDay = new Map<number, number[]>();
  for (const it of items) { const d = Math.floor(it.ts / 86400); const a = byDay.get(d) ?? []; a.push(it.ret); byDay.set(d, a); }
  const days = [...byDay.values()];
  if (days.length < 2) return [NaN, NaN, days.length];
  let seed = 20260822;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ms: number[] = [];
  for (let r = 0; r < 2000; r += 1) {
    const pick: number[] = [];
    for (let i = 0; i < days.length; i += 1) { const dd = days[Math.floor(rnd() * days.length)]; if (dd) pick.push(...dd); }
    if (pick.length) ms.push(mean(pick));
  }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(0.025 * ms.length)] ?? NaN, ms[Math.floor(0.975 * ms.length)] ?? NaN, days.length];
}

console.log('MT158 CONFIRMATION — the frozen rule on three corpora, nothing refitted');
console.log('  rule: bottom quintile of top-buyer share, depth at entry >= 40 SOL, enter delay 4, hold 30s');
console.log('');
console.log('  corpus        all pools   selected     MEAN  [95% day-clustered CI]   clusters   median   %pos   drop5   drop10');
for (const tag of ['A', 'B', 'S']) {
  const all = load(tag);
  if (all.length === 0) { console.log(`  ${tag.padEnd(12)} (missing)`); continue; }
  const g = RULE(all);
  const v = g.map((r) => r.ret);
  const [lo, hi, cl] = boot(g);
  console.log(
    `  ${('block ' + tag).padEnd(12)} ${String(all.length).padStart(9)} ${String(v.length).padStart(10)} ${mean(v).toFixed(0).padStart(8)}  [${lo.toFixed(0).padStart(7)},${hi.toFixed(0).padStart(7)}] ${String(cl).padStart(10)} ${med(v).toFixed(0).padStart(8)} ${(100 * v.filter((x) => x > 0).length / v.length).toFixed(1).padStart(6)}% ${mean(dropTop(v, 5)).toFixed(0).padStart(7)} ${mean(dropTop(v, 10)).toFixed(0).padStart(8)}`,
  );
}
console.log('');
const S = load('S');
if (S.length > 0) {
  const g = RULE(S); const v = g.map((r) => r.ret);
  const [lo, , cl] = boot(g);
  const base = mean(S.map((r) => r.ret));
  console.log(`  UNSELECTED BASELINE on the same corpus: ${base.toFixed(0)} bps — the rule must beat this, not just zero`);
  console.log(`  selected minus baseline: ${(mean(v) - base).toFixed(0)} bps`);
  console.log('');
  console.log(`VERDICT on ${cl} clusters: mean ${mean(v).toFixed(0)}, lower bound ${lo.toFixed(0)} — ${lo > 0 && mean(v) > base ? 'HOLDS' : 'DOES NOT HOLD'}`);
}
console.log('');
console.log('  Three days give three clusters. MT108 set a ten-cluster floor and MT154 had to walk back');
console.log('  two rows quoted below it. The eighteen-window column is the only properly powered one.');
