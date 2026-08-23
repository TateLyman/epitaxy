/**
 * MT158 — at delay 4, can we PREDICT the extreme 30-second runners?
 *
 * The operator's proposal, and it is the right question. MT157 found that entering every pool at
 * delay 4 with a 30 second hold has a POSITIVE mean of +663 bps, and that the mean is disqualified
 * only by its shape: the top 1% of outcomes contributes 174% of it, so removing the best trade in
 * a hundred leaves the remainder net negative. That is fatal to an indiscriminate rule. It is NOT
 * fatal to a selective one. If the pools in that tail are identifiable from what is visible at
 * delay 4, then the tail is the strategy and the losers are avoidable.
 *
 * WHAT MT147 DID AND DID NOT SETTLE. MT147 asked whether we can predict WHICH POOLS WINNERS ENTER
 * and found we can, while being early to that shortlist still lost at the median. This is a
 * different target: not where a winner goes, but which pool RUNS in the next thirty seconds. The
 * two are not the same question and the second has never been asked.
 *
 * WHAT IS ACTUALLY OBSERVABLE AT DELAY 4, and it is very little — about 1.5 seconds and a handful
 * of trades. Every feature here is computed STRICTLY from events at or before born+4 slots:
 * trade count, distinct buyers, SOL bought, largest single buy, buyer concentration, buy share,
 * price move so far, depth, the pool's own fee tier, whether three or more distinct wallets bought
 * in the very first slot (the bundle signature MT156 found on 8.1% of pools), and the creator's
 * causal prior-launch count, which is the one replicated feature this programme owns (MT151).
 *
 * A NOTE ON WHAT A POOL BIRTH IS HERE, because it changes the reading. A PumpSwap pool is created
 * when a token GRADUATES from the bonding curve, so slot 0 is the migration moment and the slot-0
 * cohort MT156 measured are migration snipers rather than launch devs. The prediction target is
 * unaffected — we are asking which freshly graduated pool runs — but the mechanism is graduation,
 * not launch, and it should not be described as the latter.
 *
 * OUT OF SAMPLE BY CONSTRUCTION. Features are ranked on block A and the resulting rule is applied,
 * unchanged, to block B. Nothing is selected after seeing block B.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const SYSTEM_ADDRESS = '11111111111111111111111111111111';
const LAMPORTS = 1e9;
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '').split(',').filter((s) => s.length > 0);
const ANALYZE = new Set((arg('analyze') ?? '').split(',').filter((s) => s.length > 0));
const TAG = arg('tag') ?? 'X';
const DELAY = Number(arg('delay') ?? '4');
const HOLD_S = Number(arg('hold') ?? '30');
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const NONAMM_BPS = 23;
const V_CANDIDATES = [0n, 17_584_500_000n];

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

/**
 * BIRTH AND CREATOR BOTH COME FROM CreatePoolEvent, and that removes two defects at once.
 *
 * The old construction inferred birth from the FIRST OBSERVED TRADE in a chunk, so a pool already
 * alive when the chunk began looked newborn the moment it first traded inside it. MT158 measured
 * that contamination at 30.8% of its selected bucket against 1.5% elsewhere, and it manufactured a
 * rule that ranked first on two independent blocks and was pure artifact. It also needed a two-pass
 * scan plus exclusion of the earliest chunk to be even approximately right.
 *
 * createdSlot is the EXACT creation slot: no inference, no two-pass, no chunk-boundary exclusions,
 * and each pool is analysed exactly once, in the chunk containing its birth. The creator comes from
 * the same event, so it no longer depends on the venue_pools snapshot that made older corpora
 * survivorship-filtered.
 */
const SPLIT_NL = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));
interface PoolMeta { born: number; creator: string }
const meta = new Map<string, PoolMeta>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(SPLIT_NL)) {
  if (line.length === 0) continue;
  try {
    const r = JSON.parse(line) as { pool: string; creator: string; createdSlot: number; quoteMint: string };
    if (r.quoteMint !== 'So11111111111111111111111111111111111111112') continue;
    meta.set(r.pool, { born: r.createdSlot, creator: r.creator });
  } catch { /* skip */ }
}
const creatorOf = new Map<string, string>();
for (const [pool, m] of meta) if (m.creator !== SYSTEM_ADDRESS && m.creator !== '') creatorOf.set(pool, m.creator);
console.log(`  pool map: ${meta.size.toLocaleString()} WSOL-quoted pools with exact creation slots`);

interface Row {
  pool: string; creator: string; bornSlot: number; ts: number; ret: number;
  nTrades: number; buyers: number; bundle: number; buySol: number; maxBuySol: number;
  topShare: number; buyShare: number; moveBps: number; depthSol: number; feeBps: number; prior: number;
}
const rows: Row[] = [];

