/**
 * TAIL ANATOMY — where does the mean-killing loss actually come from?
 *
 * DIAGNOSTIC, not a strategy test. It computes no new hypothesis and selects no cell; it
 * describes a distribution we have already measured. Any rule suggested by what it shows must
 * be preregistered and tested on days that do not exist in this analysis, exactly as MT119 was.
 *
 * MT120 found a median of +1.006% on a mean of -0.491% under tp100_sl400, positive on 18 of 18
 * days. The mean is what compounds, so the strategy loses. The question that decides whether
 * anything can be done about it is whether the loss is CONCENTRATED in pools identifiable in
 * advance, or spread uniformly across every trade.
 *
 * It also carries out the re-audit MT120 called for: every median-based claim in this repository
 * should be read with its mean beside it, MT111's depth finding first.
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
const TPS = [100];
const SLS = [400];
/** Walk bound: a busy pool can print thousands of events in 60s and we do not need them all. */
const MAX_WALK = 400;

const FIT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const VAL = [13, 14, 15, 16, 17, 18];

interface Ev { slot: number; ts: number; tx: number; addr: string; side: string; b: bigint; q: bigint; quote: bigint; user: bigint }
interface Row { ret: number; depthSol: number; gapS: number; day: string; set: string }
const ROWS: Row[] = [];

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

let LABEL = 'fit';
async function run(windows: number[], label: string): Promise<Map<string, { rets: number[]; days: Map<string, number[]> }>> {
  LABEL = label;
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
        if (!(p1 / p0 - 1 < 0)) continue;
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
          // EX ANTE context for the diagnostic: depth and arrival known before the decision.
          const gaps: number[] = [];
          for (let g = Math.max(1, i - 20); g <= i; g += 1) {
            const a0 = evs[g - 1]; const a1 = evs[g];
            if (a0 !== undefined && a1 !== undefined) gaps.push(a1.ts - a0.ts);
          }
          gaps.sort((x, y) => x - y);
          ROWS.push({ ret, depthSol: Number(post.q + v) / 1e9,
                      gapS: gaps.length > 0 ? (gaps[Math.floor(0.5 * (gaps.length - 1))] ?? 0) : 0,
                      day, set: LABEL });
        }
      }
    }
    byPool.clear();
  }
  console.log(`  ${label}: ${triggers.toLocaleString()} triggers`);
  return out;
}

const med = (a: number[]): number => { const s2 = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s2.length ? (s2[Math.floor(0.5 * (s2.length - 1))] ?? NaN) : NaN; };
const mean = (a: number[]): number => { const s2 = a.filter(Number.isFinite); return s2.length ? s2.reduce((x, y) => x + y, 0) / s2.length : NaN; };
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');

console.log('TAIL ANATOMY — diagnostic only, selects nothing');
await run(FIT, 'fit');
await run(VAL, 'val');
console.log('');
console.log(`observations: ${ROWS.length.toLocaleString()}`);

const sorted = [...ROWS].sort((a, b) => a.ret - b.ret);
const totalLoss = sorted.filter((r) => r.ret < 0).reduce((a, b) => a + b.ret, 0);
const share = (n: number): string => {
  const worst = sorted.slice(0, n).reduce((a, b) => a + b.ret, 0);
  return `${(100 * worst / totalLoss).toFixed(1)}%`;
};
console.log('');
console.log('IS THE LOSS CONCENTRATED? share of ALL losses carried by the worst trades');
console.log(`  worst 0.5%  (${Math.floor(sorted.length * 0.005)} trades) -> ${share(Math.floor(sorted.length * 0.005))} of total loss`);
console.log(`  worst 1%    (${Math.floor(sorted.length * 0.01)} trades) -> ${share(Math.floor(sorted.length * 0.01))}`);
console.log(`  worst 5%    (${Math.floor(sorted.length * 0.05)} trades) -> ${share(Math.floor(sorted.length * 0.05))}`);
console.log(`  worst 10%   (${Math.floor(sorted.length * 0.10)} trades) -> ${share(Math.floor(sorted.length * 0.10))}`);
console.log('');
console.log(`  worst single trade: ${F(sorted[0]?.ret ?? NaN)}%   p01 ${F(sorted[Math.floor(sorted.length * 0.01)]?.ret ?? NaN)}%   (a -400bps stop should have bounded this at -4.000%)`);

