/**
 * Does CreatePoolEvent carry the pool's MINTS?
 *
 * If it does, pool -> (base_mint, quote_mint) is derivable from the backfill with ZERO RPC.
 * That matters more than it sounds: `getAccountInfo` is the measured binding constraint on
 * this project — `rate:budget-v2` reports its DAILY QUOTA exhausted — and the single largest
 * consumer of it has been resolving pool mints. MT111 spent 4,730 reads, MT112 2,525, MT113
 * 6,635. All of that is one account read per pool, forever, for a fact the chain already
 * announced once when the pool was created.
 *
 * The method makes no assumption about the layout. It locates the WSOL mint's raw 32 bytes
 * inside the payload and reports the OFFSET it was found at. If that offset is stable across
 * many events, it is a field, not a coincidence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { base58Decode, base58Encode } from '../packages/solana/src/base58.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const WSOL_BYTES = Buffer.from(base58Decode(WSOL, 64));
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const CREATE_POOL = Buffer.from('b1310cd2a076a774', 'hex');
const DIR = 'data/sqd/events-pAMMBay6';

const files = readdirSync(DIR).filter((f) => /^events-\d+-\d+\.jsonl$/.test(f)).slice(0, 6);
const payloads: Buffer[] = [];
for (const f of files) {
  for (const line of readFileSync(`${DIR}/${f}`, 'utf8').split('\n')) {
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
      payloads.push(Buffer.from(body));
      if (payloads.length >= 40) break;
    }
    if (payloads.length >= 40) break;
  }
  if (payloads.length >= 40) break;
}
console.log(`CreatePoolEvent payloads found: ${payloads.length}`);
if (payloads.length === 0) { console.log('none in the scanned files'); process.exit(0); }
console.log(`payload lengths: ${[...new Set(payloads.map((p) => p.length))].sort((a, b) => a - b).join(', ')}\n`);

// Where does WSOL sit, when it sits anywhere?
const offsets = new Map<number, number>();
let withWsol = 0;
for (const p of payloads) {
  let found = -1;
  for (let o = 0; o + 32 <= p.length; o += 1) {
    if (p.subarray(o, o + 32).equals(WSOL_BYTES)) { found = o; break; }
  }
  if (found >= 0) { withWsol += 1; offsets.set(found, (offsets.get(found) ?? 0) + 1); }
}
console.log(`payloads containing the WSOL mint: ${withWsol} of ${payloads.length}`);
console.log('offsets where it was found:');
for (const [o, n] of [...offsets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  offset ${String(o).padStart(4)}   ${n} event(s)`);
}

// Dump the pubkey-shaped fields of one payload so the layout is readable.
const sample = payloads[0];
if (sample !== undefined) {
  console.log(`\nPUBKEY-SHAPED FIELDS of one ${sample.length}-byte payload, every 32 bytes from 8:`);
  for (let o = 8; o + 32 <= sample.length; o += 8) {
    const k = base58Encode(sample.subarray(o, o + 32));
    // A plausible pubkey is 43-44 base58 chars and not mostly ones (all-zero bytes).
    if (k.length >= 43 && !/^1{20,}/.test(k)) console.log(`  ${String(o).padStart(4)}  ${k}`);
  }
}
console.log('\n  A STABLE offset across events is a FIELD. If the mints are here, pool->mints');
console.log('  costs zero RPC forever, and the binding constraint on this project loosens.');
