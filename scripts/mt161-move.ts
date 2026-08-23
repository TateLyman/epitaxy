/**
 * MT161 — the model is a MOVE detector, not a WINNER detector. Say so, then measure it as one.
 *
 * MT160 asked whether delay-4 information enriches the top 1% of 30-second outcomes into a model's
 * top decile. It does — lift 3.31 on block B and 4.97 on block S — and the same retained decile
 * also held 5 of the 9 WORST outcomes on block B. The model concentrates both tails. It finds
 * pools that will move, not pools that will move up.
 *
 * That is a finding about the TARGET, not a defect in the model, and the honest response is to
 * relabel rather than to keep scoring a magnitude predictor against a direction benchmark. This
 * file does three things:
 *
 *   1. Scores the EXISTING signed-target model against |return|, so the relabelling is measured
 *      rather than asserted. If it is really a move detector, its |return| AUC should EXCEED its
 *      signed-return AUC.
 *   2. Trains a DEDICATED move model on the top decile of |return| and evaluates it the same way.
 *      If magnitude is the thing that is learnable here, training on magnitude should beat
 *      training on direction at the magnitude task.
 *   3. Reports tail enrichment SEPARATELY for each side, because a move detector that leans one
 *      way is a partial direction signal and a move detector that is symmetric is not.
 *
 * WHY THIS MATTERS BEFORE ANYTHING ELSE IS BUILT. A magnitude predictor is only monetisable
 * through an asymmetric payoff — a barrier, a stop, an option. Everything downstream (first
 * passage, sign conditioning, dump risk) is premised on the magnitude signal being real and
 * cross-regime. If it is not, none of the rest is worth building, and it is far cheaper to find
 * that out here.
 *
 * Train on block A only. Standardisation fitted on train only. Blocks B and S are holdouts, and
 * block C is scored the moment it exists.
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
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Row).filter((r) => r.depthSol >= MIN_DEPTH);
};
const FEATS = (r: Row): number[] => [
  Math.log1p(Math.max(0, r.nTrades)), Math.log1p(Math.max(0, r.buyers)),
  Math.log1p(Math.max(0, r.buySol)), Math.log1p(Math.max(0, r.maxBuySol)),
  r.topShare, r.buyShare,
  Math.sign(r.moveBps) * Math.log1p(Math.abs(r.moveBps)),
  Math.log1p(Math.max(0, r.depthSol)), r.feeBps / 100,
  Math.log1p(Math.max(0, r.prior)),
  r.buyers > 0 ? Math.log1p(r.buySol / r.buyers) : 0, r.bundle,
];
const NAMES = ['nTrades', 'buyers', 'buySol', 'maxBuySol', 'topShare', 'buyShare', 'moveBps', 'depthSol', 'feeBps', 'prior', 'solPerBuyer', 'bundle'];

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const qt = (x: number[], p: number): number => { const s = [...x].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };

function fit(X: number[][], y: number[], lambda: number, iters: number): number[] {
  const d = (X[0] ?? []).length;
  const w = new Array<number>(d + 1).fill(0);
  const lr = 0.1;
  for (let it = 0; it < iters; it += 1) {
    const g = new Array<number>(d + 1).fill(0);
    for (let i = 0; i < X.length; i += 1) {
      const xi = X[i] as number[];
      let z = w[d] as number;
      for (let j = 0; j < d; j += 1) z += (w[j] as number) * (xi[j] as number);
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const e = p - (y[i] as number);
      for (let j = 0; j < d; j += 1) g[j] = (g[j] as number) + e * (xi[j] as number);
      g[d] = (g[d] as number) + e;
    }
    for (let j = 0; j < d; j += 1) w[j] = (w[j] as number) - lr * ((g[j] as number) / X.length + lambda * (w[j] as number));
    w[d] = (w[d] as number) - lr * ((g[d] as number) / X.length);
  }
  return w;
}
function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((s, i) => [s, labels[i] as number] as [number, number]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0; let pos = 0; let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as [number, number])[0] === (idx[i] as [number, number])[0]) j += 1;
    const avgRank = (i + j) / 2 + 1;
    for (let t = i; t <= j; t += 1) if ((idx[t] as [number, number])[1] === 1) { rankSum += avgRank; pos += 1; }
    i = j + 1;
  }
  const neg = idx.length - pos;
  return pos === 0 || neg === 0 ? NaN : (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

const A = load('A');
if (A.length === 0) { console.log('no training panel'); process.exit(1); }
const Xa = A.map(FEATS);
const d = (Xa[0] ?? []).length;
const mu: number[] = []; const sd: number[] = [];
for (let j = 0; j < d; j += 1) {
  const c = Xa.map((x) => x[j] as number);
  mu[j] = mean(c);
  const v = Math.sqrt(mean(c.map((x) => (x - (mu[j] as number)) ** 2)));
  sd[j] = v > 1e-9 ? v : 1;
}
const std = (x: number[]): number[] => x.map((v, j) => (v - (mu[j] as number)) / (sd[j] as number));
const Xs = A.map((r) => std(FEATS(r)));
const sc = (w: number[], r: Row): number => {
  const x = std(FEATS(r));
  let z = w[x.length] as number;
  for (let j = 0; j < x.length; j += 1) z += (w[j] as number) * (x[j] as number);
  return z;
};

/** MODEL 1 — the existing one: trained on the top decile of SIGNED return. */
const wSigned = fit(Xs, A.map((r) => (r.ret >= qt(A.map((z) => z.ret), 0.90) ? 1 : 0)), 0.02, 4000);
/** MODEL 2 — dedicated MOVE model: trained on the top decile of |return|. */
const absThr = qt(A.map((r) => Math.abs(r.ret)), 0.90);
const wMove = fit(Xs, A.map((r) => (Math.abs(r.ret) >= absThr ? 1 : 0)), 0.02, 4000);

