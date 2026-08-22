/**
 * MT162 — FIRST PASSAGE. Can a magnitude signal be converted into direction by an asymmetric payoff?
 *
 * MT161 established what the model actually is. Its |return| AUC reaches 0.80 out of sample, so it
 * genuinely predicts MAGNITUDE; but of the extreme outcomes it captures, 43% are up on block A and
 * block B and 71% on block S. On two of three corpora it carries no direction at all. A pure
 * magnitude predictor is monetisable only through an asymmetric payoff, and this is the cheapest
 * possible test of whether that works here.
 *
 * WHAT FIRST PASSAGE ASKS. Buy at delay 4 in a pool the MOVE model puts in its top decile, then
 * follow the position forward and record WHICH BARRIER IS TOUCHED FIRST — a profit target or a
 * stop. If the process were a driftless random walk, the probability of touching a +X barrier
 * before a -X barrier is 50% and no choice of barriers can produce a positive expectation. Any
 * departure from 50% on symmetric barriers IS directional edge, and it is measured here without
 * needing the mean return, which MT160 showed is not estimable on this population.
 *
 * THE BARRIER IS ON THE EXECUTABLE MARK, NOT THE MID PRICE. At every subsequent trade the position
 * is marked by pricing an actual SELL of everything we hold, through the constant product, at the
 * pool's own unclamped charge, into reserves that already carry our own entry footprint. A ±10%
 * barrier on the mid price is not a ±10% barrier on what we could realise, and on pools this thin
 * the difference is most of the number.
 *
 * GAPS ARE HONOURED. When a barrier is crossed the position is booked at the ACTUAL mark of the
 * crossing trade, not at the barrier level. A stop does not protect you from a move that jumps
 * over it, and the 10th percentile of this population is -5,955 bps, so that is not a hypothetical.
 *
 * THE OPTIMISM THAT REMAINS, DECLARED. Exit is assumed to happen at the observed trade that
 * crosses the barrier. In reality a stop requires observing the cross and landing a transaction,
 * which is at least a slot later and possibly several. This test is therefore an UPPER BOUND on
 * what a barrier strategy achieves, and it is only worth refining if the upper bound is positive.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const TAG = arg('tag') ?? 'B';
const WINDOWS = (arg('windows') ?? 'b0,b1,b2,b3,b4,b5,b6,b7').split(',').filter((s) => s.length > 0);
const ANALYZE = new Set((arg('analyze') ?? 'b1,b2,b3,b4,b5,b6,b7').split(',').filter((s) => s.length > 0));
const DELAY = 4;
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const NONAMM_BPS = 23;
const MIN_DEPTH = 40;
const V_CANDIDATES = [0n, 17_584_500_000n];
const CAPS_S = [30, 120, 300];
/** Symmetric first — any departure from 50% is directional edge. Then asymmetric payoffs. */
const SYMMETRIC = [1000, 2000, 3000, 5000];
const ASYMMETRIC: [number, number][] = [[3000, 1000], [5000, 1000], [2000, 1000], [5000, 2000], [10000, 2000]];

interface Row { pool: string; ts: number; ret: number; nTrades: number; buyers: number; bundle: number;
  buySol: number; maxBuySol: number; topShare: number; buyShare: number; moveBps: number;
  depthSol: number; feeBps: number; prior: number; creator: string; bornSlot: number }
const loadPanel = (t: string): Row[] => {
  const f = `data/panel/runner-${t}.jsonl`;
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Row).filter((r) => r.depthSol >= MIN_DEPTH);
};
const FEATS = (r: Row): number[] => [
  Math.log1p(Math.max(0, r.nTrades)), Math.log1p(Math.max(0, r.buyers)),
  Math.log1p(Math.max(0, r.buySol)), Math.log1p(Math.max(0, r.maxBuySol)),
  r.topShare, r.buyShare, Math.sign(r.moveBps) * Math.log1p(Math.abs(r.moveBps)),
  Math.log1p(Math.max(0, r.depthSol)), r.feeBps / 100, Math.log1p(Math.max(0, r.prior)),
  r.buyers > 0 ? Math.log1p(r.buySol / r.buyers) : 0, r.bundle];
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

