/**
 * MT160 — can delay-4 information ENRICH the eventual top-1% 30-second winners into a model's
 * top decile, while rejecting the other 99%?
 *
 * This is a better-posed question than the one MT157 and MT158 answered, and it is the operator's.
 * Those asked whether a selected subset has a positive MEAN, and the mean on this population is
 * dominated by single observations - one pool contributed 58% of block B's mean - so it is not an
 * estimable quantity at this sample size. ENRICHMENT does not have that problem. It asks a
 * ranking question with a discrete answer: of the pools that actually ended up in the top 1% of
 * 30-second outcomes, how many did the model put in its top 10%? That is a count, and a count has
 * an exact null distribution.
 *
 * THE DESIGN, AND WHY EACH PIECE IS THERE.
 *
 *   TRAINED ON THE TOP DECILE, TESTED ON THE TOP PERCENTILE. Training directly on the top 1% is
 *   not possible at this sample size - about 9 positives per corpus - so the model learns to
 *   identify top-DECILE outcomes, where there are ~88 positives, and is then asked whether the
 *   extreme tail is enriched inside its top decile. The thing being predicted is never the thing
 *   being scored.
 *
 *   STANDARDISATION IS FITTED ON TRAIN ONLY. Feature means and standard deviations come from block
 *   A and are applied unchanged to every validation corpus. Re-standardising per corpus would leak.
 *
 *   THE NULL IS EXACT, NOT BOOTSTRAPPED. If the model carried no information, its top decile would
 *   contain a hypergeometric draw of the true top-1% pools. So the p-value is a hypergeometric tail
 *   probability, which needs no resampling and no distributional assumption. A permutation control
 *   is also run - the same pipeline with training labels shuffled - because an exact null on the
 *   validation set does not by itself prove the PIPELINE is unbiased.
 *
 *   REJECTION IS REPORTED AS A COST, NOT ASSUMED. "Materially rejecting the other 99%" is only
 *   valuable if what survives pays. So the mean and median return of the retained decile are
 *   reported next to the capture rate, and a rule that enriches winners while still losing money
 *   is reported as exactly that.
 *
 * HONEST POWER WARNING, STATED UP FRONT. A corpus of ~880 pools has ~9 pools in its top 1%. Under
 * the null a top-decile selection captures 0.9 of them on average. Distinguishing "captures 3" from
 * chance is possible; distinguishing "captures 2" is not. Every capture count below is small and
 * the confidence intervals are correspondingly wide.
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

/** Delay-4 feature vector. Heavy-tailed quantities enter as log1p so one whale cannot dominate. */
const FEATS = (r: Row): number[] => [
  Math.log1p(Math.max(0, r.nTrades)),
  Math.log1p(Math.max(0, r.buyers)),
  Math.log1p(Math.max(0, r.buySol)),
  Math.log1p(Math.max(0, r.maxBuySol)),
  r.topShare,
  r.buyShare,
  Math.sign(r.moveBps) * Math.log1p(Math.abs(r.moveBps)),
  Math.log1p(Math.max(0, r.depthSol)),
  r.feeBps / 100,
  Math.log1p(Math.max(0, r.prior)),
  r.buyers > 0 ? Math.log1p(r.buySol / r.buyers) : 0,
  r.bundle,
];
const FEAT_NAMES = ['nTrades', 'buyers', 'buySol', 'maxBuySol', 'topShare', 'buyShare', 'moveBps', 'depthSol', 'feeBps', 'prior', 'solPerBuyer', 'bundle'];

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const quantile = (x: number[], p: number): number => { const s = [...x].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };

/** L2-regularised logistic regression, plain gradient descent. Small data, small model. */
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
const score = (w: number[], x: number[]): number => {
  let z = w[x.length] as number;
  for (let j = 0; j < x.length; j += 1) z += (w[j] as number) * (x[j] as number);
  return z;
};

/** log C(n,k) via lgamma, so hypergeometric tails stay stable at these sizes. */
function lgamma(z: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0] as number;
  for (let i = 1; i < g + 2; i += 1) x += (c[i] as number) / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const logC = (n: number, k: number): number => (k < 0 || k > n ? -Infinity : lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1));
