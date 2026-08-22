/**
 * WHAT, MECHANICALLY, DO THE WINNERS DO THAT THE LOSERS DO NOT?
 *
 * `who-wins.ts` established the shape: winners concentrate in ONE pool, enter about four minutes
 * after its first observed trade, trade it 50-80 times over roughly half an hour, and do NOT do
 * same-slot round trips, so they are not MEV bots. That says how often they act. It does not say
 * what the actions ARE, and "trade a lot in one pool" is not a strategy anyone can run.
 *
 * This measures the actions. Four candidate mechanisms make DIFFERENT, INCOMPATIBLE predictions,
 * so one table separates them:
 *
 *   MARKET MAKING / ABSORPTION. Buys after the price falls, sells after it rises, alternates side
 *   frequently, and trades AGAINST the net flow of everyone else. Needs no forecast: it is paid
 *   for supplying immediacy. Predicts negative pre-drift on buys, positive on sells, HIGH
 *   alternation, and negative "others' net flow" alongside their buys.
 *
 *   MOMENTUM. Buys after the price rises. Predicts POSITIVE pre-drift on buys — the opposite sign.
 *
 *   ACCUMULATE-THEN-DISTRIBUTE. One-directional: buys for a while, then sells for a while. Predicts
 *   LOW alternation, and buys clustered at low price percentiles with sells at high ones.
 *
 *   FORESIGHT. Whatever they do, the price goes their way afterwards. Predicts positive POST-drift
 *   on buys and negative on sells, regardless of the other columns. This is the one that would be
 *   unreachable, because it is information rather than method.
 *
 * PnL IS FIFO-MATCHED ON COMPLETED ROUND TRIPS ONLY, and the conservation check is a hard gate.
 * Two earlier versions of this analysis reported impossible venue-wide profits — once from
 * inferring the base leg off the reserve chain, once from crediting sells of pre-window inventory
 * — and the second produced a Spearman of 0.63 that would have read as a discovery. Traders in
 * aggregate must LOSE. If they do not, nothing is printed.
 *
 * EXPLORATORY. Decides nothing. Re-preregister before believing any of it.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;
const DRIFT_S = 60;
const V_CANDIDATES = [0n, 17_584_500_000n];
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '1').split(',').filter((s) => s.length > 0);

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; big: bigint; small: bigint; who: string; base: bigint }

function resolveV(evs: Ev[]): bigint | null {
  let best: bigint | null = null; let bestBad = Infinity;
  for (const v of V_CANDIDATES) {
    let bad = 0; let n = 0;
    for (let i = 0; i + 1 < evs.length && n < 60; i += 1) {
      const a = evs[i]; const c = evs[i + 1];
      if (a === undefined || c === undefined || a.b <= 0n || a.q <= 0n || c.b <= 0n || c.q <= 0n) continue;
      const k0 = Number(a.b) * Number(a.q + v); const k1 = Number(c.b) * Number(c.q + v);
      if (!(k0 > 0) || !(k1 > 0)) continue;
      n += 1; if (k1 < k0) bad += 1;
    }
    if (n >= 10 && bad < bestBad) { bestBad = bad; best = v; }
  }
  return best;
}

/** Index of the last event at or before `t`. Events are slot-ordered so ts is monotone. */
function atOrBefore(ts: number[], t: number): number {
  let a = 0; let b = ts.length - 1; let r = -1;
  while (a <= b) { const m = (a + b) >> 1; const v = ts[m]; if (v === undefined) break; if (v <= t) { r = m; a = m + 1; } else b = m - 1; }
  return r;
}

