/**
 * MT165 — SIGN. Conditional on a big move happening, can we call which way?
 *
 * MT161 established that the delay-4 model is a MAGNITUDE detector: |return| AUC of 0.71 to 0.80
 * out of sample, and of the extremes it captures, 43% are up on two of three corpora. Direction was
 * absent. MT162 then showed the magnitude signal IS monetisable through a wide symmetric barrier —
 * half-Kelly growth of roughly +0.007 per trade on two corpora, surviving four trades of execution
 * lag — but that strategy is direction-agnostic by construction: it profits from the pool moving,
 * whichever way, and pays the down-crossings in full.
 *
 * So the question this asks is narrow and it is the right one: GIVEN that a pool is going to move
 * sharply, is the SIGN of that move predictable from what we know at delay 4? Every basis point of
 * direction is worth more here than magnitude, because the barrier already harvests magnitude and
 * the down-crossings are its entire cost.
 *
 * THE POPULATION IS DELIBERATELY RESTRICTED, and that is the operator's design. Training a sign
 * model on the whole corpus would mostly learn to separate "moves" from "does not move", which
 * MT161 already did. Restricting to pools whose |return| is actually extreme forces the model to
 * spend its capacity on direction alone. It also means the model is only ever applied where the
 * MOVE head has already fired, which is how it will be used.
 *
 * THE FEATURE SET IS THE UNION OF TWO FAMILIES, and the second is the interesting one:
 *   - the twelve delay-4 microstructure features from MT158
 *   - the MELT-derived DUMP_RISK family from MT164, whose two strongest members are slot0Share and
 *     churnRatio. Those measure whether the cheap early cohort has ALREADY STARTED SELLING by delay
 *     4, and MT164 found them separating the high-risk label at 0.303 against 0.984 and 0.724
 *     against 0.000. If anything carries direction, it should be those: a cohort that is already
 *     distributing is a cohort that will keep distributing.
 *
 * Regularised logistic first, as specified. A linear model that fails here fails for a reason worth
 * knowing before any gradient-boosted model is allowed to memorise 90 observations.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { readFileSync, existsSync } from 'node:fs';

interface RRow { pool: string; ts: number; ret: number; nTrades: number; buyers: number; bundle: number;
  buySol: number; maxBuySol: number; topShare: number; buyShare: number; moveBps: number;
  depthSol: number; feeBps: number; prior: number }
interface DRow { pool: string; entities: number; coordShare: number; topEntityShare: number;
  slot0Share: number; lowCostBase: number; liqImpactBps: number; washWallets: number;
  churnRatio: number; meltRatio: number; meltHighRisk: number }
interface Joined extends RRow, Omit<DRow, 'pool'> {}

const MIN_DEPTH = 40;
function load(tag: string): Joined[] {
  const rf = `data/panel/runner-${tag}.jsonl`;
  const df = `data/panel/dumprisk-${tag}.jsonl`;
  if (!existsSync(rf) || !existsSync(df)) return [];
  const dmap = new Map<string, DRow>();
  for (const l of readFileSync(df, 'utf8').split('\n')) { if (l.length === 0) continue; const d = JSON.parse(l) as DRow; dmap.set(d.pool, d); }
  const out: Joined[] = [];
  for (const l of readFileSync(rf, 'utf8').split('\n')) {
    if (l.length === 0) continue;
    const r = JSON.parse(l) as RRow;
    if (r.depthSol < MIN_DEPTH) continue;
    const d = dmap.get(r.pool);
    if (d === undefined) continue;
    out.push({ ...r, entities: d.entities, coordShare: d.coordShare, topEntityShare: d.topEntityShare,
      slot0Share: d.slot0Share, lowCostBase: d.lowCostBase, liqImpactBps: d.liqImpactBps,
      washWallets: d.washWallets, churnRatio: d.churnRatio, meltRatio: d.meltRatio, meltHighRisk: d.meltHighRisk });
  }
  return out;
}
const FEATS = (r: Joined): number[] => [
  Math.log1p(Math.max(0, r.nTrades)), Math.log1p(Math.max(0, r.buyers)),
  Math.log1p(Math.max(0, r.buySol)), Math.log1p(Math.max(0, r.maxBuySol)),
  r.topShare, r.buyShare, Math.sign(r.moveBps) * Math.log1p(Math.abs(r.moveBps)),
  Math.log1p(Math.max(0, r.depthSol)), r.feeBps / 100, Math.log1p(Math.max(0, r.prior)), r.bundle,
  // DUMP_RISK family
  Math.log1p(Math.max(0, r.entities)), r.coordShare, r.topEntityShare, r.slot0Share,
  Math.log1p(Math.max(0, r.lowCostBase)),
  Math.sign(r.liqImpactBps) * Math.log1p(Math.abs(r.liqImpactBps)),
  Math.log1p(Math.max(0, r.washWallets)), Math.min(3, r.churnRatio),
];
const NAMES = ['nTrades', 'buyers', 'buySol', 'maxBuySol', 'topShare', 'buyShare', 'moveBps', 'depthSol',
  'feeBps', 'prior', 'bundle', 'entities', 'coordShare', 'topEntityShare', 'slot0Share', 'lowCostBase',
  'liqImpactBps', 'washWallets', 'churnRatio'];

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const qt = (x: number[], p: number): number => { const s = [...x].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
function fitLR(X: number[][], y: number[], lam: number, iters: number): number[] {
  const d = (X[0] ?? []).length; const w = new Array<number>(d + 1).fill(0); const lr = 0.1;
  for (let it = 0; it < iters; it += 1) {
    const g = new Array<number>(d + 1).fill(0);
    for (let i = 0; i < X.length; i += 1) {
      const xi = X[i] as number[]; let z = w[d] as number;
      for (let j = 0; j < d; j += 1) z += (w[j] as number) * (xi[j] as number);
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const e = p - (y[i] as number);
      for (let j = 0; j < d; j += 1) g[j] = (g[j] as number) + e * (xi[j] as number);
      g[d] = (g[d] as number) + e;
    }
    for (let j = 0; j < d; j += 1) w[j] = (w[j] as number) - lr * ((g[j] as number) / X.length + lam * (w[j] as number));
    w[d] = (w[d] as number) - lr * ((g[d] as number) / X.length);
  }
  return w;
}
function auc(s: number[], y: number[]): number {
  const idx = s.map((v, i) => [v, y[i] as number] as [number, number]).sort((a, b) => a[0] - b[0]);
  let rs = 0; let pos = 0; let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as [number, number])[0] === (idx[i] as [number, number])[0]) j += 1;
    const ar = (i + j) / 2 + 1;
    for (let t = i; t <= j; t += 1) if ((idx[t] as [number, number])[1] === 1) { rs += ar; pos += 1; }
    i = j + 1;
  }
  const neg = idx.length - pos;
  return pos === 0 || neg === 0 ? NaN : (rs - (pos * (pos + 1)) / 2) / (pos * neg);
}

const A = load('A');
if (A.length === 0) { console.log('need runner-A and dumprisk-A'); process.exit(1); }
console.log(`MT165 — SIGN conditional on a big move. Joined panels: A=${A.length}`);

/** THE RESTRICTED POPULATION: pools whose |return| is in the top decile of their own corpus. */
const extremeOf = (R: Joined[]): Joined[] => {
  const t = qt(R.map((r) => Math.abs(r.ret)), 0.90);
  return R.filter((r) => Math.abs(r.ret) >= t);
};
const Aex = extremeOf(A);
console.log(`  training population: ${Aex.length} extreme-|move| pools from block A`);
console.log(`  of which UP: ${Aex.filter((r) => r.ret > 0).length}  DOWN: ${Aex.filter((r) => r.ret <= 0).length}`);

