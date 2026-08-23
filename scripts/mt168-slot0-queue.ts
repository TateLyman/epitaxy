/**
 * MT168 — what is a slot-0 seat actually worth to US, at each position in the queue?
 *
 * MT156 found that 96.9% of all counted gains on this venue go to wallets present in a pool's very
 * first slot, at +955 bps on deployed capital. Everything since has been an attempt to make money
 * from delay 4, where MT167 has just shown the prediction is real and the profit is not. So the
 * obvious question is whether the seat that actually pays is reachable.
 *
 * PUBLISHED ACCOUNTS SAY IT IS, AND NOT BY WINNING A RACE. Migration is deterministic: a pump.fun
 * curve completes at roughly 85 SOL deposited, the trigger is automatic and permissionless, and the
 * curve state is a public account. Once deposits reach about 84.5 SOL completion is arithmetically
 * inevitable, so a participant watching the bonding-curve PDA can fire into the SAME slot the
 * threshold is crossed rather than the slot after. That is prediction of a known event, not a
 * reaction to an unknown one, which is a different problem from the one MT144 closed.
 *
 * BUT A SEAT IS ONLY WORTH SOMETHING IF IT IS NOT ALREADY FULL, and that is what this measures.
 * MT156's +955 bps is what the EXISTING slot-0 cohort earned. It is not what an ADDITIONAL
 * participant would earn, because every buy moves the price for the next one. So this prices OUR
 * OWN buy inserted at each position in the slot-0 queue - first, second, third and so on - against
 * the reserves as they actually stood at that moment, and reads how fast the seat loses value.
 *
 * WHAT THE SHAPES WOULD MEAN. If position 1 pays enormously and position 5 pays nothing, the seat
 * is a race after all and we would be buying a ticket to a contest against people with better
 * infrastructure. If the value decays slowly across ten positions, then arriving inside the slot is
 * what matters and being first is a bonus - which is the case where building for it is rational.
 *
 * FEASIBILITY IS A SEPARATE QUESTION AND IS NOT ANSWERED HERE. This says what each rung is worth.
 * Whether we can occupy a given rung depends on infrastructure that has not been built or costed.
 *
 * Read-only on the rebuilt caches. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '').split(',').filter((s) => s.length > 0);
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const FIXED_NONAMM_LAMPORTS = 46_000;
const NONAMM_BPS = 1e4 * FIXED_NONAMM_LAMPORTS / Number(NOTIONAL);
const HOLD_S = Number(arg('hold') ?? '30');
const BARRIER = Number(arg('barrier') ?? '3000');
const V_CANDIDATES = [0n, 17_584_500_000n];
/** Queue positions to price: insert our buy BEFORE the Nth existing slot-0 trade. */
const POSITIONS = [0, 1, 2, 3, 5, 8, 12];
/** Slots that must pass after entry before we may sell. Buying fast is useless if selling is slow. */
const EXIT_LAG_SLOTS = Number(arg(String.fromCharCode(101,120,105,116,45,108,97,103)) ?? 1);

const SPLIT_NL = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
interface PoolMeta { born: number }
const meta = new Map<string, PoolMeta>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(SPLIT_NL)) {
  if (line.length === 0) continue;
  try {
    const r = JSON.parse(line) as { pool: string; createdSlot: number; quoteMint: string };
    if (r.quoteMint !== 'So11111111111111111111111111111111111111112') continue;
    meta.set(r.pool, { born: r.createdSlot });
  } catch { /* skip */ }
}

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; qa: bigint; ua: bigint; who: string }

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

