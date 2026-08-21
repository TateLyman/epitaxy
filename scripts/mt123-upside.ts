/**
 * MT123 — the half of the event space that 123 ledger rows discarded.
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT123 before this file existed, including the
 * arithmetic prediction that it comes out NEGATIVE.
 *
 * Every reversion test — MT110, MT111, MT116, MT117, MT118, MT119, MT120, MT121 — and the MT122
 * sweep carried the same line: if the price did not move DOWN, skip the event. The up-move side
 * has never been measured once. That is not a slice of an exhausted cell; it is half the space,
 * filtered out at the top of the first script and inherited ever since.
 *
 * It is also the only direction TRADEABLE without a borrow. MT114 found the strongest replicating
 * effect in the programme — tokens up >20% return -78.54% over 24h — and it is unshortable here.
 *
 * THE INVERSION OF THE DIRECTION FILTER IS THE ONLY CHANGE. Every threshold, cost model and exit
 * rule is carried over unchanged, deliberately: the point is to measure what was discarded, not
 * to search it.
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
const TPS = [50, 100, 200];
const SLS = [200, 400];
/** Walk bound: a busy pool can print thousands of events in 60s and we do not need them all. */
const MAX_WALK = 400;

const FIT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const VAL = [13, 14, 15, 16, 17, 18];

interface Ev { slot: number; ts: number; tx: number; addr: string; side: string; b: bigint; q: bigint; quote: bigint; user: bigint }

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

const KEYS: string[] = ['fixed15s'];
for (const tp of TPS) for (const sl of SLS) KEYS.push(`tp${tp}_sl${sl}`);

async function run(windows: number[], label: string): Promise<Map<string, { rets: number[]; days: Map<string, number[]> }>> {
  const out = new Map<string, { rets: number[]; days: Map<string, number[]> }>();
  for (const k of KEYS) out.set(k, { rets: [], days: new Map() });
  let triggers = 0;

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
      for (let i = 1; i + 1 < evs.length; i += 1) {
        const pre = evs[i]; const post = evs[i + 1];
        if (pre === undefined || post === undefined) continue;
        if (pre.b <= 0n || pre.q <= 0n || post.b <= 0n || post.q <= 0n) continue;
        const p0 = Number(pre.q + v) / Number(pre.b);
        const p1 = Number(post.q + v) / Number(post.b);
        if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0 || p1 <= 0) continue;
        if (!(p1 / p0 - 1 > 0)) continue; // MT123: UP-moves — the inverted filter, and the only change
        if (Math.abs(Number(post.q - pre.q)) / Number(pre.q) < IMPACT_BAR) continue;
        if (post.ts < lastEnd) continue;
        lastEnd = post.ts + TIMEOUT_S;
        triggers += 1;
        const day = new Date(post.ts * 1000).toISOString().slice(0, 10);

        let ei = -1;
        for (let j = i + 2; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= post.ts + DELAY_S) { ei = j; break; } }
        if (ei < 0) continue;
        const entry = evs[ei];
        if (entry === undefined) continue;

        let bought;
        try { bought = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, fees); }
        catch (e) { if (e instanceof FillNotPriceable) continue; throw e; }
        const quoteAdded = bought.reservesAfter.quote - entry.q;

        /** Mark our position at a later pool state, carrying our own footprint. */
        const markAt = (e: Ev): number | null => {
          try {
            const s = priceSell({ base: e.b - bought.baseOut, quote: e.q + quoteAdded, virtualQuote: v }, bought.baseOut, fees);
            return Number(s.quoteOut - NOTIONAL) / Number(NOTIONAL);
          } catch { return null; }
        };

        // Baseline: the fixed clock every prior test used.
        let base: number | null = null;
        for (let j = ei + 1; j < evs.length; j += 1) {
          const e = evs[j];
          if (e === undefined) continue;
          if (e.ts >= entry.ts + BASELINE_HOLD_S) { base = markAt(e); break; }
        }
        if (base !== null) {
          const b = out.get('fixed15s');
          if (b !== undefined) { b.rets.push(base); const d = b.days.get(day) ?? []; d.push(base); b.days.set(day, d); }
        }

        // Policies: first crossing of TP or SL, else timeout.
        for (const tp of TPS) for (const sl of SLS) {
          const key = `tp${tp}_sl${sl}`;
          let ret: number | null = null;
          let walked = 0;
          for (let j = ei + 1; j < evs.length && walked < MAX_WALK; j += 1) {
            const e = evs[j];
            if (e === undefined) continue;
            walked += 1;
            const m = markAt(e);
            if (m === null) continue;
            if (m * 1e4 >= tp || m * 1e4 <= -sl) { ret = m; break; }
            if (e.ts >= entry.ts + TIMEOUT_S) { ret = m; break; }
          }
          if (ret === null) continue;
          const b = out.get(key);
          if (b !== undefined) { b.rets.push(ret); const d = b.days.get(day) ?? []; d.push(ret); b.days.set(day, d); }
        }
      }
    }
    byPool.clear();
  }
  console.log(`  ${label}: ${triggers.toLocaleString()} triggers`);
  return out;
}

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const mean = (a: number[]): number => { const s = a.filter(Number.isFinite); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
// MT121's lesson applied rather than learned twice: a raw mean on this venue can be one lottery
// win — a +1037% trade carried 6,074 observations there. The winsorised mean is the statistic
// that survives contact with its own outliers.
const wmean = (a: number[], p = 0.01): number => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  if (s.length < 20) return NaN;
  const k = Math.floor(p * (s.length - 1));
  const lo = s[k] ?? 0; const hi = s[s.length - 1 - k] ?? 0;
  return s.map((x) => (x < lo ? lo : x > hi ? hi : x)).reduce((x, y) => x + y, 0) / s.length;
};
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');

