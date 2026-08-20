/**
 * Does the PumpSwap invariant use a virtual quote reserve, and if so how big is it?
 *
 * This is load-bearing. MT110 and MT111 both price at (q_raw + v)/b with v = 17.5845 SOL,
 * a constant inherited from MT100 and never verified on this venue. MT112 would compute
 * k = b * (q_raw + v). If v is wrong, or belongs to the pump.fun bonding curve rather than
 * to the post-graduation AMM, then every price and every k is wrong by a factor.
 *
 * It is decidable from the data alone and needs no documentation. Between two adjacent
 * trades the pool keeps the LP fee, so the true invariant grows SLIGHTLY and monotonically.
 * A candidate v that is too large or too small will make it jump around instead. So: sweep
 * v, and take the value that minimises the dispersion of log(k_next/k_prev) while keeping
 * that ratio at or above 1.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const DIR = 'data/sqd/events-pAMMBay6';
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('no file yet'); process.exit(0); }

interface E { slot: number; tx: number; addr: string; b: bigint; q: bigint; lp: bigint }
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
    a.push({ slot: blk.header.number, tx: i.transactionIndex, addr: i.instructionAddress.join('.'),
             b: t.poolBaseReservesBefore, q: t.poolQuoteReservesBefore, lp: t.lpFeeBasisPoints });
    byPool.set(t.pool, a);
  }
}

// Only pools with many trades and a stable lp fee, so the expected growth per step is known.
const pairs: { b0: bigint; q0: bigint; b1: bigint; q1: bigint; lp: number }[] = [];
for (const [, evs] of byPool) {
  if (evs.length < 50) continue;
  evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  for (let i = 0; i + 1 < evs.length; i += 1) {
    const a = evs[i]; const b = evs[i + 1];
    if (a === undefined || b === undefined) continue;
    if (a.b <= 0n || a.q <= 0n || b.b <= 0n || b.q <= 0n) continue;
    pairs.push({ b0: a.b, q0: a.q, b1: b.b, q1: b.q, lp: Number(a.lp) });
  }
}
console.log(`adjacent pairs from pools with >=50 trades: ${pairs.length.toLocaleString()}\n`);

const stats = (v: number): { sd: number; medBps: number; shareNeg: number } => {
  const V = BigInt(Math.round(v * 1e9));
  const g: number[] = [];
  for (const p of pairs) {
    const k0 = Number(p.b0) * Number(p.q0 + V);
    const k1 = Number(p.b1) * Number(p.q1 + V);
    if (!(k0 > 0) || !(k1 > 0)) continue;
    g.push(1e4 * Math.log(k1 / k0));
  }
  if (g.length === 0) return { sd: NaN, medBps: NaN, shareNeg: NaN };
  const m = g.reduce((a, b) => a + b, 0) / g.length;
  const sd = Math.sqrt(g.reduce((a, b) => a + (b - m) ** 2, 0) / g.length);
  const s = [...g].sort((a, b) => a - b);
  return { sd, medBps: s[Math.floor(0.5 * (s.length - 1))] ?? NaN, shareNeg: g.filter((x) => x < -1e-9).length / g.length };
};

console.log('SWEEP over the virtual quote reserve. The true v minimises the dispersion of');
console.log('log k growth per trade, and keeps that growth NON-NEGATIVE (the pool retains the LP fee).\n');
console.log('     v (SOL)      sd of log-k growth (bps)     median growth (bps)     share k DECREASED');
const candidates = [0, 15, 16, 17, 17.4, 17.5, 17.55, 17.58, 17.5845, 17.59, 17.6, 17.65, 17.7, 18, 19, 20, 30];
let best = { v: NaN, sd: Infinity };
for (const v of candidates) {
  const s = stats(v);
  if (s.shareNeg < best.sd) best = { v, sd: s.shareNeg };
  console.log(`  ${String(v).padStart(9)}   ${s.sd.toFixed(2).padStart(22)}   ${s.medBps.toFixed(3).padStart(21)}   ${(100 * s.shareNeg).toFixed(2).padStart(16)}%`);
}
console.log(`\n  MINIMUM SHARE-DECREASED at v = ${best.v} SOL, at ${(100 * best.sd).toFixed(2)}%. Dispersion is NOT the criterion - it falls monotonically in v and always prefers the largest candidate. NON-NEGATIVITY is, because the pool retains the LP fee`);
console.log('\nHOW TO READ IT: if v = 0 wins, PumpSwap has NO virtual quote reserve and the 17.5845');
console.log('constant belongs to the pump.fun bonding curve, not to this AMM - in which case the');
console.log('price definition used by MT110 and MT111 carries an additive error and must be redone.');
console.log('A high "share k DECREASED" at every v would mean liquidity events, not a wrong v.');