const out = new Map<number, number[]>();
for (const p of POSITIONS) out.set(p, []);
let pools = 0;
let unpriceable = 0;
const slot0Counts: number[] = [];
const slot0Sol: number[] = [];

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const byPool = new Map<string, Ev[]>();
  let chunkMin = Infinity; let chunkMax = -Infinity;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (r.length < 15) continue;
    if (r[1] < chunkMin) chunkMin = r[1];
    if (r[1] > chunkMax) chunkMax = r[1];
    if (!meta.has(r[0])) continue;
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
             b: BigInt(r[6]), q: BigInt(r[7]), qa: BigInt(r[8]), ua: BigInt(r[9]), who: typeof r[13] === 'string' ? r[13] : '' });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [pool, raw] of byPool) {
    const mm = meta.get(pool);
    if (mm === undefined) continue;
    const evs = raw.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const first = evs[0];
    if (first === undefined) continue;
    /**
     * THE POOL MUST HAVE BEEN CREATED INSIDE THIS CHUNK, or evs[0] is not its first trade EVER, only
     * its first trade in our window. Dropping this check while relaxing the same-slot requirement
     * pulled in pools born earlier and produced a mean of 576,273 bps - a 5,762x average return, or
     * 115 SOL of profit on a 0.02 SOL stake, which is arithmetically impossible and is how the bug
     * announced itself.
     */
    if (mm.born < chunkMin || mm.born > chunkMax) continue;
    const fee = feeOf(evs); const v = resolveV(evs);
    if (fee === null || v === null) continue;
    /**
     * THE QUEUE IS THE POOL FIRST TRADES, NOT ONLY THE ONES IN ITS CREATE SLOT. Requiring the first
     * trade to land in the create slot dropped 47.4% of block D migrations - and those were not duds:
     * NONE of them failed to trade, their first trade simply arrived a median of ONE slot later. On
     * those we would face no slot-0 competition at all, so excluding them understated the population
     * and biased the denominator. Position k now means inserting our buy before the pool k-th trade
     * ever, which is what firing on every migration actually produces.
     */
    const inSlot0 = evs;
    if (inSlot0.length === 0) continue;
    pools += 1;
    slot0Counts.push(new Set(inSlot0.filter((e) => e.buy && e.who).map((e) => e.who)).size);
    slot0Sol.push(inSlot0.filter((e) => e.buy).reduce((a2, e) => a2 + Number(e.qa > e.ua ? e.qa : e.ua) / LAMPORTS, 0));

    const ladder: PoolFeeLadder = { lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: BigInt(Math.round(fee)) };
    for (const pos of POSITIONS) {
      /** Insert our buy against the reserves as they stood before the pos-th slot-0 trade. */
      const at = inSlot0[Math.min(pos, inSlot0.length - 1)];
      if (at === undefined || at.b <= 0n || at.q <= 0n) continue;
      if (pos > 0 && pos >= inSlot0.length) continue;
      let bf;
      try { bf = priceBuy({ base: at.b, quote: at.q, virtualQuote: v }, NOTIONAL, ladder); } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; continue; }
      /** Exit at the barrier within the hold, else mark at the last observation inside it. */
      let booked: number | null = null; let last = NaN;
      for (const e of evs) {
        /**
         * EXIT NO EARLIER THAN THE NEXT SLOT. The first version of this booked the exit at the mark
         * of a trade in the SAME slot as our entry, which is not reachable: we cannot sell into buys
         * that land in the block we bought in. It produced a median of +14,766 bps at position 0,
         * because the entire graduation pump happens inside slot 0. Requiring the exit to be at least
         * one slot later is the honest constraint and it is the whole difference.
         */
        if (e.slot < at.slot + EXIT_LAG_SLOTS || e.b <= 0n || e.q <= 0n) continue;
        if (e.ts > at.ts + HOLD_S) break;
        /**
         * WE CANNOT SELL MORE BASE THAN THE POOL HOLDS. Buying drains the base reserve, so in a pool
         * being slammed after migration e.b can fall BELOW the base we bought - and subtracting our
         * position then yields a negative reserve, which makes priceSell return nonsense. That is how
         * a mean of 1,064,952 bps appeared beside a median of 3,222: a handful of impossible marks.
         * Refusing to price those is the fail-closed reading; they are counted and reported.
         */
        if (e.b <= bf.baseOut) { unpriceable += 1; continue; }
        /**
         * REFUSE A MARK TAKEN AFTER LIQUIDITY LEFT THE POOL. MT106 recorded that deposits and
         * withdrawals move reserves for reasons that are NOT trades, and the constant product only
         * ever rises from fees - so a fall in k means liquidity was removed. Pricing a sell against
         * the remnant of a drained pool produced marks of 110,674,783 bps, an 11,067x return in
         * thirty seconds, and a p95 of 369x. Reaching 369x from a 67.4 SOL pool would need about
         * 24,800 SOL of buying, so these are arithmetic, not trades. You cannot sell into a pool
         * that is no longer there; the fail-closed reading is to refuse the mark.
         */
        const kEntry = Number(at.b) * Number(at.q + v);
        const kExit = Number(e.b) * Number(e.q + v);
        if (!(kExit >= kEntry * 0.99)) { unpriceable += 1; continue; }
        try {
          const sf = priceSell({ base: e.b - bf.baseOut, quote: e.q + (bf.reservesAfter.quote - at.q), virtualQuote: v }, bf.baseOut, ladder);
          const bps = 1e4 * Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL) - NONAMM_BPS;
          last = bps;
          if (bps >= BARRIER || bps <= -BARRIER) { booked = bps; break; }
        } catch (e2) { if (!(e2 instanceof FillNotPriceable)) throw e2; }
      }
      const val = booked !== null ? booked : last;
      if (Number.isFinite(val)) out.get(pos)?.push(val);
    }
  }
  byPool.clear();
  console.log(`  ${w} — ${pools.toLocaleString()} pools with an observed birth slot`);
}

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const qt = (x: number[], p: number): number => { const s = [...x].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};