for (const w of WINDOWS) {
  if (!ANALYZE.has(w)) continue;
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const byPool = new Map<string, Ev[]>();
  let chunkMin = Infinity; let chunkMax = -Infinity; let lastTs = 0;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (r.length < 15) continue;
    if (r[1] < chunkMin) chunkMin = r[1];
    if (r[1] > chunkMax) chunkMax = r[1];
    if (r[2] > lastTs) lastTs = r[2];
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
             b: BigInt(r[6]), q: BigInt(r[7]), qa: BigInt(r[8]), ua: BigInt(r[9]), who: typeof r[13] === 'string' ? r[13] : '' });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [pool, evs] of byPool) {
    const mm = meta.get(pool);
    if (mm === undefined) continue;
    const born = mm.born;
    /** Analyse a pool exactly once, in the chunk that contains its ACTUAL creation. */
    if (born < chunkMin || born > chunkMax) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const fee = poolFeeBps(evs); const v = resolveV(evs);
    if (fee === null || v === null) continue;
    const first = evs[0];
    if (first === undefined) continue;

    /** Everything at or before born+DELAY. This is the entire information set. */
    const pre = evs.filter((e) => e.slot <= born + DELAY);
    if (pre.length === 0) continue;
    const buyers = new Set<string>(); const perBuyer = new Map<string, number>();
    let buySol = 0; let maxBuy = 0; let buyCount = 0;
    for (const e of pre) {
      const big = e.qa > e.ua ? e.qa : e.ua;
      const sol = Number(big) / LAMPORTS;
      if (!e.buy) continue;
      buySol += sol; buyCount += 1; if (sol > maxBuy) maxBuy = sol;
      if (e.who) { buyers.add(e.who); perBuyer.set(e.who, (perBuyer.get(e.who) ?? 0) + sol); }
    }
    const slot0Buyers = new Set(pre.filter((e) => e.slot === born && e.buy && e.who).map((e) => e.who));
    let topShare = 0;
    if (buySol > 0) for (const x of perBuyer.values()) if (x / buySol > topShare) topShare = x / buySol;

    /** Entry at the first trade at or after born+DELAY. */
    let entry: Ev | null = null;
    for (const e of evs) { if (e.slot >= born + DELAY && e.b > 0n && e.q > 0n) { entry = e; break; } }
    if (entry === null) continue;
    if (entry.ts + HOLD_S > lastTs) continue;
    let exit: Ev | null = null;
    for (const e of evs) { if (e.ts >= entry.ts + HOLD_S && e.b > 0n && e.q > 0n) { exit = e; break; } }
    if (exit === null) for (let i = evs.length - 1; i >= 0; i -= 1) { const e = evs[i]; if (e !== undefined && e.b > 0n && e.q > 0n) { exit = e; break; } }
    if (exit === null) continue;

    const ladder: PoolFeeLadder = {
      lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n,
      chargedFeeBasisPoints: BigInt(Math.round(fee)),
    };
    let ret: number | null = null;
    try {
      const bf = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, ladder);
      const sf = priceSell({ base: exit.b - bf.baseOut, quote: exit.q + (bf.reservesAfter.quote - entry.q), virtualQuote: v }, bf.baseOut, ladder);
      ret = 1e4 * Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL) - NONAMM_BPS;
    } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; }
    if (ret === null) continue;

    const p0 = Number(first.q + v) / Number(first.b);
    const pE = Number(entry.q + v) / Number(entry.b);
    rows.push({
      pool, creator: creatorOf.get(pool) ?? '', bornSlot: born, ts: entry.ts, ret,
      nTrades: pre.length, buyers: buyers.size, bundle: slot0Buyers.size >= 3 ? 1 : 0,
      buySol: Number(buySol.toFixed(4)), maxBuySol: Number(maxBuy.toFixed(4)),
      topShare: Number(topShare.toFixed(4)), buyShare: Number((buyCount / pre.length).toFixed(4)),
      moveBps: p0 > 0 && pE > 0 ? Math.round(1e4 * (pE / p0 - 1)) : 0,
      depthSol: Number((Number(entry.q + v) / LAMPORTS).toFixed(3)),
      feeBps: Number(fee.toFixed(1)), prior: 0,
    });
  }
  byPool.clear();
  console.log(`  pass2 ${w} — ${rows.length.toLocaleString()} rows`);
}

/** Causal prior-launch count, MT151 construction, computed across the whole block. */
rows.sort((a, b) => a.bornSlot - b.bornSlot);
const seen = new Map<string, number>();
for (const r of rows) {
  if (r.creator === '') { r.prior = -1; continue; }
  r.prior = seen.get(r.creator) ?? 0;
  seen.set(r.creator, r.prior + 1);
}

writeFileSync(`data/panel/runner-${TAG}.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log('');
console.log(`runner-${TAG}.jsonl — ${rows.length.toLocaleString()} pools, delay ${DELAY}, hold ${HOLD_S}s`);
const rr = rows.map((r) => r.ret).sort((a, b) => a - b);
const pc = (p: number): string => (rr[Math.floor(p * (rr.length - 1))] ?? NaN).toFixed(0);
console.log(`  outcome distribution bps: p10 ${pc(0.1)}  p50 ${pc(0.5)}  p90 ${pc(0.9)}  p99 ${pc(0.99)}  max ${(rr[rr.length - 1] ?? NaN).toFixed(0)}`);
console.log(`  mean ${(rr.reduce((a, b) => a + b, 0) / rr.length).toFixed(0)} bps`);
