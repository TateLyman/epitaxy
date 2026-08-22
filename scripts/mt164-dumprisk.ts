/**
 * MT164 — DUMP_RISK: who is holding cheap inventory at delay 4, and what happens if they sell?
 *
 * The feature family here is taken from MELT (arXiv 2602.13480), a behavioural-trace dataset over
 * 41k memecoin launches and 200M transactions, rather than invented after looking at outcomes.
 * That matters: this programme has already produced one compelling artifact by searching a feature
 * space against a corpus it had seen, and an externally motivated family is the cheapest defence
 * against doing it again.
 *
 * WHAT MELT USES AND WHAT WE CAN ACTUALLY COMPUTE, stated honestly rather than blurred.
 *
 *   ENTITY RECONSTRUCTION. MELT links coordinated wallets three ways: accounts trading in the SAME
 *   TRANSACTION (which requires shared signing authority), accounts funded by a common address, and
 *   accounts sharing a Jito bundle ID. Our corpus is a pAMMBay6 event pull, so it carries the
 *   transaction index of every trade and therefore supports the FIRST signal exactly. It carries no
 *   transfers and no bundle IDs, so the other two are unavailable. MELT reports 36.5% of supply
 *   sitting in coordinated accounts, so the linkage we can build is a LOWER BOUND on coordination.
 *
 *   HOLDING CONCENTRATION. MELT's largest group. We compute the post-migration analogues from
 *   observed flow: how much base each entity has accumulated by delay 4, the largest entity's share,
 *   and the share held by the slot-0 cohort, whose cost basis is the lowest in the pool.
 *
 *   LIQUIDATION STRESS. This one we can do EXACTLY rather than approximately, and it is the
 *   strongest thing in the family. We know the pool reserves and we know how much base the early
 *   cohort holds, so pricing that inventory through the constant product gives the precise
 *   basis-point impact of them liquidating into us. It is not a proxy for dump risk; it is the
 *   arithmetic of the dump.
 *
 * THE LABEL IS MELT'S, ADAPTED. They define high risk as min_price_ratio below 0.3, the minimum
 * price within 20 minutes of migration divided by the migration price, and report 84.13% of tokens
 * landing in that class. Ours is the same shape measured on what we could actually realise: the
 * minimum EXECUTABLE mark of a delay-4 position over the following 20 minutes, divided by its entry
 * value. Using an externally fixed threshold rather than one tuned here is the point.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const OUT = 'data/panel';
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '').split(',').filter((s) => s.length > 0);
const ANALYZE = new Set((arg('analyze') ?? '').split(',').filter((s) => s.length > 0));
const TAG = arg('tag') ?? 'X';
const DELAY = 4;
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const NONAMM_BPS = 23;
/** MELT's horizon: 20 minutes. */
const RISK_HORIZON_S = 1200;
/** MELT's threshold: min_price_ratio below 0.3 is high risk. Not tuned here. */
const MELT_RATIO = 0.3;
const V_CANDIDATES = [0n, 17_584_500_000n];

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; qa: bigint; ua: bigint; who: string; base: bigint }

