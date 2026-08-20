/**
 * THE OPEN DEFECT, probably closed here.
 *
 * CURRENT_STATE records that `quote_amount` and `user_quote_amount` appear SWAPPED on about a
 * third of buys, that the cause is unknown, and that it blocks MT106/MT112 volume measurement.
 * Every prior attempt looked for the cause in the VALUES. It is in the LAYOUT.
 *
 * BuyEvent comes in TWO struct lengths, 465 and 480 bytes, and the 465 class is 36.4% of buys
 * against a measured 36.7% of buys where user_quote_amount is the larger field. This tests
 * whether those are the same set - if they are, the fields are not swapped at all, we have
 * been reading two different structs with one offset table.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DIR = 'data/sqd/events-pAMMBay6';
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('none'); process.exit(0); }

const tally = new Map<string, number>();
const byLen = new Map<number, { q: bigint; u: bigint; base: bigint }[]>();
for (const line of readFileSync(`${DIR}/${file}`, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  const blk = JSON.parse(line) as { header?: { number: number }; instructions?: { data: string }[] };
  if (blk.header === undefined) continue;
  for (const i of blk.instructions ?? []) {
    let raw: Buffer;
    try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
    const body = raw.subarray(8);
    const t = decodePumpSwapTrade(body);
    if (t === null || t.side !== 'BUY') continue;
    const larger = t.userQuoteAmount > t.quoteAmount ? 'user_quote LARGER' : t.quoteAmount > t.userQuoteAmount ? 'quote LARGER' : 'equal';
    tally.set(`${body.length}B  ${larger}`, (tally.get(`${body.length}B  ${larger}`) ?? 0) + 1);
    const a = byLen.get(body.length) ?? [];
    a.push({ q: t.quoteAmount, u: t.userQuoteAmount, base: t.baseAmount });
    byLen.set(body.length, a);
  }
}
console.log('BUY EVENTS — struct length CROSSED WITH which quote field is larger\n');
const total = [...tally.values()].reduce((a, b) => a + b, 0);
for (const [k, v] of [...tally.entries()].sort()) {
  console.log(`  ${k.padEnd(30)} ${String(v).padStart(6)}   ${(100 * v / total).toFixed(1).padStart(5)}%`);
}
console.log('\n  A PERFECT split - each length class showing only ONE ordering - means the fields were');
console.log('  never swapped. It means 465-byte and 480-byte BuyEvents are DIFFERENT STRUCTS and');
console.log('  our single offset table reads one of them at the wrong positions.');

console.log('\nRATIO user_quote / quote, per length class');
for (const [len, a] of [...byLen.entries()].sort((x, y) => x[0] - y[0])) {
  const rs = a.filter((r) => r.q > 0n).map((r) => Number(r.u) / Number(r.q)).filter(Number.isFinite).sort((x, y) => x - y);
  if (rs.length === 0) continue;
  const P = (x: number): number => rs[Math.floor(x * (rs.length - 1))] ?? NaN;
  console.log(`  ${len}B  n=${String(rs.length).padStart(6)}   p10 ${P(0.1).toFixed(5)}   p50 ${P(0.5).toFixed(5)}   p90 ${P(0.9).toFixed(5)}`);
}
console.log('\n  If one class sits just ABOVE 1.0 by roughly a fee and the other just BELOW by the same,');
console.log('  both are internally consistent and only the FIELD NAMES are exchanged between them.');
