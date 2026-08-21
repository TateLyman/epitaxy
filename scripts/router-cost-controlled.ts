/**
 * Is OKX routing genuinely cheaper, or is it just quoted on cheaper tokens?
 *
 * MT124 found median round-trip cost of 83 bps via Pump.fun Amm against 5 bps via OKX DEX
 * Router. If that is ROUTING it is the single largest cost lever in this project — 78 bps a
 * round trip against a gross edge that never exceeded 95. If it is TOKEN SELECTION it is
 * nothing, because a router gets chosen partly because a token is liquid, and a cheap route
 * would simply be reporting cheap tokens.
 *
 * THE CONTROL IS WITHIN-MINT. Only mints quoted through MORE THAN ONE router are used, and the
 * comparison is made inside each mint before being pooled. A within-mint difference cannot be
 * token selection, because the token is held fixed by construction.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/runtime.db', { readOnly: true });

interface Pair { mint: string; router: string; route: string; cost: number }
const rows = db.prepare(`
  SELECT b.mint mint, b.router router, b.route_labels route,
         CAST(b.in_amount AS REAL) bin, CAST(b.out_amount AS REAL) bout,
         CAST(s.in_amount AS REAL) sin, CAST(s.out_amount AS REAL) sout
    FROM quotes b
    JOIN quotes s ON s.mint = b.mint AND s.side = 'sell' AND b.side = 'buy'
                 AND ABS(s.requested_utc_ms - b.requested_utc_ms) < 5000
   WHERE b.out_amount IS NOT NULL AND s.out_amount IS NOT NULL AND b.router IS NOT NULL`).all() as
  { mint: string; router: string; route: string | null; bin: number; bout: number; sin: number; sout: number }[];

const pairs: Pair[] = [];
for (const r of rows) {
  if (!(r.bout > 0) || !(r.bin > 0) || !(r.sin > 0) || !(r.sout > 0)) continue;
  pairs.push({ mint: r.mint, router: r.router, route: r.route ?? 'unknown', cost: -1e4 * ((r.sout * (r.bout / r.sin)) / r.bin - 1) });
}
const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };

console.log(`paired quotes with a known router: ${pairs.length.toLocaleString()}`);
console.log('');
console.log('UNCONTROLLED — the MT124 view, which cannot separate routing from token');
const byR = new Map<string, number[]>();
for (const p of pairs) { const a = byR.get(p.router) ?? []; a.push(p.cost); byR.set(p.router, a); }
for (const [k, a] of [...byR.entries()].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`  ${k.padEnd(8)} n=${String(a.length).padStart(5)}   median cost ${med(a).toFixed(0).padStart(5)} bps`);
}

// ---- WITHIN-MINT: the control that holds the token fixed ----
const byMint = new Map<string, Map<string, number[]>>();
for (const p of pairs) {
  const m = byMint.get(p.mint) ?? new Map<string, number[]>();
  const a = m.get(p.router) ?? [];
  a.push(p.cost);
  m.set(p.router, a);
  byMint.set(p.mint, m);
}
const multi = [...byMint.entries()].filter(([, m]) => m.size > 1);
console.log('');
console.log(`MINTS QUOTED THROUGH MORE THAN ONE ROUTER: ${multi.length} of ${byMint.size}`);
if (multi.length === 0) {
  console.log('');
  console.log('  NONE. The routers never overlap on a token, so routing and token cannot be');
  console.log('  separated in this corpus and the MT124 route table is NOT evidence about routing.');
} else {
  const deltas = new Map<string, number[]>();
  for (const [, m] of multi) {
    const entries = [...m.entries()].map(([r, a]) => [r, med(a)] as [string, number]).filter(([, v]) => Number.isFinite(v));
    for (const [ra, va] of entries) for (const [rb, vb] of entries) {
      if (ra === rb) continue;
      const key = `${ra} - ${rb}`;
      const d = deltas.get(key) ?? [];
      d.push(va - vb); // positive => ra costs MORE than rb on this same token
      deltas.set(key, d);
    }
  }
  console.log('');
  console.log('WITHIN-MINT COST DIFFERENCE (positive = first router costs MORE on the same token)');
  for (const [k, a] of [...deltas.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, 8)) {
    if (a.length < 5) continue;
    console.log(`  ${k.padEnd(20)} mints=${String(a.length).padStart(4)}   median delta ${med(a).toFixed(0).padStart(6)} bps`);
  }
  console.log('');
  console.log('  A within-mint delta cannot be token selection. If OKX is cheaper HERE, it is routing.');
}
db.close();