function feeOf(evs: Ev[]): number | null {
  const s: number[] = [];
  for (const e of evs) {
    if (e.qa <= 0n || e.ua <= 0n) continue;
    const f = e.buy ? 1e4 * Number(e.ua - e.qa) / Number(e.qa) : 1e4 * Number(e.qa - e.ua) / Number(e.qa);
    if (Number.isFinite(f) && f >= 0 && f < 2000) s.push(f);
  }
  if (s.length < 5) return null;
  s.sort((a, b) => a - b); return s[Math.floor(0.5 * (s.length - 1))] ?? null;
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

/** Union-find over wallets. MELT's co-purchase signal: same transaction implies shared control. */
class DSU {
  private p = new Map<string, string>();
  find(x: string): string {
    const px = this.p.get(x);
    if (px === undefined) { this.p.set(x, x); return x; }
    if (px === x) return x;
    const r = this.find(px); this.p.set(x, r); return r;
  }
  union(a: string, b: string): void { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

// pass 1 — true birth slot
const firstSlot = new Map<string, number>();
for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    const i = line.indexOf('"', 2); if (i < 0) continue;
    const pool = line.slice(2, i); const rest = line.slice(i + 2);
    const j = rest.indexOf(','); const slot = Number(j < 0 ? rest : rest.slice(0, j));
    if (!Number.isFinite(slot)) continue;
    const prev = firstSlot.get(pool);
    if (prev === undefined || slot < prev) firstSlot.set(pool, slot);
  }
  rl.close();
}
console.log(`  pass1 — ${firstSlot.size.toLocaleString()} pools`);

interface Out {
  pool: string; ts: number; bornSlot: number; ret30: number;
  entities: number; coordShare: number; topEntityShare: number; slot0Share: number;
  lowCostBase: number; liqImpactBps: number; washWallets: number; churnRatio: number;
  meltRatio: number; meltHighRisk: number;
}
const rows: Out[] = [];

for (const w of WINDOWS) {
  if (!ANALYZE.has(w)) continue;
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const byPool = new Map<string, Ev[]>();
  let chunkMin = Infinity; let lastTs = 0;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (r.length < 15) continue;
    if (r[1] < chunkMin) chunkMin = r[1];
    if (r[2] > lastTs) lastTs = r[2];
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
             b: BigInt(r[6]), q: BigInt(r[7]), qa: BigInt(r[8]), ua: BigInt(r[9]),
             who: typeof r[13] === 'string' ? r[13] : '', base: BigInt(r[14]) });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [pool, evsRaw] of byPool) {
    const born = firstSlot.get(pool);
    if (born === undefined || born < chunkMin) continue;
    const evs = evsRaw.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const fee = feeOf(evs); const v = resolveV(evs);
    if (fee === null || v === null) continue;

    /** Everything at or before delay 4 — the entire information set. */
    const pre = evs.filter((e) => e.slot <= born + DELAY && e.who !== '');
    if (pre.length === 0) continue;

    /**
     * ENTITY LINKAGE, CORRECTED FOR THE VENUE. MELT's co-purchase signal links wallets appearing in
     * the SAME TRANSACTION, which is right for launchpad-stage buys but fires on essentially nothing
     * here: a first run over block B found a median coordinated share of 0.0%, because on PumpSwap
     * each AMM swap is its own transaction. The AMM-stage analogue of a bundle is a JITO BUNDLE,
     * which lands as CONSECUTIVE TRANSACTIONS INSIDE ONE SLOT.
     *
     * So wallets are linked when they trade in the same slot at transaction indices within
     * BUNDLE_GAP of each other. Same-transaction linkage is kept as a subset of this and remains
     * exact. Same-SLOT-alone would be far too loose - a busy slot contains many unrelated traders -
     * so the adjacency requirement is what makes this a proxy for coordination rather than for
     * congestion. It is still a PROXY: unrelated wallets can land adjacently by chance, and a
     * bundle split across non-adjacent indices is missed. It will therefore both over- and
     * under-count, and it is not represented as MELT's measurement.
     */
    const BUNDLE_GAP = 1;
    const dsu = new DSU();
    const bySlot = new Map<number, { tx: number; who: string }[]>();
    for (const e of pre) {
      const a = bySlot.get(e.slot) ?? []; a.push({ tx: e.tx, who: e.who }); bySlot.set(e.slot, a);
    }
    for (const arr of bySlot.values()) {
      arr.sort((x, y) => x.tx - y.tx);
      for (let i = 1; i < arr.length; i += 1) {
        const a = arr[i - 1] as { tx: number; who: string };
        const b = arr[i] as { tx: number; who: string };
        if (b.tx - a.tx <= BUNDLE_GAP) dsu.union(a.who, b.who);
      }
    }

    /** Per-wallet observed base position and per-entity aggregation, up to delay 4. */
    const walletBase = new Map<string, number>();
    const walletBought = new Map<string, number>();
    const walletSold = new Map<string, number>();
    for (const e of pre) {
      if (e.base <= 0n) continue;
      const b = Number(e.base);
      walletBase.set(e.who, (walletBase.get(e.who) ?? 0) + (e.buy ? b : -b));
      if (e.buy) walletBought.set(e.who, (walletBought.get(e.who) ?? 0) + b);
      else walletSold.set(e.who, (walletSold.get(e.who) ?? 0) + b);
    }
    const entityBase = new Map<string, number>();
    for (const [wl, b] of walletBase) if (b > 0) entityBase.set(dsu.find(wl), (entityBase.get(dsu.find(wl)) ?? 0) + b);
    const totalHeld = [...entityBase.values()].reduce((a, b) => a + b, 0);
    if (totalHeld <= 0) continue;
    const sortedEnt = [...entityBase.values()].sort((a, b) => b - a);
    const topEntityShare = (sortedEnt[0] ?? 0) / totalHeld;
    /** MELT's coordinated share: supply held by entities that span MORE THAN ONE wallet. */
    const multi = new Map<string, number>();
    for (const wl of walletBase.keys()) { const r0 = dsu.find(wl); multi.set(r0, (multi.get(r0) ?? 0) + 1); }
    let coordHeld = 0;
    for (const [ent, b] of entityBase) if ((multi.get(ent) ?? 1) > 1) coordHeld += b;
    const coordShare = coordHeld / totalHeld;

    /** Slot-0 cohort: lowest cost basis in the pool, and the ones MT156 showed take 96.9% of gains. */
    let slot0Held = 0;
    const slot0Wallets = new Set(pre.filter((e) => e.slot === born && e.buy).map((e) => e.who));
    for (const [wl, b] of walletBase) if (slot0Wallets.has(wl) && b > 0) slot0Held += b;

    /** Wash signal: wallets that both bought AND sold before delay 4. */
    let wash = 0;
    for (const wl of walletBought.keys()) if ((walletSold.get(wl) ?? 0) > 0) wash += 1;
    const totalBought = [...walletBought.values()].reduce((a, b) => a + b, 0);
    const totalSold = [...walletSold.values()].reduce((a, b) => a + b, 0);
    const churn = totalBought > 0 ? totalSold / totalBought : 0;

    /** Entry, and the exact liquidation stress of the cheap inventory hitting this curve. */
    let entry: Ev | null = null;
    for (const e of evs) { if (e.slot >= born + DELAY && e.b > 0n && e.q > 0n) { entry = e; break; } }
    if (entry === null) continue;
    const ladder: PoolFeeLadder = { lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: BigInt(Math.round(fee)) };
    let bf;
    try { bf = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, ladder); } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; continue; }

    /**
     * ADVERSARIAL LIQUIDATION STRESS. Price the whole low-cost inventory through the curve and read
     * how far it moves the pool. This is the arithmetic of the dump, not a proxy for it.
     */
    let liqImpactBps = 0;
    const dumpBase = BigInt(Math.floor(Math.max(0, slot0Held)));
    if (dumpBase > 0n && dumpBase < entry.b) {
      try {
        const p0 = Number(entry.q + v) / Number(entry.b);
        const sf = priceSell({ base: entry.b, quote: entry.q, virtualQuote: v }, dumpBase, ladder);
        const p1 = Number(sf.reservesAfter.quote + v) / Number(sf.reservesAfter.base);
        liqImpactBps = p0 > 0 && p1 > 0 ? 1e4 * (p1 / p0 - 1) : 0;
      } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; }
    }

    /** Outcome at 30s, and MELT's minimum-ratio label over 20 minutes. */
    let ret30 = NaN; let minMark = Infinity;
    for (const e of evs) {
      if (e.ts <= entry.ts || e.b <= 0n || e.q <= 0n) continue;
      if (e.ts > entry.ts + RISK_HORIZON_S) break;
      try {
        const sf = priceSell({ base: e.b - bf.baseOut, quote: e.q + (bf.reservesAfter.quote - entry.q), virtualQuote: v }, bf.baseOut, ladder);
        const bps = 1e4 * Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL) - NONAMM_BPS;
        if (e.ts <= entry.ts + 30 || !Number.isFinite(ret30)) ret30 = bps;
        if (bps < minMark) minMark = bps;
      } catch (e2) { if (!(e2 instanceof FillNotPriceable)) throw e2; }
    }
    if (!Number.isFinite(ret30) || minMark === Infinity) continue;
    if (entry.ts + RISK_HORIZON_S > lastTs) continue;
    const meltRatio = 1 + minMark / 1e4;

    rows.push({
      pool, ts: entry.ts, bornSlot: born, ret30,
      entities: entityBase.size,
      coordShare: Number(coordShare.toFixed(4)),
      topEntityShare: Number(topEntityShare.toFixed(4)),
      slot0Share: Number((slot0Held / totalHeld).toFixed(4)),
      lowCostBase: Number((slot0Held / 1e6).toFixed(3)),
      liqImpactBps: Math.round(liqImpactBps),
      washWallets: wash,
      churnRatio: Number(churn.toFixed(4)),
      meltRatio: Number(meltRatio.toFixed(4)),
      meltHighRisk: meltRatio < MELT_RATIO ? 1 : 0,
    });
  }
  byPool.clear();
  console.log(`  pass2 ${w} — ${rows.length.toLocaleString()} rows`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/dumprisk-${TAG}.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const hr = rows.filter((r) => r.meltHighRisk === 1).length;
console.log('');
console.log(`dumprisk-${TAG}.jsonl — ${rows.length.toLocaleString()} pools`);
console.log(`  MELT high-risk (min ratio < ${MELT_RATIO} over ${RISK_HORIZON_S}s): ${hr.toLocaleString()} (${(100 * hr / Math.max(1, rows.length)).toFixed(1)}%)  [MELT reports 84.13% on launchpad data]`);
const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))] ?? NaN; };
console.log(`  entities per pool      p50 ${q(rows.map((r) => r.entities), 0.5)}`);
console.log(`  coordinated share      p50 ${(100 * q(rows.map((r) => r.coordShare), 0.5)).toFixed(1)}%   [MELT reports 36.5% of supply coordinated]`);
console.log(`  slot-0 cohort share    p50 ${(100 * q(rows.map((r) => r.slot0Share), 0.5)).toFixed(1)}%`);
console.log(`  liquidation impact     p10 ${q(rows.map((r) => r.liqImpactBps), 0.1).toFixed(0)}  p50 ${q(rows.map((r) => r.liqImpactBps), 0.5).toFixed(0)}  bps if the cheap inventory dumps`);
