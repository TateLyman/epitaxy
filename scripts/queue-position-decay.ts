/**
 * How much of the reversion survives to the SECOND responder? The third? The tenth?
 *
 * MT144 measured decay against the clock and found 94.0 bps at zero delay, 23.2 by one slot. The
 * operator has now identified shred streaming — seeing transactions while a block is still being
 * produced — as the tool that could reach the zero-delay rung. Before paying for it, there is a
 * question that decides whether it would help at all, and it costs nothing to answer.
 *
 * THE 94 BPS IS WHAT THE FIRST RESPONDER GETS. Every account of this so far has priced entry at
 * the pool state immediately after the trigger. But a block contains many transactions, and if
 * five other searchers act on the same dislocation before us, the price has already moved back by
 * the time our transaction executes. MT107 raised this as crowding and it has never been measured.
 *
 * SO THIS MEASURES DECAY AGAINST QUEUE POSITION RATHER THAN AGAINST TIME. For each trigger, price
 * the same round trip entering at the 1st, 2nd, 3rd ... Nth subsequent trade in the tape, and read
 * how fast the edge disappears as others get there first.
 *
 * WHAT THE SHAPES WOULD MEAN. If the edge survives to the 5th or 10th responder, then arriving
 * inside the block is what matters and being first is a bonus — shred streaming would be worth
 * buying. If it is gone by the 2nd, then the tool buys a ticket to a race we would also have to
 * WIN, against participants who have been doing this longer and are closer to the leader.
 *
 * Read-only, on the cache already on disk. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const IMPACT_BAR = 0.05;
const HOLD_S = 15;
const NOTIONAL = 20_000_000n;
const V_CANDIDATES = [0n, 17_584_500_000n];
/** Queue positions to price: the 1st trade after the trigger, the 2nd, and so on. */
const POSITIONS = [1, 2, 3, 5, 8, 12, 20];
/** MT136, realised live on a complete round trip. */
const COST_BPS = 23;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '1,2,3,4,5,6').split(',').filter((s) => s.length > 0);

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; big: bigint; small: bigint }

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

const gross = new Map<number, number[]>();
const sameSlot = new Map<number, number>();
for (const p of POSITIONS) { gross.set(p, []); sameSlot.set(p, 0); }
let triggers = 0;

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const byPool = new Map<string, Ev[]>();
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number];
    try { r = JSON.parse(line); } catch { continue; }
    const qa = BigInt(r[8]); const ua = BigInt(r[9]);
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1, b: BigInt(r[6]), q: BigInt(r[7]),
             big: qa > ua ? qa : ua, small: qa > ua ? ua : qa });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [, evs] of byPool) {
    if (evs.length < 40) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const v = resolveV(evs);
    if (v === null) continue;
    /** Zero fee, so the curve is gross and no cost assumption is baked into its shape. */
    const fees: PoolFeeLadder = {
      lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: 0n,
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

      for (const pos of POSITIONS) {
        const ei = i + 1 + pos;                     // the Nth trade after the trigger
        const entry = evs[ei];
        if (entry === undefined || entry.b <= 0n || entry.q <= 0n) continue;
        if (entry.slot === post.slot) sameSlot.set(pos, (sameSlot.get(pos) ?? 0) + 1);
        let exit: Ev | null = null;
        for (let j = ei + 1; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= entry.ts + HOLD_S) { exit = e; break; } }
        if (exit === null) continue;
        try {
          const bf = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, fees);
          const sf = priceSell(
            { base: exit.b - bf.baseOut, quote: exit.q + (bf.reservesAfter.quote - entry.q), virtualQuote: v },
            bf.baseOut, fees,
          );
          gross.get(pos)?.push(1e4 * Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL));
        } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; }
      }
    }
  }
  byPool.clear();
  console.log(`  w${w} done`);
}

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };

console.log('');
console.log(`DECAY BY QUEUE POSITION — ${triggers.toLocaleString()} triggers, gross (zero fee)`);
console.log(`  cost to beat is ${COST_BPS} bps, measured live in MT136`);
console.log('');
console.log('  position       n   GROSS med    net vs cost   share in the SAME slot as the trigger');
for (const pos of POSITIONS) {
  const a = gross.get(pos) ?? [];
  if (a.length === 0) continue;
  const g = med(a);
  const ss = (sameSlot.get(pos) ?? 0) / Math.max(1, triggers);
  console.log(
    `  ${String(pos).padStart(6)}th ${String(a.length).padStart(8)}  ${g.toFixed(1).padStart(9)} bps  ${(g - COST_BPS).toFixed(1).padStart(10)} bps  ${(100 * ss).toFixed(0).padStart(6)}%`,
  );
}
console.log('');
console.log('  If the edge survives to the 5th or 10th responder, arriving INSIDE the block is what');
console.log('  matters and shred streaming is worth buying. If it is gone by the 2nd, the tool buys');
console.log('  a ticket to a race that must also be WON, against people closer to the leader.');