/** MOVE model, fitted on block A only, exactly as MT161. */
const A = loadPanel('A');
const XaR = A.map(FEATS); const dF = (XaR[0] ?? []).length;
const mu: number[] = []; const sdv: number[] = [];
for (let j = 0; j < dF; j += 1) {
  const c = XaR.map((x) => x[j] as number); mu[j] = mean(c);
  const s = Math.sqrt(mean(c.map((x) => (x - (mu[j] as number)) ** 2))); sdv[j] = s > 1e-9 ? s : 1;
}
const std = (x: number[]): number[] => x.map((v, j) => (v - (mu[j] as number)) / (sdv[j] as number));
const absThr = qt(A.map((r) => Math.abs(r.ret)), 0.90);
const wMove = fitLR(A.map((r) => std(FEATS(r))), A.map((r) => (Math.abs(r.ret) >= absThr ? 1 : 0)), 0.02, 4000);
const scoreOf = (r: Row): number => {
  const x = std(FEATS(r)); let z = wMove[x.length] as number;
  for (let j = 0; j < x.length; j += 1) z += (wMove[j] as number) * (x[j] as number);
  return z;
};

const panel = loadPanel(TAG);
if (panel.length === 0) { console.log(`no panel for ${TAG}`); process.exit(1); }
const nKeep = Math.max(1, Math.round(0.10 * panel.length));
const watch = new Map<string, Row>();
for (const [, r] of panel.map((r) => [scoreOf(r), r] as [number, Row]).sort((a, b) => b[0] - a[0]).slice(0, nKeep)) watch.set(r.pool, r);
console.log(`MT162 — first passage on the MOVE model's top decile of block ${TAG}: ${watch.size} pools`);

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; qa: bigint; ua: bigint }
const evsOf = new Map<string, Ev[]>();
for (const w of WINDOWS) {
  if (!ANALYZE.has(w)) continue;
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    const i = line.indexOf('"', 2); if (i < 0) continue;
    if (!watch.has(line.slice(2, i))) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, ...unknown[]];
    try { r = JSON.parse(line); } catch { continue; }
    const a = evsOf.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
             b: BigInt(r[6]), q: BigInt(r[7]), qa: BigInt(r[8]), ua: BigInt(r[9]) });
    evsOf.set(r[0], a);
  }
  rl.close();
}
console.log(`  tape loaded for ${evsOf.size} of them`);

function feeOf(evs: Ev[]): number | null {
  const s: number[] = [];
  for (const e of evs) {
    if (e.qa <= 0n || e.ua <= 0n) continue;
    const f = e.buy ? 1e4 * Number(e.ua - e.qa) / Number(e.qa) : 1e4 * Number(e.qa - e.ua) / Number(e.qa);
    if (Number.isFinite(f) && f >= 0 && f < 2000) s.push(f);
  }
  if (s.length < 5) return null;
  s.sort((a, b) => a - b); return s[Math.floor(0.5 * (s.length - 1))] ?? null;
}
function resolveV(evs: Ev[]): bigint | null {
  let best: bigint | null = null; let bestBad = Infinity;
  for (const v of V_CANDIDATES) {
    let bad = 0; let n = 0;
    for (let i = 0; i + 1 < evs.length && n < 60; i += 1) {
      const a = evs[i]; const c = evs[i + 1];
      if (a === undefined || c === undefined || a.b <= 0n || a.q <= 0n || c.b <= 0n || c.q <= 0n) continue;
      const k0 = Number(a.b) * Number(a.q + v); const k1 = Number(c.b) * Number(c.q + v);
      if (!(k0 > 0) || !(k1 > 0)) continue;
      n += 1; if (k1 < k0) bad += 1;
    }
    if (n >= 10 && bad < bestBad) { bestBad = bad; best = v; }
  }
  return best;
}

