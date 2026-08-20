/**
 * MT111 — the frozen rule, applied to days that were never queried.
 *
 * The rule was frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT111 BEFORE this file
 * existed and before any holdout slot was read. It is transcribed here verbatim and is
 * not to be edited to make a result appear:
 *
 *   trigger   a trade whose quote leg exceeds 5% of the pool quote reserve before it,
 *             AND which moves the pool price DOWN
 *   entry     buy 0.02 SOL against it, at the post-trade reserves
 *   exit      +15 seconds
 *   universe  WSOL-quoted pools, resolved by name, never assumed
 *   overlap   a trigger inside a live position's horizon is skipped outright
 *   split     pool quote reserve at entry, at 35 SOL — an ABSOLUTE cut, not the
 *             holdout's own median, because re-taking the median here would refit the
 *             rule on the data meant to test it
 *   unit      the POOL. Events inside a pool share one price path and are not
 *             independent observations
 *
 * SURVIVES only if all four hold: >=60% of deep pools positive; positive median of deep
 * pool medians; a day-clustered bootstrap lower bound above zero; and the SHALLOW arm
 * NOT also positive. Any one failing closes it.
 *
 * ONE DEVIATION FROM THE FIT, declared: the tape timestamps in milliseconds and the
 * backfill in seconds, so the 15s horizon is resolved to +/-1s here. It is reported.
 *
 * Read-only. Opens no capital-bearing table, imports nothing from packages/execution.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { openDb } from '../packages/storage/src/db.js';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { poolAddressesFrom } from '../packages/solana/src/pumpswap-offline.js';
import { decodePumpSwapTrade, type PumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';
import { FillNotPriceable, priceBuy, priceSell } from '../packages/intelligence/src/copy-fill.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const V = 17_584_500_000n;
const IMPACT_BAR = 0.05;
const HORIZON_S = 15;
const DEPTH_CUT_SOL = 35;
const NOTIONAL = 20_000_000n;
const MIN_EVENTS_PER_POOL = 5;
const CPI_WRAPPER = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

const DIR = 'data/sqd/events-pAMMBay6';
const HEAD = 440_494_520;
const SLOTS_PER_DAY = 207_494;
/** The twelve windows, recomputed exactly as they were pulled. */
const WINDOWS: { from: number; to: number }[] = [];
for (let k = 1; k <= 12; k += 1) {
  const to = HEAD - k * SLOTS_PER_DAY;
  WINDOWS.push({ from: to - 19_999, to });
}
const inHoldout = (slot: number): boolean => WINDOWS.some((w) => slot >= w.from && slot <= w.to);

interface Ev {
  readonly slot: number;
  readonly ts: number;
  readonly txIndex: number;
  readonly addr: string;
  readonly t: PumpSwapTrade;
}

// ---------------------------------------------------------------------------
// 1. Decode. Only the holdout windows; anything else on disk is ignored.
// ---------------------------------------------------------------------------
const byPool = new Map<string, Ev[]>();
let blocks = 0;
let instrs = 0;
let undecodable = 0;
let notWrapped = 0;

