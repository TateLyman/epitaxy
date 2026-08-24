/**
 * What priority fee do our own transactions actually carry, and is it competitive?
 *
 * This matters far more on a bonding curve than on an ordinary swap, and the reason is mechanical.
 * Every buy against a given curve write-locks the SAME account, so those transactions all conflict,
 * and Anza's central scheduler processes conflicting transactions in strict priority order within
 * the slot. On a curve, order within the slot IS the fill price: the trade ahead of you moves the
 * reserves you are about to buy against. Priority fee is therefore not merely buying inclusion, it
 * is buying position in the queue against the one to seven other trades a second that MT193 shows
 * the edge decaying against.
 *
 * The bot has never set one. `buildSignableOrderV1` sends `dynamicComputeUnitLimit` and nothing
 * else, so whatever is in our transactions is Jupiter's default rather than a decision. This reads
 * the real bytes of transactions we actually sent and compares them against what the curve's own
 * local fee market is paying.
 *
 * Reads transactions. Signs nothing, sends nothing.
 */
import { decodeTransaction, readComputeBudget, priorityFeeLamports } from '../packages/solana/src/transaction.js';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const EP = arg('rpc') ?? 'https://solana-rpc.publicnode.com';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** Our own live buys, so the comparison is against what we really sent. */
const OURS: [string, string][] = [
  ['buy 2Wscc', '2nxn1RxWR4hWiGzRtw3ax6BEZ9buu5qaQhgRqDqLBRgrDty5vmiDwWFJUxxZhD455UQEy4hn1UVNpnkUTd2zio5J'],
  ['buy HRnFb', '2vtExjZtmkAgHYGi6z5zzUYN2WmgqbdDEUbf5s7Ae4HMHx2Ding3pTa59Q3CALjXkriPs5GhpTrqBTm64JYrn3eh'],
  ['buy HpzLA', '2W559iNu9Cjobk39bhjRyPLmVCv63v9cyvAo181ipqxtwa2nrGZewhbEbT8ynj6xR8v6tMGAtP89zA5GtHPUKfXk'],
];

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(EP, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`http ${String(r.status)}`);
  const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error !== undefined) throw new Error(j.error.message ?? 'rpc error');
  return j.result;
}

console.log('OUR OWN PRIORITY FEES, read from the transaction bytes');
console.log('');
for (const [label, sig] of OURS) {
  try {
    const tx = (await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'base64' }])) as
      { transaction?: [string, string]; meta?: { fee?: number; computeUnitsConsumed?: number } } | null;
    if (tx === null || tx.transaction === undefined) { console.log(`  ${label}: not found`); continue; }
    const raw = Buffer.from(tx.transaction[0], 'base64');
    const decoded = decodeTransaction(new Uint8Array(raw));
    const cb = readComputeBudget(decoded);
    const prio = priorityFeeLamports(cb);
    const fee = tx.meta?.fee ?? 0;
    console.log(`  ${label}`);
    console.log(`    unit price ${cb.unitPriceMicroLamports === null ? 'NOT SET' : `${String(cb.unitPriceMicroLamports)} microLamports/CU`}`);
    console.log(`    unit limit ${cb.unitLimit === null ? 'NOT SET' : String(cb.unitLimit)}   actually used ${String(tx.meta?.computeUnitsConsumed ?? 0)}`);
    console.log(`    priority portion ${String(prio)} lamports of a ${String(fee)} lamport total fee`);
  } catch (e) { console.log(`  ${label}: ${(e as Error).message.slice(0, 60)}`); }
}

/**
 * The curve's OWN fee market, which is the only distribution that matters here. Fees are local to
 * writable accounts, so the network-wide estimate says nothing about what it costs to be ahead of
 * the queue on this particular curve.
 */
console.log('');
console.log('WHAT THE CURVE-LOCAL FEE MARKET IS PAYING');
try {
  const fees = (await rpc('getRecentPrioritizationFees', [[PUMP]])) as { slot: number; prioritizationFee: number }[];
  const vals = fees.map((f) => f.prioritizationFee).filter((v) => v > 0).sort((a, b) => a - b);
  if (vals.length === 0) { console.log('  no non-zero fees reported for this account'); }
  else {
    const q = (p: number): number => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 0;
    console.log(`  ${vals.length} non-zero samples of ${fees.length} recent slots, microLamports per CU:`);
    console.log(`    p25 ${q(0.25)}   p50 ${q(0.5)}   p75 ${q(0.75)}   p95 ${q(0.95)}   max ${vals[vals.length - 1]}`);
    /** Translate to what a buy would cost at a realistic compute limit. */
    for (const [name, price] of [['p50', q(0.5)], ['p75', q(0.75)], ['p95', q(0.95)]] as [string, number][]) {
      console.log(`    at ${name}, a 130,000 CU buy pays ${((price * 130_000) / 1e6).toFixed(0)} lamports of priority fee`);
    }
  }
} catch (e) { console.log(`  ${(e as Error).message.slice(0, 80)}`); }
console.log('');
console.log('  A tight compute limit matters as much as the price: scheduler priority divides by the');
console.log('  units REQUESTED, so over-requesting lowers our position for the same lamports spent.');
