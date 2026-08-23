/**
 * Take a wallet apart until its strategy can be rebuilt from scratch.
 *
 * MT180 established the thing this exists to answer. MRiYA4oN... is profitable in 16 of 17 windows,
 * never touches a launch bundle, and trades pools that are already a day old - but FOLLOWING it does
 * not work. Its positions, priced for an observer arriving twelve slots later, lose their entire edge
 * when the best 3.4% of outcomes are removed. It makes 55,572 trades to close 1,846 positions, about
 * thirty per position, so it is slicing entry and exit algorithmically.
 *
 * THAT COMBINATION POINTS SOMEWHERE SPECIFIC. If the profit were in WHICH pools it chose, a follower
 * buying the same pool minutes later would capture most of it, because a four-hour hold does not turn
 * on a twelve-slot delay. The follower captures nothing. So the profit is not in the choice; it is in
 * the thirty trades - in how the position is built and unwound. That is not something you can copy by
 * watching. It is something you would have to REBUILD.
 *
 * So this does not measure an expectation and does not produce a signal. It answers mechanical
 * questions precisely enough to reimplement:
 *
 *   WHAT IS A POSITION MADE OF - how many buys, how many sells, and crucially whether they interleave.
 *   Buy-buy-buy-sell-sell-sell is algorithmic accumulation and distribution, a directional bet worked
 *   carefully. Buy-sell-buy-sell around a level is market making, which earns the spread and is a
 *   completely different business with completely different requirements.
 *
 *   WHAT DOES IT ENTER INTO - pool age, size, and what the price did in the minutes BEFORE it bought.
 *   Buying after a fall is mean reversion; buying after a rise is momentum; buying regardless is
 *   liquidity provision.
 *
 *   WHAT ENDS A POSITION - time, a profit target, or a price event. The exit rule is usually the part
 *   that carries a strategy, and it is the part a follower can never see in time.
 *
 *   HOW BIG, in absolute SOL, because a method that needs size is not a method available to us.
 *
 * Reads tape. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WALLET = arg('wallet') ?? '';
const WINDOWS = (arg('windows') ?? 'E').split(',').filter((s) => s.length > 0);
const SAMPLES = Number(arg('samples') ?? '3');
const CACHE = 'data/trade-cache';
if (WALLET === '') { console.log('need --wallet=<pubkey>'); process.exit(2); }

const poolBorn = new Map<string, number>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(/\r?\n/)) {
  if (line.length === 0) continue;
  try { const r = JSON.parse(line) as { pool: string; createdSlot?: number }; if (r.createdSlot !== undefined) poolBorn.set(r.pool, r.createdSlot); } catch { /* skip */ }
}

type Row = [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
async function* read(windows: string[]): AsyncGenerator<Row> {
  for (const w of windows) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) continue;
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      try { yield JSON.parse(line) as Row; } catch { /* skip */ }
    }
    rl.close();
  }
}

// ---- pass 1: which pools does it touch ----
const pools = new Set<string>();
for await (const r of read(WINDOWS)) { if (r[13] === WALLET) pools.add(r[0]); }
console.log(`WALLET ANATOMY — ${WALLET}`);
console.log(`  windows ${WINDOWS.join(',')}, ${pools.size.toLocaleString()} pools touched`);

// ---- pass 2: the full tape of those pools, so context around each trade is visible ----
interface T { slot: number; buy: boolean; price: number; quote: number; base: number; mine: boolean }
const tape = new Map<string, T[]>();
for await (const r of read(WINDOWS)) {
  const pool = r[0];
  if (!pools.has(pool)) continue;
  const b = Number(r[6]); const q = Number(r[7]);
  if (!(b > 0) || !(q > 0)) continue;
  const a = tape.get(pool) ?? [];
  a.push({ slot: r[1], buy: r[5] === 1, price: q / b, quote: Number(r[9]), base: Number(r[14]), mine: r[13] === WALLET });
  tape.set(pool, a);
}
for (const a of tape.values()) a.sort((x, y) => x.slot - y.slot);

/** A position: a contiguous run in one pool from first buy until inventory returns to ~zero. */
interface Pos { pool: string; trades: T[]; startSlot: number; endSlot: number }
const positions: Pos[] = [];
for (const [pool, a] of tape) {
  let cur: T[] = []; let inv = 0;
  for (const t of a) {
    if (!t.mine) continue;
    cur.push(t);
    inv += t.buy ? t.base : -t.base;
    /** Inventory back to within 1% of flat closes the position. */
    if (cur.length > 1 && Math.abs(inv) < 0.01 * cur.filter((x) => x.buy).reduce((s, x) => s + x.base, 0)) {
      positions.push({ pool, trades: cur, startSlot: cur[0]?.slot ?? 0, endSlot: t.slot });
      cur = []; inv = 0;
    }
  }
}
console.log(`  ${positions.length.toLocaleString()} completed positions (inventory returned to flat)`);
console.log('');

const med = (a: number[]): number => { if (a.length === 0) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };
const SOL = (x: number): string => (x / 1e9).toFixed(4);

