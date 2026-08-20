/**
 * Verify the BACKFILL decode path the same way the tape decode path was verified.
 *
 * This deliberately reports NO returns, NO price outcomes and NO cell statistics. It is
 * run while the MT111 holdout is still downloading, and looking at holdout outcomes
 * before the frozen rule runs would spend the holdout. It checks only mechanics.
 *
 * THE INVARIANT: PumpSwap reserves in the event are the state BEFORE the trade. That was
 * established on the tape by chaining - consecutive trades in one pool must satisfy
 *
 *     reserves_before(trade N+1) == reserves_before(trade N) -/+ the legs of trade N
 *
 * If the backfill is ordered correctly and decoded correctly, the chain closes exactly.
 * If it does not close, then either the ordering key is wrong (slot, transactionIndex,
 * instructionAddress) or the offsets differ between the log path and the CPI path, and
 * every number MT111 would produce would be built on sand.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const DIR = 'data/sqd/events-pAMMBay6';
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('no holdout file on disk yet'); process.exit(0); }
console.log(`verifying decode against ${file}\n`);

interface E { slot: number; tx: number; addr: string; side: string; b: bigint; q: bigint; base: bigint; quote: bigint; userQuote: bigint }
const byPool = new Map<string, E[]>();
let lines = 0; let ins = 0; let wrapped = 0; let trades = 0;
for (const line of readFileSync(`${DIR}/${file}`, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  lines += 1;
  const blk = JSON.parse(line) as { header: { number: number }; instructions: { transactionIndex: number; instructionAddress: number[]; data: string }[] };
  for (const i of blk.instructions) {
    ins += 1;
    let raw: Buffer;
    try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
    wrapped += 1;
    const t = decodePumpSwapTrade(raw.subarray(8));
    if (t === null) continue;
    trades += 1;
    const a = byPool.get(t.pool) ?? [];
    a.push({ slot: blk.header.number, tx: i.transactionIndex, addr: i.instructionAddress.join('.'),
             side: t.side, b: t.poolBaseReservesBefore, q: t.poolQuoteReservesBefore,
             base: t.baseAmount, quote: t.quoteAmount, userQuote: t.userQuoteAmount });
    byPool.set(t.pool, a);
  }
}
console.log(`blocks ${lines.toLocaleString()}  instructions ${ins.toLocaleString()}  emit_cpi-wrapped ${wrapped.toLocaleString()}  decoded as trades ${trades.toLocaleString()}`);
console.log(`pools ${byPool.size.toLocaleString()}\n`);

// Chain the reserves. A BUY sends quote in and base out; a SELL the reverse.
let checked = 0; let exact = 0; let mismatch = 0;
const examples: string[] = [];
for (const [pool, evs] of byPool) {
  if (evs.length < 3) continue;
  evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  for (let i = 0; i + 1 < evs.length; i += 1) {
    const a = evs[i]; const b = evs[i + 1];
    if (a === undefined || b === undefined) continue;
    // Predict the next trade's BEFORE state from this trade's BEFORE state and its legs.
    const predB = a.side === 'BUY' ? a.b - a.base : a.b + a.base;
    const predQ = a.side === 'BUY' ? a.q + a.quote : a.q - a.quote;
    checked += 1;
    if (predB === b.b && predQ === b.q) exact += 1;
    else {
      mismatch += 1;
      if (examples.length < 5) examples.push(
        `  ${pool.slice(0, 8)} ${a.side} slot ${a.slot}: predicted base ${predB} quote ${predQ}  |  next reports base ${b.b} quote ${b.q}  |  dq ${b.q - predQ} db ${b.b - predB}`);
    }
  }
}
console.log('RESERVE CHAIN — consecutive trades in one pool, predicted vs reported');
console.log(`  adjacent pairs checked ${checked.toLocaleString()}`);
console.log(`  EXACT (zero tolerance) ${exact.toLocaleString()} = ${(100 * exact / Math.max(checked, 1)).toFixed(2)}%`);
console.log(`  mismatched             ${mismatch.toLocaleString()}`);
if (examples.length > 0) { console.log('\n  first mismatches:'); for (const e of examples) console.log(e); }
console.log('\n  A mismatch is EXPECTED wherever a Deposit or Withdraw landed between two trades,');
console.log('  or where the pool was touched by a route this program filter does not carry.');
console.log('  What would be fatal is a LOW exact rate, which would mean the ordering key or the');
console.log('  offsets are wrong. No outcome, price or return is computed by this script.');