console.log('MT161 — MOVE, not WINNER. Both models trained on block A only.');
console.log(`  signed model target: top decile of ret        (${A.filter((r) => r.ret >= qt(A.map((z) => z.ret), 0.90)).length} positives)`);
console.log(`  MOVE model target:   top decile of |ret|      (${A.filter((r) => Math.abs(r.ret) >= absThr).length} positives)`);
console.log('');
console.log('  MOVE model weights (standardised)');
for (const [n, v] of NAMES.map((n, j) => [n, wMove[j] as number] as [string, number]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
  console.log(`    ${n.padEnd(12)} ${v >= 0 ? '+' : ''}${v.toFixed(3)}`);
}

console.log('');
console.log('  AUC — is it a magnitude detector or a direction detector?');
console.log('  corpus     n   signed-model: AUC(up10%)  AUC(|ret|10%)   MOVE-model: AUC(up10%)  AUC(|ret|10%)');
for (const tag of ['A', 'B', 'C', 'D']) {
  const R = tag === 'A' ? A : load(tag);
  if (R.length === 0) { if (tag === 'C') console.log('  block C    (not built yet)'); continue; }
  const up = R.map((r) => (r.ret >= qt(R.map((z) => z.ret), 0.90) ? 1 : 0));
  const ab = R.map((r) => (Math.abs(r.ret) >= qt(R.map((z) => Math.abs(z.ret)), 0.90) ? 1 : 0));
  const s1 = R.map((r) => sc(wSigned, r)); const s2 = R.map((r) => sc(wMove, r));
  const tail = tag === 'A' ? '  <- TRAIN' : '';
  console.log(
    `  ${('block ' + tag).padEnd(9)} ${String(R.length).padStart(4)} ${auc(s1, up).toFixed(3).padStart(22)} ${auc(s1, ab).toFixed(3).padStart(14)} ${auc(s2, up).toFixed(3).padStart(23)} ${auc(s2, ab).toFixed(3).padStart(14)}${tail}`,
  );
}

console.log('');
console.log('  EXTREME-MOVE CAPTURE and PER-SIDE TAIL ENRICHMENT — MOVE model, its top decile');
console.log('  corpus   kept   |ret| top1% caught   UP top1%   DOWN bottom1%   symmetry   kept mean / median');
for (const tag of ['A', 'B', 'C', 'D']) {
  const R = tag === 'A' ? A : load(tag);
  if (R.length === 0) continue;
  const rets = R.map((r) => r.ret);
  const aThr = qt(rets.map(Math.abs), 0.99);
  const uThr = qt(rets, 0.99); const dThr = qt(rets, 0.01);
  const n = Math.max(1, Math.round(0.10 * R.length));
  const keep = R.map((r, i) => [sc(wMove, r), i] as [number, number]).sort((a, b) => b[0] - a[0]).slice(0, n).map(([, i]) => i);
  const kAbs = keep.filter((i) => Math.abs(rets[i] as number) >= aThr).length;
  const kUp = keep.filter((i) => (rets[i] as number) >= uThr).length;
  const kDn = keep.filter((i) => (rets[i] as number) <= dThr).length;
  const KA = rets.filter((x) => Math.abs(x) >= aThr).length;
  const KU = rets.filter((x) => x >= uThr).length; const KD = rets.filter((x) => x <= dThr).length;
  const kept = keep.map((i) => rets[i] as number);
  const sym = kUp + kDn > 0 ? kUp / (kUp + kDn) : NaN;
  const tail = tag === 'A' ? '  <- TRAIN' : '';
  console.log(
    `  ${('blk ' + tag).padEnd(8)} ${String(n).padStart(4)} ${`${kAbs}/${KA}`.padStart(17)} ${`${kUp}/${KU}`.padStart(10)} ${`${kDn}/${KD}`.padStart(15)} ${(Number.isFinite(sym) ? (100 * sym).toFixed(0) + '% up' : 'n/a').padStart(10)} ${mean(kept).toFixed(0).padStart(10)} / ${med(kept).toFixed(0)}${tail}`,
  );
}
console.log('');
console.log('  A symmetry near 50% means the detector is pure magnitude and carries NO direction.');
console.log('  Only an asymmetric payoff — a barrier, a stop, an option — can monetise that.');
