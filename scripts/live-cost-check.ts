/**
 * What does a round trip ACTUALLY cost, priced against live executable Jupiter quotes?
 *
 * Every number in this programme models a trade as a direct swap against the PumpSwap pool.
 * Paper mode has been pricing against live Jupiter quotes instead — real routes, real depth,
 * and 18% of them are NOT a direct Pump.fun hop: OKX DEX Router, Meteora DAMM v2, multi-hop
 * Meteora>Pump.fun, across three routers (metis, dflow, okx).
 *
 * If routed execution is materially cheaper than direct-pool math, every cost figure in the
 * ledger is pessimistic. If it is dearer, every one is optimistic. Either way the model has
 * never been checked against the thing it models.
 *
 * PAIRING IS THE WHOLE DIFFICULTY. A buy and a sell quoted 20 seconds apart contain 20 seconds
 * of price drift, which is why a loose pairing showed a p10 "gain" of 119 bps — that is the
 * market moving, not free money. Tightening the window trades sample size for cleanliness, so
 * several windows are reported and the trend across them is the answer.
 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const sql = `
  SELECT CAST(b.in_amount AS REAL) bin, CAST(b.out_amount AS REAL) bout,
         CAST(s.in_amount AS REAL) sin, CAST(s.out_amount AS REAL) sout,
         b.route_labels brl
    FROM quotes b
    JOIN quotes s ON s.mint = b.mint AND s.side = 'sell' AND b.side = 'buy'
                 AND ABS(s.requested_utc_ms - b.requested_utc_ms) < ?
   WHERE b.out_amount IS NOT NULL AND s.out_amount IS NOT NULL`;

const q = (a: number[], x: number): number => (a.length ? (a[Math.floor(x * (a.length - 1))] ?? NaN) : NaN);

console.log('LIVE round-trip cost, from paired executable Jupiter quotes');
console.log('  (positive = cost in bps. Tighter pairing = less price drift, smaller sample.)');
console.log('');
console.log('  pair window      n     p25      p50      p75     mean');
for (const win of [20000, 5000, 2000, 1000, 500, 200]) {
  const rows = db.prepare(sql).all(win) as { bin: number; bout: number; sin: number; sout: number; brl: string | null }[];
  const rt: number[] = [];
  for (const r of rows) {
    if (!(r.bout > 0) || !(r.bin > 0) || !(r.sin > 0) || !(r.sout > 0)) continue;
    // Scale the sell's proceeds to the base the buy actually returned, so both legs are the
    // same position rather than two differently-sized probes.
    rt.push((r.sout * (r.bout / r.sin)) / r.bin - 1);
  }
  rt.sort((a, b) => a - b);
  if (rt.length < 20) { console.log(`  ${String(win).padStart(7)}ms  n=${String(rt.length).padStart(5)}  too few`); continue; }
  const mean = rt.reduce((a, b) => a + b, 0) / rt.length;
  console.log(`  ${String(win).padStart(7)}ms  ${String(rt.length).padStart(5)}  ${(-1e4 * q(rt, 0.75)).toFixed(0).padStart(6)}  ${(-1e4 * q(rt, 0.5)).toFixed(0).padStart(6)}  ${(-1e4 * q(rt, 0.25)).toFixed(0).padStart(6)}  ${(-1e4 * mean).toFixed(0).padStart(7)}`);
}

console.log('');
console.log('BY ROUTE, at the tightest window that still has a sample');
const rows = db.prepare(sql).all(5000) as { bin: number; bout: number; sin: number; sout: number; brl: string | null }[];
const byRoute = new Map<string, number[]>();
for (const r of rows) {
  if (!(r.bout > 0) || !(r.bin > 0) || !(r.sin > 0) || !(r.sout > 0)) continue;
  const k = (r.brl ?? 'unknown').slice(0, 34);
  const a = byRoute.get(k) ?? [];
  a.push((r.sout * (r.bout / r.sin)) / r.bin - 1);
  byRoute.set(k, a);
}
console.log('  route                                  n      p50 cost bps');
for (const [k, a] of [...byRoute.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, 6)) {
  if (a.length < 20) continue;
  a.sort((x, y) => x - y);
  console.log(`  ${k.padEnd(36)} ${String(a.length).padStart(5)}   ${(-1e4 * q(a, 0.5)).toFixed(0).padStart(6)}`);
}
db.close();
console.log('');
console.log('  The modelled direct-pool round trip was p05 50, p50 60, p95 240 bps (cost-census).');
console.log('  If live sits above that, every cost figure in this ledger is OPTIMISTIC.');