const Xr = Aex.map(FEATS); const d = (Xr[0] ?? []).length;
const mu: number[] = []; const sd: number[] = [];
for (let j = 0; j < d; j += 1) {
  const c = Xr.map((x) => x[j] as number); mu[j] = mean(c);
  const v = Math.sqrt(mean(c.map((x) => (x - (mu[j] as number)) ** 2))); sd[j] = v > 1e-9 ? v : 1;
}
const std = (x: number[]): number[] => x.map((v, j) => (v - (mu[j] as number)) / (sd[j] as number));
const y = Aex.map((r) => (r.ret > 0 ? 1 : 0));
const w = fitLR(Aex.map((r) => std(FEATS(r))), y, 0.05, 4000);
const sc = (r: Joined): number => {
  const x = std(FEATS(r)); let z = w[x.length] as number;
  for (let j = 0; j < x.length; j += 1) z += (w[j] as number) * (x[j] as number);
  return z;
};

console.log('');
console.log('  SIGN model weights (standardised; positive means "predicts UP")');
for (const [n, v] of NAMES.map((n, j) => [n, w[j] as number] as [string, number]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 10)) {
  console.log(`    ${n.padEnd(14)} ${v >= 0 ? '+' : ''}${v.toFixed(3)}`);
}

console.log('');
console.log('  DIRECTION AUC among extreme movers — 0.500 is a coin flip and is the null here');
console.log('  corpus     n extreme   up    down   AUC(sign)   top-half mean/median   bottom-half mean/median');
for (const tag of ['A', 'B', 'S', 'C']) {
  const R = tag === 'A' ? A : load(tag);
  if (R.length === 0) { if (tag === 'C') console.log('  block C    (not built yet)'); continue; }
  const E = extremeOf(R);
  if (E.length < 30) continue;
  const s = E.map(sc); const lab = E.map((r) => (r.ret > 0 ? 1 : 0));
  const order = E.map((_r, i) => [s[i] as number, i] as [number, number]).sort((a, b) => b[0] - a[0]);
  const half = Math.floor(order.length / 2);
  const top = order.slice(0, half).map(([, i]) => (E[i] as Joined).ret);
  const bot = order.slice(half).map(([, i]) => (E[i] as Joined).ret);
  const flag = tag === 'A' ? '  <- TRAIN' : '';
  console.log(
    `  ${('block ' + tag).padEnd(9)} ${String(E.length).padStart(9)} ${String(lab.filter((x) => x === 1).length).padStart(5)} ${String(lab.filter((x) => x === 0).length).padStart(6)} ${auc(s, lab).toFixed(3).padStart(11)} ${(mean(top).toFixed(0) + ' / ' + med(top).toFixed(0)).padStart(22)} ${(mean(bot).toFixed(0) + ' / ' + med(bot).toFixed(0)).padStart(25)}${flag}`,
  );
}

