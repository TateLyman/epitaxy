/**
 * Is the PumpSwap fee ladder a DETERMINISTIC function of a market-cap tier?
 *
 * A literature sweep reported that PumpSwap runs a market-cap-tiered dynamic fee schedule,
 * and that our own measured cost distribution - floor 50, median 60, p95 240 bps - is exactly
 * the flat tier, the 20M+ tier and the 85k-300k tier of that schedule.
 *
 * That is a claim about OUR data, so it is checkable against OUR data rather than believed.
 * If the schedule is real, the triple (lp, protocol, creator) must collapse onto a SMALL
 * NUMBER OF EXACT COMBINATIONS rather than varying continuously, and each combination must
 * sit at a distinct pool size. If instead the triple is scattered, the schedule is not what
 * is generating our costs and the claim is wrong.
 *
 * This computes no return and conditions on no outcome.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const V = 17_584_500_000n;
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const wsol = new Set((db.prepare('SELECT pool FROM venue_pools WHERE quote_mint=?').all(WSOL) as { pool: string }[]).map((r) => r.pool));
db.close();
const DIR = 'data/sqd/events-pAMMBay6';
const file = readdirSync(DIR).filter((f) => /^events-44\d+-\d+\.jsonl$/.test(f)).sort()[0];
if (file === undefined) { console.log('no file'); process.exit(0); }

interface R { lp: number; pf: number; cf: number; depth: number; pool: string }
const rows: R[] = [];
for (const line of readFileSync(`${DIR}/${file}`, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  const blk = JSON.parse(line) as { header?: { number: number }; instructions?: { data: string }[] };
  if (blk.header === undefined) continue;
  for (const i of blk.instructions ?? []) {
    let raw: Buffer;
    try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
    const t = decodePumpSwapTrade(raw.subarray(8));
    if (t === null || t.coinCreatorFeeBasisPoints === null) continue;
    if (t.poolBaseReservesBefore <= 0n || t.poolQuoteReservesBefore <= 0n) continue;
    rows.push({ lp: Number(t.lpFeeBasisPoints), pf: Number(t.protocolFeeBasisPoints), cf: Number(t.coinCreatorFeeBasisPoints),
                depth: Number(t.poolQuoteReservesBefore + V) / 1e9, pool: t.pool });
  }
}
console.log(`trades ${rows.length.toLocaleString()}   (WSOL-quoted subset ${rows.filter((r) => wsol.has(r.pool)).length.toLocaleString()})\n`);

const key = (r: R): string => `lp=${String(r.lp).padStart(2)} proto=${String(r.pf).padStart(2)} creator=${String(r.cf).padStart(2)}`;
const groups = new Map<string, R[]>();
for (const r of rows) { const k = key(r); const a = groups.get(k); if (a === undefined) groups.set(k, [r]); else a.push(r); }
const P = (a: number[], x: number): number => { const s = [...a].sort((m, n) => m - n); return s.length ? (s[Math.floor(x * (s.length - 1))] ?? NaN) : NaN; };

console.log('THE JOINT DISTRIBUTION OF (lp, protocol, creator). A tiered schedule predicts a SHORT list.');
console.log('  combination                    trades    share   round-trip   pools   pool quote reserve SOL (p10/p50/p90)');
const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [k, a] of sorted) {
  const first = a[0];
  if (first === undefined) continue;
  const rt = 2 * (first.lp + first.pf + first.cf);
  const d = a.map((x) => x.depth);
  console.log(`  ${k}   ${String(a.length).padStart(6)}  ${(100 * a.length / rows.length).toFixed(1).padStart(5)}%   ${String(rt).padStart(6)} bps   ${String(new Set(a.map((x) => x.pool)).size).padStart(5)}   ${P(d, 0.1).toFixed(0).padStart(6)} ${P(d, 0.5).toFixed(0).padStart(7)} ${P(d, 0.9).toFixed(0).padStart(8)}`);
}
console.log(`\n  DISTINCT COMBINATIONS OBSERVED: ${groups.size}`);
console.log('  A continuously varying fee would produce hundreds. A tiered schedule produces a handful.');

console.log('\nIS THE TIER A FUNCTION OF POOL SIZE? Each combination should occupy its own size band.');
console.log('  If bands overlap heavily, pool quote reserve is NOT the tiering variable — the docs say');
console.log('  MARKET CAP, which is base supply times price, not pool depth, so overlap is expected and');
console.log('  is NOT evidence against the schedule. Reported so the distinction is not fudged.');
const perPoolCombos = new Map<string, Set<string>>();
for (const r of rows) { const s = perPoolCombos.get(r.pool) ?? new Set<string>(); s.add(key(r)); perPoolCombos.set(r.pool, s); }
const multi = [...perPoolCombos.values()].filter((s) => s.size > 1).length;
console.log(`\n  pools whose fee combination CHANGED within this 2.3-hour window: ${multi} of ${perPoolCombos.size}`);
console.log('  A pool that crosses a market-cap boundary mid-window should re-tier. That is the');
console.log('  signature of a dynamic schedule, and it is the sharpest test available in one window.');
