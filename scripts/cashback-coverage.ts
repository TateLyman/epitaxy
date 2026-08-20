/**
 * How much of the venue is actually a CASHBACK COIN?
 *
 * A literature sweep flagged Pump Cashback - which redirects the whole creator fee back to the
 * TRADER - as the largest recoverable cost on this venue, worth up to 190 bps at the tier where
 * our costs are worst. Checking the repo first showed the plumbing is already built and tested:
 * `packages/solana/src/cashback.ts` derives the PDAs, orders the remaining accounts per leg, and
 * `scripts/cashback-mechanics-surface.ts` cross-checks every derivation against the SDK's own.
 *
 * So the plumbing is not the question. COVERAGE is, and it has never been measured. The rebate
 * is opt-in BY THE CREATOR, per coin. If almost nothing sets the flag, the 190 bps is unreachable
 * and no amount of correct plumbing helps.
 *
 * Pools are sampled BY TRADE ACTIVITY, not uniformly, because the decision-relevant quantity is
 * the share of FLOW that is rebate-eligible, not the share of pools. A pool we cannot read is
 * REFUSED and counted, never assumed either way.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { openDb } from '../packages/storage/src/db.js';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { poolAddressesFrom } from '../packages/solana/src/pumpswap-offline.js';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const SAMPLE = 250;
const DIR = 'data/sqd/events-pAMMBay6';
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('no backfill file'); process.exit(0); }

const trades = new Map<string, number>();
const creatorBps = new Map<string, number>();
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
    trades.set(t.pool, (trades.get(t.pool) ?? 0) + 1);
    creatorBps.set(t.pool, Number(t.coinCreatorFeeBasisPoints));
  }
}
const db = openDb({ path: 'data/runtime.db' });
const wsol = new Set((db.prepare('SELECT pool FROM venue_pools WHERE quote_mint = ?').all(WSOL) as { pool: string }[]).map((r) => r.pool));
const ranked = [...trades.entries()].filter(([p]) => wsol.has(p)).sort((a, b) => b[1] - a[1]).slice(0, SAMPLE);
const totalTrades = ranked.reduce((a, b) => a + b[1], 0);
console.log(`CASHBACK COVERAGE — top ${ranked.length} WSOL pools by activity, ${totalTrades.toLocaleString()} trades\n`);

const { rpc } = researchRpc(loadSecrets(), db);
let onCount = 0; let onTrades = 0; let off = 0; let offTrades = 0; let unknown = 0; let refused = 0;
let onCreatorSum = 0; let offCreatorSum = 0;
for (let i = 0; i < ranked.length; i += 1) {
  const entry = ranked[i];
  if (entry === undefined) continue;
  const [pool, n] = entry;
  try {
    const raw = await rpc.getAccountRaw(pool);
    const a = poolAddressesFrom({ get: (k: string) => (k === pool ? { owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports } : null) }, pool);
    const flag = a.isCashbackCoin;
    if (flag === null || flag === undefined) { unknown += 1; continue; }
    if (flag) { onCount += 1; onTrades += n; onCreatorSum += creatorBps.get(pool) ?? 0; }
    else { off += 1; offTrades += n; offCreatorSum += creatorBps.get(pool) ?? 0; }
  } catch { refused += 1; }
  if ((i + 1) % 50 === 0) console.log(`  read ${i + 1}/${ranked.length}`);
}
db.close();

const read = onCount + off;
console.log('\nRESULT');
console.log(`  cashback ENABLED   pools ${String(onCount).padStart(4)}   trades ${String(onTrades).padStart(6)}`);
console.log(`  cashback disabled  pools ${String(off).padStart(4)}   trades ${String(offTrades).padStart(6)}`);
console.log(`  flag absent from the decoded pool (REFUSED, not assumed) ${unknown}`);
console.log(`  unreadable account (REFUSED) ${refused}`);
if (read > 0) {
  console.log(`\n  share of POOLS with cashback:  ${(100 * onCount / read).toFixed(1)}%`);
  console.log(`  share of TRADES with cashback: ${(100 * onTrades / Math.max(onTrades + offTrades, 1)).toFixed(1)}%   <- the decision-relevant number`);
  console.log(`\n  mean creator fee bps, cashback pools ${onCount > 0 ? (onCreatorSum / onCount).toFixed(1) : 'n/a'}   non-cashback ${off > 0 ? (offCreatorSum / off).toFixed(1) : 'n/a'}`);
  console.log('  The creator fee IS the rebate, so a cashback pool with a 5 bps creator fee returns 10 bps');
  console.log('  a round trip and one with 95 bps returns 190. Coverage alone does not size the prize.');
}
console.log('\n  ONE WINDOW, ONE CLUSTER, top-activity pools only. Not a venue-wide census.');