/** The realised mark path of one position, in bps, at every trade after entry. */
interface Path { ts: number[]; mark: number[] }
const paths: Path[] = [];
for (const [pool, evsRaw] of evsOf) {
  const row = watch.get(pool);
  if (row === undefined) continue;
  const evs = evsRaw.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  const fee = feeOf(evs); const v = resolveV(evs);
  if (fee === null || v === null) continue;
  const born = row.bornSlot;
  let entry: Ev | null = null;
  for (const e of evs) { if (e.slot >= born + DELAY && e.b > 0n && e.q > 0n) { entry = e; break; } }
  if (entry === null) continue;
  const ladder: PoolFeeLadder = { lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: BigInt(Math.round(fee)) };
  let bf;
  try { bf = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, ladder); } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; continue; }
  const p: Path = { ts: [], mark: [] };
  for (const e of evs) {
    if (e.ts < entry.ts || e === entry) continue;
    if (e.b <= 0n || e.q <= 0n) continue;
    try {
      const sf = priceSell({ base: e.b - bf.baseOut, quote: e.q + (bf.reservesAfter.quote - entry.q), virtualQuote: v }, bf.baseOut, ladder);
      p.ts.push(e.ts - entry.ts);
      p.mark.push(1e4 * Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL) - NONAMM_BPS);
    } catch (e2) { if (!(e2 instanceof FillNotPriceable)) throw e2; }
  }
  if (p.mark.length > 0) paths.push(p);
}
console.log(`  ${paths.length} priced mark paths`);

/** Book the position at the ACTUAL mark of the crossing trade, so a gap is charged in full. */
function run(up: number, down: number, cap: number): { out: number[]; hitUp: number; hitDn: number; none: number } {
  const out: number[] = []; let hu = 0; let hd = 0; let nn = 0;
  for (const p of paths) {
    let done = false;
    for (let i = 0; i < p.mark.length; i += 1) {
      const t = p.ts[i] as number; const m = p.mark[i] as number;
      if (t > cap) break;
      if (m >= up) { out.push(m); hu += 1; done = true; break; }
      if (m <= -down) { out.push(m); hd += 1; done = true; break; }
    }
    if (done) continue;
    let last = NaN;
    for (let i = 0; i < p.mark.length; i += 1) { if ((p.ts[i] as number) > cap) break; last = p.mark[i] as number; }
    if (Number.isFinite(last)) { out.push(last); nn += 1; }
  }
  return { out, hitUp: hu, hitDn: hd, none: nn };
}

console.log('');
console.log('SYMMETRIC BARRIERS — a driftless walk touches +X before -X exactly half the time.');
console.log('  barrier   cap      n    up first   down first   neither    P(up|decided)   mean bps   median');
for (const b of SYMMETRIC) {
  for (const cap of CAPS_S) {
    const r = run(b, b, cap);
    if (r.out.length < 30) continue;
    const dec = r.hitUp + r.hitDn;
    console.log(
      `  ${('±' + b).padStart(7)} ${(cap + 's').padStart(5)} ${String(r.out.length).padStart(6)} ${String(r.hitUp).padStart(11)} ${String(r.hitDn).padStart(12)} ${String(r.none).padStart(9)} ${(dec > 0 ? (100 * r.hitUp / dec).toFixed(1) + '%' : 'n/a').padStart(15)} ${mean(r.out).toFixed(0).padStart(10)} ${med(r.out).toFixed(0).padStart(8)}`,
    );
  }
}
console.log('');
console.log('ASYMMETRIC PAYOFFS — only worth reading if the symmetric column is not 50/50.');
console.log('  target/stop   cap      n    hit target   hit stop   neither   mean bps   median   E[log growth]');
for (const [u, dn] of ASYMMETRIC) {
  for (const cap of CAPS_S) {
    const r = run(u, dn, cap);
    if (r.out.length < 30) continue;
    /** Expected log growth of a bankroll risking the whole notional each time, capped at total loss. */
    const g = mean(r.out.map((x) => Math.log(Math.max(1e-6, 1 + x / 1e4))));
    console.log(
      `  ${(`+${u}/-${dn}`).padStart(12)} ${(cap + 's').padStart(5)} ${String(r.out.length).padStart(6)} ${String(r.hitUp).padStart(12)} ${String(r.hitDn).padStart(10)} ${String(r.none).padStart(9)} ${mean(r.out).toFixed(0).padStart(10)} ${med(r.out).toFixed(0).padStart(8)} ${g.toFixed(4).padStart(15)}`,
    );
  }
}
console.log('');
console.log('  Exit is booked at the observed crossing trade, so this is an UPPER BOUND: a real stop');
console.log('  needs a slot or more to observe and land. Refine only if the upper bound is positive.');
