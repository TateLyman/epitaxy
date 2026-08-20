/**
 * Which quote field is which, settled by arithmetic rather than by naming.
 *
 * CURRENT_STATE records that `quote_amount` and `user_quote_amount` appear SWAPPED on
 * 32.2% of stored buys, that the defect is undiagnosed, and that it blocks MT106 because
 * LP volume cannot be measured without knowing which leg the pool actually received.
 *
 * The backfill settles it without needing either name to be trustworthy. Chaining showed
 * the BASE leg closes exactly on 100% of adjacent pairs, so ordering and offsets are
 * correct; only the quote leg is off, by small signed amounts. That residual IS the fee.
 * So for every adjacent pair we can read the pool's realised quote delta directly:
 *
 *     realised = quote_reserves_before(N+1) - quote_reserves_before(N)
 *
 * and ask which of the two decoded fields reproduces it, and at what implied fee. The
 * answer is a fact about the wire format, not an opinion about a field name.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const DIR = 'data/sqd/events-pAMMBay6';
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('no holdout file yet'); process.exit(0); }

interface E { slot: number; tx: number; addr: string; side: string; q: bigint; quote: bigint; userQuote: bigint; lp: bigint; pf: bigint; cf: bigint | null }
const byPool = new Map<string, E[]>();
for (const line of readFileSync(`${DIR}/${file}`, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  const blk = JSON.parse(line) as { header: { number: number }; instructions: { transactionIndex: number; instructionAddress: number[]; data: string }[] };
  for (const i of blk.instructions) {
    let raw: Buffer;
    try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
    const t = decodePumpSwapTrade(raw.subarray(8));
    if (t === null) continue;
    const a = byPool.get(t.pool) ?? [];
    a.push({ slot: blk.header.number, tx: i.transactionIndex, addr: i.instructionAddress.join('.'), side: t.side,
             q: t.poolQuoteReservesBefore, quote: t.quoteAmount, userQuote: t.userQuoteAmount,
             lp: t.lpFeeBasisPoints, pf: t.protocolFeeBasisPoints, cf: t.coinCreatorFeeBasisPoints });
    byPool.set(t.pool, a);
  }
}

interface Row { side: string; realised: bigint; quote: bigint; userQuote: bigint; feeBps: number }
const rows: Row[] = [];
for (const [, evs] of byPool) {
  evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  for (let i = 0; i + 1 < evs.length; i += 1) {
    const a = evs[i]; const b = evs[i + 1];
    if (a === undefined || b === undefined || a.cf === null) continue;
    rows.push({ side: a.side, realised: b.q - a.q, quote: a.quote, userQuote: a.userQuote,
                feeBps: Number(a.lp + a.pf + a.cf) });
  }
}
console.log(`adjacent pairs with a known fee ladder: ${rows.length.toLocaleString()}\n`);

const pct = (a: number[], x: number): number => { const s = [...a].sort((m, n) => m - n); return s.length ? (s[Math.floor(x * (s.length - 1))] ?? NaN) : NaN; };
for (const side of ['BUY', 'SELL']) {
  const r = rows.filter((x) => x.side === side);
  if (r.length === 0) continue;
  console.log(`=== ${side}  n=${r.length.toLocaleString()} ===`);
  // The pool's realised quote delta, in magnitude, against each candidate field.
  const mag = (v: bigint): bigint => (v < 0n ? -v : v);
  const exactQuote = r.filter((x) => mag(x.realised) === x.quote).length;
  const exactUser = r.filter((x) => mag(x.realised) === x.userQuote).length;
  console.log(`  pool delta EXACTLY equals quote_amount ...... ${exactQuote.toLocaleString()} = ${(100 * exactQuote / r.length).toFixed(2)}%`);
  console.log(`  pool delta EXACTLY equals user_quote_amount . ${exactUser.toLocaleString()} = ${(100 * exactUser / r.length).toFixed(2)}%`);
  // Implied fee: how far the OTHER field sits from the realised delta.
  const impliedFromQuote = r.filter((x) => x.quote > 0n).map((x) => 1e4 * (Number(x.quote) - Number(mag(x.realised))) / Number(x.quote));
  const impliedFromUser = r.filter((x) => x.userQuote > 0n).map((x) => 1e4 * (Number(x.userQuote) - Number(mag(x.realised))) / Number(x.userQuote));
  console.log(`  implied bps if quote_amount is the GROSS leg:      p10 ${pct(impliedFromQuote, 0.1).toFixed(1)}  p50 ${pct(impliedFromQuote, 0.5).toFixed(1)}  p90 ${pct(impliedFromQuote, 0.9).toFixed(1)}`);
  console.log(`  implied bps if user_quote_amount is the GROSS leg: p10 ${pct(impliedFromUser, 0.1).toFixed(1)}  p50 ${pct(impliedFromUser, 0.5).toFixed(1)}  p90 ${pct(impliedFromUser, 0.9).toFixed(1)}`);
  // Against the ladder the event itself declares.
  const ladder = r.map((x) => x.feeBps);
  console.log(`  the fee ladder DECLARED by the event:              p10 ${pct(ladder, 0.1).toFixed(1)}  p50 ${pct(ladder, 0.5).toFixed(1)}  p90 ${pct(ladder, 0.9).toFixed(1)}`);
  // Which field is larger - the gross leg must be the larger one on a buy.
  const qBigger = r.filter((x) => x.quote > x.userQuote).length;
  const uBigger = r.filter((x) => x.userQuote > x.quote).length;
  const same = r.filter((x) => x.userQuote === x.quote).length;
  console.log(`  quote_amount > user_quote_amount: ${(100 * qBigger / r.length).toFixed(1)}%   user > quote: ${(100 * uBigger / r.length).toFixed(1)}%   equal: ${(100 * same / r.length).toFixed(1)}%`);
  console.log('');
}
console.log('READ THIS AS: whichever assignment produces an implied fee matching the DECLARED');
console.log('ladder is the correct one. A field that implies a fee of the wrong sign, or one an');
console.log('order of magnitude off the declared ladder, is not the leg its name claims.');
