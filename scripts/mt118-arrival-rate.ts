/**
 * MT118 — is the decay COMPETITION, and therefore slower where nobody is competing?
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT118 before this file existed, including
 * the expectation that the slowest bucket is still NEGATIVE.
 *
 * MT117 closed reversion: the net falls 79 bps in the first second and is negative at 2s on all
 * twelve days. But WHY it decays that fast is a mechanism with a testable consequence. Reversion
 * decays because somebody else takes it. In a pool whose next trade arrives thirty seconds later
 * there is nobody to take it inside one second, so the decay must be slower there.
 *
 * This is NOT slicing MT117 hunting for a positive cell. It is the single prediction the
 * competition mechanism makes, and the required confirmation is MONOTONICITY across five
 * buckets — one positive bucket without it is a multiplicity artifact and is read as noise.
 *
 * The conditioning variable is the pool's median inter-trade gap over the 20 trades BEFORE the
 * trigger, so it is strictly ex ante. Depth is reported as a control because slow pools are
 * often thin, and MT111 measured shallow pools at -6.68% a round trip.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const HEAD = 440_494_520;
const SLOTS_PER_DAY = 207_494;
const IMPACT_BAR = 0.05;
const HOLD_S = 15;
const NOTIONAL = 20_000_000n;
/** The honest floor for detect, build, sign and land is 1 to 2 seconds. */
const DELAYS_S = [2];
const V_CANDIDATES = [0n, 17_584_500_000n];

const WINDOWS: { idx: number; from: number; to: number }[] = [];
for (let k = 1; k <= 12; k += 1) {
  const to = HEAD - k * SLOTS_PER_DAY;
  WINDOWS.push({ idx: k, from: to - 19_999, to });
}

interface Ev { slot: number; ts: number; tx: number; addr: string; side: string; b: bigint; q: bigint; quote: bigint; user: bigint }

function resolveV(evs: Ev[]): bigint | null {
  let best: bigint | null = null;
  let bestBad = Infinity;
  for (const v of V_CANDIDATES) {
    let bad = 0; let n = 0;
    for (let i = 0; i + 1 < evs.length && n < 60; i += 1) {
      const a = evs[i]; const c = evs[i + 1];
      if (a === undefined || c === undefined || a.b <= 0n || a.q <= 0n || c.b <= 0n || c.q <= 0n) continue;
      const k0 = Number(a.b) * Number(a.q + v);
      const k1 = Number(c.b) * Number(c.q + v);
      if (!(k0 > 0) || !(k1 > 0)) continue;
      n += 1;
      if (k1 < k0) bad += 1;
    }
    if (n >= 10 && bad < bestBad) { bestBad = bad; best = v; }
  }
  return best;
}

// The cache is already WSOL-filtered by name at build time, so no pool lookup is needed here.

interface Obs { gapS: number; depthSol: number; ret: number; day: string }
const obs: Obs[] = [];
let triggers = 0;

