/**
 * Decode the backfill ONCE into a compact cache, so a test costs seconds instead of an hour.
 *
 * WHY. The bottleneck is not disk - 22 GB reads in about two minutes - it is base58-decoding
 * roughly 28 million instruction payloads at about 5,200 a second. MT116 and MT117 decode the
 * SAME bytes to the same values, and every future test would decode them again. This pays that
 * cost once.
 *
 * WHAT IS AND IS NOT FILTERED. Only two filters are applied, and both are ones every consumer
 * already applies identically, so caching them changes no result:
 *   - the payload must be an emit_cpi-wrapped PumpSwap trade event
 *   - the pool must be WSOL-quoted BY NAME in venue_pools, never inferred
 * Everything else - impact bars, depth cuts, virtual reserves, fee models - stays in the test.
 * A cache that pre-applied those would be a cache that decided the answer.
 *
 * ORDER IS PRESERVED as (slot, transactionIndex, instructionAddress), which is the ordering the
 * reserve chain was verified against at 35,650 of 35,650 exact.
 *
 * Run one process per window range; they are independent. Verify against a known trigger count
 * before trusting it.
 */
import { createReadStream, readdirSync, createWriteStream, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { openDb } from '../packages/storage/src/db.js';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
/**
 * The BULK decoder, not the canonical one. base58 decoding is 99.4% of this script's runtime -
 * measured at 268.8ms against 1.9ms of JSON.parse on the same 1,566 real instructions - because the
 * canonical implementation is O(n squared) with a large constant and PumpSwap event payloads run
 * about 594 base58 characters. The bulk decoder is 4.4x faster, produces byte-identical output on
 * every one of those 1,566 real payloads, and is proven equivalent by tests/unit/base58-bulk.test.ts
 * across every length, every leading-zero pattern and every alphabet boundary.
 *
 * The canonical decoder is deliberately untouched and still owns the transaction-decode and signer
 * paths. This is an offline research backfill; the two concerns are kept apart on purpose.
 */
import { base58DecodeBulk } from '../packages/solana/src/base58.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DIR = 'data/sqd/events-pAMMBay6';
const OUT = 'data/trade-cache';
const HEAD = 440_494_520;
const SLOTS_PER_DAY = 207_494;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const only = (arg('windows') ?? '').split(',').filter((s) => s.length > 0).map(Number);
// Explicit-range mode, for windows that are NOT on the HEAD - k*SLOTS_PER_DAY grid. The
// time-of-day test needs windows deliberately staggered around the clock, which that grid
// cannot express - every window on it lands at the same wall-clock hour, which is exactly the
// confound MT122 disclosed.
const explicit = arg('range');   // form: label:from:to
if (only.length === 0 && explicit === null) { console.error('need --windows=1,2,3 or --range=label:from:to'); process.exit(2); }

/**
 * THE POOL SET IS THE UNION OF TWO SOURCES, AND THE SECOND ONE IS WHY THIS IS NOT A SURVIVORSHIP
 * FILTER ANY MORE.
 *
 * `venue_pools` is a single-day snapshot - every row carries resolved_utc_ms of 2026-08-20 - so a
 * pool appears in it only if it was still observable on that date. Measured against RAW SQD events,
 * that keeps 44.7% of pools at slot 435.74M, 53.8% at 436.74M, 78.1% at 438.82M and about 70% across
 * blocks A and B. It is a survivorship filter whose strength varies with the AGE of the window,
 * biasing older corpora harder and removing exactly the pools that died - the worst possible shape
 * for any comparison across corpora.
 *
 * `data/panel/pool-map.jsonl` is built from CreatePoolEvent, which the SQD pull already captured
 * because it filters on the emit_cpi discriminator. It carries the pool address and both mints, so
 * it needs no RPC and no account reads. Since the analysis only ever scores pools whose BIRTH is
 * observed inside a block, and a pool born in a block has its create event in that block, the union
 * gives 100% coverage of the analysable population instead of 45-78%.
 *
 * Only WSOL-QUOTED pools are kept, from either source. A pool with WSOL as its BASE is the inverted
 * direction and its constant-product price math means the opposite thing; 55% of created pools are
 * that shape and they are excluded deliberately.
 */
const db = openDb({ path: 'data/runtime.db' });
const wsol = new Set<string>();
for (const r of db.prepare('SELECT pool FROM venue_pools WHERE quote_mint = ?').all(WSOL) as { pool: string }[]) wsol.add(r.pool);
db.close();
const fromSnapshot = wsol.size;
if (existsSync('data/panel/pool-map.jsonl')) {
  for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(/\r?\n/)) {
    if (line.length === 0) continue;
    try {
      const r = JSON.parse(line) as { pool: string; quoteMint: string };
      if (r.quoteMint === WSOL) wsol.add(r.pool);
    } catch { /* skip */ }
  }
}
console.log(`  pool set: ${fromSnapshot.toLocaleString()} from venue_pools snapshot, ${wsol.size.toLocaleString()} after union with CreatePoolEvent map`);
mkdirSync(OUT, { recursive: true });
console.log(`cache builder — windows ${only.join(',')} — ${wsol.size.toLocaleString()} WSOL pools known`);

