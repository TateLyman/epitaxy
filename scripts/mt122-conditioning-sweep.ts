/**
 * MT122 — the conditioning space no ledger row has touched.
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT122 before this file existed: the full
 * 32-cell grid, the survival bar, and the expectation that nothing survives.
 *
 * 121 rows have tested one family — size over depth, depth, fee tier, arrival rate, latency.
 * The classical microstructure conditioners have never been tried here. Order-flow imbalance has
 * the strongest prior in every other market ever studied, and MT118 showed the exit side
 * dominates, which is precisely what imbalance measures: who is available to trade against.
 *
 * THE DECISION QUANTITY IS THE WINSORISED MEAN AT 1%, forced by MT121. A median ignores the tail
 * that kills the strategy (MT120: positive on 18 of 18 days and still lost). A raw mean is
 * hostage to one observation (MT121: +0.847% was a single +1037% trade, collapsing to +0.005%).
 *
 * EVERY CELL IS REPORTED, not just the best, and the count of cells examined is printed beside
 * any survivor. Best-of-32 is how MT119 died.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const IMPACT_BAR = 0.05;
const DELAY_S = 2;
const BASELINE_HOLD_S = 15;
const TIMEOUT_S = 60;
const NOTIONAL = 20_000_000n;
const V_CANDIDATES = [0n, 17_584_500_000n];
const TP = 100;
const SL = 400;
const MAX_WALK = 400;
const LOOKBACK = 20;
const FIT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const VAL = [13, 14, 15, 16, 17, 18];

interface Ev { slot: number; ts: number; tx: number; addr: string; side: string; b: bigint; q: bigint; quote: bigint; user: bigint }
interface Row { fixed: number | null; policy: number | null; ofi: number; vol: number; activity: number; hour: number; day: string }

function resolveV(evs: Ev[]): bigint | null {
  let best: bigint | null = null; let bestBad = Infinity;
  for (const v of V_CANDIDATES) {
    let bad = 0; let n = 0;
    for (let i = 0; i + 1 < evs.length && n < 60; i += 1) {
      const a = evs[i]; const c = evs[i + 1];
      if (a === undefined || c === undefined || a.b <= 0n || a.q <= 0n || c.b <= 0n || c.q <= 0n) continue;
      const k0 = Number(a.b) * Number(a.q + v);
      const k1 = Number(c.b) * Number(c.q + v);
      if (!(k0 > 0) || !(k1 > 0)) continue;
      n += 1; if (k1 < k0) bad += 1;
    }
    if (n >= 10 && bad < bestBad) { bestBad = bad; best = v; }
  }
  return best;
}

async function collect(windows: number[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const w of windows) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) continue;
    const byPool = new Map<string, Ev[]>();
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let r: [string, number, number, number, string, number, string, string, string, string, number, number, number];
      try { r = JSON.parse(line); } catch { continue; }
      const a = byPool.get(r[0]) ?? [];
      a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], side: r[5] === 1 ? 'BUY' : 'SELL',
               b: BigInt(r[6]), q: BigInt(r[7]), quote: BigInt(r[8]), user: BigInt(r[9]) });
      byPool.set(r[0], a);
    }
    rl.close();

    for (const [, evs] of byPool) {
      if (evs.length < 40) continue;
      evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
      const v = resolveV(evs);
      if (v === null) continue;
      const ch: number[] = [];
      for (const e of evs) {
        if (e.side !== 'SELL' || e.quote <= 0n || e.user <= 0n) continue;
        const c = 1e4 * (Number(e.quote) - Number(e.user)) / Number(e.quote);
        if (Number.isFinite(c) && c > 0 && c < 1000) ch.push(c);
      }
      if (ch.length < 5) continue;
      ch.sort((a, b) => a - b);
      const chargedBps = ch[Math.floor(0.5 * (ch.length - 1))] ?? NaN;
      if (!Number.isFinite(chargedBps)) continue;
      const creditedBps = Math.max(Math.min(chargedBps, 25), 1);
      const fees: PoolFeeLadder = {
        lpFeeBasisPoints: BigInt(Math.round(creditedBps)), protocolFeeBasisPoints: 0n,
        coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: BigInt(Math.round(creditedBps)),
      };

      let lastEnd = -1;
      for (let i = LOOKBACK + 1; i + 1 < evs.length; i += 1) {
        const pre = evs[i]; const post = evs[i + 1];
        if (pre === undefined || post === undefined) continue;
        if (pre.b <= 0n || pre.q <= 0n || post.b <= 0n || post.q <= 0n) continue;
        const p0 = Number(pre.q + v) / Number(pre.b);
        const p1 = Number(post.q + v) / Number(post.b);
        if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0 || p1 <= 0) continue;
        if (!(p1 / p0 - 1 < 0)) continue;
        if (Math.abs(Number(post.q - pre.q)) / Number(pre.q) < IMPACT_BAR) continue;
        if (post.ts < lastEnd) continue;
        lastEnd = post.ts + TIMEOUT_S;

        // ---- EX ANTE conditioners, all from the 20 trades BEFORE the trigger ----
        let buyVol = 0; let sellVol = 0;
        const lp: number[] = [];
        for (let g = i - LOOKBACK; g <= i; g += 1) {
          const a0 = evs[g - 1]; const a1 = evs[g];
          if (a0 === undefined || a1 === undefined || a0.q <= 0n || a1.q <= 0n || a0.b <= 0n || a1.b <= 0n) continue;
          const dq = Math.abs(Number(a1.q - a0.q));
          if (a0.side === 'BUY') buyVol += dq; else sellVol += dq;
          const px0 = Number(a0.q + v) / Number(a0.b);
          const px1 = Number(a1.q + v) / Number(a1.b);
          if (px0 > 0 && px1 > 0) lp.push(Math.log(px1 / px0));
        }
        const tot = buyVol + sellVol;
        const ofi = tot > 0 ? (buyVol - sellVol) / tot : 0;
        const mu = lp.length > 0 ? lp.reduce((a, b) => a + b, 0) / lp.length : 0;
        const vol = lp.length > 1 ? Math.sqrt(lp.reduce((a, b) => a + (b - mu) ** 2, 0) / lp.length) : 0;

        let ei = -1;
        for (let j = i + 2; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= post.ts + DELAY_S) { ei = j; break; } }
        if (ei < 0) continue;
        const entry = evs[ei];
        if (entry === undefined) continue;
        let bought;
        try { bought = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, fees); }
        catch (e) { if (e instanceof FillNotPriceable) continue; throw e; }
        const quoteAdded = bought.reservesAfter.quote - entry.q;
        const markAt = (e: Ev): number | null => {
          try {
            const s = priceSell({ base: e.b - bought.baseOut, quote: e.q + quoteAdded, virtualQuote: v }, bought.baseOut, fees);
            return Number(s.quoteOut - NOTIONAL) / Number(NOTIONAL);
          } catch { return null; }
        };

        let fixed: number | null = null;
        for (let j = ei + 1; j < evs.length; j += 1) {
          const e = evs[j];
          if (e !== undefined && e.ts >= entry.ts + BASELINE_HOLD_S) { fixed = markAt(e); break; }
        }
        let policy: number | null = null;
        let walked = 0;
        for (let j = ei + 1; j < evs.length && walked < MAX_WALK; j += 1) {
          const e = evs[j];
          if (e === undefined) continue;
          walked += 1;
          const m = markAt(e);
          if (m === null) continue;
          if (m * 1e4 >= TP || m * 1e4 <= -SL || e.ts >= entry.ts + TIMEOUT_S) { policy = m; break; }
        }
        const d = new Date(post.ts * 1000);
        rows.push({ fixed, policy, ofi, vol, activity: i, hour: d.getUTCHours(), day: d.toISOString().slice(0, 10) });
      }
    }
    byPool.clear();
  }
  return rows;
}

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const mean = (a: number[]): number => { const s = a.filter(Number.isFinite); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
const wmean = (a: number[], p = 0.01): number => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  if (s.length < 20) return NaN;
  const k = Math.floor(p * (s.length - 1));
  const lo = s[k] ?? 0; const hi = s[s.length - 1 - k] ?? 0;
  return s.map((x) => (x < lo ? lo : x > hi ? hi : x)).reduce((x, y) => x + y, 0) / s.length;
};
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');
const qtile = (a: number[], p: number): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(p * (s.length - 1))] ?? NaN) : NaN; };

console.log('MT122 — conditioning sweep, 32 frozen cells, every one reported');
const fit = await collect(FIT);
const val = await collect(VAL);
console.log(`  fit ${fit.length.toLocaleString()} triggers   validation ${val.length.toLocaleString()}`);

type Pick = (r: Row) => number;
const CONDS: [string, Pick][] = [
  ['OFI', (r) => r.ofi], ['volatility', (r) => r.vol], ['activity', (r) => r.activity], ['hourUTC', (r) => r.hour],
];
const EXITS: [string, (r: Row) => number | null][] = [['fixed15s', (r) => r.fixed], ['tp100sl400', (r) => r.policy]];

interface Cell { name: string; cond: string; exit: string; lo: number; hi: number; wm: number; n: number }
const cells: Cell[] = [];
let examined = 0;

for (const [cname, pick] of CONDS) {
  const vals = fit.map(pick).filter(Number.isFinite);
  const edges = cname === 'hourUTC' ? [0, 6, 12, 18, 24] : [-Infinity, qtile(vals, 0.25), qtile(vals, 0.5), qtile(vals, 0.75), Infinity];
  for (const [ename, ex] of EXITS) {
    console.log('');
    console.log(`${cname} x ${ename}`);
    console.log('  bucket                     n     median      mean    WINSORISED   %pos');
    for (let b = 0; b < 4; b += 1) {
      const lo = edges[b] ?? -Infinity; const hi = edges[b + 1] ?? Infinity;
      const sub = fit.filter((r) => { const x = pick(r); return x >= lo && x < hi; }).map(ex).filter((x): x is number => x !== null);
      examined += 1;
      if (sub.length < 50) { console.log(`  [${lo.toFixed(2)}, ${hi.toFixed(2)})  n<50`); continue; }
      const wm = wmean(sub);
      cells.push({ name: `${cname}[${b}]`, cond: cname, exit: ename, lo, hi, wm, n: sub.length });
      console.log(`  [${String(lo.toFixed(2)).padStart(8)}, ${String(hi.toFixed(2)).padStart(8)})  ${String(sub.length).padStart(6)} ${F(med(sub))}% ${F(mean(sub))}% ${F(wm)}%  ${(100 * sub.filter((x) => x > 0).length / sub.length).toFixed(1).padStart(5)}%`);
    }
  }
}

console.log('');
console.log(`CELLS EXAMINED: ${examined}`);
const cands = cells.filter((c) => c.wm > 0).sort((a, b) => b.wm - a.wm);
console.log(`CANDIDATES with a POSITIVE winsorised mean on fit: ${cands.length}`);
if (cands.length === 0) {
  console.log('');
  console.log('  NONE. The conditioning space this data supports is exhausted.');
} else {
  for (const c of cands.slice(0, 5)) console.log(`  ${c.cond} ${c.name} ${c.exit}  [${c.lo.toFixed(2)}, ${c.hi.toFixed(2)})  winsorised ${F(c.wm)}%  n=${c.n}`);
  const best = cands[0];
  if (best !== undefined) {
    const pick = (CONDS.find(([n]) => n === best.cond) ?? CONDS[0])?.[1];
    const ex = (EXITS.find(([n]) => n === best.exit) ?? EXITS[0])?.[1];
    if (pick !== undefined && ex !== undefined) {
      const sub = val.filter((r) => { const x = pick(r); return x >= best.lo && x < best.hi; });
      const rets = sub.map(ex).filter((x): x is number => x !== null);
      const days = new Set(sub.map((r) => r.day));
      let dp = 0;
      for (const d of days) {
        const a = sub.filter((r) => r.day === d).map(ex).filter((x): x is number => x !== null);
        if (a.length >= 20 && wmean(a) > 0) dp += 1;
      }
      console.log('');
      console.log(`VALIDATION of the best cell on windows 13-18, SAME parameters`);
      console.log(`  n=${rets.length}   winsorised ${F(wmean(rets))}%   median ${F(med(rets))}%   raw mean ${F(mean(rets))}%   daysPositive ${dp}/${days.size}`);
      const survives = wmean(rets) > 0 && dp >= 4;
      console.log('');
      console.log(`  VERDICT: ${survives ? 'SURVIVES' : 'CLOSED'}   (best of ${examined} cells examined — that is the multiplicity bar this must clear)`);
    }
  }
}
