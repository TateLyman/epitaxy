/**
 * Do DepositEvent and WithdrawEvent actually decode from the backfill?
 *
 * CURRENT_STATE once said this was "already built". That was wrong and is recorded as a
 * correction: `decodePumpSwapLiquidity` existed in `pumpswap-event.ts` but had no table,
 * was never called by the collector, and had never been run against a captured event.
 * MT106 - LP on deep high-fee pools, the only mechanism found that needs no predictive
 * edge, no latency and no distribution - self-voided partly for want of exactly this.
 *
 * Mechanics only. No LP return, no LVR, no fee income is computed here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { decodePumpSwapTrade, decodePumpSwapLiquidity } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const DIR = 'data/sqd/events-pAMMBay6';
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('no holdout file yet'); process.exit(0); }
console.log(`liquidity decode against ${file}\n`);

let wrapped = 0; let trades = 0; let liq = 0; let neither = 0;
const disc = new Map<string, number>();
const poolsWithLiq = new Set<string>();
const poolsWithTrades = new Set<string>();
let deposits = 0; let withdraws = 0;
const samples: string[] = [];

for (const line of readFileSync(`${DIR}/${file}`, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  const blk = JSON.parse(line) as { header: { number: number }; instructions: { data: string }[] };
  for (const i of blk.instructions) {
    let raw: Buffer;
    try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
    wrapped += 1;
    const body = raw.subarray(8);
    const t = decodePumpSwapTrade(body);
    if (t !== null) { trades += 1; poolsWithTrades.add(t.pool); continue; }
    const l = decodePumpSwapLiquidity(body);
    if (l !== null) {
      liq += 1;
      poolsWithLiq.add(l.pool);
      if (l.side === 'DEPOSIT') deposits += 1; else withdraws += 1;
      if (samples.length < 4) samples.push(`  ${l.side.padEnd(8)} pool ${l.pool.slice(0, 8)} baseReserves ${String(l.poolBaseReserves)} quoteReserves ${String(l.poolQuoteReserves)} lpMintSupply ${String(l.lpMintSupply)}`);
      continue;
    }
    neither += 1;
    const d = body.subarray(0, 8).toString('hex');
    disc.set(d, (disc.get(d) ?? 0) + 1);
  }
}
console.log(`emit_cpi-wrapped events ${wrapped.toLocaleString()}`);
console.log(`  decoded as TRADE      ${trades.toLocaleString()}  across ${poolsWithTrades.size.toLocaleString()} pools`);
console.log(`  decoded as LIQUIDITY  ${liq.toLocaleString()}  across ${poolsWithLiq.size.toLocaleString()} pools   deposits ${deposits}  withdraws ${withdraws}`);
console.log(`  decoded as NEITHER    ${neither.toLocaleString()}`);
if (samples.length > 0) { console.log('\nfirst liquidity events decoded:'); for (const s of samples) console.log(s); }
if (disc.size > 0) {
  console.log('\nunknown discriminators, preserved rather than dropped:');
  for (const [d, n] of [...disc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${d}  ${n.toLocaleString()}`);
}
const both = [...poolsWithLiq].filter((p) => poolsWithTrades.has(p)).length;
console.log(`\npools with BOTH trades and liquidity events in this file: ${both}`);
console.log('MT106 needs exactly this: a pool whose reserve path is complete AND whose liquidity');
console.log('events are known, so k-growth is never mistaken for volume. That is what voided it twice.');