const jobs: { label: string; from: number; to: number }[] = [];
for (const w of only) { const to = HEAD - w * SLOTS_PER_DAY; jobs.push({ label: String(w), from: to - 19_999, to }); }
if (explicit !== null) {
  const [lab, f, t] = explicit.split(':');
  if (lab === undefined || f === undefined || t === undefined) { console.error('bad --range'); process.exit(2); }
  jobs.push({ label: lab, from: Number(f), to: Number(t) });
}
for (const job of jobs) {
  const w = job.label;
  const from = job.from;
  const to = job.to;
  const files = readdirSync(DIR).filter((f) => {
    const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(f);
    return m !== null && Number(m[2]) >= from && Number(m[1]) <= to;
  });
  if (files.length === 0) { console.log(`  window ${w}: no files`); continue; }
  const out = createWriteStream(`${OUT}/w${w}.jsonl`);
  let kept = 0;
  let seen = 0;
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(`${DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let blk: { header?: { number: number; timestamp: number }; instructions?: { transactionIndex: number; instructionAddress: number[]; data: string }[] };
      try { blk = JSON.parse(line); } catch { continue; }
      const h = blk.header;
      if (h === undefined || h.number < from || h.number > to) continue;
      for (const i of blk.instructions ?? []) {
        seen += 1;
        let raw: Buffer;
        try { raw = Buffer.from(base58DecodeBulk(i.data, 4096)); } catch { continue; }
        if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
        const t = decodePumpSwapTrade(raw.subarray(8));
        if (t === null || t.coinCreatorFeeBasisPoints === null) continue;
        if (!wsol.has(t.pool)) continue;
        // Compact positional record. bigints as strings: SQLite INTEGER is 64-bit SIGNED and
        // JSON numbers lose precision above 2^53, and these are raw token units.
        out.write(JSON.stringify([
          t.pool, h.number, h.timestamp, i.transactionIndex, i.instructionAddress.join('.'),
          t.side === 'BUY' ? 1 : 0,
          t.poolBaseReservesBefore.toString(), t.poolQuoteReservesBefore.toString(),
          t.quoteAmount.toString(), t.userQuoteAmount.toString(),
          Number(t.lpFeeBasisPoints), Number(t.protocolFeeBasisPoints), Number(t.coinCreatorFeeBasisPoints),
          // Field 13, APPENDED so every existing consumer that indexes 0-12 is unaffected.
          // `user` is what makes a wallet-selected entry testable at all: without it the tape
          // records that a buy happened and not WHO bought, and MT101/MT104 are both wallet tests.
          t.user,
          // Field 14. The DECODED base leg. Do not be tempted to recover this from the reserve
          // chain instead: baseAfter(i) == baseBefore(i+1) holds only when nothing but a trade
          // happened in between, and MT106 recorded that liquidity deposits and withdrawals move
          // reserves for reasons that are not trades. Inferring it produced phantom balances and
          // a venue-wide profit of +1,075,843 SOL, which is arithmetically impossible.
          t.baseAmount.toString(),
        ]) + '\n');
        kept += 1;
      }
    }
    rl.close();
  }
  await new Promise<void>((res) => out.end(res));
  console.log(`  window ${w}: ${kept.toLocaleString()} WSOL trades cached from ${seen.toLocaleString()} instructions`);
}
console.log('done');
