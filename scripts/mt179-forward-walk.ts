/**
 * MT179 — a forward walk. Does the cohort edge have a consistent sign, or does it follow the period?
 *
 * MT178 read +0.0030 selecting on block D and testing on block E, survived a matched control, and
 * looked like the first real result in this programme. It does not replicate. Selecting on block A
 * and testing on block D gives -0.0030, and the sign is unchanged on single contiguous windows, so
 * it is not the sparse-tape stitching that killed MT171.
 *
 * THE SIGN FOLLOWS THE TEST PERIOD, NOT THE WALLETS. Block E reads about +0.0030 whether the cohort
 * was chosen on A or on D; block D reads about -0.0030 either way. Two periods cannot distinguish a
 * strategy that works sometimes from a strategy that works never and got one lucky draw, and with
 * n=2 the honest prior is the second.
 *
 * SO THIS WALKS FORWARD. The cohort is chosen ONCE, on the oldest windows in the archive, and then
 * evaluated on every later window in order. Nothing about the selection can see the test periods,
 * and there are fifteen of them rather than two. The output is a distribution of signs, which is the
 * only thing that can answer the question: if the edge is real the sign should be positive most of
 * the time and the median window should be above zero; if MT178 was a draw from a wide distribution
 * centred near or below zero, that is what fifteen windows will show.
 *
 * DIRECTION MATTERS AND IS EASY TO GET WRONG HERE. Window numbering runs backwards - w18 is the
 * OLDEST and w1 the newest - so selecting on w16 through w18 and testing on w15 down to w1 is a walk
 * FORWARD in time. Selecting on recent data and testing on older data would let the cohort's later
 * success leak into its earlier scores, which is a look-ahead and would flatter every number below.
 *
 * The control cohort, the follower pricing, the fee ladder and the flat transaction cost are all
 * MT178's, unchanged.
 *
 * Reads tape. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
/** Oldest windows in the archive. w18 is the oldest. */
const P1 = (arg('p1') ?? '16,17,18').split(',').filter((s) => s.length > 0);
/** Later windows, walked in forward time order. */
const P2 = (arg('p2') ?? '15,14,13,12,11,10,9,8,7,6,5,4,3,A0,D0,E').split(',').filter((s) => s.length > 0);
const MIN_CLOSED = Number(arg('min-closed') ?? '3');
const LAG = Number(arg('lag') ?? '12');
/** Minimum positions before a window's growth is quoted; pooling still uses everything above it. */
const MIN_N = Number(arg('min-n') ?? '200');
const FIXED_LAMPORTS = Number(arg('fixed-lamports') ?? '46000');
const NOTIONAL_SOL = Number(arg('notional') ?? '0.02');
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL_SOL;
const CACHE = 'data/trade-cache';

const poolBorn = new Map<string, number>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(/\r?\n/)) {
  if (line.length === 0) continue;
  try { const r = JSON.parse(line) as { pool: string; createdSlot?: number }; if (r.createdSlot !== undefined) poolBorn.set(r.pool, r.createdSlot); } catch { /* skip */ }
}

type Row = [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
async function* read(windows: string[]): AsyncGenerator<Row> {
  for (const w of windows) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) continue;
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      try { yield JSON.parse(line) as Row; } catch { /* skip */ }
    }
    rl.close();
  }
}

