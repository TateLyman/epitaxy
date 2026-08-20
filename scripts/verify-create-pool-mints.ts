/**
 * Validate the CreatePoolEvent layout against pools we already resolved by RPC.
 *
 * WSOL sits at offset 50 in 40 of 40 CreatePoolEvent payloads, so 50 is a mint field. That is
 * a claim about a layout, and a layout claim is worth nothing until a second instrument agrees.
 * `venue_pools` holds base_mint/quote_mint for thousands of pools, each resolved by an actual
 * `getAccountInfo`. If the event and the account agree on the same pool, the event can replace
 * the account read - and `getAccountInfo` is the measured binding constraint on this project.
 *
 * Nothing here calls the network.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { base58Decode, base58Encode } from '../packages/solana/src/base58.js';

const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const CREATE_POOL = Buffer.from('b1310cd2a076a774', 'hex');
const DIR = 'data/sqd/events-pAMMBay6';

/**
 * EVERY byte offset, not a guessed list.
 *
 * A first pass guessed 8-aligned offsets and found nothing, which was the wrong method:
 * WSOL sits at 50, so this struct has unaligned fields and guessing alignment cannot find
 * them. Brute force is cheap here - 333 bytes by 400 events - and it cannot be fooled by a
 * wrong assumption about layout.
 */
const CANDIDATES: number[] = [];
for (let o = 8; o + 32 <= 333; o += 1) CANDIDATES.push(o);

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const known = new Map<string, { base: string; quote: string }>();
for (const r of db.prepare('SELECT pool, base_mint, quote_mint FROM venue_pools').all() as
  { pool: string; base_mint: string; quote_mint: string }[]) {
  known.set(r.pool, { base: r.base_mint, quote: r.quote_mint });
}
db.close();
console.log(`pools already resolved by RPC in venue_pools: ${known.size.toLocaleString()}\n`);

interface Ev { fields: Map<number, string> }
const events: Ev[] = [];
for (const f of readdirSync(DIR).filter((x) => /^events-\d+-\d+\.jsonl$/.test(x))) {
  // Streamed: a backfill file is about a gigabyte, past Node's max string length.
  const rl = createInterface({ input: createReadStream(`${DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let blk: { header?: { number: number }; instructions?: { data: string }[] };
    try { blk = JSON.parse(line); } catch { continue; }
    if (blk.header === undefined) continue;
    for (const i of blk.instructions ?? []) {
      let raw: Buffer;
      try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
      if (raw.length < 16 || !raw.subarray(0, 8).equals(CPI)) continue;
      const body = raw.subarray(8);
      if (!body.subarray(0, 8).equals(CREATE_POOL)) continue;
      const fields = new Map<number, string>();
      for (const o of CANDIDATES) if (o + 32 <= body.length) fields.set(o, base58Encode(body.subarray(o, o + 32)));
      events.push({ fields });
    }
    if (events.length >= 400) break;
  }
  rl.close();
  if (events.length >= 400) break;
}
console.log(`CreatePoolEvent payloads scanned: ${events.length}\n`);
if (events.length === 0) { console.log('none found'); process.exit(0); }

// Which offset holds a value that venue_pools recognises as a POOL address?
console.log('WHICH OFFSET IS THE POOL ADDRESS? (matched against venue_pools keys)');
for (const o of CANDIDATES) {
  const hits = events.filter((e) => { const v = e.fields.get(o); return v !== undefined && known.has(v); }).length;
  if (hits > 0) console.log(`  offset ${String(o).padStart(4)}   ${String(hits).padStart(4)} of ${events.length} are known pools`);
}

// For events whose pool we know, do the mint fields agree with the RPC-resolved account?
let checked = 0;
const agree = new Map<string, number>();
for (const e of events) {
  let poolOff: number | null = null;
  for (const o of CANDIDATES) { const v = e.fields.get(o); if (v !== undefined && known.has(v)) { poolOff = o; break; } }
  if (poolOff === null) continue;
  const pool = e.fields.get(poolOff);
  if (pool === undefined) continue;
  const truth = known.get(pool);
  if (truth === undefined) continue;
  checked += 1;
  for (const o of CANDIDATES) {
    const v = e.fields.get(o);
    if (v === undefined) continue;
    if (v === truth.base) agree.set(`offset ${o} == base_mint`, (agree.get(`offset ${o} == base_mint`) ?? 0) + 1);
    if (v === truth.quote) agree.set(`offset ${o} == quote_mint`, (agree.get(`offset ${o} == quote_mint`) ?? 0) + 1);
  }
}
console.log(`\nEVENTS WHOSE POOL IS ALSO IN venue_pools: ${checked}`);
console.log('AGREEMENT WITH THE RPC-RESOLVED ACCOUNT:');
for (const [k, n] of [...agree.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${String(n).padStart(4)} of ${checked}`);
}
console.log('\n  A field that matches the account on EVERY overlapping pool can replace the account');
console.log('  read. That turns pool->mints from one getAccountInfo per pool into zero, forever.');
