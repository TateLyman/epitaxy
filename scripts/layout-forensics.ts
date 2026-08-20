/**
 * BuyEvent and SellEvent are DIFFERENT STRUCTS and our decoder uses one offset table.
 *
 * Measured: SELL payloads are 417 bytes; BUY payloads are 465 OR 480 - three distinct
 * layouts, decoded as if they were one. `pumpswap-event.ts` reads lpFeeBps at 72,
 * protocolFeeBps at 88, coinCreatorFeeBps at 344, pool at 120, reserves at 56/64.
 *
 * This dumps the same offsets across the three length classes so the damage is visible
 * rather than assumed, and checks the one invariant that must hold if the fee offsets are
 * right: THE FEE LADDER OF A POOL CANNOT DEPEND ON WHICH SIDE A TRADE TOOK.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DIR = 'data/sqd/events-pAMMBay6';
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('none'); process.exit(0); }

const samples = new Map<number, Buffer>();
interface Row { side: string; len: number; pool: string; lp: number; pf: number; cf: number }
const rows: Row[] = [];
for (const line of readFileSync(`${DIR}/${file}`, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  const blk = JSON.parse(line) as { header?: { number: number }; instructions?: { data: string }[] };
  if (blk.header === undefined) continue;
  for (const i of blk.instructions ?? []) {
    let raw: Buffer;
    try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
    const body = raw.subarray(8);
    const t = decodePumpSwapTrade(body);
    if (t === null || t.coinCreatorFeeBasisPoints === null) continue;
    if (!samples.has(body.length)) samples.set(body.length, Buffer.from(body));
    rows.push({ side: t.side, len: body.length, pool: t.pool, lp: Number(t.lpFeeBasisPoints), pf: Number(t.protocolFeeBasisPoints), cf: Number(t.coinCreatorFeeBasisPoints) });
  }
}
console.log(`decoded ${rows.length.toLocaleString()} events\n`);
console.log('LENGTH CLASSES');
for (const [len, n] of [...rows.reduce((m, r) => m.set(r.len, (m.get(r.len) ?? 0) + 1), new Map<number, number>())].sort((a, b) => a[0] - b[0])) {
  const sides = [...new Set(rows.filter((r) => r.len === len).map((r) => r.side))].join('/');
  console.log(`  ${len} bytes   n=${String(n).padStart(6)}   sides ${sides}`);
}

console.log('\nu64 VALUES AT THE FEE OFFSETS WE USE, per length class');
console.log('  (a plausible fee is a small number: 0,2,5,20,25,30..95. A huge value is a wrong offset)');
for (const [len, buf] of [...samples.entries()].sort((a, b) => a[0] - b[0])) {
  const at = (o: number): string => (o + 8 <= buf.length ? String(buf.readBigUInt64LE(o)) : 'OOB');
  console.log(`  len ${len}:  off72(lp) ${at(72).padStart(22)}   off88(proto) ${at(88).padStart(22)}   off344(creator) ${at(344).padStart(14)}`);
}

console.log('\nTHE INVARIANT — a pool fee ladder CANNOT depend on the side of the trade.');
const byPool = new Map<string, { buy: Set<string>; sell: Set<string> }>();
for (const r of rows) {
  const e = byPool.get(r.pool) ?? { buy: new Set<string>(), sell: new Set<string>() };
  (r.side === 'BUY' ? e.buy : e.sell).add(`${r.lp}/${r.pf}/${r.cf}`);
  byPool.set(r.pool, e);
}
let both = 0; let agree = 0; const bad: string[] = [];
for (const [pool, e] of byPool) {
  if (e.buy.size === 0 || e.sell.size === 0) continue;
  both += 1;
  const inter = [...e.buy].filter((x) => e.sell.has(x));
  if (inter.length > 0) agree += 1;
  else if (bad.length < 6) bad.push(`    ${pool.slice(0, 8)}  BUY {${[...e.buy].join(', ')}}   SELL {${[...e.sell].join(', ')}}`);
}
console.log(`  pools with both sides: ${both}   ladders share at least one combination: ${agree} = ${(100 * agree / Math.max(both, 1)).toFixed(1)}%`);
if (bad.length > 0) { console.log('  pools where BUY and SELL ladders share NOTHING:'); for (const b of bad) console.log(b); }
console.log('\n  If that share is high the fee offsets survive the layout difference and MT110-MT112');
console.log('  fee numbers stand. If it is low, every fee-derived number in this programme is suspect.');
