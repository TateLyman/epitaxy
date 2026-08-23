/**
 * Where are `pool`, `base_mint` and `quote_mint` inside CreatePoolEvent? Decided from OUR chain
 * data, not from a third-party IDL.
 *
 * WHY NOT JUST READ THE IDL. Two published sources disagree. A widely-copied IDL gist orders the
 * fields timestamp, index, creator, base_mint, quote_mint..., which puts base_mint at offset 50. A
 * generated Go binding orders them timestamp, pool, baseMint, quoteMint, lpMint..., which puts
 * quoteMint at 80. This repository's own earlier probe found WSOL sitting at offset 50 in 40 of 40
 * payloads, which matches NEITHER. One of the three is wrong and guessing which would silently
 * corrupt every pool-to-mint mapping built from it.
 *
 * THE EMPIRICAL ANCHOR IS EXACT AND COSTS NOTHING. A pool created inside a window very often
 * TRADES inside the same window, and trade events carry the pool address in a field we already
 * decode correctly and have verified against the chain. So: collect the set of pools that provably
 * traded, then for every 32-byte aligned candidate offset in the create payloads, count how often
 * the bytes at that offset are one of those pools. The real `pool` offset will hit at a high rate
 * and every other offset at essentially zero. The same trick pins the mints: WSOL is a fixed,
 * known address, so whichever offset holds it is the quote mint, and the offset holding a mint
 * that venue_pools independently records as a base_mint is the base mint.
 *
 * THIS IS THE SAME DISCIPLINE THAT CAUGHT THE EARLIER DEFECTS TODAY. A layout inherited from a
 * document is an assumption; a layout that reproduces addresses we independently decoded is a
 * measurement.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { base58DecodeBulk, base58Encode } from '../packages/solana/src/base58.js';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';

const DIR = 'data/sqd/events-pAMMBay6';
const WSOL = 'So11111111111111111111111111111111111111112';
const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const CREATE_POOL = Buffer.from('b1310cd2a076a774', 'hex');
const FILE = process.argv[2] ?? 'events-435740000-435759999.jsonl';

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const knownBaseMints = new Set((db.prepare('SELECT DISTINCT base_mint m FROM venue_pools').all() as { m: string }[]).map((r) => r.m));
db.close();

if (!existsSync(`${DIR}/${FILE}`)) { console.log(`missing ${FILE}`); process.exit(1); }

/** Pass 1: every pool that provably traded here, and every create payload. */
const tradedPools = new Set<string>();
const creates: Buffer[] = [];
const rl = createInterface({ input: createReadStream(`${DIR}/${FILE}`, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  if (line.length === 0) continue;
  let blk: { instructions?: { data: string }[] };
  try { blk = JSON.parse(line) as { instructions?: { data: string }[] }; } catch { continue; }
  for (const i of blk.instructions ?? []) {
    let raw: Buffer;
    try { raw = Buffer.from(base58DecodeBulk(i.data, 4096)); } catch { continue; }
    if (raw.length < 16 || !raw.subarray(0, 8).equals(CPI)) continue;
    const b = raw.subarray(8);
    if (b.subarray(0, 8).equals(CREATE_POOL)) { if (creates.length < 4000) creates.push(Buffer.from(b)); continue; }
    const t = decodePumpSwapTrade(b);
    if (t !== null) tradedPools.add(t.pool);
  }
}
rl.close();
console.log(`${FILE}`);
console.log(`  ${tradedPools.size.toLocaleString()} pools provably traded   ${creates.length.toLocaleString()} CreatePoolEvent payloads`);
if (creates.length === 0) { console.log('  no creates in this file — try another'); process.exit(0); }
console.log(`  payload lengths: ${[...new Set(creates.map((c) => c.length))].sort((a, b) => a - b).join(', ')}`);

/** Pass 2: score every candidate offset. */
const hitPool = new Map<number, number>();
const hitWsol = new Map<number, number>();
const hitBase = new Map<number, number>();
const maxLen = Math.max(...creates.map((c) => c.length));
for (let o = 8; o + 32 <= maxLen; o += 1) {
  let p = 0; let w = 0; let bm = 0;
  for (const c of creates) {
    if (o + 32 > c.length) continue;
    const k = base58Encode(c.subarray(o, o + 32));
    if (tradedPools.has(k)) p += 1;
    if (k === WSOL) w += 1;
    else if (knownBaseMints.has(k)) bm += 1;
  }
  if (p > 0) hitPool.set(o, p);
  if (w > 0) hitWsol.set(o, w);
  if (bm > 0) hitBase.set(o, bm);
}
const show = (label: string, m: Map<number, number>): void => {
  console.log('');
  console.log(label);
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length === 0) { console.log('  (no offset matches)'); return; }
  for (const [o, c] of top) console.log(`  offset ${String(o).padStart(4)}   ${String(c).padStart(5)} of ${creates.length}   ${(100 * c / creates.length).toFixed(1)}%`);
};
show('POOL — bytes that equal a pool we independently decoded from a trade', hitPool);
show('QUOTE MINT — bytes that equal WSOL exactly', hitWsol);
show('BASE MINT — bytes that venue_pools independently records as a base_mint', hitBase);

console.log('');
console.log('  A real field hits at a high rate at exactly one offset. Anything hitting at a few');
console.log('  percent across many offsets is coincidence and must not be used as a layout.');