console.log('');
console.log('ARE THE TAIL TRADES IDENTIFIABLE EX ANTE? worst 1% vs the rest');
const cut = Math.floor(sorted.length * 0.01);
const tail = sorted.slice(0, cut);
const rest = sorted.slice(cut);
const q = (a: Row[], f: (r: Row) => number, p: number): number => { const v = a.map(f).filter(Number.isFinite).sort((x, y) => x - y); return v.length ? (v[Math.floor(p * (v.length - 1))] ?? NaN) : NaN; };
console.log(`  depth SOL   tail p50 ${q(tail, (r) => r.depthSol, 0.5).toFixed(1).padStart(9)}   rest p50 ${q(rest, (r) => r.depthSol, 0.5).toFixed(1).padStart(9)}`);
console.log(`  arrival s   tail p50 ${q(tail, (r) => r.gapS, 0.5).toFixed(2).padStart(9)}   rest p50 ${q(rest, (r) => r.gapS, 0.5).toFixed(2).padStart(9)}`);

console.log('');
console.log('THE MT120 RE-AUDIT — every median with its MEAN beside it, by depth');
console.log('  depth band          n      median       MEAN     %positive');
for (const [lab, lo, hi] of [['0-35 SOL', 0, 35], ['35-120', 35, 120], ['120-300', 120, 300], ['300-1000', 300, 1000], ['1000+', 1000, Infinity]] as [string, number, number][]) {
  const sub = ROWS.filter((r) => r.depthSol >= lo && r.depthSol < hi);
  if (sub.length === 0) { console.log(`  ${lab.padEnd(14)} (none)`); continue; }
  const rets = sub.map((r) => r.ret);
  console.log(`  ${lab.padEnd(14)} ${String(sub.length).padStart(6)} ${F(med(rets))}% ${F(mean(rets))}%   ${(100 * rets.filter((x) => x > 0).length / rets.length).toFixed(1).padStart(5)}%`);
}
console.log('');
console.log('IS THE ONE POSITIVE MEAN REAL, OR ONE LOTTERY WIN? winsorised at each level');
for (const [lab, lo, hi] of [['0-35 SOL', 0, 35], ['35-120', 35, 120], ['120-300', 120, 300]] as [string, number, number][]) {
  const sub = ROWS.filter((r) => r.depthSol >= lo && r.depthSol < hi).map((r) => r.ret).sort((a, b) => a - b);
  if (sub.length < 50) continue;
  const w = (p: number): number => {
    const k = Math.floor(p * (sub.length - 1));
    const loV = sub[k] ?? 0; const hiV = sub[sub.length - 1 - k] ?? 0;
    const c = sub.map((x) => (x < loV ? loV : x > hiV ? hiV : x));
    return c.reduce((a, b) => a + b, 0) / c.length;
  };
  console.log(`  ${lab.padEnd(10)} raw mean ${F(mean(sub))}%   w1% ${F(w(0.01))}%   w5% ${F(w(0.05))}%   best trade ${F(sub[sub.length - 1] ?? NaN)}%`);
}
console.log('');
console.log('  A mean that collapses under winsorisation is one lottery win, not an edge. That is the');
console.log('  same test that turned every unconditional mean in MT114 negative at p99.');
console.log('');
console.log('  If the loss is concentrated AND the tail is identifiable ex ante, a rule excluding it');
console.log('  must be preregistered and tested on days not in this analysis, exactly as MT119 was.');
console.log('  If a depth band shows median and MEAN both positive, that is the first such cell here.');
