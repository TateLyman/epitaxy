/**
 * MT152 — is the POSITIVE MEAN real, once the round trip is priced through the actual curve?
 *
 * MT151 replicated a filter and reported medians. But a bankroll that buys every candidate at
 * equal size collects the MEAN, and the block B means were strongly positive: +3,102 bps at one
 * prior launch, +1,550 at two-to-four, +50 at five-to-nine. Weighted across the surviving buckets
 * that is +314 bps. Every negative this programme has reported was a median or a winsorised mean.
 * Neither is what a bankroll collects.
 *
 * TWO DEFECTS IN MT149 MAKE THAT +314 UNREADABLE, AND BOTH ARE FIXED HERE.
 *
 *   COST. MT149 subtracts a flat COST_BPS = 23, inherited from MT136's live round trip, from a
 *   return computed as a ratio of RESERVES — which is the MID price and charges no AMM fee on
 *   either leg. MT127-DEFECT measured the venue's real charge at a median of 115 bps PER LEG and
 *   found a 25 bps clamp binding on 100% of pools. The same mistake is live again for the same
 *   reason: a negative result never exercises a cost model, so nobody looked. Here every leg is
 *   priced through the constant product with the POOL'S OWN charge, read off its own trades as
 *   (ua-qa)/qa on a buy and (qa-ua)/qa on a sell, unclamped. MT136's 23 bps is then added on top
 *   as the non-AMM drag (network, priority, routing) it actually measured.
 *
 *   SURVIVORSHIP. MT149 scores a pool only if a trade exists at or after judge + 1800s. A pool
 *   that died inside the window is dropped — and those are the ones that went to zero. The drop
 *   is silent and it is upward. An AMM always permits a sell, so a position held to a pool that
 *   stopped trading is marked HERE at the last observable reserve state, priced through the curve
 *   like any other exit. Pools whose horizon runs past the end of their chunk are excluded and
 *   COUNTED, because there the absence is ours, not the pool's.
 *
 * Size is real too: the entry moves the pool it enters, and the exit sells into what the entry
 * left behind. Both are priced, and the notional is swept.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const SYSTEM_ADDRESS = '11111111111111111111111111111111';
const JUDGE_AT_TRADE = 25;
const HORIZON_S = 1800;
/** MT136, realised live: the NON-AMM drag only. The AMM fee is priced per leg below. */
const NONAMM_BPS = 23;
const V_CANDIDATES = [0n, 17_584_500_000n];

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? 'b0,b1,b2,b3,b4,b5,b6,b7').split(',').filter((s) => s.length > 0);
const BURNIN_H = Number(arg('burnin-hours') ?? '24');
const NOTIONALS = (arg('notionals') ?? '20000000').split(',').map((s) => BigInt(s));
const TAG = arg('tag') ?? 'block';
/**
 * GROSS MODE. Forces the fee ladder to zero on both legs and drops the non-AMM drag, so the number
 * reported is the raw move the strategy captures before ANY cost. It answers the only question a
 * cost reduction can depend on: whether there is anything here to reduce the cost OF. If gross is
 * flat or negative, no fee tier, cashback, venue or rebate rescues this entry rule, because a
 * discount on a toll cannot manufacture a move that is not there.
 */
const GROSS = arg('gross') === '1';

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const creatorOf = new Map<string, string>();
for (const r of db.prepare(
  `SELECT pool, coin_creator FROM venue_pools WHERE coin_creator NOT IN ('', ?)`).all(SYSTEM_ADDRESS) as { pool: string; coin_creator: string }[]) {
  creatorOf.set(r.pool, r.coin_creator);
}
db.close();

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; qa: bigint; ua: bigint }
interface Row { pool: string; creator: string; firstTs: number; trades: number; feeBps: number; alive: boolean; ret: Map<string, number> }

/** The pool's own charged fee, per leg, unclamped. Median over its own trades. */
function poolFeeBps(evs: Ev[]): number | null {
  const s: number[] = [];
  for (const e of evs) {
    if (e.qa <= 0n || e.ua <= 0n) continue;
    // buy: user pays ua, pool keeps qa -> f = (ua-qa)/qa. sell: pool gives qa, user gets ua -> f = (qa-ua)/qa.
    const f = e.buy ? 1e4 * Number(e.ua - e.qa) / Number(e.qa) : 1e4 * Number(e.qa - e.ua) / Number(e.qa);
    if (Number.isFinite(f) && f >= 0 && f < 2000) s.push(f);
  }
  if (s.length < 5) return null;
  s.sort((a, b) => a - b);
  return s[Math.floor(0.5 * (s.length - 1))] ?? null;
}

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