// ---- select once, on the oldest windows ----
interface Leg { qIn: number; qOut: number; bIn: number; bOut: number; firstBuySlot: number }
const legs = new Map<string, Leg>();
for await (const r of read(P1)) {
  const user = r[13]; const uq = Number(r[9]); const base = Number(r[14]);
  if (user === undefined || !Number.isFinite(uq) || !Number.isFinite(base)) continue;
  const k = `${user}|${r[0]}`;
  let g = legs.get(k);
  if (g === undefined) { g = { qIn: 0, qOut: 0, bIn: 0, bOut: 0, firstBuySlot: -1 }; legs.set(k, g); }
  if (r[5] === 1) { g.qIn += uq; g.bIn += base; if (g.firstBuySlot < 0) g.firstBuySlot = r[1]; }
  else { g.qOut += uq; g.bOut += base; }
}
interface P { pnl: number; closed: number; atBirth: number; classified: number }
const per = new Map<string, P>();
let agg1 = 0;
for (const [k, g] of legs) {
  const bar = k.indexOf('|'); const user = k.slice(0, bar); const pool = k.slice(bar + 1);
  const matched = Math.min(g.bIn, g.bOut);
  const realised = matched <= 0 ? 0 : g.qOut * (matched / g.bOut) - g.qIn * (matched / g.bIn);
  agg1 += realised;
  let p = per.get(user);
  if (p === undefined) { p = { pnl: 0, closed: 0, atBirth: 0, classified: 0 }; per.set(user, p); }
  p.pnl += realised;
  if (g.bIn > 0 && g.bOut > 0) {
    p.closed += 1;
    const born = poolBorn.get(pool);
    if (born !== undefined && g.firstBuySlot >= born) { p.classified += 1; if (g.firstBuySlot === born) p.atBirth += 1; }
  }
}
legs.clear();
console.log('MT179 — forward walk');
console.log(`  selection ${P1.join(',')} (oldest in the archive), aggregate ${(agg1 / 1e9).toFixed(0)} SOL`);
if (agg1 > 0) { console.log('  REFUSED: positive aggregate means the accounting is wrong.'); process.exit(1); }
const ranked = [...per.entries()].filter(([, p]) => p.closed >= MIN_CLOSED).sort((a, b) => b[1].pnl - a[1].pnl);
const decile = ranked.slice(0, Math.floor(ranked.length / 10));
let cohort = new Set(decile.filter(([, p]) => p.classified >= MIN_CLOSED && p.atBirth === 0).map(([u]) => u));
/**
 * An explicit cohort, for testing ONE named wallet rather than a selected decile.
 *
 * The distinction matters when reading the output. A decile is a population and its result is an
 * expectation. A single wallet is one draw, chosen because it won, and following it is a bet that
 * whatever it is doing continues - which no amount of its own past record can establish. What this
 * CAN answer is narrower and still worth having: whether the wallet's positions are followable at
 * all, or whether its profit lives in the part of the trade an observer cannot reach.
 */
const EXPLICIT = (arg('cohort') ?? '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);
if (EXPLICIT.length > 0) cohort = new Set(EXPLICIT);
const mid = ranked.slice(Math.floor(ranked.length * 0.45), Math.floor(ranked.length * 0.55));
const control = new Set(mid.filter(([, p]) => p.classified >= MIN_CLOSED && p.atBirth === 0).map(([u]) => u));
console.log(`  cohort ${cohort.size.toLocaleString()} wallets, control ${control.size.toLocaleString()}, both fixed before any test period is read`);
console.log('');

const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};