console.log('');
console.log('  UNIVARIATE DIRECTION CHECK — does any single feature separate up-extremes from down?');
console.log('  feature          A up p50   A down p50   B up p50   B down p50   S up p50   S down p50');
const B = load('B'); const S = load('S');
for (const [name, f] of [['slot0Share', (r: Joined) => r.slot0Share], ['churnRatio', (r: Joined) => r.churnRatio],
  ['topEntityShare', (r: Joined) => r.topEntityShare], ['liqImpactBps', (r: Joined) => r.liqImpactBps],
  ['coordShare', (r: Joined) => r.coordShare], ['buyers', (r: Joined) => r.buyers],
  ['topShare', (r: Joined) => r.topShare]] as [string, (r: Joined) => number][]) {
  const cells: string[] = [];
  for (const R of [A, B, S]) {
    if (R.length === 0) { cells.push('-', '-'); continue; }
    const E = extremeOf(R);
    cells.push(med(E.filter((r) => r.ret > 0).map(f)).toFixed(2), med(E.filter((r) => r.ret <= 0).map(f)).toFixed(2));
  }
  console.log(`  ${name.padEnd(16)} ${cells.map((c) => c.padStart(10)).join(' ')}`);
}
console.log('');
console.log('  A sign AUC near 0.5 out of sample means direction is not there, and the barrier of');
console.log('  MT162 — which is direction-agnostic on purpose — remains the only way to use the move signal.');