const rows: Row[] = [];
let excludedTruncated = 0;
let unpriceable = 0;

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  (missing ${w})`); continue; }
  const byPool = new Map<string, Ev[]>();
  let lastTs = 0;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, ...unknown[]];
    try { r = JSON.parse(line); } catch { continue; }
    if (!creatorOf.has(r[0])) continue;
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
             b: BigInt(r[6]), q: BigInt(r[7]), qa: BigInt(r[8]), ua: BigInt(r[9]) });
    byPool.set(r[0], a);
    if (r[2] > lastTs) lastTs = r[2];
  }
  rl.close();

  for (const [pool, evs] of byPool) {
    const creator = creatorOf.get(pool);
    if (creator === undefined) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const first = evs[0];
    if (first === undefined) continue;
    const row: Row = { pool, creator, firstTs: first.ts, trades: evs.length, feeBps: NaN, alive: false, ret: new Map() };

    if (evs.length >= JUDGE_AT_TRADE) {
      const judge = evs[JUDGE_AT_TRADE - 1];
      const fee = poolFeeBps(evs);
      const v = resolveV(evs);
      if (judge !== undefined && fee !== null && v !== null && judge.b > 0n && judge.q > 0n) {
        row.feeBps = fee;
        /**
         * THE HORIZON MUST FIT INSIDE THE CHUNK. If it does not, the pool is excluded and counted
         * rather than marked at the last event, because there the missing data is an artifact of
         * where we cut the tape, not a fact about the pool.
         */
        if (judge.ts + HORIZON_S > lastTs) { excludedTruncated += 1; }
        else {
          /** Exit event: first trade at or after the horizon, else the LAST one we saw (pool died). */
          let exit: Ev | null = null;
          for (let i = JUDGE_AT_TRADE; i < evs.length; i += 1) {
            const e = evs[i];
            if (e !== undefined && e.ts >= judge.ts + HORIZON_S && e.b > 0n && e.q > 0n) { exit = e; break; }
          }
          if (exit !== null) row.alive = true;
          else for (let i = evs.length - 1; i >= JUDGE_AT_TRADE; i -= 1) { const e = evs[i]; if (e !== undefined && e.b > 0n && e.q > 0n) { exit = e; break; } }

          if (exit !== null) {
            const ladder: PoolFeeLadder = {
              lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n,
              chargedFeeBasisPoints: GROSS ? 0n : BigInt(Math.round(fee)),
            };
            for (const N of NOTIONALS) {
              try {
                const bf = priceBuy({ base: judge.b, quote: judge.q, virtualQuote: v }, N, ladder);
                /** Sell into what our own entry left behind: carry our footprint forward to the exit state. */
                const sf = priceSell(
                  { base: exit.b - bf.baseOut, quote: exit.q + (bf.reservesAfter.quote - judge.q), virtualQuote: v },
                  bf.baseOut, ladder,
                );
                row.ret.set(N.toString(), 1e4 * Number(sf.quoteOut - N) / Number(N) - (GROSS ? 0 : NONAMM_BPS));
              } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; unpriceable += 1; }
            }
          }
        }
      }
    }
    rows.push(row);
  }
  byPool.clear();
  console.log(`  w${w} — ${rows.length.toLocaleString()} pools so far`);
}

/** Causal prior-launch count, then burn-in. Identical construction to MT149/MT151. */
rows.sort((a, b) => a.firstTs - b.firstTs);
const seen = new Map<string, number>();
const priorOf = new Map<string, number>();
for (const p of rows) { priorOf.set(p.pool, seen.get(p.creator) ?? 0); seen.set(p.creator, (seen.get(p.creator) ?? 0) + 1); }
const blockStart = rows.length > 0 ? (rows[0] as Row).firstTs : 0;
const judged = BURNIN_H > 0 ? rows.filter((p) => p.firstTs >= blockStart + BURNIN_H * 3600) : rows;

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const trimmed = (x: number[], p: number): number => {
  const s = [...x].sort((a, b) => a - b); const k = Math.floor(s.length * p);
  return mean(s.slice(k, s.length - k));
};
/** Share of the raw mean contributed by the largest 1% of outcomes. MT127's lottery test. */
const topShare = (x: number[]): number => {
  if (x.length < 100) return NaN;
  const s = [...x].sort((a, b) => b - a); const k = Math.max(1, Math.floor(s.length * 0.01));
  return s.slice(0, k).reduce((a, b) => a + b, 0) / s.reduce((a, b) => a + b, 0);
};
/** Day-clustered bootstrap on the MEAN. Clusters are calendar days of pool birth. */
function boot(items: { day: number; v: number }[]): [number, number] {
  const byDay = new Map<number, number[]>();
  for (const it of items) { const a = byDay.get(it.day) ?? []; a.push(it.v); byDay.set(it.day, a); }
  const days = [...byDay.values()];
  if (days.length < 2) return [NaN, NaN];
  let seed = 20260822;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ms: number[] = [];
  for (let r = 0; r < 2000; r += 1) {
    const pick: number[] = [];
    for (let i = 0; i < days.length; i += 1) { const d = days[Math.floor(rnd() * days.length)]; if (d) pick.push(...d); }
    if (pick.length) ms.push(mean(pick));
  }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(0.025 * ms.length)] ?? NaN, ms[Math.floor(0.975 * ms.length)] ?? NaN];
}

console.log('');
console.log(`MT152 [${TAG}]${GROSS ? ' *** GROSS: zero fee, zero drag ***' : ''} — the mean, priced through the real curve`);
console.log(`  ${judged.length.toLocaleString()} pools scored of ${rows.length.toLocaleString()} (burn-in ${BURNIN_H}h)`);
console.log(`  horizon ran past the end of its chunk, EXCLUDED: ${excludedTruncated.toLocaleString()}`);
console.log(`  unpriceable fills: ${unpriceable.toLocaleString()}`);
const feeAll = judged.map((r) => r.feeBps).filter(Number.isFinite).sort((a, b) => a - b);
if (feeAll.length) {
  const pc = (p: number): string => (feeAll[Math.floor(p * (feeAll.length - 1))] ?? NaN).toFixed(1);
  console.log(`  POOL OWN CHARGED FEE per leg, bps: p05 ${pc(0.05)}  p25 ${pc(0.25)}  MEDIAN ${pc(0.5)}  p75 ${pc(0.75)}  p95 ${pc(0.95)}`);
  console.log(`  (MT149 credited a FLAT 23 bps for the whole ROUND TRIP, on a mid-price return)`);
}

const buckets: [string, (n: number) => boolean][] = [
  ['0 (first ever)', (n) => n === 0],
  ['1', (n) => n === 1],
  ['2-4', (n) => n >= 2 && n <= 4],
  ['5-9', (n) => n >= 5 && n <= 9],
  ['10+', (n) => n >= 10],
];

for (const N of NOTIONALS) {
  const key = N.toString();
  const scored = judged.filter((r) => r.ret.has(key));
  if (scored.length === 0) continue;
  console.log('');
  console.log(`NOTIONAL ${(Number(N) / 1e9).toFixed(3)} SOL — ${scored.length.toLocaleString()} priced round trips`);
  const aliveN = scored.filter((r) => r.alive).length;
  console.log(`  still trading at +${HORIZON_S}s: ${aliveN.toLocaleString()} (${(100 * aliveN / scored.length).toFixed(1)}%) — the rest are marked at their LAST observable state, not dropped`);
  console.log('');
  console.log('  prior launches      n       MEAN    [95% day-clustered CI]     median   trim10%    %pos   top1% share of mean');
  const emit = (label: string, g: Row[]): void => {
    const v = g.map((r) => r.ret.get(key) as number);
    if (v.length === 0) return;
    const [lo, hi] = boot(g.map((r) => ({ day: Math.floor(r.firstTs / 86400), v: r.ret.get(key) as number })));
    console.log(
      `  ${label.padEnd(16)} ${String(v.length).padStart(6)} ${mean(v).toFixed(0).padStart(9)}  [${lo.toFixed(0).padStart(8)},${hi.toFixed(0).padStart(8)}]  ` +
      `${med(v).toFixed(0).padStart(8)} ${trimmed(v, 0.1).toFixed(0).padStart(9)} ${(100 * v.filter((x) => x > 0).length / v.length).toFixed(1).padStart(7)}% ` +
      `${(100 * topShare(v)).toFixed(0).padStart(9)}%`,
    );
  };
  for (const [label, f] of buckets) emit(label, scored.filter((r) => f(priorOf.get(r.pool) ?? 0)));
  console.log('  ' + '-'.repeat(100));
  emit('ALL', scored);
  emit('MT151 FILTER', scored.filter((r) => (priorOf.get(r.pool) ?? 0) !== 0));
}

console.log('');
console.log('  A mean whose 95% CI straddles zero is not an edge, however large it is.');
console.log('  A mean living in its top 1% is a lottery ticket, and MT127 already closed one of those.');
