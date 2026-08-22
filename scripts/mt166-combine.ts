/**
 * MT166 — does composing the heads beat the MOVE head alone?
 *
 * MOVE x SIGN x (1 - DUMP_RISK), exactly as specified. The ordering is the point: the magnitude
 * head builds the watchlist, and direction and inventory risk decide whether money actually goes in.
 *
 * WHAT EACH HEAD IS AND WHERE IT CAME FROM.
 *   MOVE      MT161. Predicts the top decile of |return| at delay 4. Out-of-sample |ret| AUC 0.707
 *             on block B and 0.801 on block S.
 *   SIGN      MT165. Predicts the direction of the move, trained ONLY on pools whose |return| is
 *             extreme, so its capacity is spent on direction rather than on re-learning magnitude.
 *             Out-of-sample AUC 0.695 and 0.691, driven by churnRatio.
 *   DUMP_RISK MT164. Predicts MELT's own high-risk label - minimum price ratio below 0.3 over 20
 *             minutes - from the MELT-derived inventory and coordination family.
 *
 * THE COMPARISON IS LIKE FOR LIKE AND THAT IS THE WHOLE DESIGN. Both watchlists are the SAME SIZE,
 * scored on the same corpus, replayed against the same barrier at the same cap and the same
 * execution lag. The only thing that differs is which pools are in the list. A composite score can
 * always be made to look impressive by quietly changing the selection size or the barrier; holding
 * both fixed is what makes the difference attributable to the heads.
 *
 * IF THE COMBINATION DOES NOT BEAT MOVE ALONE, that is the finding and it will be reported as one.
 * Two extra heads that buy nothing are a cost, not a feature, and this programme has already spent
 * enough rows on composites that looked better than their parts.
 *
 * All three heads are fitted on block A ONLY, with block A standardisation, and applied unchanged.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const TAG = arg('tag') ?? 'B';
const WINDOWS = (arg('windows') ?? '').split(',').filter((s) => s.length > 0);
const ANALYZE = new Set((arg('analyze') ?? '').split(',').filter((s) => s.length > 0));
const DELAY = 4;
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const NONAMM_BPS = 23;
const MIN_DEPTH = 40;
const BARRIER = Number(arg('barrier') ?? '3000');
const CAP_S = Number(arg('cap') ?? '30');
const V_CANDIDATES = [0n, 17_584_500_000n];

interface RRow { pool: string; ts: number; bornSlot: number; ret: number; nTrades: number; buyers: number;
  bundle: number; buySol: number; maxBuySol: number; topShare: number; buyShare: number;
  moveBps: number; depthSol: number; feeBps: number; prior: number }
interface DRow { pool: string; entities: number; coordShare: number; topEntityShare: number;
  slot0Share: number; lowCostBase: number; liqImpactBps: number; washWallets: number;
  churnRatio: number; meltRatio: number; meltHighRisk: number }
type Full = RRow & Omit<DRow, 'pool'>;

function load(tag: string): Full[] {
  const rf = `data/panel/runner-${tag}.jsonl`;
  const df = `data/panel/dumprisk-${tag}.jsonl`;
  if (!existsSync(rf) || !existsSync(df)) return [];
  const dm = new Map<string, DRow>();
  for (const l of readFileSync(df, 'utf8').split('\n')) { if (l.length === 0) continue; const d = JSON.parse(l) as DRow; dm.set(d.pool, d); }
  const out: Full[] = [];
  for (const l of readFileSync(rf, 'utf8').split('\n')) {
    if (l.length === 0) continue;
    const r = JSON.parse(l) as RRow;
    if (r.depthSol < MIN_DEPTH) continue;
    const d = dm.get(r.pool);
    if (d === undefined) continue;
    out.push({ ...r, entities: d.entities, coordShare: d.coordShare, topEntityShare: d.topEntityShare,
      slot0Share: d.slot0Share, lowCostBase: d.lowCostBase, liqImpactBps: d.liqImpactBps,
      washWallets: d.washWallets, churnRatio: d.churnRatio, meltRatio: d.meltRatio, meltHighRisk: d.meltHighRisk });
  }
  return out;
}
const FEATS = (r: Full): number[] => [
  Math.log1p(Math.max(0, r.nTrades)), Math.log1p(Math.max(0, r.buyers)),
  Math.log1p(Math.max(0, r.buySol)), Math.log1p(Math.max(0, r.maxBuySol)),
  r.topShare, r.buyShare, Math.sign(r.moveBps) * Math.log1p(Math.abs(r.moveBps)),
  Math.log1p(Math.max(0, r.depthSol)), r.feeBps / 100, Math.log1p(Math.max(0, r.prior)), r.bundle,
  Math.log1p(Math.max(0, r.entities)), r.coordShare, r.topEntityShare, r.slot0Share,
  Math.log1p(Math.max(0, r.lowCostBase)),
  Math.sign(r.liqImpactBps) * Math.log1p(Math.abs(r.liqImpactBps)),
  Math.log1p(Math.max(0, r.washWallets)), Math.min(3, r.churnRatio)];

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

const A = load('A');
if (A.length === 0) { console.log('need runner-A and dumprisk-A'); process.exit(1); }
const XA = A.map(FEATS); const dF = (XA[0] ?? []).length;
const mu: number[] = []; const sd: number[] = [];
for (let j = 0; j < dF; j += 1) {
  const c = XA.map((x) => x[j] as number); mu[j] = mean(c);
  const t = Math.sqrt(mean(c.map((x) => (x - (mu[j] as number)) ** 2))); sd[j] = t > 1e-9 ? t : 1;
}
const std = (x: number[]): number[] => x.map((v, j) => (v - (mu[j] as number)) / (sd[j] as number));
const absT = qt(A.map((r) => Math.abs(r.ret)), 0.90);
const Aex = A.filter((r) => Math.abs(r.ret) >= absT);
const wMove = fitLR(A.map((r) => std(FEATS(r))), A.map((r) => (Math.abs(r.ret) >= absT ? 1 : 0)), 0.05, 4000);
const wSign = fitLR(Aex.map((r) => std(FEATS(r))), Aex.map((r) => (r.ret > 0 ? 1 : 0)), 0.05, 4000);
const wDump = fitLR(A.map((r) => std(FEATS(r))), A.map((r) => r.meltHighRisk), 0.05, 4000);
const prob = (w: number[], r: Full): number => {
  const x = std(FEATS(r)); let z = w[x.length] as number;
  for (let j = 0; j < x.length; j += 1) z += (w[j] as number) * (x[j] as number);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
};

const R = load(TAG);
if (R.length === 0) { console.log(`no joined panel for ${TAG}`); process.exit(1); }
const nKeep = Math.max(1, Math.round(0.10 * R.length));
const selMove = new Set(R.map((r) => [prob(wMove, r), r] as [number, Full]).sort((a, b) => b[0] - a[0]).slice(0, nKeep).map(([, r]) => r.pool));
const selComb = new Set(R.map((r) => [prob(wMove, r) * prob(wSign, r) * (1 - prob(wDump, r)), r] as [number, Full]).sort((a, b) => b[0] - a[0]).slice(0, nKeep).map(([, r]) => r.pool));
const union = new Set([...selMove, ...selComb]);
const byPoolRow = new Map(R.map((r) => [r.pool, r]));
console.log(`MT166 — block ${TAG}: ${R.length} joined pools, watchlists of ${nKeep} each`);
console.log(`  shared between MOVE-only and combined: ${[...selMove].filter((p) => selComb.has(p)).length}`);

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
    if (!union.has(line.slice(2, i))) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, ...unknown[]];
    try { r = JSON.parse(line); } catch { continue; }
    const a = evsOf.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
             b: BigInt(r[6]), q: BigInt(r[7]), qa: BigInt(r[8]), ua: BigInt(r[9]) });
    evsOf.set(r[0], a);
  }
  rl.close();
}
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

interface Path { pool: string; ts: number[]; mark: number[] }
const paths: Path[] = [];
for (const [pool, raw] of evsOf) {
  const row = byPoolRow.get(pool);
  if (row === undefined) continue;
  const evs = raw.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  const fee = feeOf(evs); const v = resolveV(evs);
  if (fee === null || v === null) continue;
  let entry: Ev | null = null;
  for (const e of evs) { if (e.slot >= row.bornSlot + DELAY && e.b > 0n && e.q > 0n) { entry = e; break; } }
  if (entry === null) continue;
  const ladder: PoolFeeLadder = { lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: BigInt(Math.round(fee)) };
  let bf;
  try { bf = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, ladder); } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; continue; }
  const p: Path = { pool, ts: [], mark: [] };
  for (const e of evs) {
    if (e.ts < entry.ts || e === entry || e.b <= 0n || e.q <= 0n) continue;
    try {
      const sf = priceSell({ base: e.b - bf.baseOut, quote: e.q + (bf.reservesAfter.quote - entry.q), virtualQuote: v }, bf.baseOut, ladder);
      p.ts.push(e.ts - entry.ts);
      p.mark.push(1e4 * Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL) - NONAMM_BPS);
    } catch (e2) { if (!(e2 instanceof FillNotPriceable)) throw e2; }
  }
  if (p.mark.length > 0) paths.push(p);
}
console.log(`  ${paths.length} priced mark paths`);

function run(sel: Set<string>, lag: number): { out: number[]; hu: number; hd: number } {
  const out: number[] = []; let hu = 0; let hd = 0;
  for (const p of paths) {
    if (!sel.has(p.pool)) continue;
    let done = false;
    for (let i = 0; i < p.mark.length; i += 1) {
      const t = p.ts[i] as number; const m = p.mark[i] as number;
      if (t > CAP_S) break;
      if (m >= BARRIER || m <= -BARRIER) {
        const j = Math.min(i + lag, p.mark.length - 1);
        out.push(p.mark[j] as number); if (m >= BARRIER) hu += 1; else hd += 1; done = true; break;
      }
    }
    if (done) continue;
    let last = NaN;
    for (let i = 0; i < p.mark.length; i += 1) { if ((p.ts[i] as number) > CAP_S) break; last = p.mark[i] as number; }
    if (Number.isFinite(last)) out.push(last);
  }
  return { out, hu, hd };
}
const growthAt = (o: number[], f: number): number => mean(o.map((x) => Math.log(Math.max(1e-9, 1 + f * (x / 1e4)))));

console.log('');
console.log(`COMBINED HEAD vs MOVE ALONE — same barrier ±${BARRIER}, same ${CAP_S}s cap, same watchlist size`);
console.log('  selection                lag      n   up   down   mean bps   median   %pos   best f    g(f*)   g(f*/2)');
for (const [label, sel] of [['MOVE only', selMove], ['MOVE x SIGN x (1-DUMP)', selComb]] as [string, Set<string>][]) {
  for (const lag of [0, 2, 4]) {
    const r = run(sel, lag);
    if (r.out.length < 20) { console.log(`  ${label.padEnd(24)} ${String(lag).padStart(3)} ${String(r.out.length).padStart(6)}   (too few)`); continue; }
    let bf = 0; let bg = 0;
    for (let f = 0.01; f <= 1.0001; f += 0.01) { const g = growthAt(r.out, f); if (g > bg) { bg = g; bf = f; } }
    console.log(
      `  ${label.padEnd(24)} ${String(lag).padStart(3)} ${String(r.out.length).padStart(6)} ${String(r.hu).padStart(4)} ${String(r.hd).padStart(6)} ${mean(r.out).toFixed(0).padStart(10)} ${med(r.out).toFixed(0).padStart(8)} ${(100 * r.out.filter((x) => x > 0).length / r.out.length).toFixed(1).padStart(6)}% ${(bf > 0 ? bf.toFixed(2) : '-').padStart(8)} ${(bf > 0 ? bg.toFixed(4) : '-').padStart(8)} ${(bf > 0 ? growthAt(r.out, bf / 2).toFixed(4) : '-').padStart(9)}`,
    );
  }
}
console.log('');
console.log('  If the composite does not beat MOVE alone at the same size and barrier, the extra two');
console.log('  heads are a cost rather than a feature, and that is the result.');
