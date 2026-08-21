/**
 * MT117 — does the reversion survive a realistic entry latency?
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT117 before this file existed, including
 * the expectation that it KILLS the idea. That is recorded in advance so it cannot be revised
 * after the numbers appear.
 *
 * MT116 enters at the post-trade reserves, which is t=0 and physically impossible: it assumes
 * we are already there when the trade lands. A real bot sees the trigger on the tape at 100 to
 * 500ms, builds and signs, and lands in the next block or two. One to two seconds is the honest
 * floor. MT107 measured +57.7 bps by 2 seconds after a large trade, so much of the move happens
 * before we could arrive, and the reversion we want is the mirror of that move.
 *
 * Cost is held CONSTANT at MT116's credited model. Only ENTRY TIME varies, so the decay curve
 * is attributable to latency and to nothing else.
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
const DELAYS_S = [0, 1, 2, 3, 5];
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
for (const d of DELAYS_S) byDelay.set(d, []);
const dayOf = new Map<number, Map<string, number[]>>();
for (const d of DELAYS_S) dayOf.set(d, new Map());
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

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const pct = (a: number[], x: number): number => { const s = [...a].filter(Number.isFinite).sort((m, n) => m - n); return s.length ? (s[Math.floor(x * (s.length - 1))] ?? NaN) : NaN; };
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');

console.log(`\ntriggers evaluated: ${triggers.toLocaleString()}\n`);
console.log('NET ROUND TRIP vs ENTRY DELAY — cost identical at every row, only entry time moves');
console.log('  delay      n     median      p25        p05      %positive   days');
for (const d of DELAYS_S) {
  const a = byDelay.get(d) ?? [];
  if (a.length === 0) { console.log(`  ${String(d).padStart(3)}s   (none)`); continue; }
  const dm = dayOf.get(d);
  const days = dm === undefined ? 0 : [...dm.values()].filter((x) => x.length > 0).length;
  const pos = a.filter((x) => x > 0).length / a.length;
  console.log(`  ${String(d).padStart(3)}s ${String(a.length).padStart(6)} ${F(med(a))}% ${F(pct(a, 0.25))}% ${F(pct(a, 0.05))}%    ${(100 * pos).toFixed(1).padStart(5)}%    ${String(days).padStart(2)}`);
}
console.log('\nPER-DAY MEDIAN at the decision delay of 2s — day clustering, per MT108');
const dm2 = dayOf.get(2);
if (dm2 !== undefined) {
  for (const [day, a] of [...dm2.entries()].sort()) {
    console.log(`  ${day}  n=${String(a.length).padStart(5)}  median ${F(med(a))}%  positive ${(100 * a.filter((x) => x > 0).length / a.length).toFixed(1)}%`);
  }
}
console.log('\n  FROZEN READING: a graceful monotone decay that stays POSITIVE through 2 seconds is the');
console.log('  only result that licenses anything further. Positive at 0 and negative by 1 means the');
console.log('  reversion belongs to whoever is already in the block, and this closes - for free.');
