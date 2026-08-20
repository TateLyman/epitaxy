/**
 * Which offsets in CreatePoolEvent are the MINTS?
 *
 * The pool-address test found no overlap, and that is a sampling fact rather than a negative:
 * venue_pools holds pools that TRADED in our windows, while the CreatePoolEvents in those same
 * windows are pools being CREATED, most of which have not traded yet.
 *
 * So test against mints instead. WSOL is provably at offset 50 in 40 of 40 payloads. If a
 * second offset holds a mint that venue_pools also knows as a base_mint, the mint pair is in
 * the event and pool->mints needs no account read. getAccountInfo is the measured binding
 * constraint on this project, and resolving mints has been its single largest consumer.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { base58Decode, base58Encode } from '../packages/solana/src/base58.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const CREATE_POOL = Buffer.from('b1310cd2a076a774', 'hex');
const DIR = 'data/sqd/events-pAMMBay6';

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const baseMints = new Set(
  (db.prepare('SELECT DISTINCT base_mint m FROM venue_pools').all() as { m: string }[]).map((r) => r.m),
);
const knownPools = new Set(
  (db.prepare('SELECT pool p FROM venue_pools').all() as { p: string }[]).map((r) => r.p),
);
db.close();
console.log(`known base mints ${baseMints.size.toLocaleString()}   known pools ${knownPools.size.toLocaleString()}\n`);

const hitsBase = new Map<number, number>();
const hitsWsol = new Map<number, number>();
const hitsPool = new Map<number, number>();
let n = 0;
outer: for (const f of readdirSync(DIR).filter((x) => /^events-\d+-\d+\.jsonl$/.test(x))) {
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
      n += 1;
      for (let o = 8; o + 32 <= b.length; o += 1) {
        const k = base58Encode(b.subarray(o, o + 32));
        if (k === WSOL) hitsWsol.set(o, (hitsWsol.get(o) ?? 0) + 1);
        else if (baseMints.has(k)) hitsBase.set(o, (hitsBase.get(o) ?? 0) + 1);
        if (knownPools.has(k)) hitsPool.set(o, (hitsPool.get(o) ?? 0) + 1);
      }
      if (n >= 2000) { rl.close(); break outer; }
    }
  }
  rl.close();
}
console.log(`CreatePoolEvent payloads scanned: ${n}\n`);
const show = (label: string, m: Map<number, number>): void => {
  console.log(label);
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (top.length === 0) { console.log('  (none)'); return; }
  for (const [o, c] of top) console.log(`  offset ${String(o).padStart(4)}   ${String(c).padStart(5)} of ${n}   ${(100 * c / n).toFixed(1)}%`);
};
show('WSOL found at:', hitsWsol);
show('\na KNOWN base_mint found at:', hitsBase);
show('\na KNOWN pool address found at:', hitsPool);
console.log('\n  Two stable offsets - one carrying WSOL, one carrying a mint we independently know -');
console.log('  means the mint pair is in the event, and pool->mints costs no account read.');