console.log('MT123 — the UP-move side, never measured in 123 rows\n');
const fit = await run(FIT, 'FIT windows 1-12');
const val = await run(VAL, 'VALIDATION windows 13-18');

const table = (label: string, m: Map<string, { rets: number[]; days: Map<string, number[]> }>): void => {
  console.log('');
  console.log(label);
  console.log('  policy          n       median       MEAN   WINSOR-1%  WINSOR-5%  %positive  daysPos');
  for (const k of KEYS) {
    const e = m.get(k);
    if (e === undefined || e.rets.length === 0) { console.log(`  ${k.padEnd(14)} (none)`); continue; }
    const pos = e.rets.filter((x) => x > 0).length / e.rets.length;
    let dp = 0;
    for (const [, a] of e.days) if (med(a) > 0) dp += 1;
    console.log(`  ${k.padEnd(14)} ${String(e.rets.length).padStart(6)} ${F(med(e.rets))}% ${F(mean(e.rets))}% ${F(wmean(e.rets, 0.01))}% ${F(wmean(e.rets, 0.05))}%   ${(100 * pos).toFixed(1).padStart(5)}%     ${dp}`);
  }
};
table('FIT — windows 1-12', fit);
table('VALIDATION — windows 13-18, six days pulled after MT118 reported', val);

console.log('');
console.log('PREREGISTERED CONFIRMATIONS');
const bl = fit.get('fixed15s');
const blMed = bl === undefined ? NaN : med(bl.rets);
console.log(`  (1) baseline reproduces MT117 near -0.48% ... ${Number.isFinite(blMed) && Math.abs(blMed * 100 + 0.48) < 0.35 ? 'PASS' : 'CHECK'}  (${F(blMed)}%)`);
let bestKey: string | null = null; let bestMean = -Infinity;
for (const k of KEYS) {
  if (k === 'fixed15s') continue;
  const e = fit.get(k);
  if (e === undefined || e.rets.length === 0) continue;
  const mn = mean(e.rets);
  if (mn > bestMean) { bestMean = mn; bestKey = k; }
}
const blMean = bl === undefined ? NaN : mean(bl.rets);
console.log(`  (2) best fit policy beats baseline on BOTH moments`);
if (bestKey !== null) {
  const e = fit.get(bestKey);
  const bm = e === undefined ? NaN : med(e.rets);
  const okBoth = bm > blMed && bestMean > blMean;
  console.log(`      best by mean: ${bestKey}   median ${F(bm)}% vs ${F(blMed)}%   mean ${F(bestMean)}% vs ${F(blMean)}%   -> ${okBoth ? 'PASS' : 'FAIL'}`);
  const ve = val.get(bestKey);
  const vbl = val.get('fixed15s');
  if (ve !== undefined && vbl !== undefined && ve.rets.length > 0) {
    let dp = 0;
    for (const [, a] of ve.days) if (med(a) > 0) dp += 1;
    console.log(`  (3) SAME parameters on the six validation days`);
    console.log(`      ${bestKey}   median ${F(med(ve.rets))}%   mean ${F(mean(ve.rets))}%   daysPositive ${dp}/${ve.days.size}   baseline median ${F(med(vbl.rets))}%`);
  }
}
console.log('');
console.log('  A rule that lifts the median while worsening the mean has MOVED the loss, not removed');
console.log('  it, and is a failure. A cell that passes fit and fails validation is closed, as MT119 was.');