console.log(`  Walking forward. Cohort fixed. lag ${LAG} slots, stake ${NOTIONAL_SOL} SOL, ${fixedBps.toFixed(0)} bps flat cost.`);
console.log('');
console.log('  window        n   median     mean    %pos   g cohort   g control   separation');
const gs: number[] = [];
const poolC: number[] = [];
const poolK: number[] = [];
for (const w of P2) {
  interface Tick { slot: number; price: number; feeBps: number }
  const ticks = new Map<string, Tick[]>();
  const posOf = new Map<string, { buy: number; sell: number; pool: string; ctl: boolean }>();
  for await (const r of read([w])) {
    const pool = r[0]; const slot = r[1];
    const b = Number(r[6]); const qq = Number(r[7]);
    if (b > 0 && qq > 0) {
      const t = ticks.get(pool) ?? [];
      t.push({ slot, price: qq / b, feeBps: (r[10] ?? 0) + (r[11] ?? 0) + (r[12] ?? 0) });
      ticks.set(pool, t);
    }
    const user = r[13];
    if (user === undefined) continue;
    const isC = cohort.has(user); const isK = control.has(user);
    if (!isC && !isK) continue;
    const k = `${user}|${pool}`;
    const p = posOf.get(k) ?? { buy: -1, sell: -1, pool, ctl: isK };
    if (r[5] === 1) { if (p.buy < 0) p.buy = slot; } else { p.sell = slot; }
    posOf.set(k, p);
  }
  for (const t of ticks.values()) t.sort((x, y) => x.slot - y.slot);
  function priceAt(pool: string, slot: number): Tick | null {
    const t = ticks.get(pool);
    if (t === undefined) return null;
    let lo = 0; let hi = t.length - 1; let ans: Tick | null = null;
    while (lo <= hi) { const mid2 = (lo + hi) >> 1; const c = t[mid2] as Tick; if (c.slot >= slot) { ans = c; hi = mid2 - 1; } else lo = mid2 + 1; }
    return ans;
  }
  const arms: Record<string, number[]> = { c: [], k: [] };
  for (const p of posOf.values()) {
    if (p.buy < 0 || p.sell <= p.buy) continue;
    const inT = priceAt(p.pool, p.buy + LAG); const outT = priceAt(p.pool, p.sell + LAG);
    if (inT === null || outT === null || outT.slot < inT.slot) continue;
    if (!(inT.price > 0) || !(outT.price > 0)) continue;
    const net = (outT.price / inT.price) * (1 - inT.feeBps / 1e4) * (1 - outT.feeBps / 1e4);
    (p.ctl ? arms.k : arms.c)?.push(1e4 * (net - 1) - fixedBps);
  }
  const c = arms.c ?? []; const k = arms.k ?? [];
  if (c.length < MIN_N) { console.log(`  ${w.padEnd(8)} too few positions (${c.length})`); continue; }
  poolC.push(...c); poolK.push(...k);
  const gc = growth(c, 0.05); const gk = k.length > 0 ? growth(k, 0.05) : NaN;
  gs.push(gc);
  const fm = (x: number): string => (x === -Infinity ? 'RUIN' : x.toFixed(4));
  console.log(
    `  ${w.padEnd(8)} ${String(c.length).padStart(7)} ${q(c, 0.5).toFixed(0).padStart(8)} ${mean(c).toFixed(0).padStart(8)} ` +
    `${(100 * c.filter((x) => x > 0).length / c.length).toFixed(1).padStart(6)}% ${fm(gc).padStart(10)} ${fm(gk).padStart(11)} ${(gc - gk).toFixed(4).padStart(12)}`,
  );
}
console.log('');
const pos = gs.filter((x) => x > 0).length;
console.log(`  ${pos} of ${gs.length} test periods positive for the cohort. Median growth ${q(gs, 0.5).toFixed(4)}, mean ${mean(gs).toFixed(4)}.`);
console.log('  A real edge should be positive in most periods. A wide distribution centred near zero');
console.log('  means MT178 was a draw from it and there is nothing to fund.');

/**
 * POOLING IS THE BETTER ESTIMATOR AND IT IS REPORTED LAST SO IT CANNOT BE MISTAKEN FOR A PERIOD.
 *
 * Counting how many periods came out positive weights a window holding three thousand positions
 * exactly as heavily as one holding nineteen thousand, which throws away most of the evidence and
 * turns a real measurement into a show of hands. Pooling every position from every test period into
 * one set and scoring it once uses all of it.
 *
 * The best-50-removed column is the same concentration test applied throughout: if a positive
 * pooled growth disappears when fifty outcomes are dropped from a set this large, the result rests
 * on a handful of trades and is not an edge.
 */
const fm2 = (x: number): string => (x === -Infinity ? 'RUIN' : x.toFixed(4));
const srtC = [...poolC].sort((x, y) => y - x);
const srtK = [...poolK].sort((x, y) => y - x);
console.log('');
console.log('  ===== POOLED OVER EVERY TEST PERIOD =====');
console.log(`  cohort   n=${poolC.length.toLocaleString()}  median ${q(poolC, 0.5).toFixed(0)}  mean ${mean(poolC).toFixed(0)}  ` +
  `%pos ${(100 * poolC.filter((x) => x > 0).length / poolC.length).toFixed(1)}  ` +
  `g(.02) ${fm2(growth(poolC, 0.02))}  g(.05) ${fm2(growth(poolC, 0.05))}  best50out ${fm2(growth(srtC.slice(50), 0.05))}  best500out ${fm2(growth(srtC.slice(500), 0.05))}`);
console.log(`  control  n=${poolK.length.toLocaleString()}  median ${q(poolK, 0.5).toFixed(0)}  mean ${mean(poolK).toFixed(0)}  ` +
  `%pos ${(100 * poolK.filter((x) => x > 0).length / poolK.length).toFixed(1)}  ` +
  `g(.02) ${fm2(growth(poolK, 0.02))}  g(.05) ${fm2(growth(poolK, 0.05))}  best50out ${fm2(growth(srtK.slice(50), 0.05))}  best500out ${fm2(growth(srtK.slice(500), 0.05))}`);