console.log('MT117 — net round trip against ENTRY LATENCY, cost held constant\n');
for (const w of WINDOWS) {
  // Read the decoded cache rather than re-decoding 22 GB. The cache applies exactly two
  // filters - emit_cpi-wrapped PumpSwap trade, and WSOL-quoted BY NAME - which every consumer
  // applied identically anyway, so this changes no result. Everything that decides an outcome
  // still happens below. Verified against MT116's independently computed window-1 count.
  const cacheFile = `${CACHE}/w${w.idx}.jsonl`;
  if (!existsSync(cacheFile)) { console.log(`  window ${w.idx}: no cache, skipped`); continue; }
  const byPool = new Map<string, Ev[]>();
  {
    const rl = createInterface({ input: createReadStream(cacheFile, { encoding: 'utf8' }), crlfDelay: Infinity });
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
  }

  for (const [, evs] of byPool) {
    if (evs.length < 40) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const v = resolveV(evs);
    if (v === null) continue;

    // The fee actually charged, from the sell identity, then credited as MT116 does.
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
    // Credited: the LP+protocol part stays, the redirected creator part returns.
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
      lastEnd = post.ts + HOLD_S + 5;
      triggers += 1;
      const day = new Date(post.ts * 1000).toISOString().slice(0, 10);

      for (const d of DELAYS_S) {
        // Entry is the first observed pool state at or after trigger + d. At d = 0 that is the
        // post-trade state itself, which is the physically impossible case MT116 priced.
        let entry: Ev | null = d === 0 ? post : null;
        if (d > 0) for (let j = i + 2; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= post.ts + d) { entry = e; break; } }
        if (entry === null) continue;
        let exit: Ev | null = null;
        for (let j = i + 2; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= entry.ts + HOLD_S) { exit = e; break; } }
        if (exit === null) continue;
        try {
          const bf = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, fees);
          const sf = priceSell(
            { base: exit.b - bf.baseOut, quote: exit.q + (bf.reservesAfter.quote - entry.q), virtualQuote: v },
            bf.baseOut, fees,
          );
          const ret = Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL);
          // EX ANTE arrival: the median gap over the 20 trades BEFORE the trigger. Nothing
          // after the decision point is used.
          const gaps: number[] = [];
          for (let j = Math.max(1, i - 20); j <= i; j += 1) {
            const a0 = evs[j - 1]; const a1 = evs[j];
            if (a0 !== undefined && a1 !== undefined) gaps.push(a1.ts - a0.ts);
          }
          gaps.sort((x, y) => x - y);
          const gapS = gaps.length > 0 ? (gaps[Math.floor(0.5 * (gaps.length - 1))] ?? 0) : 0;
          obs.push({ gapS, depthSol: Number(post.q + v) / 1e9, ret, day });
        } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; }
      }
    }
  }
  byPool.clear();
  console.log(`  window ${w.idx} (${w.from}..${w.to})  triggers ${triggers}`);
}

const med = (a: number[]): number => { const s2 = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s2.length ? (s2[Math.floor(0.5 * (s2.length - 1))] ?? NaN) : NaN; };
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');

const BUCKETS: [string, number, number][] = [
  ['<1s', 0, 1], ['1-3s', 1, 3], ['3-10s', 3, 10], ['10-30s', 10, 30], ['>30s', 30, Infinity],
];

console.log('');
console.log(`triggers evaluated: ${triggers.toLocaleString()}   priced: ${obs.length.toLocaleString()}
`);

const table = (label: string, rows: Obs[]): number[] => {
  console.log(label);
  console.log('  arrival gap      n      median net@2s   %positive   days');
  const meds: number[] = [];
  for (const [name, lo, hi] of BUCKETS) {
    const sub = rows.filter((o) => o.gapS >= lo && o.gapS < hi);
    if (sub.length === 0) { console.log(`  ${name.padEnd(10)} (none)`); meds.push(NaN); continue; }
    const m = med(sub.map((o) => o.ret));
    meds.push(m);
    const pos = sub.filter((o) => o.ret > 0).length / sub.length;
    const days = new Set(sub.map((o) => o.day)).size;
    console.log(`  ${name.padEnd(10)} ${String(sub.length).padStart(6)}   ${F(m)}%     ${(100 * pos).toFixed(1).padStart(5)}%    ${String(days).padStart(2)}`);
  }
  return meds;
};

const all = table('ALL POOLS', obs);
console.log('');
const deep = table('DEPTH CONTROL — pools above 120 SOL effective quote', obs.filter((o) => o.depthSol > 120));

const monotone = (m: number[]): boolean => {
  const v = m.filter(Number.isFinite);
  return v.length >= 3 && v.every((x, k) => k === 0 || x >= (v[k - 1] ?? -Infinity));
};
console.log('');
console.log('PREREGISTERED CONFIRMATIONS');
console.log(`  (1) monotone in arrival gap, all pools ...... ${monotone(all) ? 'YES' : 'NO'}`);
console.log(`  (2) monotone, depth-controlled .............. ${monotone(deep) ? 'YES' : 'NO'}`);
const slowAll = all[all.length - 1];
const slowDeep = deep[deep.length - 1];
console.log(`  (3) slowest bucket positive ................. all ${Number.isFinite(slowAll ?? NaN) && (slowAll ?? -1) > 0 ? 'YES' : 'NO'}   deep ${Number.isFinite(slowDeep ?? NaN) && (slowDeep ?? -1) > 0 ? 'YES' : 'NO'}`);
console.log('');
console.log('  A single positive bucket WITHOUT monotonicity is a multiplicity artifact across five');
console.log('  cells and is read as noise. If the effect survives only in thin pools it is the');
console.log('  thinness, not the arrival rate, and MT111 already priced thinness at -6.68%.');