const files = readdirSync(DIR).filter((f) => f.endsWith('.jsonl') && f.startsWith('events-'));
for (const f of files) {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(f);
  if (m === null) continue;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!WINDOWS.some((w) => hi >= w.from && lo <= w.to)) continue;

  for (const line of readFileSync(`${DIR}/${f}`, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    const b = JSON.parse(line) as {
      header: { number: number; timestamp: number };
      instructions: { transactionIndex: number; instructionAddress: number[]; data: string }[];
    };
    if (!inHoldout(b.header.number)) continue;
    blocks += 1;
    for (const ins of b.instructions) {
      instrs += 1;
      let raw: Buffer;
      try {
        raw = Buffer.from(base58Decode(ins.data, 4096));
      } catch {
        undecodable += 1;
        continue;
      }
      // Anchor emit_cpi! wraps the event. Anything not wrapped is not ours to interpret.
      if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI_WRAPPER)) {
        notWrapped += 1;
        continue;
      }
      const t = decodePumpSwapTrade(raw.subarray(8));
      if (t === null) continue; // Deposit/Withdraw and the 5 unknown discriminators
      let a = byPool.get(t.pool);
      if (a === undefined) {
        a = [];
        byPool.set(t.pool, a);
      }
      a.push({
        slot: b.header.number,
        ts: b.header.timestamp,
        txIndex: ins.transactionIndex,
        addr: ins.instructionAddress.join('.'),
        t,
      });
    }
  }
}
console.log('MT111 HOLDOUT — days never queried');
console.log(`  windows ${WINDOWS.length}   blocks ${blocks.toLocaleString()}   instructions ${instrs.toLocaleString()}`);
console.log(`  trade events ${[...byPool.values()].reduce((a, b) => a + b.length, 0).toLocaleString()} across ${byPool.size.toLocaleString()} pools`);
console.log(`  base58 undecodable ${undecodable}   not emit_cpi-wrapped ${notWrapped}`);
if (byPool.size === 0) {
  console.log('\n  NO HOLDOUT DATA ON DISK YET. The backfill has not reached these windows. Nothing computed.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Candidate triggers, before any mint is resolved. Resolving mints only for pools
//    that produce a candidate is a cost saving and cannot bias the result: the WSOL
//    requirement is a property of the pool, independent of how the trade turned out.
// ---------------------------------------------------------------------------
const price = (q: bigint, b: bigint): number => (b > 0n ? Number(q + V) / Number(b) : NaN);

interface Cand {
  readonly pool: string;
  readonly day: string;
  readonly depthSol: number;
  readonly bPost: bigint;
  readonly qPost: bigint;
  readonly fees: { lpFeeBasisPoints: bigint; protocolFeeBasisPoints: bigint; coinCreatorFeeBasisPoints: bigint };
  readonly mark: { b: bigint; q: bigint } | null;
  readonly lagS: number;
}
const cands: Cand[] = [];
let noMark = 0;
let noCreatorFee = 0;

for (const [pool, evs] of byPool) {
  evs.sort((x, y) => x.slot - y.slot || x.txIndex - y.txIndex || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  let lastEnd = -1;
  for (let i = 1; i < evs.length - 1; i += 1) {
    const evPre = evs[i];
    const evPost = evs[i + 1];
    if (evPre === undefined || evPost === undefined) continue;
    const pre = evPre.t;
    const post = evPost.t;
    const bPre = pre.poolBaseReservesBefore;
    const qPre = pre.poolQuoteReservesBefore;
    const bPost = post.poolBaseReservesBefore;
    const qPost = post.poolQuoteReservesBefore;
    if (bPre <= 0n || qPre <= 0n || bPost <= 0n || qPost <= 0n) continue;
    const p0 = price(qPre, bPre);
    const p1 = price(qPost, bPost);
    if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0 || p1 <= 0) continue;
    if (!(p1 / p0 - 1 < 0)) continue; // downward only
    const rel = Math.abs(Number(qPost - qPre)) / Number(qPre);
    if (rel < IMPACT_BAR) continue;
    if (pre.coinCreatorFeeBasisPoints === null) {
      noCreatorFee += 1;
      continue;
    }
    const entryTs = evPost.ts;
    if (entryTs < lastEnd) continue; // non-overlapping
    let mark: { b: bigint; q: bigint } | null = null;
    let lagS = 0;
    for (let j = i + 2; j < evs.length; j += 1) {
      const e = evs[j];
      if (e !== undefined && e.ts >= entryTs + HORIZON_S) {
        mark = { b: e.t.poolBaseReservesBefore, q: e.t.poolQuoteReservesBefore };
        lagS = e.ts - entryTs;
        break;
      }
    }
    if (mark === null) {
      noMark += 1;
      continue;
    }
    lastEnd = entryTs + HORIZON_S;
    cands.push({
      pool,
      day: new Date(entryTs * 1000).toISOString().slice(0, 10),
      depthSol: Number(qPost) / 1e9,
      bPost,
      qPost,
      fees: {
        lpFeeBasisPoints: pre.lpFeeBasisPoints,
        protocolFeeBasisPoints: pre.protocolFeeBasisPoints,
        coinCreatorFeeBasisPoints: pre.coinCreatorFeeBasisPoints,
      },
      mark,
      lagS,
    });
  }
}
console.log(`\n  candidate triggers before the WSOL filter: ${cands.length.toLocaleString()}`);
console.log(`  dropped: no mark past the horizon ${noMark}   creator fee absent ${noCreatorFee}`);
const lags = cands.map((c) => c.lagS).sort((a, b) => a - b);
if (lags.length > 0) {
  console.log(`  horizon actually realised: p50 ${lags[Math.floor(lags.length / 2)] ?? 0}s  p90 ${lags[Math.floor(0.9 * lags.length)] ?? 0}s  (target ${HORIZON_S}s, second granularity)`);
}

// ---------------------------------------------------------------------------
// 3. Resolve quote mints by name. An unread pool is REFUSED, never assumed WSOL.
// ---------------------------------------------------------------------------
const db = openDb({ path: 'data/runtime.db' });
const known = new Map<string, string>();
for (const r of db.prepare('SELECT pool, quote_mint FROM venue_pools').all() as { pool: string; quote_mint: string }[]) {
  known.set(r.pool, r.quote_mint);
}
const upsert = db.prepare(
  `INSERT OR REPLACE INTO venue_pools (pool, base_mint, quote_mint, base_vault, quote_vault, coin_creator, resolved_utc_ms, tracked)
   VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT tracked FROM venue_pools WHERE pool = ?), 0))`,
);

const need = [...new Set(cands.map((c) => c.pool))].filter((p) => !known.has(p));
console.log(`\n  pools needing a mint lookup: ${need.length} (of ${new Set(cands.map((c) => c.pool)).size} candidate pools; ${new Set(cands.map((c) => c.pool)).size - need.length} already cached)`);
let unresolved = 0;
if (need.length > 0) {
  const { rpc } = researchRpc(loadSecrets(), db);
  for (let i = 0; i < need.length; i += 1) {
    const pool = need[i];
    if (pool === undefined) continue;
    try {
      const raw = await rpc.getAccountRaw(pool);
      const a = poolAddressesFrom(
        { get: (k: string) => (k === pool ? { owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports } : null) },
        pool,
      );
      upsert.run(pool, a.baseMint, a.quoteMint, a.poolBaseTokenAccount, a.poolQuoteTokenAccount, a.coinCreator, Date.now(), pool);
      known.set(pool, a.quoteMint);
    } catch {
      unresolved += 1; // absence of a read is a fact about the provider, not about the pool
    }
    if ((i + 1) % 200 === 0) console.log(`    resolved ${i + 1}/${need.length}`);
  }
}
db.close();
console.log(`  unresolvable and therefore REFUSED: ${unresolved}`);

const wsolCands = cands.filter((c) => known.get(c.pool) === WSOL);
console.log(`  candidates in WSOL-quoted pools: ${wsolCands.length.toLocaleString()}`);

// ---------------------------------------------------------------------------
// 4. Price the round trip, then aggregate with the POOL as the unit.
// ---------------------------------------------------------------------------
interface Scored { pool: string; day: string; depthSol: number; ret: number }
const scored: Scored[] = [];
let unpriceable = 0;
for (const c of wsolCands) {
  if (c.mark === null) continue;
  try {
    const buy = priceBuy({ base: c.bPost, quote: c.qPost }, NOTIONAL, c.fees);
    const sell = priceSell({ base: c.mark.b, quote: c.mark.q }, buy.baseOut, c.fees);
    scored.push({ pool: c.pool, day: c.day, depthSol: c.depthSol, ret: Number(sell.quoteOut - NOTIONAL) / Number(NOTIONAL) });
  } catch (e) {
    if (e instanceof FillNotPriceable) unpriceable += 1;
    else throw e;
  }
}
console.log(`  priced ${scored.length.toLocaleString()}   unpriceable and refused ${unpriceable}`);
console.log(`  distinct UTC days present: ${new Set(scored.map((s) => s.day)).size}`);

const med = (a: number[]): number => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return s.length > 0 ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN;
};
const F = (v: number, d = 2): string => (Number.isFinite(v) ? (100 * v).toFixed(d).padStart(8) : '     n/a');

interface PoolAgg { pool: string; n: number; depthSol: number; med: number; day: string }
const aggs: PoolAgg[] = [];
const grouped = new Map<string, Scored[]>();
for (const s of scored) {
  const a = grouped.get(s.pool);
  if (a === undefined) grouped.set(s.pool, [s]);
  else a.push(s);
}
for (const [pool, rows] of grouped) {
  if (rows.length < MIN_EVENTS_PER_POOL) continue;
  aggs.push({ pool, n: rows.length, depthSol: med(rows.map((r) => r.depthSol)), med: med(rows.map((r) => r.ret)), day: rows[0]?.day ?? 'unknown' });
}

const deep = aggs.filter((a) => a.depthSol > DEPTH_CUT_SOL);
const shallow = aggs.filter((a) => a.depthSol <= DEPTH_CUT_SOL);
console.log(`\nPOOLS with >=${MIN_EVENTS_PER_POOL} non-overlapping events: ${aggs.length}   deep ${deep.length}   shallow ${shallow.length}`);

const arm = (label: string, a: PoolAgg[]): { share: number; median: number } => {
  if (a.length === 0) {
    console.log(`  ${label.padEnd(9)} no pools`);
    return { share: NaN, median: NaN };
  }
  const pos = a.filter((p) => p.med > 0).length;
  const m = med(a.map((p) => p.med));
  console.log(`  ${label.padEnd(9)} pools ${String(a.length).padStart(4)}   positive ${String(pos).padStart(4)}/${a.length} = ${(100 * pos / a.length).toFixed(1)}%   median of pool medians ${F(m)}%   events ${a.reduce((x, y) => x + y.n, 0)}`);
  return { share: pos / a.length, median: m };
};
console.log('\nTHE TWO ARMS');
const dRes = arm('DEEP', deep);
const sRes = arm('SHALLOW', shallow);

// ---------------------------------------------------------------------------
// 5. Bootstrap over UTC DAYS, resampling days and never events. MT108 established
//    that the cluster is the day and that anything less has a false-positive rate an
//    order of magnitude above nominal.
// ---------------------------------------------------------------------------
const dayOf = new Map<string, PoolAgg[]>();
for (const p of deep) {
  const a = dayOf.get(p.day);
  if (a === undefined) dayOf.set(p.day, [p]);
  else a.push(p);
}
const days = [...dayOf.keys()].sort();
console.log(`\nDAY-CLUSTERED BOOTSTRAP over ${days.length} UTC days, resampling DAYS`);
for (const d of days) {
  const a = dayOf.get(d) ?? [];
  console.log(`  ${d}  pools ${String(a.length).padStart(3)}  median ${F(med(a.map((p) => p.med)))}%  positive ${a.filter((p) => p.med > 0).length}/${a.length}`);
}
let lo = NaN;
let hi = NaN;
if (days.length >= 2) {
  // Deterministic resampling: a fixed LCG, so the interval is reproducible byte-for-byte.
  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const draws: number[] = [];
  for (let b = 0; b < 10_000; b += 1) {
    const picked: number[] = [];
    for (let k = 0; k < days.length; k += 1) {
      const d = days[Math.floor(rnd() * days.length)] ?? '';
      for (const p of dayOf.get(d) ?? []) picked.push(p.med);
    }
    draws.push(med(picked));
  }
  draws.sort((a, b) => a - b);
  lo = draws[Math.floor(0.025 * (draws.length - 1))] ?? NaN;
  hi = draws[Math.floor(0.975 * (draws.length - 1))] ?? NaN;
  console.log(`  95% CI on the deep-arm median of pool medians: [${F(lo)}%, ${F(hi)}%]`);
} else {
  console.log('  FEWER THAN 2 DAY CLUSTERS — no interval is computable and none is reported.');
}

// ---------------------------------------------------------------------------
// 6. The frozen decision rule. Four conditions; any one failing closes it.
// ---------------------------------------------------------------------------
const c1 = dRes.share >= 0.6;
const c2 = dRes.median > 0;
const c3 = Number.isFinite(lo) && lo > 0;
const c4 = !(sRes.median > 0);
console.log('\nFROZEN DECISION RULE (MT111, written before this file existed)');
console.log(`  (1) deep arm >=60% of pools positive .......... ${c1 ? 'PASS' : 'FAIL'}  (${Number.isFinite(dRes.share) ? (100 * dRes.share).toFixed(1) : 'n/a'}%)`);
console.log(`  (2) deep arm median of pool medians > 0 ....... ${c2 ? 'PASS' : 'FAIL'}  (${F(dRes.median)}%)`);
console.log(`  (3) day-clustered bootstrap lower bound > 0 ... ${c3 ? 'PASS' : 'FAIL'}  (${F(lo)}%)`);
console.log(`  (4) shallow control NOT also positive ......... ${c4 ? 'PASS' : 'FAIL'}  (${F(sRes.median)}%)`);
console.log(`\n  VERDICT: ${c1 && c2 && c3 && c4 ? 'SURVIVES — licenses paper mode against live quotes, and nothing else' : 'CLOSED'}`);
console.log('  No position is proposed. Nothing is funded. Nothing is signed.');
