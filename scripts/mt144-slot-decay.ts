/**
 * MT144 — the decay curve in the interval nobody measured.
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT144 before this file existed, including the
 * prediction that the decay is CONVEX and break-even lands under 500 ms.
 *
 * MT117 measured entry delays of 0, 1, 2, 3 and 5 SECONDS and found the edge gone by one second.
 * It never sampled anything between 0 and 1. Every latency claim this programme has made since —
 * the 286 ms break-even, then the 890 ms one MT143 re-derived with the live-measured cost — is a
 * LINEAR INTERPOLATION across that gap. And the gap is exactly where break-even now sits, against
 * a measured achievable latency of about 617 ms.
 *
 * A slot is 377 ms, measured. So expressing the delay in SLOTS samples that interval directly at
 * roughly 0, 377, 754 and 1131 ms instead of jumping from 0 to 1000.
 *
 * GROSS IS REPORTED SEPARATELY FROM NET so the break-even can be read off rather than assumed.
 * The cost figure has already been wrong twice in this session — 230 bps assumed, 71 simulated,
 * 23 measured — and a curve that reports only net has to be recomputed every time it changes.
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
const DELAY_SLOTS = [0, 1, 2, 3];
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

/** delay -> returns */
const byDelay = new Map<number, number[]>();
const grossOf = new Map<number, number[]>();
for (const d of [0, 1, 2, 3]) grossOf.set(d, []);
/** Zero-fee twin used only to recover the gross decay curve. */
const FEES_ZERO = { lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: 0n };
for (const d of DELAY_SLOTS) byDelay.set(d, []);
const dayOf = new Map<number, Map<string, number[]>>();
for (const d of DELAY_SLOTS) dayOf.set(d, new Map());
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

      for (const d of DELAY_SLOTS) {
        /**
         * Entry is the first pool state at or after trigger PLUS d SLOTS, not d seconds. A slot is
         * 377 ms measured (MT143), so this samples 0, 377, 754 and 1131 ms — the interval MT117
         * skipped entirely by jumping from 0 to 1000. At d = 0 the entry is the post-trade state
         * itself, the physically impossible case that costs nothing to price and bounds the rest.
         */
        let entry: Ev | null = d === 0 ? post : null;
        if (d > 0) for (let j = i + 2; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.slot >= post.slot + d) { entry = e; break; } }
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
          // GROSS twin: identical fills at zero fee, so the decay curve can be read without any
          // cost assumption baked into it. The cost figure has been wrong twice already today.
          const bg = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, FEES_ZERO);
          const sg = priceSell(
            { base: exit.b - bg.baseOut, quote: exit.q + (bg.reservesAfter.quote - entry.q), virtualQuote: v },
            bg.baseOut, FEES_ZERO,
          );
          grossOf.get(d)?.push(Number(sg.quoteOut - NOTIONAL) / Number(NOTIONAL));
          byDelay.get(d)?.push(ret);
          const dm = dayOf.get(d);
          if (dm !== undefined) { const a = dm.get(day) ?? []; a.push(ret); dm.set(day, a); }
        } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; }
      }
    }
  }
  byPool.clear();
  console.log(`  window ${w.idx} (${w.from}..${w.to})  triggers ${triggers}`);
}

const grossMed = (d: number): number => {
  const a = (grossOf.get(d) ?? []).filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? (a[Math.floor(0.5 * (a.length - 1))] ?? NaN) : NaN;
};
const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
// retained from MT117 for the per-day tail below
const pct = (a: number[], x: number): number => { const s = [...a].filter(Number.isFinite).sort((m, n) => m - n); return s.length ? (s[Math.floor(x * (s.length - 1))] ?? NaN) : NaN; };
void pct;
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');

console.log(`\ntriggers evaluated: ${triggers.toLocaleString()}\n`);
console.log('DECAY BY SLOT — a slot is 377ms, so this is the interval MT117 never sampled');
console.log('  delay        ms       n   GROSS med    NET med    %positive   days');
for (const d of DELAY_SLOTS) {
  const a = byDelay.get(d) ?? [];
  if (a.length === 0) { console.log(`  ${String(d).padStart(3)} slots  (none)`); continue; }
  const dm = dayOf.get(d);
  const days = dm === undefined ? 0 : [...dm.values()].filter((x) => x.length > 0).length;
  const pos = a.filter((x) => x > 0).length / a.length;
  console.log(`  ${String(d).padStart(3)} slot ${String(Math.round(d * 377)).padStart(6)} ${String(a.length).padStart(7)} ${F(grossMed(d))}% ${F(med(a))}%    ${(100 * pos).toFixed(1).padStart(5)}%    ${String(days).padStart(2)}`);
}
console.log('\nPER-DAY MEDIAN at the decision delay of 2s — day clustering, per MT108');
const dm2 = dayOf.get(2);
void 0;
if (dm2 !== undefined) {
  for (const [day, a] of [...dm2.entries()].sort()) {
    console.log(`  ${day}  n=${String(a.length).padStart(5)}  median ${F(med(a))}%  positive ${(100 * a.filter((x) => x > 0).length / a.length).toFixed(1)}%`);
  }
}
console.log('\n  FROZEN READING: a graceful monotone decay that stays POSITIVE through 2 seconds is the');
console.log('  only result that licenses anything further. Positive at 0 and negative by 1 means the');
console.log('  reversion belongs to whoever is already in the block, and this closes - for free.');
