/**
 * ONE expensive pass over the tape, writing a compact per-pool panel that every later test slices
 * for free.
 *
 * WHY THIS EXISTS. MT147 through MT152 each re-read seven gigabytes of decoded trades to answer a
 * single question, so every iteration costs an hour and every new cut costs another one. The tape
 * is the expensive part; the statistics are not. This collapses each pool to one row carrying
 * everything the last six tests needed plus the fields they could not afford to ask for, and
 * writes it as JSONL. Slicing it afterwards is milliseconds.
 *
 * THE FIELD THIS IS REALLY FOR IS THE FEE. MT127-DEFECT measured the venue's charge at p05 30.0,
 * median 115.0, p95 125.0 basis points PER LEG. That is a 170 bps round-trip spread across pools,
 * it is observable before a trade is placed, and it is larger than any alpha this programme has
 * measured in 152 rows. No test has ever selected on it — every one of them either clamped the fee
 * at 25 bps or subtracted a flat constant, so the axis was invisible. A cost lever is not an edge,
 * but it moves the same bottom line and it cannot be arbitraged away by someone faster.
 *
 * ACCOUNTING RULES, CARRIED FROM MT152 UNCHANGED. Each leg is priced through the constant product
 * with the pool's OWN unclamped charged fee. The exit sells into what our own entry left behind. A
 * pool that stopped trading before the horizon is MARKED at its last observable reserve state
 * rather than dropped, because dropping it is silent and it is upward. A pool whose horizon runs
 * past the end of its chunk is excluded and counted.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const OUT_DIR = 'data/panel';
const SYSTEM_ADDRESS = '11111111111111111111111111111111';
const LAMPORTS = 1e9;
const JUDGE_AT_TRADE = 25;
/** Several horizons, because fee is paid ONCE per round trip and its drag falls as the hold grows. */
const HORIZONS_S = [300, 900, 1800, 3600];
const NOTIONALS = [5_000_000n, 20_000_000n, 100_000_000n];
/** MT136, realised live: the NON-AMM drag only. The AMM fee is priced per leg. */
const NONAMM_BPS = 23;
const V_CANDIDATES = [0n, 17_584_500_000n];

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? 'b0,b1,b2,b3,b4,b5,b6,b7').split(',').filter((s) => s.length > 0);
const TAG = arg('tag') ?? 'b';

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const creatorOf = new Map<string, string>();
for (const r of db.prepare(
  `SELECT pool, coin_creator FROM venue_pools WHERE coin_creator NOT IN ('', ?)`).all(SYSTEM_ADDRESS) as { pool: string; coin_creator: string }[]) {
  creatorOf.set(r.pool, r.coin_creator);
}
db.close();

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; qa: bigint; ua: bigint; who: string }

function poolFeeBps(evs: Ev[]): number | null {
  const s: number[] = [];
  for (const e of evs) {
    if (e.qa <= 0n || e.ua <= 0n) continue;
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

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const out = createWriteStream(`${OUT_DIR}/panel-${TAG}.jsonl`);
let written = 0; let truncated = 0; let unpriceable = 0;

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  (missing ${w})`); continue; }
  const byPool = new Map<string, Ev[]>();
  let lastTs = 0;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (!creatorOf.has(r[0])) continue;
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
             b: BigInt(r[6]), q: BigInt(r[7]), qa: BigInt(r[8]), ua: BigInt(r[9]), who: typeof r[13] === 'string' ? r[13] : '' });
    byPool.set(r[0], a);
    if (r[2] > lastTs) lastTs = r[2];
  }
  rl.close();

  for (const [pool, evs] of byPool) {
    const creator = creatorOf.get(pool);
    if (creator === undefined || evs.length < JUDGE_AT_TRADE) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const first = evs[0];
    const judge = evs[JUDGE_AT_TRADE - 1];
    if (first === undefined || judge === undefined || judge.b <= 0n || judge.q <= 0n) continue;
    const fee = poolFeeBps(evs);
    const v = resolveV(evs);
    if (fee === null || v === null) continue;

    /** Pre-judge features, computed STRICTLY from trades at or before the judging moment. */
    const pre = evs.slice(0, JUDGE_AT_TRADE);
    const buyers = new Set<string>();
    let buySol = 0; let sellSol = 0; let buyCount = 0;
    for (const e of pre) {
      const big = e.qa > e.ua ? e.qa : e.ua;
      const sol = Number(big) / LAMPORTS;
      if (e.buy) { buySol += sol; buyCount += 1; if (e.who) buyers.add(e.who); } else sellSol += sol;
    }
    const p0 = Number(first.q + v) / Number(first.b);
    const pJ = Number(judge.q + v) / Number(judge.b);

    const ladder: PoolFeeLadder = {
      lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n,
      chargedFeeBasisPoints: BigInt(Math.round(fee)),
    };

    /** ret[horizon][notional] and whether the pool was still trading at that horizon. */
    const ret: Record<string, Record<string, number>> = {};
    const alive: Record<string, number> = {};
    for (const H of HORIZONS_S) {
      if (judge.ts + H > lastTs) { truncated += 1; continue; }
      let exit: Ev | null = null;
      for (let i = JUDGE_AT_TRADE; i < evs.length; i += 1) {
        const e = evs[i];
        if (e !== undefined && e.ts >= judge.ts + H && e.b > 0n && e.q > 0n) { exit = e; break; }
      }
      alive[String(H)] = exit !== null ? 1 : 0;
      if (exit === null) for (let i = evs.length - 1; i >= JUDGE_AT_TRADE; i -= 1) { const e = evs[i]; if (e !== undefined && e.b > 0n && e.q > 0n) { exit = e; break; } }
      if (exit === null) continue;
      const cell: Record<string, number> = {};
      for (const N of NOTIONALS) {
        try {
          const bf = priceBuy({ base: judge.b, quote: judge.q, virtualQuote: v }, N, ladder);
          const sf = priceSell(
            { base: exit.b - bf.baseOut, quote: exit.q + (bf.reservesAfter.quote - judge.q), virtualQuote: v },
            bf.baseOut, ladder,
          );
          cell[N.toString()] = 1e4 * Number(sf.quoteOut - N) / Number(N) - NONAMM_BPS;
        } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; unpriceable += 1; }
      }
      if (Object.keys(cell).length > 0) ret[String(H)] = cell;
    }
    if (Object.keys(ret).length === 0) continue;

    out.write(JSON.stringify({
      pool, creator, firstTs: first.ts, judgeTs: judge.ts, trades: evs.length,
      feeBps: Number(fee.toFixed(1)),
      v: v === 0n ? 0 : 1,
      ageS: judge.ts - first.ts,
      buyers: buyers.size,
      buySol: Number(buySol.toFixed(3)),
      netFlowSol: Number((buySol - sellSol).toFixed(3)),
      buyShare: Number((buyCount / JUDGE_AT_TRADE).toFixed(3)),
      depthSol: Number((Number(judge.q + v) / LAMPORTS).toFixed(3)),
      runupBps: Number.isFinite(pJ / p0) ? Math.round(1e4 * (pJ / p0 - 1)) : null,
      alive, ret,
    }) + '\n');
    written += 1;
  }
  byPool.clear();
  console.log(`  w${w} — ${written.toLocaleString()} panel rows`);
}
out.end();
console.log('');
console.log(`panel-${TAG}.jsonl — ${written.toLocaleString()} pools`);
console.log(`  horizon past end of chunk (that horizon skipped): ${truncated.toLocaleString()}`);
console.log(`  unpriceable fills: ${unpriceable.toLocaleString()}`);
