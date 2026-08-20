// MT110 — does temporary impact revert enough to pay a follower who takes the other side?
//
// Every mechanism this programme has tested is a PREDICTION. Temporary impact is the one
// structure that pays a LIQUIDITY PROVIDER instead: the impatient trader pushes price away
// from where it settles and whoever takes the other side is compensated.
//
// PRICE COMES ONLY FROM THE RESERVE PATH. quote_amount and user_quote_amount are physically
// swapped on 32.2% of stored buys and that defect is undiagnosed, so neither is used for
// anything here. The reserve fields are the ones verified against pool-vault balances at
// 55/55 exact.
//
// The decision quantity is the NET round trip through the fee model, never the gross price
// reversion — on an AMM the fee acts like a spread and a raw price series will show mean
// reversion that is purely the fee and is not capturable.
import { DatabaseSync } from 'node:sqlite';
import { priceBuy, priceSell } from '../packages/intelligence/src/copy-fill.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const V = 17_584_500_000n; // virtual quote reserve, MT100: 17.5845 SOL on graduates
const HORIZONS = [5_000, 15_000, 30_000, 60_000, 120_000];
const BUCKETS = [
  ['0.1-0.5%', 0.001, 0.005],
  ['0.5-1%', 0.005, 0.01],
  ['1-2%', 0.01, 0.02],
  ['2-5%', 0.02, 0.05],
  ['>5%', 0.05, Infinity],
];
const NOTIONAL = 20_000_000n; // 0.02 SOL, the frozen research notional

const db = new DatabaseSync('data/runtime.db', { readOnly: true });

// WSOL-quoted pools only, by name. Never assumed.
const wsol = new Set(
  (db.prepare('SELECT pool FROM venue_pools WHERE quote_mint = ?').all(WSOL)).map((r) => r.pool),
);
console.log(`MT110 — impact reversion\n  WSOL-quoted pools resolved by name: ${wsol.size}`);

const pools = db
  .prepare(
    `SELECT pool FROM venue_trades GROUP BY pool
      HAVING COUNT(*) >= 300 AND (MAX(observed_utc_ms)-MIN(observed_utc_ms)) >= 1800000`,
  )
  .all()
  .map((r) => r.pool)
  .filter((p) => wsol.has(p));
console.log(`  pools with >=300 trades over >=30 min AND WSOL-quoted: ${pools.length}\n`);

const price = (q, b) => (b > 0n ? Number(q + V) / Number(b) : NaN);

/** cell -> horizon -> samples */
const cells = new Map();
const push = (bucket, h, key, v) => {
  if (!Number.isFinite(v)) return;
  let c = cells.get(bucket);
  if (c === undefined) { c = new Map(); cells.set(bucket, c); }
  let hh = c.get(h);
  if (hh === undefined) { hh = { revert: [], net: [] }; c.set(h, hh); }
  hh[key].push(v);
};

let triggers = 0;
let refusedFee = 0;
let noMark = 0;

for (const pool of pools) {
  const t = db
    .prepare(
      `SELECT observed_utc_ms ms, side, pool_base_reserves_before b, pool_quote_reserves_before q,
              lp_fee_bps lp, protocol_fee_bps pf, creator_fee_bps cf
         FROM venue_trades WHERE pool = ? ORDER BY observed_utc_ms, rowid`,
    )
    .all(pool);
  if (t.length < 300) continue;

  for (let i = 1; i < t.length - 1; i += 1) {
    const pre = t[i];
    const post = t[i + 1];
    const bPre = BigInt(pre.b), qPre = BigInt(pre.q);
    const bPost = BigInt(post.b), qPost = BigInt(post.q);
    if (bPre <= 0n || qPre <= 0n || bPost <= 0n || qPost <= 0n) continue;

    const p0 = price(qPre, bPre);   // before the triggering trade
    const p1 = price(qPost, bPost); // after it
    if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0) continue;

    // Displacement caused by the triggering trade, and its relative size.
    const disp = p1 / p0 - 1;
    const rel = Math.abs(Number(qPost - qPre)) / Number(qPre);
    if (!(rel >= 0.001)) continue;

    const bucket = BUCKETS.find(([, lo, hi]) => rel >= lo && rel < hi);
    if (bucket === undefined) continue;
    // Direction: trade AGAINST the displacement, never with it.
    // Price up (a buy pushed it) -> we would need to sell, which we cannot do without
    // inventory, so only the DOWNWARD displacement is takeable: price fell, we buy.
    if (!(disp < 0)) continue;

    if (pre.cf === null || pre.cf === undefined) { refusedFee += 1; continue; }
    const fees = {
      lpFeeBasisPoints: BigInt(pre.lp),
      protocolFeeBasisPoints: BigInt(pre.pf),
      coinCreatorFeeBasisPoints: BigInt(pre.cf),
    };

    triggers += 1;

    for (const h of HORIZONS) {
      // The pool state AT the horizon is the before-reserves of the first trade past it.
      // Using the last trade INSIDE the horizon would mark one trade early. If the pool
      // never trades again we drop the sample rather than carry the last known price —
      // carrying it would mark a dead pool at its last live price, which is the single
      // most flattering error available here.
      let at = null;
      for (let j = i + 2; j < t.length; j += 1) {
        if (t[j].ms > post.ms + h) { at = t[j]; break; }
      }
      if (at === null) { noMark += 1; continue; }
      const bAt = BigInt(at.b), qAt = BigInt(at.q);
      if (bAt <= 0n || qAt <= 0n) continue;
      const p2 = price(qAt, bAt);
      if (!Number.isFinite(p2) || p2 <= 0) continue;

      // Gross reversion: what fraction of the displacement came back.
      push(bucket[0], h, 'revert', (p2 - p1) / (p0 - p1));

      // NET round trip: enter against the trade at the post-trade reserves, exit at the
      // horizon reserves, through the same fee model as copy-fill.
      try {
        const buy = priceBuy({ base: bPost, quote: qPost }, NOTIONAL, fees);
        const sell = priceSell({ base: bAt, quote: qAt }, buy.baseOut, fees);
        push(bucket[0], h, 'net', Number(sell.quoteOut - NOTIONAL) / Number(NOTIONAL));
      } catch {
        /* unpriceable; already counted by refusedFee upstream where applicable */
      }
    }
  }
}
db.close();