/** P(X >= k) for X ~ Hypergeometric(N population, K successes, n draws). */
function hyperTail(N: number, K: number, n: number, k: number): number {
  let p = 0;
  const denom = logC(N, n);
  for (let i = k; i <= Math.min(K, n); i += 1) p += Math.exp(logC(K, i) + logC(N - K, n - i) - denom);
  return Math.min(1, Math.max(0, p));
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
  if (pos === 0 || neg === 0) return NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

const TRAIN = 'A';
const trainRows = load(TRAIN);
if (trainRows.length === 0) { console.log('no training panel'); process.exit(1); }

/** Standardisation fitted on TRAIN ONLY. */
const Xtr_raw = trainRows.map(FEATS);
const d = (Xtr_raw[0] ?? []).length;
const mu = new Array<number>(d).fill(0); const sd = new Array<number>(d).fill(1);
for (let j = 0; j < d; j += 1) {
  const col = Xtr_raw.map((x) => x[j] as number);
  mu[j] = mean(col);
  const v = mean(col.map((x) => (x - (mu[j] as number)) ** 2));
  sd[j] = Math.sqrt(v) > 1e-9 ? Math.sqrt(v) : 1;
}
const std = (x: number[]): number[] => x.map((v, j) => (v - (mu[j] as number)) / (sd[j] as number));
const Xtr = Xtr_raw.map(std);

/** TARGET: top decile of 30s outcome on the training corpus. ~88 positives, not ~9. */
const trThresh = quantile(trainRows.map((r) => r.ret), 0.90);
const ytr = trainRows.map((r) => (r.ret >= trThresh ? 1 : 0));
const w = fit(Xtr, ytr, 0.02, 4000);

console.log('MT160 — can delay-4 information enrich the eventual top-1% into the model top 10%?');
console.log(`  trained on block ${TRAIN}: ${trainRows.length} pools, target = top decile of 30s return (${ytr.reduce((a, b) => a + b, 0)} positives)`);
console.log(`  standardisation fitted on train only; L2 logistic, 12 delay-4 features`);
console.log('');
console.log('  learned weights (standardised, so magnitudes are comparable)');
const order = FEAT_NAMES.map((n, j) => [n, w[j] as number] as [string, number]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
for (const [n, v] of order) console.log(`    ${n.padEnd(12)} ${v >= 0 ? '+' : ''}${v.toFixed(3)}`);

console.log('');
console.log('  corpus     n    top1% n   AUC(top10%)   captured in model top-10%   lift    exact p     retained decile: mean / median bps');
for (const tag of ['A', 'B', 'S', 'C']) {
  const rows = tag === TRAIN ? trainRows : load(tag);
  if (rows.length === 0) { if (tag === 'C') console.log('  block C    (not built yet)'); continue; }
  const sc = rows.map((r) => score(w, std(FEATS(r))));
  const rets = rows.map((r) => r.ret);
  const t1 = quantile(rets, 0.99);
  const t10 = quantile(rets, 0.90);
  const isTop1 = rows.map((r) => (r.ret >= t1 ? 1 : 0));
  const isTop10 = rows.map((r) => (r.ret >= t10 ? 1 : 0));
  const K = isTop1.reduce((a, b) => a + b, 0);

  /** The model's top decile. */
  const nDraw = Math.max(1, Math.round(0.10 * rows.length));
  const rank = sc.map((s, i) => [s, i] as [number, number]).sort((a, b) => b[0] - a[0]);
  const chosen = new Set(rank.slice(0, nDraw).map(([, i]) => i));
  const k = [...chosen].reduce((a, i) => a + (isTop1[i] as number), 0);
  const p = hyperTail(rows.length, K, nDraw, k);
  const lift = K > 0 ? (k / nDraw) / (K / rows.length) : NaN;
  const kept = [...chosen].map((i) => rets[i] as number);
  const a10 = auc(sc, isTop10);
  const flag = tag === TRAIN ? '  <- TRAIN (in-sample, not evidence)' : '';
  console.log(
    `  ${('block ' + tag).padEnd(9)} ${String(rows.length).padStart(4)} ${String(K).padStart(9)} ${(Number.isFinite(a10) ? a10.toFixed(3) : 'n/a').padStart(13)} ${`${k} of ${K}`.padStart(27)} ${(Number.isFinite(lift) ? lift.toFixed(2) : 'n/a').padStart(6)} ${p.toFixed(3).padStart(10)} ${mean(kept).toFixed(0).padStart(15)} / ${med(kept).toFixed(0)}${flag}`,
  );
}

/**
 * PERMUTATION CONTROL. The hypergeometric null covers the validation draw, but not the pipeline.
 * Refitting on SHUFFLED training labels and re-scoring gives the distribution of capture counts
 * this whole procedure produces when the training signal is destroyed.
 */
console.log('');
console.log('  PERMUTATION CONTROL — same pipeline, training labels shuffled, MATCHED 4000 iterations');
console.log('  (a control fitted for fewer iterations than the real model is not the same pipeline)');
let seed = 20260822;
const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (const tag of ['B', 'S']) {
  const rows = load(tag);
  if (rows.length === 0) continue;
  const rets = rows.map((r) => r.ret);
  const t1 = quantile(rets, 0.99);
  const isTop1 = rows.map((r) => (r.ret >= t1 ? 1 : 0));
  const K = isTop1.reduce((a, b) => a + b, 0);
  const nDraw = Math.max(1, Math.round(0.10 * rows.length));
  const caps: number[] = [];
  for (let rep = 0; rep < 100; rep += 1) {
    const yp = [...ytr];
    for (let i = yp.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); const t = yp[i] as number; yp[i] = yp[j] as number; yp[j] = t; }
    const wp = fit(Xtr, yp, 0.02, 4000);
    const sp = rows.map((r) => score(wp, std(FEATS(r))));
    const rk = sp.map((s, i) => [s, i] as [number, number]).sort((a, b) => b[0] - a[0]);
    caps.push(rk.slice(0, nDraw).reduce((a, [, i]) => a + (isTop1[i] as number), 0));
  }
  caps.sort((a, b) => a - b);
  console.log(`  block ${tag}: shuffled capture of ${K} top-1% pools — median ${med(caps).toFixed(1)}, 95th pct ${(caps[Math.floor(0.95 * caps.length)] ?? NaN)}, max ${caps[caps.length - 1]}`);
}
console.log('');
console.log(`  With ~9 pools in a corpus top 1%, a top-decile selection captures ~0.9 by chance.`);
console.log(`  Enrichment is only readable if the capture count is well clear of that, and the`);
console.log(`  retained decile must also PAY - enriching winners while still losing money is not a strategy.`);