interface Acc {
  pnl: number; trades: number; buys: number; sells: number; flips: number;
  preBuy: number[]; preSell: number[]; postBuy: number[]; postSell: number[];
  pctBuy: number[]; pctSell: number[];
  othersFlowBuy: number[]; othersFlowSell: number[];
  gapS: number[]; solPerTrade: number[]; sizeFrac: number[];
  pools: Set<string>;
}
const blank = (): Acc => ({ pnl: 0, trades: 0, buys: 0, sells: 0, flips: 0, preBuy: [], preSell: [], postBuy: [], postSell: [], pctBuy: [], pctSell: [], othersFlowBuy: [], othersFlowSell: [], gapS: [], solPerTrade: [], sizeFrac: [], pools: new Set() });
const acc = new Map<string, Acc>();
let netAll = 0; let feeAll = 0; let poolsUsed = 0;

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  (missing w${w})`); continue; }
  const byPool = new Map<string, Ev[]>();
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (r.length < 15) { console.log(`  w${w} lacks the base field — rebuild it`); process.exit(2); }
    const qa = BigInt(r[8]); const ua = BigInt(r[9]);
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1, b: BigInt(r[6]), q: BigInt(r[7]),
             big: qa > ua ? qa : ua, small: qa > ua ? ua : qa, who: r[13], base: BigInt(r[14]) });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [pool, evs] of byPool) {
    if (evs.length < 30) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const v = resolveV(evs);
    if (v === null) continue;
    poolsUsed += 1;

    const n = evs.length;
    const ts = new Array<number>(n); const px = new Array<number>(n);
    // Signed quote flow per event: a buy pushes SOL in, a sell pulls SOL out.
    const flow = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      const e = evs[i];
      if (e === undefined) continue;
      ts[i] = e.ts;
      px[i] = e.b > 0n ? Number(e.q + v) / Number(e.b) : NaN;
      flow[i] = (e.buy ? 1 : -1) * Number(e.big) / LAMPORTS;
    }
    const cum = new Array<number>(n + 1); cum[0] = 0;
    for (let i = 0; i < n; i += 1) cum[i + 1] = (cum[i] ?? 0) + (flow[i] ?? 0);

    const sorted = [...px].filter(Number.isFinite).sort((a, b) => a - b);
    const pctOf = (p: number): number => {
      if (!Number.isFinite(p) || sorted.length === 0) return NaN;
      let a = 0; let b = sorted.length - 1; let r = 0;
      while (a <= b) { const m = (a + b) >> 1; const vv = sorted[m]; if (vv === undefined) break; if (vv <= p) { r = m + 1; a = m + 1; } else b = m - 1; }
      return r / sorted.length;
    };

    const lots = new Map<string, { base: number; cost: number }[]>();
    const lastSide = new Map<string, boolean>();
    const lastTs = new Map<string, number>();

    for (let i = 0; i < n; i += 1) {
      const e = evs[i];
      if (e === undefined || e.base <= 0n) continue;
      const p = px[i];
      if (!Number.isFinite(p) || p === undefined || p <= 0) continue;

      let s = acc.get(e.who);
      if (s === undefined) { s = blank(); acc.set(e.who, s); }
      s.trades += 1; s.pools.add(pool);
      const sol = Number(e.big) / LAMPORTS;
      s.solPerTrade.push(sol);
      if (e.q > 0n) s.sizeFrac.push(sol / (Number(e.q) / LAMPORTS));
      feeAll += Number(e.big - e.small) / LAMPORTS;

      const lt = lastTs.get(e.who);
      if (lt !== undefined) s.gapS.push(e.ts - lt);
      lastTs.set(e.who, e.ts);
      const ls = lastSide.get(e.who);
      if (ls !== undefined && ls !== e.buy) s.flips += 1;
      lastSide.set(e.who, e.buy);

      // Drift before and after this trade.
      const bi = atOrBefore(ts, e.ts - DRIFT_S);
      const ai = atOrBefore(ts, e.ts + DRIFT_S);
      const pb = bi >= 0 ? px[bi] : undefined;
      const pa = ai >= 0 ? px[ai] : undefined;
      const pre = pb !== undefined && Number.isFinite(pb) && pb > 0 ? p / pb - 1 : NaN;
      const post = pa !== undefined && Number.isFinite(pa) && pa > 0 ? pa / p - 1 : NaN;

      // Everyone ELSE's net SOL flow in the surrounding window, excluding this trade.
      const lo = bi >= 0 ? bi : 0; const hi = ai >= 0 ? ai : n - 1;
      const others = (cum[hi + 1] ?? 0) - (cum[lo] ?? 0) - (flow[i] ?? 0);

      if (e.buy) {
        s.buys += 1;
        if (Number.isFinite(pre)) s.preBuy.push(pre);
        if (Number.isFinite(post)) s.postBuy.push(post);
        s.pctBuy.push(pctOf(p)); s.othersFlowBuy.push(others);
        const q = lots.get(e.who) ?? []; q.push({ base: Number(e.base), cost: sol }); lots.set(e.who, q);
      } else {
        s.sells += 1;
        if (Number.isFinite(pre)) s.preSell.push(pre);
        if (Number.isFinite(post)) s.postSell.push(post);
        s.pctSell.push(pctOf(p)); s.othersFlowSell.push(others);
        const q = lots.get(e.who) ?? [];
        let rem = Number(e.base);
        const per = (Number(e.small) / LAMPORTS) / Number(e.base);
        while (rem > 0 && q.length > 0) {
          const lot = q[0];
          if (lot === undefined) break;
          const take = Math.min(rem, lot.base);
          const cost = lot.cost * (take / lot.base);
          s.pnl += per * take - cost; netAll += per * take - cost;
          lot.base -= take; lot.cost -= cost; rem -= take;
          if (lot.base <= 0) q.shift();
        }
        lots.set(e.who, q);
      }
    }
  }
  byPool.clear();
  console.log(`  w${w} folded in — ${acc.size.toLocaleString()} wallets`);
}

const med = (a: number[]): number => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const F = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

console.log('');
console.log(`pools ${poolsUsed.toLocaleString()}   wallets ${acc.size.toLocaleString()}`);
console.log('');
console.log('CONSERVATION CHECK — hard gate');
console.log(`  net realised trader PnL  ${netAll.toFixed(1)} SOL`);
console.log(`  fees paid                ${feeAll.toFixed(1)} SOL`);
if (netAll > 0) {
  console.log('  *** POSITIVE. Impossible. Accounting is wrong; nothing below is printed. ***');
  process.exit(2);
}
console.log('  Negative as required.');

const rows = [...acc.entries()].filter(([, s]) => s.trades >= 6).map(([who, s]) => ({ who, s }));
rows.sort((a, b) => b.s.pnl - a.s.pnl);
console.log('');
console.log(`wallets with >=6 trades: ${rows.length.toLocaleString()}`);
console.log('');
console.log('MECHANISM TABLE — the four hypotheses make different signs, so read the signs');
console.log('  cohort          n    medPnL   preBuy%  preSell%  postBuy% postSell%  flip%  pctBuy pctSell  othersBuy  medGap  medSOL');
const band = (label: string, rs: typeof rows): void => {
  if (rs.length === 0) return;
  const ss = rs.map((r) => r.s);
  console.log(
    `  ${label.padEnd(12)} ${String(rs.length).padStart(6)}  ${F(med(rs.map((r) => r.s.pnl)), 3).padStart(8)}  ` +
    `${F(100 * med(ss.flatMap((s) => s.preBuy))).padStart(7)}  ${F(100 * med(ss.flatMap((s) => s.preSell))).padStart(8)}  ` +
    `${F(100 * med(ss.flatMap((s) => s.postBuy))).padStart(8)}  ${F(100 * med(ss.flatMap((s) => s.postSell))).padStart(9)}  ` +
    `${F(100 * med(ss.map((s) => (s.trades > 1 ? s.flips / (s.trades - 1) : NaN))), 0).padStart(5)}  ` +
    `${F(med(ss.flatMap((s) => s.pctBuy))).padStart(6)}  ${F(med(ss.flatMap((s) => s.pctSell))).padStart(6)}  ` +
    `${F(med(ss.flatMap((s) => s.othersFlowBuy))).padStart(9)}  ${F(med(ss.flatMap((s) => s.gapS)), 0).padStart(6)}s  ${F(med(ss.flatMap((s) => s.solPerTrade)), 3).padStart(7)}`,
  );
};
band('top 10', rows.slice(0, 10));
band('top 100', rows.slice(0, 100));
band('top 1%', rows.slice(0, Math.max(1, Math.floor(rows.length * 0.01))));
band('top 10%', rows.slice(0, Math.max(1, Math.floor(rows.length * 0.10))));
band('middle 50%', rows.slice(Math.floor(rows.length * 0.25), Math.floor(rows.length * 0.75)));
band('bottom 10%', rows.slice(Math.floor(rows.length * 0.90)));
console.log('');
console.log('  preBuy%   price change in the 60s BEFORE their buy. NEGATIVE = they buy dips.');
console.log('  preSell%  price change in the 60s BEFORE their sell. POSITIVE = they sell rips.');
console.log('  postBuy%  price change in the 60s AFTER their buy. POSITIVE = the move went their way.');
console.log('  flip%     share of trades that reverse the previous side. HIGH = market making.');
console.log('  pctBuy    where their buy price sits in the pool\'s own price distribution, 0 low 1 high.');
console.log('  othersBuy everyone ELSE\'s net SOL flow around their buy. NEGATIVE = they absorb selling.');
console.log('');
console.log('  MARKET MAKING  => preBuy<0, preSell>0, flip% high, othersBuy<0');
console.log('  MOMENTUM       => preBuy>0');
console.log('  ACCUM/DISTRIB  => flip% low, pctBuy low, pctSell high');
console.log('  FORESIGHT      => postBuy>0 and postSell<0 whatever else is true');
console.log('');
console.log('EXPLORATORY. Decides nothing.');