const stat = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (s.length === 0) return null;
  const p = (x) => s[Math.floor(x * (s.length - 1))];
  return { n: s.length, mean: s.reduce((x, y) => x + y, 0) / s.length, p25: p(0.25), med: p(0.5), p75: p(0.75), pos: s.filter((v) => v > 0).length / s.length };
};
const f = (v, d = 2) => (v === null || !Number.isFinite(v) ? '   n/a' : (100 * v).toFixed(d).padStart(7));

console.log(`triggering downward displacements: ${triggers}   refused for unknown creator fee: ${refusedFee}   horizon marks dropped, no trade past horizon: ${noMark}\n`);
console.log('GROSS REVERSION — fraction of the displacement that came back');
console.log('  bucket        ' + HORIZONS.map((h) => `${h / 1000}s`.padStart(9)).join(''));
for (const [name] of BUCKETS) {
  const c = cells.get(name);
  if (c === undefined) continue;
  const row = HORIZONS.map((h) => {
    const s = stat(c.get(h)?.revert ?? []);
    return s === null ? '      n/a' : `${(100 * s.med).toFixed(1)}%`.padStart(9);
  }).join('');
  const n = stat(c.get(HORIZONS[0])?.revert ?? [])?.n ?? 0;
  console.log(`  ${name.padEnd(10)} n=${String(n).padStart(6)} ${row}`);
}

console.log('\nNET ROUND TRIP after the full fee ladder both ways, at 0.02 SOL — THE DECISION QUANTITY');
console.log('  bucket        ' + HORIZONS.map((h) => `${h / 1000}s`.padStart(11)).join(''));
for (const [name] of BUCKETS) {
  const c = cells.get(name);
  if (c === undefined) continue;
  const med = HORIZONS.map((h) => {
    const s = stat(c.get(h)?.net ?? []);
    return s === null ? '        n/a' : `${f(s.med)}%`.padStart(11);
  }).join('');
  const posr = HORIZONS.map((h) => {
    const s = stat(c.get(h)?.net ?? []);
    return s === null ? '        n/a' : `${(100 * s.pos).toFixed(1)}%`.padStart(11);
  }).join('');
  const mean = HORIZONS.map((h) => {
    const s = stat(c.get(h)?.net ?? []);
    return s === null ? '        n/a' : `${f(s.mean)}%`.padStart(11);
  }).join('');
  console.log(`  ${name.padEnd(10)} median ${med}`);
  console.log(`  ${' '.padEnd(10)} mean   ${mean}`);
  console.log(`  ${' '.padEnd(10)} pos    ${posr}`);
}

console.log('\nPREREGISTERED CHECKS — a reversion that does not scale with impact is not impact reverting');
const at60 = BUCKETS.map(([name]) => {
  const s = stat(cells.get(name)?.get(60_000)?.net ?? []);
  return { name, med: s === null ? NaN : s.med, n: s?.n ?? 0 };
});
console.log('  net median at 60s by impact bucket (must INCREASE with impact if real):');
for (const a of at60) console.log(`    ${a.name.padEnd(10)} n=${String(a.n).padStart(6)}  ${f(a.med)}%`);
const ordered = at60.filter((a) => Number.isFinite(a.med));
const monotone = ordered.every((a, i) => i === 0 || a.med >= ordered[i - 1].med);
console.log(`  monotone in impact: ${monotone ? 'YES' : 'NO'}`);
console.log('\n  ONE UTC DAY = ONE CLUSTER. Point estimates only. No position is licensed by this.');