// ---- 1. what is a position made of ----
const nTrades = positions.map((p) => p.trades.length);
const nBuys = positions.map((p) => p.trades.filter((t) => t.buy).length);
const nSells = positions.map((p) => p.trades.filter((t) => !t.buy).length);
/** Interleaving: share of positions where a buy occurs AFTER the first sell. */
const interleaved = positions.filter((p) => {
  const firstSell = p.trades.findIndex((t) => !t.buy);
  return firstSell >= 0 && p.trades.slice(firstSell).some((t) => t.buy);
}).length;
console.log('  1. WHAT A POSITION IS MADE OF');
console.log(`     median trades per position ${med(nTrades).toFixed(0)}   buys ${med(nBuys).toFixed(0)}   sells ${med(nSells).toFixed(0)}`);
console.log(`     positions where a BUY follows the first SELL: ${interleaved}/${positions.length} = ${((100 * interleaved) / Math.max(1, positions.length)).toFixed(1)}%`);
console.log(`     ${(100 * interleaved) / Math.max(1, positions.length) > 50 ? '=> INTERLEAVED: market making around a level, earning the spread' : '=> SEQUENTIAL: accumulate then distribute, a directional bet worked in slices'}`);
console.log('');

// ---- 2. what does it enter into ----
const ages: number[] = []; const liq: number[] = []; const pre: number[] = [];
for (const p of positions) {
  const a = tape.get(p.pool) ?? [];
  const i = a.findIndex((t) => t.slot === p.startSlot && t.mine);
  if (i < 0) continue;
  const born = poolBorn.get(p.pool);
  if (born !== undefined) ages.push(p.startSlot - born);
  liq.push(a[i]?.price !== undefined ? 0 : 0);
  /** Price change over the 1,500 slots (~10 min) before entry. */
  const then = a.filter((t) => t.slot <= p.startSlot - 1500).pop();
  const now = a[i];
  if (then !== undefined && now !== undefined && then.price > 0) pre.push(1e4 * (now.price / then.price - 1));
}
console.log('  2. WHAT IT ENTERS INTO');
console.log(`     median pool age at entry: ${med(ages).toFixed(0)} slots = ${(med(ages) * 0.4 / 3600).toFixed(1)} hours`);
console.log(`     median price change in the 10 minutes BEFORE entry: ${med(pre).toFixed(0)} bps  (n=${pre.length})`);
console.log(`     share of entries after a FALL: ${((100 * pre.filter((x) => x < 0).length) / Math.max(1, pre.length)).toFixed(1)}%`);
console.log(`     ${med(pre) < -100 ? '=> buys weakness: mean reversion' : med(pre) > 100 ? '=> buys strength: momentum' : '=> indifferent to prior move: liquidity provision or schedule-driven'}`);
console.log('');

// ---- 3. what ends a position ----
const holds: number[] = []; const runup: number[] = []; const exitVsPeak: number[] = [];
for (const p of positions) {
  holds.push(p.endSlot - p.startSlot);
  const a = tape.get(p.pool) ?? [];
  const span = a.filter((t) => t.slot >= p.startSlot && t.slot <= p.endSlot);
  const entry = span[0]?.price ?? 0; const exit = span[span.length - 1]?.price ?? 0;
  if (entry > 0) runup.push(1e4 * (exit / entry - 1));
  const peak = Math.max(...span.map((t) => t.price), 0);
  if (peak > 0 && exit > 0) exitVsPeak.push(1e4 * (exit / peak - 1));
}
console.log('  3. WHAT ENDS A POSITION');
console.log(`     median hold ${med(holds).toFixed(0)} slots = ${(med(holds) * 0.4 / 60).toFixed(0)} min`);
console.log(`     median price move across the hold: ${med(runup).toFixed(0)} bps`);
console.log(`     median exit price vs the PEAK during the hold: ${med(exitVsPeak).toFixed(0)} bps`);
console.log(`     ${med(exitVsPeak) > -500 ? '=> exits near the high: the exit is triggered, not scheduled' : '=> exits well off the high: time- or schedule-based exit'}`);
console.log('');

// ---- 4. size ----
const buySize = positions.flatMap((p) => p.trades.filter((t) => t.buy).map((t) => t.quote));
const posSize = positions.map((p) => p.trades.filter((t) => t.buy).reduce((s, t) => s + t.quote, 0));
console.log('  4. SIZE');
console.log(`     median single buy ${SOL(med(buySize))} SOL   median total position ${SOL(med(posSize))} SOL`);
console.log(`     smallest position ${SOL(Math.min(...posSize))} SOL   largest ${SOL(Math.max(...posSize))} SOL`);
console.log('');

// ---- 5. a few positions in full, because aggregates hide the shape ----
console.log(`  5. ${SAMPLES} POSITIONS IN FULL`);
const byPnl = [...positions].sort((x, y) => y.trades.length - x.trades.length).slice(0, SAMPLES);
for (const p of byPnl) {
  console.log(`     pool ${p.pool.slice(0, 12)}  ${p.trades.length} trades over ${((p.endSlot - p.startSlot) * 0.4 / 60).toFixed(0)} min`);
  let inv = 0;
  for (const t of p.trades.slice(0, 40)) {
    inv += t.buy ? t.base : -t.base;
    console.log(`       +${String(t.slot - p.startSlot).padStart(6)} slots  ${t.buy ? 'BUY ' : 'SELL'}  ${SOL(t.quote).padStart(10)} SOL   price ${t.price.toExponential(3)}   inventory ${(inv / 1e6).toFixed(1)}M`);
  }
  if (p.trades.length > 40) console.log(`       ... ${p.trades.length - 40} more`);
  console.log('');
}
