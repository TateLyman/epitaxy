/**
 * CONFIRM the CreatePoolEvent layout against the RPC-resolved truth, pair by pair.
 *
 * Brute-forcing every offset over 2,000 payloads found three stable fields:
 *   offset 173  the pool address   (71.3% are pools venue_pools already knows)
 *   offset  50  a mint             (WSOL 70.7%, a known base_mint 26.4%)
 *   offset  82  a mint             (WSOL 28.0%, a known base_mint  1.1%)
 *
 * Stability is not correctness. This checks the ORDERED pair: for every event whose pool at
 * 173 is in venue_pools, do (50, 82) equal (base_mint, quote_mint) as resolved by an actual
 * getAccountInfo? Two instruments agreeing is evidence; one is a claim.
 *
 * If they agree, pool -> mints is free forever, and the binding constraint on this project -
 * the getAccountInfo daily quota - stops being spent on its largest consumer.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { base58Decode, base58Encode } from '../packages/solana/src/base58.js';

const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const CREATE_POOL = Buffer.from('b1310cd2a076a774', 'hex');
const OFF = { mintA: 50, mintB: 82, pool: 173 } as const;
const DIR = 'data/sqd/events-pAMMBay6';

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const truth = new Map<string, { base: string; quote: string }>();
for (const r of db.prepare('SELECT pool, base_mint, quote_mint FROM venue_pools').all() as
  { pool: string; base_mint: string; quote_mint: string }[]) truth.set(r.pool, { base: r.base_mint, quote: r.quote_mint });
db.close();

let events = 0;
let overlapping = 0;
let exact = 0;
let swapped = 0;
let mismatch = 0;
const examples: string[] = [];

// ONE file is enough: an earlier sweep found 2,000 CreatePoolEvents in it. A full 22 GB
// sweep to confirm a layout that is already stable is spending an hour to learn nothing.
outer: for (const f of readdirSync(DIR).filter((x) => /^events-\d+-\d+\.jsonl$/.test(x)).slice(0, 1)) {
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
      const b = raw.subarray(8);
      if (!b.subarray(0, 8).equals(CREATE_POOL)) continue;
      if (b.length < OFF.pool + 32) continue;
      events += 1;
      const pool = base58Encode(b.subarray(OFF.pool, OFF.pool + 32));
      const t = truth.get(pool);
      if (t === undefined) continue;
      overlapping += 1;
      const a = base58Encode(b.subarray(OFF.mintA, OFF.mintA + 32));
      const q = base58Encode(b.subarray(OFF.mintB, OFF.mintB + 32));
      if (a === t.base && q === t.quote) exact += 1;
      else if (a === t.quote && q === t.base) swapped += 1;
      else {
        mismatch += 1;
        if (examples.length < 4) examples.push(`    ${pool.slice(0, 8)}  event(${a.slice(0, 6)}, ${q.slice(0, 6)})  account(${t.base.slice(0, 6)}, ${t.quote.slice(0, 6)})`);
      }
      if (overlapping >= 3000) { rl.close(); break outer; }
    }
  }
  rl.close();
}

console.log(`CreatePoolEvent payloads scanned : ${events.toLocaleString()}`);
console.log(`whose pool venue_pools also knows: ${overlapping.toLocaleString()}\n`);
if (overlapping === 0) { console.log('no overlap; nothing provable here'); process.exit(0); }
const pct = (x: number): string => `${((100 * x) / overlapping).toFixed(2)}%`;
console.log(`  (50,82) == (base_mint, quote_mint)   ${String(exact).padStart(5)}   ${pct(exact)}`);
console.log(`  (50,82) == (quote_mint, base_mint)   ${String(swapped).padStart(5)}   ${pct(swapped)}`);
console.log(`  neither                              ${String(mismatch).padStart(5)}   ${pct(mismatch)}`);
if (examples.length > 0) { console.log('\n  mismatches:'); for (const e of examples) console.log(e); }
console.log(`\n  agreement on the unordered PAIR: ${pct(exact + swapped)}`);
console.log('\n  A high ordered rate names the fields outright. A high unordered rate with a split');
console.log('  order still resolves the pair, and WSOL-by-name then decides which side is quote -');
console.log('  which is all any caller in this repo actually asks for.');
