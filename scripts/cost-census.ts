/**
 * What is the MINIMUM achievable round-trip cost on this venue, and how much of the
 * venue is available at it?
 *
 * THIS IS NOT A STRATEGY TEST AND IT COMPUTES NO RETURN. That matters, because the ledger
 * now records that reversion is closed and must not be reopened with a new conditioning
 * variable. No outcome appears anywhere below. This measures a cost term that is knowable
 * before any trade, from fields the event itself declares.
 *
 * The round trip identity, derived from the routing verified in diagnose-quote-fields.ts:
 *
 *     buy Q_gross -> swapped x = Q(1-f_total), reserves gain y = Q(1-f_out), LP part retained
 *     sell the base straight back:
 *         R = (q_eff + y)/(q_eff + x) * (1 - f_total)^2
 *
 * The leading factor is 1 + O(Q*f_lp/q_eff), negligible at research size. So the round trip
 * costs 2 * f_total and PRICE IMPACT CANCELS - you traverse the curve up and back. The whole
 * binding constraint is therefore the fee ladder, which varies by more than tenfold across
 * pools and is set per coin.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const V = 17_584_500_000n;
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DIR = 'data/sqd/events-pAMMBay6';
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('no file'); process.exit(0); }
console.log(`COST CENSUS — one window, ${file}\n`);

interface T { pool: string; rt: number; lp: number; cf: number; depth: number; notional: number }
const ts: T[] = [];
for (const line of readFileSync(`${DIR}/${file}`, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  const blk = JSON.parse(line) as { header?: { number: number }; instructions?: { data: string }[] };
  if (blk.header === undefined) continue;
  for (const i of blk.instructions ?? []) {
    let raw: Buffer;
    try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
    const t = decodePumpSwapTrade(raw.subarray(8));
    if (t === null || t.coinCreatorFeeBasisPoints === null) continue;
    if (t.poolBaseReservesBefore <= 0n || t.poolQuoteReservesBefore <= 0n) continue;
    const one = Number(t.lpFeeBasisPoints + t.protocolFeeBasisPoints + t.coinCreatorFeeBasisPoints);
    ts.push({ pool: t.pool, rt: 2 * one, lp: Number(t.lpFeeBasisPoints), cf: Number(t.coinCreatorFeeBasisPoints),
              depth: Number(t.poolQuoteReservesBefore + V) / 1e9, notional: Number(t.quoteAmount) / 1e9 });
  }
}
console.log(`trades with a fully declared fee ladder: ${ts.length.toLocaleString()}   pools ${new Set(ts.map((t) => t.pool)).size.toLocaleString()}\n`);

const P = (a: number[], x: number): number => { const s = [...a].sort((m, n) => m - n); return s.length ? (s[Math.floor(x * (s.length - 1))] ?? NaN) : NaN; };
const rts = ts.map((t) => t.rt);
console.log('ROUND-TRIP COST IN BASIS POINTS, by trade');
console.log(`  p05 ${P(rts, 0.05).toFixed(0)}   p25 ${P(rts, 0.25).toFixed(0)}   p50 ${P(rts, 0.5).toFixed(0)}   p75 ${P(rts, 0.75).toFixed(0)}   p95 ${P(rts, 0.95).toFixed(0)}   max ${P(rts, 1).toFixed(0)}`);

console.log('\nWHERE THE COST COMES FROM — the creator fee is the only large SELECTABLE term');
const cfs = ts.map((t) => t.cf);
console.log(`  lp fee bps        ${[...new Set(ts.map((t) => t.lp))].sort((a, b) => a - b).join(', ')}`);
console.log(`  creator fee bps   p05 ${P(cfs, 0.05).toFixed(0)}  p50 ${P(cfs, 0.5).toFixed(0)}  p95 ${P(cfs, 0.95).toFixed(0)}   share at ZERO ${(100 * cfs.filter((c) => c === 0).length / cfs.length).toFixed(1)}%`);

console.log('\nHOW MUCH OF THE VENUE IS AVAILABLE AT EACH COST, by TRADE COUNT and by VOLUME');
console.log('  (volume here is the trade quote leg as reported; it is used ONLY to weight cost,');
console.log('   never to compute a return, so the known quote-field defect cannot bias a P&L)');
const totVol = ts.reduce((a, b) => a + b.notional, 0);
for (const [lab, lo, hi] of [['<=50', 0, 50], ['51-100', 51, 100], ['101-150', 101, 150], ['151-200', 151, 200], ['>200', 201, Infinity]] as const) {
  const sub = ts.filter((t) => t.rt >= lo && t.rt <= hi);
  const vol = sub.reduce((a, b) => a + b.notional, 0);
  console.log(`  ${String(lab).padStart(7)} bps   trades ${String(sub.length).padStart(6)} = ${(100 * sub.length / ts.length).toFixed(1).padStart(5)}%   volume ${(100 * vol / Math.max(totVol, 1e-9)).toFixed(1).padStart(5)}%   distinct pools ${new Set(sub.map((s) => s.pool)).size}`);
}

console.log('\nTHE CELL THAT MATTERS: CHEAP **AND** DEEP — cheap alone was a depth confound (MT111)');
for (const [lab, f] of [
  ['cheap<=50 & deep>35SOL', (t: T) => t.rt <= 50 && t.depth > 35],
  ['cheap<=50 & shallow', (t: T) => t.rt <= 50 && t.depth <= 35],
  ['dear>200 & deep>35SOL', (t: T) => t.rt > 200 && t.depth > 35],
  ['dear>200 & shallow', (t: T) => t.rt > 200 && t.depth <= 35],
] as const) {
  const sub = ts.filter(f);
  const vol = sub.reduce((a, b) => a + b.notional, 0);
  console.log(`  ${lab.padEnd(24)} trades ${String(sub.length).padStart(6)} = ${(100 * sub.length / ts.length).toFixed(1).padStart(5)}%   volume share ${(100 * vol / Math.max(totVol, 1e-9)).toFixed(1).padStart(5)}%   pools ${new Set(sub.map((s) => s.pool)).size}`);
}
console.log('\n  ONE WINDOW, ONE CLUSTER. A cost distribution, not a return. Nothing is licensed by it.');
