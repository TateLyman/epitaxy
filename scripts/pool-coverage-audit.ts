/**
 * What fraction of the pools actually trading in a window does `venue_pools` know about?
 *
 * `build-trade-cache.ts` keeps a trade only if its pool is in `venue_pools` with a WSOL quote mint.
 * That table is a SNAPSHOT - every one of its 14,854 rows carries resolved_utc_ms of 2026-08-20 -
 * so a pool appears in it only if it was still observable on that date. A pool that lived for
 * twenty minutes three weeks earlier is invisible to every corpus built from that filter.
 *
 * THAT MAKES THE FILTER A SURVIVORSHIP FILTER WHOSE STRENGTH VARIES WITH HOW OLD THE WINDOW IS,
 * which is the worst possible shape: it does not bias a single corpus uniformly, it biases OLDER
 * corpora harder than newer ones, and the direction is to remove exactly the pools that died. Any
 * comparison across corpora of different ages is confounded by it unless the coverage is measured.
 *
 * This decodes the RAW SQD events - before the filter - and asks how many of the pools present are
 * in the table at all. It is the audit that should have run before block C was treated as a holdout.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { base58DecodeBulk } from '../packages/solana/src/base58.js';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const known = new Set<string>();
for (const r of db.prepare('SELECT pool FROM venue_pools').all() as { pool: string }[]) known.add(r.pool);
const wsol = new Set<string>();
for (const r of db.prepare('SELECT pool FROM venue_pools WHERE quote_mint = ?').all('So11111111111111111111111111111111111111112') as { pool: string }[]) wsol.add(r.pool);
db.close();
console.log(`venue_pools: ${known.size} total, ${wsol.size} WSOL-quoted`);
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const f of files) {
  const seen = new Set<string>();
  let n = 0;
  const rl = createInterface({ input: createReadStream(`data/sqd/events-pAMMBay6/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let blk: { instructions?: { data: string }[] };
    try { blk = JSON.parse(line) as { instructions?: { data: string }[] }; } catch { continue; }
    for (const i of blk.instructions ?? []) {
      let raw: Buffer;
      try { raw = Buffer.from(base58DecodeBulk(i.data, 4096)); } catch { continue; }
      if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
      const t = decodePumpSwapTrade(raw.subarray(8));
      if (t === null) continue;
      seen.add(t.pool); n += 1;
      if (n > 400000) break;
    }
    if (n > 400000) break;
  }
  rl.close();
  const inKnown = [...seen].filter((p) => known.has(p)).length;
  const inWsol = [...seen].filter((p) => wsol.has(p)).length;
  console.log(`${f}`);
  console.log(`  ${n.toLocaleString()} trades, ${seen.size.toLocaleString()} distinct pools`);
  console.log(`  in venue_pools at all: ${inKnown.toLocaleString()} (${(100 * inKnown / seen.size).toFixed(1)}%)   WSOL-quoted: ${inWsol.toLocaleString()} (${(100 * inWsol / seen.size).toFixed(1)}%)`);
}
