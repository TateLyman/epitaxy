/**
 * Where does the money on this venue actually GO?
 *
 * Pure accounting. No return, no strategy, no conditioning on any outcome. Every mechanism
 * this programme has tested loses because edge is smaller than cost. This asks the dual
 * question, which has never been asked: the cost that takers pay is SOMEBODY's income.
 * Whose, and how much?
 *
 * VOLUME IS RECONSTRUCTED FROM RESERVE DELTAS, never from quote_amount. The quote fields are
 * defective - the buy-side routing model reproduces them only ~55% of the time - and a first
 * cut of this weighting by quote_amount put 100% of venue volume in a single bucket, which is
 * one outlier dominating a sum. The reserve delta between consecutive trades chains EXACTLY on
 * 35,650 of 35,650 adjacent pairs, so it is used instead, inverted through the fee routing:
 *
 *     BUY   pool gains Q_gross*(1 - f_out)     ->  Q_gross = delta / (1 - f_out)
 *     SELL  pool loses  Q_curve*(1 - f_lp)     ->  Q_curve = -delta / (1 - f_lp)
 *
 * where f_out is protocol+creator, the part that LEAVES the pool, and f_lp is retained.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const V = 17_584_500_000n;

// WSOL-quoted BY NAME. A pool whose quote mint we have not read is REFUSED, never assumed.
// Skipping this is how a first cut of this script reported 21.8M SOL of volume in 2.3 hours,
// which annualises to a quarter of a billion SOL: non-SOL quote mints carry different decimals
// and dividing their raw amounts by 1e9 produces arithmetic nonsense. CURRENT_STATE records the
// same confusion producing a bogus 3,897 SOL sell.
const wsolDb = new DatabaseSync('data/runtime.db', { readOnly: true });
const wsol = new Set<string>(
  (wsolDb.prepare('SELECT pool FROM venue_pools WHERE quote_mint = ?').all(WSOL) as { pool: string }[]).map((r) => r.pool),
);
const knownAny = new Set<string>(
  (wsolDb.prepare('SELECT pool FROM venue_pools').all() as { pool: string }[]).map((r) => r.pool),
);
wsolDb.close();
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DIR = 'data/sqd/events-pAMMBay6';
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('no file'); process.exit(0); }

interface E { slot: number; tx: number; addr: string; side: string; pool: string; b: bigint; q: bigint; lp: number; pf: number; cf: number }
const byPool = new Map<string, E[]>();
const unread = new Set<string>();
const nonWsol = new Set<string>();
for (const line of readFileSync(`${DIR}/${file}`, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  const blk = JSON.parse(line) as { header?: { number: number }; instructions?: { transactionIndex: number; instructionAddress: number[]; data: string }[] };
  if (blk.header === undefined) continue;
  for (const i of blk.instructions ?? []) {
    let raw: Buffer;
    try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
    const t = decodePumpSwapTrade(raw.subarray(8));
    if (t === null || t.coinCreatorFeeBasisPoints === null) continue;
    if (!knownAny.has(t.pool)) { unread.add(t.pool); continue; }
    if (!wsol.has(t.pool)) { nonWsol.add(t.pool); continue; }
    const a = byPool.get(t.pool) ?? [];
    a.push({ slot: blk.header.number, tx: i.transactionIndex, addr: i.instructionAddress.join('.'), side: t.side, pool: t.pool,
             b: t.poolBaseReservesBefore, q: t.poolQuoteReservesBefore,
             lp: Number(t.lpFeeBasisPoints), pf: Number(t.protocolFeeBasisPoints), cf: Number(t.coinCreatorFeeBasisPoints) });
    byPool.set(t.pool, a);
  }
}

let oversize = 0;
let volume = 0; let lpFees = 0; let protoFees = 0; let creatorFees = 0; let n = 0;
const perPoolCreator = new Map<string, number>();
const perPoolVol = new Map<string, number>();
const perPoolDepth = new Map<string, number>();
for (const [pool, evs] of byPool) {
  evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  for (let i = 0; i + 1 < evs.length; i += 1) {
    const e = evs[i]; const nx = evs[i + 1];
    if (e === undefined || nx === undefined || e.q <= 0n || nx.q <= 0n) continue;
    const delta = Number(nx.q - e.q);
    if (delta === 0) continue;
    const fOut = (e.pf + e.cf) / 1e4;
    const fLp = e.lp / 1e4;
    const gross = e.side === 'BUY' ? delta / Math.max(1 - fOut, 1e-9) : -delta / Math.max(1 - fLp, 1e-9);
    if (!(gross > 0) || !Number.isFinite(gross)) continue;
    // A single trade above 10,000 SOL against a venue whose deepest pools are hundreds of
    // SOL is a decode artifact, not a trade. Counted and excluded rather than allowed to
    // dominate a sum, which is exactly how the first cut of this went wrong.
    if (gross / 1e9 > 10_000) { oversize += 1; continue; }
    volume += gross; n += 1;
    lpFees += gross * fLp;
    protoFees += gross * (e.pf / 1e4);
    creatorFees += gross * (e.cf / 1e4);
    perPoolCreator.set(pool, (perPoolCreator.get(pool) ?? 0) + gross * (e.cf / 1e4));
    perPoolVol.set(pool, (perPoolVol.get(pool) ?? 0) + gross);
    perPoolDepth.set(pool, Number(e.q + V) / 1e9);
  }
}
const S = (x: number): string => (x / 1e9).toFixed(2);
console.log(`MONEY FLOW — one 2.3-hour window, ${file}\n`);
console.log(`  WSOL-quoted pools measured ${byPool.size.toLocaleString()}   REFUSED as non-WSOL ${nonWsol.size.toLocaleString()}   REFUSED as unread ${unread.size.toLocaleString()}`);
console.log(`  trades priced from reserve deltas: ${n.toLocaleString()}   excluded as oversize artifacts ${oversize.toLocaleString()}`);
console.log(`  total quote volume: ${S(volume)} SOL\n`);
console.log('WHO RECEIVES WHAT A TAKER PAYS');
const tot = lpFees + protoFees + creatorFees;
console.log(`  liquidity providers  ${S(lpFees).padStart(10)} SOL   ${(100 * lpFees / Math.max(tot, 1e-9)).toFixed(1).padStart(5)}% of fees   ${(1e4 * lpFees / Math.max(volume, 1e-9)).toFixed(1)} bps of volume`);
console.log(`  protocol             ${S(protoFees).padStart(10)} SOL   ${(100 * protoFees / Math.max(tot, 1e-9)).toFixed(1).padStart(5)}%              ${(1e4 * protoFees / Math.max(volume, 1e-9)).toFixed(1)} bps`);
console.log(`  coin creators        ${S(creatorFees).padStart(10)} SOL   ${(100 * creatorFees / Math.max(tot, 1e-9)).toFixed(1).padStart(5)}%              ${(1e4 * creatorFees / Math.max(volume, 1e-9)).toFixed(1)} bps`);
console.log(`  TOTAL EXTRACTED      ${S(tot).padStart(10)} SOL over 2.3 hours`);
console.log(`  annualised run-rate at this rate: ${(tot / 1e9 * (24 / 2.3) * 365).toFixed(0)} SOL/year across the venue`);

console.log('\nCONCENTRATION — how many pools carry the creator-fee income');
const cr = [...perPoolCreator.entries()].sort((a, b) => b[1] - a[1]);
const cum = cr.reduce((a, b) => a + b[1], 0);
let run = 0; let k = 0;
for (const [, v] of cr) { run += v; k += 1; if (run >= 0.8 * cum) break; }
console.log(`  ${k} of ${cr.length} pools carry 80% of all creator fees`);
console.log('  top earners this window:');
for (const [pool, v] of cr.slice(0, 8)) {
  console.log(`    ${pool.slice(0, 8)}  ${(v / 1e9).toFixed(3).padStart(9)} SOL   volume ${((perPoolVol.get(pool) ?? 0) / 1e9).toFixed(1).padStart(8)} SOL   depth ${(perPoolDepth.get(pool) ?? 0).toFixed(0)} SOL`);
}
const perPool = cr.map(([, v]) => v / 1e9).filter((v) => v > 0).sort((a, b) => a - b);
if (perPool.length > 0) {
  const Pp = (x: number): number => perPool[Math.floor(x * (perPool.length - 1))] ?? 0;
  console.log(`\n  creator SOL per pool per 2.3h:  p50 ${Pp(0.5).toFixed(4)}   p90 ${Pp(0.9).toFixed(3)}   p99 ${Pp(0.99).toFixed(2)}   max ${Pp(1).toFixed(2)}`);
  console.log(`  pools earning a creator fee at all: ${perPool.length} of ${byPool.size}`);
}
console.log('\n  ONE WINDOW, ONE CLUSTER. Accounting only - no return, no strategy, nothing licensed.');
