/**
 * Is the "hidden" creator fee the CASHBACK fee?
 *
 * Two facts, found separately:
 *   A. On 26.8% of sells the declared ladder understates the fee actually charged, the residual
 *      is a clean multiple of 5 bps, and offset 344 reports creator_fee_bps = 0 on 4,850 of 4,867.
 *   B. 43.9% of trades are in pools whose Pool account has is_cashback_coin set, and those pools
 *      report a mean creator fee of exactly 0.0 bps.
 *
 * A cashback coin redirects the creator fee AWAY FROM THE CREATOR and to the trader's volume
 * accumulator. So the creator's fee really is zero - offset 344 is telling the truth - while the
 * TRADER still pays it, and it becomes claimable.
 *
 * If A and B are the same pools, that is the whole story, and it settles a question I had said
 * needed a funded live trade: the trader pays, and there is a matching receivable.
 * If they are DIFFERENT pools, then there is a second, unexplained fee and the cost model is
 * simply broken. Both outcomes are decision-relevant.
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
const SAMPLE = 150;
const DIR = 'data/sqd/events-pAMMBay6';
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('none'); process.exit(0); }

/** per pool: sells where the ladder understated, and total sells */
const stat = new Map<string, { under: number; total: number; resid: number[] }>();
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
    const charged = 1e4 * (Number(t.quoteAmount) - Number(t.userQuoteAmount)) / Number(t.quoteAmount);
    const declared = Number(t.lpFeeBasisPoints + t.protocolFeeBasisPoints + t.coinCreatorFeeBasisPoints);
    if (!Number.isFinite(charged)) continue;
    const e = stat.get(t.pool) ?? { under: 0, total: 0, resid: [] };
    e.total += 1;
    if (charged - declared > 0.75) { e.under += 1; e.resid.push(charged - declared); }
    stat.set(t.pool, e);
  }
}
const db = openDb({ path: 'data/runtime.db' });
const wsol = new Set((db.prepare('SELECT pool FROM venue_pools WHERE quote_mint = ?').all(WSOL) as { pool: string }[]).map((r) => r.pool));
const ranked = [...stat.entries()].filter(([p, e]) => wsol.has(p) && e.total >= 10).sort((a, b) => b[1].total - a[1].total).slice(0, SAMPLE);
console.log(`CASHBACK vs HIDDEN FEE — ${ranked.length} WSOL pools with >=10 sells\n`);

const { rpc } = researchRpc(loadSecrets(), db);
const cell = { onUnder: 0, onClean: 0, offUnder: 0, offClean: 0 };
let refused = 0;
const onResid: number[] = []; const offResid: number[] = [];
for (let i = 0; i < ranked.length; i += 1) {
  const entry = ranked[i];
  if (entry === undefined) continue;
  const [pool, e] = entry;
  let flag: boolean | null = null;
  try {
    const raw = await rpc.getAccountRaw(pool);
    const a = poolAddressesFrom({ get: (k: string) => (k === pool ? { owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports } : null) }, pool);
    flag = a.isCashbackCoin ?? null;
  } catch { refused += 1; continue; }
  if (flag === null) { refused += 1; continue; }
  // A pool "hides a fee" if the ladder understated on the majority of its sells.
  const hides = e.under > e.total / 2;
  if (flag && hides) { cell.onUnder += 1; onResid.push(...e.resid); }
  else if (flag && !hides) cell.onClean += 1;
  else if (!flag && hides) { cell.offUnder += 1; offResid.push(...e.resid); }
  else cell.offClean += 1;
  if ((i + 1) % 50 === 0) console.log(`  read ${i + 1}/${ranked.length}`);
}
db.close();
const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
console.log('\n                       ladder UNDERSTATES    ladder clean');
console.log(`  cashback ENABLED     ${String(cell.onUnder).padStart(16)}    ${String(cell.onClean).padStart(12)}`);
console.log(`  cashback disabled    ${String(cell.offUnder).padStart(16)}    ${String(cell.offClean).padStart(12)}`);
console.log(`  refused (unreadable / flag absent): ${refused}`);
const tot = cell.onUnder + cell.onClean + cell.offUnder + cell.offClean;
if (tot > 0) {
  const diag = cell.onUnder + cell.offClean;
  console.log(`\n  agreement on the diagonal: ${diag}/${tot} = ${(100 * diag / tot).toFixed(1)}%`);
  console.log(`  median hidden fee, cashback pools  ${Number.isFinite(med(onResid)) ? med(onResid).toFixed(1) : 'n/a'} bps`);
  console.log(`  median hidden fee, NON-cashback    ${Number.isFinite(med(offResid)) ? med(offResid).toFixed(1) : 'n/a'} bps`);
}
console.log('\n  HIGH agreement means the hidden fee IS the redirected creator fee: the trader pays it,');
console.log('  the creator does not receive it, and it is claimable. That settles the semantics from');
console.log('  history alone. LOW agreement means a second unexplained fee exists and the cost model');
console.log('  is broken in a way neither finding explains.');
