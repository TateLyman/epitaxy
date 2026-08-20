/**
 * Does offset 344 actually carry the creator fee?
 *
 * I told the user that offsets 72, 88 and 344 "return plausible ladders in all three struct
 * lengths, so MT110 through MT112 fee numbers stand". An adversarial review says that is wrong,
 * and that plausibility was never the test. This checks it independently.
 *
 * SELL LEGS ONLY, deliberately: the sell struct has one layout, so this is immune to the
 * two-BuyEvent-layout question. On a sell the program's own arithmetic is checkable:
 *
 *     user_quote_amount = quote_amount - lp - protocol - creator
 *
 * so the fee ACTUALLY charged is (quote_amount - user_quote_amount), and the fee we MODEL is
 * (lp + protocol + creator) read at 72/88/344. If those disagree, the decode is wrong, and the
 * residual is the fee we are failing to charge.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DIR = 'data/sqd/events-pAMMBay6';
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('none'); process.exit(0); }

let n = 0; let exact = 0; let under = 0; let over = 0;
let gapSum = 0;
const residuals = new Map<number, number>();
const declaredWhenWrong = new Map<number, number>();
for (const line of readFileSync(`${DIR}/${file}`, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  const blk = JSON.parse(line) as { header?: { number: number }; instructions?: { data: string }[] };
  if (blk.header === undefined) continue;
  for (const i of blk.instructions ?? []) {
    let raw: Buffer;
    try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
    const t = decodePumpSwapTrade(raw.subarray(8));
    if (t === null || t.side !== 'SELL' || t.coinCreatorFeeBasisPoints === null) continue;
    if (t.quoteAmount <= 0n || t.userQuoteAmount <= 0n) continue;
    // Fee actually charged, in bps of the curve leg.
    const chargedBps = 1e4 * (Number(t.quoteAmount) - Number(t.userQuoteAmount)) / Number(t.quoteAmount);
    const declaredBps = Number(t.lpFeeBasisPoints + t.protocolFeeBasisPoints + t.coinCreatorFeeBasisPoints);
    if (!Number.isFinite(chargedBps)) continue;
    n += 1;
    const gap = chargedBps - declaredBps;
    gapSum += gap;
    if (Math.abs(gap) < 0.75) exact += 1;
    else if (gap > 0) {
      under += 1;
      const r = Math.round(gap / 5) * 5;
      residuals.set(r, (residuals.get(r) ?? 0) + 1);
      declaredWhenWrong.set(Number(t.coinCreatorFeeBasisPoints), (declaredWhenWrong.get(Number(t.coinCreatorFeeBasisPoints)) ?? 0) + 1);
    } else over += 1;
  }
}
console.log(`SELL legs checked: ${n.toLocaleString()}\n`);
console.log(`  declared ladder MATCHES the fee actually charged  ${exact.toLocaleString()} = ${(100 * exact / n).toFixed(1)}%`);
console.log(`  declared ladder UNDERSTATES the charge            ${under.toLocaleString()} = ${(100 * under / n).toFixed(1)}%`);
console.log(`  declared ladder overstates                        ${over.toLocaleString()} = ${(100 * over / n).toFixed(2)}%`);
console.log(`  mean gap over all sells: ${(gapSum / n).toFixed(2)} bps per leg  ->  ${(2 * gapSum / n).toFixed(2)} bps per ROUND TRIP\n`);
console.log('THE MISSING FEE, rounded to 5 bps — if these are clean multiples the field is real');
for (const [r, c] of [...residuals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  +${String(r).padStart(3)} bps   ${String(c).padStart(6)} sells`);
}
console.log('\nWHAT offset 344 REPORTED on those same trades');
for (const [d, c] of [...declaredWhenWrong.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  creator_fee_bps = ${String(d).padStart(3)}   ${String(c).padStart(6)} sells`);
}
console.log('\n  If the residual is a clean multiple of 5 while offset 344 reads 0, then the creator');
console.log('  fee is REAL, CHARGED, and NOT AT 344 on those events. Every cost number built on it');
console.log('  is understated, and my claim that the fee numbers stand was wrong.');