console.log('');
console.log(`MT168 — value of a slot-0 seat by queue position, ${pools.toLocaleString()} pools`);
console.log(`  stake ${(Number(NOTIONAL) / 1e9).toFixed(4)} SOL, non-AMM drag ${NONAMM_BPS.toFixed(0)} bps, exit at +/-${BARRIER} or ${HOLD_S}s`);
console.log(`  distinct slot-0 BUYERS per pool: p25 ${qt(slot0Counts, 0.25)}  median ${med(slot0Counts)}  p75 ${qt(slot0Counts, 0.75)}  p95 ${qt(slot0Counts, 0.95)}`);
console.log(`  SOL bought in slot 0 per pool:   p25 ${qt(slot0Sol, 0.25).toFixed(1)}  median ${med(slot0Sol).toFixed(1)}  p75 ${qt(slot0Sol, 0.75).toFixed(1)}`);
console.log('');
console.log(`  marks refused because our position exceeded the pool base reserve: ${unpriceable.toLocaleString()}`);
const p0: number[] = (out.get(0) ?? []).slice().sort((a, b) => b - a);
console.log('  position-0 outcome tail (bps): max ' + p0.slice(0,6).map(x=>x.toFixed(0)).join(', '));
console.log('  p99 ' + (p0[Math.floor(0.01 * p0.length)] ?? 0).toFixed(0) + '  p95 ' + (p0[Math.floor(0.05 * p0.length)] ?? 0).toFixed(0) + '  p75 ' + (p0[Math.floor(0.25 * p0.length)] ?? 0).toFixed(0));
console.log('  share of the MEAN from the top 10 outcomes: ' + (100*p0.slice(0,10).reduce((a,b)=>a+b,0)/p0.reduce((a,b)=>a+b,0)).toFixed(1) + '%');
console.log('  our queue position       n      mean      median     %pos    g(f=.05)   g(f=.10)');
for (const pos of POSITIONS) {
  const a = out.get(pos) ?? [];
  if (a.length < 30) continue;
  const f5 = growth(a, 0.05); const f10 = growth(a, 0.10);
  console.log(
    `  ${(pos === 0 ? 'FIRST (ahead of all)' : `after ${pos}`).padEnd(22)} ${String(a.length).padStart(6)} ${mean(a).toFixed(0).padStart(9)} ${med(a).toFixed(0).padStart(11)} ${(100 * a.filter((x) => x > 0).length / a.length).toFixed(1).padStart(7)}% ${(f5 === -Infinity ? 'RUIN' : f5.toFixed(4)).padStart(11)} ${(f10 === -Infinity ? 'RUIN' : f10.toFixed(4)).padStart(10)}`,
  );
}
console.log('');
console.log('  If the value collapses across the first few positions, the seat is a RACE and buying');
console.log('  infrastructure buys a contest against better-funded participants. If it decays slowly,');
console.log('  arriving inside the slot is what matters and being first is only a bonus.');
