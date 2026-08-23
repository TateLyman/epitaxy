/**
 * Build a COMPLETE pool -> (base_mint, quote_mint, creator) map from CreatePoolEvent, so the trade
 * cache stops being a survivorship filter.
 *
 * THE PROBLEM THIS FIXES. `build-trade-cache.ts` keeps a trade only if its pool is in `venue_pools`
 * with a WSOL quote mint, and that table is a single-day snapshot — all 14,854 rows carry
 * resolved_utc_ms of 2026-08-20. A pool only appears if it was still observable on that date, so a
 * pool that lived twenty minutes three weeks earlier is invisible. Measured on raw SQD events, that
 * filter keeps 44.7% of pools at slot 435.74M, 53.8% at 436.74M, 78.1% at 438.82M and ~70% across
 * blocks A and B. It is a survivorship filter whose STRENGTH VARIES WITH THE AGE OF THE WINDOW,
 * which biases older corpora harder and removes precisely the pools that died.
 *
 * THE FIX NEEDS NO RPC AND NO ACCOUNT READS. The SQD pull filters on the Anchor `emit_cpi`
 * discriminator, which captures EVERY pump_amm event — including CreatePoolEvent, which we have
 * been decoding to null and discarding. That event carries the pool address and both mints. Since
 * the analysis only ever scores pools whose BIRTH is observed inside a block, and a pool born in a
 * block has its create event in that block, this gives 100% coverage of the analysable population
 * rather than 45-78%.
 *
 * THE LAYOUT IS MEASURED, NOT READ OFF A DOCUMENT. Two published sources disagree about
 * CreatePoolEvent's field order, and neither matched this repository's earlier probe. So
 * `createpool-layout.ts` pinned it against our own chain data: for a pool created in a window that
 * later TRADES in the same window, the trade event gives the pool address independently. The bytes
 * at offset 173 equal such a pool in 228 of 228 payloads — 100.0% — which is the only offset that
 * hits at all, and it reproduces the IDL ordering exactly when the field widths are walked out.
 *
 * WSOL APPEARS AT BOTH MINT OFFSETS AND THAT IS NOT A BUG. It is at offset 50 in 55.3% of payloads
 * and at 82 in 40.4%, because anyone may create a PumpSwap pool in either direction. Offset 50 is
 * base_mint and 82 is quote_mint, so a pool with WSOL at 50 has WSOL as its BASE — the inverted
 * direction, where the constant-product price math means the opposite thing. Those are excluded
 * here for the same reason the existing filter excludes them.
 *
 * Writes a JSONL map rather than inserting into runtime.db. The database is the research corpus and
 * this is a derived artifact; keeping it separate means it can be rebuilt or discarded freely.
 *
 * Read-only with respect to the database. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, createWriteStream, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk, base58Encode } from '../packages/solana/src/base58.js';

const DIR = 'data/sqd/events-pAMMBay6';
const OUT_DIR = 'data/panel';
const WSOL = 'So11111111111111111111111111111111111111112';
const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const CREATE_POOL = Buffer.from('b1310cd2a076a774', 'hex');
/** Measured in createpool-layout.ts against pools independently decoded from trades. */
const OFF_CREATOR = 18;
const OFF_BASE_MINT = 50;
const OFF_QUOTE_MINT = 82;
const OFF_POOL = 173;
const MIN_PAYLOAD = OFF_POOL + 32;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const SHARD = Number(arg('shard') ?? '0');
const SHARDS = Number(arg('shards') ?? '1');

const files = readdirSync(DIR).filter((f) => /^events-\d+-\d+\.jsonl$/.test(f)).sort()
  .filter((_f, i) => i % SHARDS === SHARD);

mkdirSync(OUT_DIR, { recursive: true });
const out = createWriteStream(`${OUT_DIR}/pool-map-${SHARD}.jsonl`);
let creates = 0; let wsolQuote = 0; let wsolBase = 0; let other = 0;
const seen = new Set<string>();

for (const f of files) {
  if (!existsSync(`${DIR}/${f}`)) continue;
  const rl = createInterface({ input: createReadStream(`${DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let blk: { header?: { number: number }; instructions?: { data: string }[] };
    try { blk = JSON.parse(line) as { header?: { number: number }; instructions?: { data: string }[] }; } catch { continue; }
    const slot = blk.header?.number;
    if (slot === undefined) continue;
    for (const i of blk.instructions ?? []) {
      let raw: Buffer;
      try { raw = Buffer.from(base58DecodeBulk(i.data, 4096)); } catch { continue; }
      if (raw.length < 16 || !raw.subarray(0, 8).equals(CPI)) continue;
      const b = raw.subarray(8);
      if (!b.subarray(0, 8).equals(CREATE_POOL)) continue;
      if (b.length < MIN_PAYLOAD) continue;
      creates += 1;
      const pool = base58Encode(b.subarray(OFF_POOL, OFF_POOL + 32));
      if (seen.has(pool)) continue;
      const baseMint = base58Encode(b.subarray(OFF_BASE_MINT, OFF_BASE_MINT + 32));
      const quoteMint = base58Encode(b.subarray(OFF_QUOTE_MINT, OFF_QUOTE_MINT + 32));
      if (quoteMint === WSOL) wsolQuote += 1;
      else if (baseMint === WSOL) { wsolBase += 1; continue; }
      else { other += 1; continue; }
      seen.add(pool);
      out.write(JSON.stringify({
        pool, baseMint, quoteMint,
        creator: base58Encode(b.subarray(OFF_CREATOR, OFF_CREATOR + 32)),
        createdSlot: slot,
      }) + '\n');
    }
  }
  rl.close();
}
await new Promise<void>((r) => out.end(r));
console.log(`shard ${SHARD}/${SHARDS}: ${files.length} files`);
console.log(`  CreatePoolEvents: ${creates.toLocaleString()}`);
console.log(`  WSOL-quoted (kept):   ${wsolQuote.toLocaleString()}   unique pools written ${seen.size.toLocaleString()}`);
console.log(`  WSOL-based (skipped): ${wsolBase.toLocaleString()}   inverted direction`);
console.log(`  neither  (skipped):   ${other.toLocaleString()}`);
