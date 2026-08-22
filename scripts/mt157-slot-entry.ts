/**
 * MT157 — can a MECHANICAL rule capture what the slot 1-4 wallets captured?
 *
 * MT156 found that 96.3% of all realised gains on this venue go to wallets present in a pool's
 * VERY FIRST SLOT, and that everything from slot 5 onward is negative. It also found something
 * easier to miss: slots 1 through 4 are POSITIVE — +146 and +197 basis points on deployed capital,
 * at win rates near 47% — and those figures already contain the AMM fee, because the FIFO
 * accounting uses the user-side amounts a trader actually paid and received.
 *
 * THAT IS A CLAIM ABOUT WALLETS, NOT ABOUT A STRATEGY, AND THE DIFFERENCE IS THE WHOLE TEST.
 * Wallet attribution is confounded by everything those wallets chose: which pools they entered,
 * how much they sized, when they exited, and whether they entered at all. A cohort can show a
 * positive average while a mechanical rule that enters EVERY pool at the same moment loses,
 * because the wallets were selecting and the rule is not. This programme has been fooled by that
 * exact gap before — MT147 could predict which pools winners entered, and being early to that
 * shortlist still lost at the median.
 *
 * SO THIS PRICES A RULE, NOT A COHORT. Enter EVERY analysable pool at the first trade at or after
 * `born + delay` slots, at a fixed notional, priced through the constant product at the pool's own
 * unclamped charged fee, with our own entry moving the pool and our exit selling into what the
 * entry left behind. Exit at a fixed hold. No selection of any kind.
 *
 * WHY THE DELAY AXIS IS THE POINT. Slot 0 is not reachable by reaction — a bundled launch puts the
 * creation and its buys in one block precisely so that no observer can get between them. Slot 1 is
 * the first rung a reacting participant can occupy, and it costs roughly 377ms of detection and
 * landing to reach. The sweep says what each rung is worth BEFORE any infrastructure is bought.
 *
 * THE SAME CHUNK-BOUNDARY GUARD AS MT156, for the same reason: a pool already alive when a chunk
 * begins looks born at that chunk's first slot, which would put latecomers on the earliest rungs
 * and manufacture the result. Pass one reads every window; pass two analyses only chunks that
 * genuinely contain a pool's birth.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? 'b0,b1,b2,b3,b4,b5,b6,b7').split(',').filter((s) => s.length > 0);
const ANALYZE = new Set((arg('analyze') ?? 'b1,b2,b3,b4,b5,b6,b7').split(',').filter((s) => s.length > 0));
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
/** MT136: network and priority drag only. The AMM fee is priced per leg from the pool's own charge. */
const NONAMM_BPS = 23;
const V_CANDIDATES = [0n, 17_584_500_000n];
const DELAYS = [1, 2, 4, 8, 16];
const HOLDS_S = [30, 120, 600, 1800];

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; qa: bigint; ua: bigint }

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

// pass 1 — true birth slot across the whole block
const firstSlot = new Map<string, number>();
for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    const i = line.indexOf('"', 2);
    if (i < 0) continue;
    const pool = line.slice(2, i);
    const rest = line.slice(i + 2);
    const j = rest.indexOf(',');
    const slot = Number(j < 0 ? rest : rest.slice(0, j));
    if (!Number.isFinite(slot)) continue;
    const prev = firstSlot.get(pool);
    if (prev === undefined || slot < prev) firstSlot.set(pool, slot);
  }
  rl.close();
  console.log(`  pass1 ${w} — ${firstSlot.size.toLocaleString()} pools`);
}

/** key `${delay}|${hold}` -> outcomes, with the day for clustering. */
const cells = new Map<string, { v: number; day: number }[]>();
for (const d of DELAYS) for (const h of HOLDS_S) cells.set(`${d}|${h}`, []);
let pools = 0;

for (const w of WINDOWS) {
  if (!ANALYZE.has(w)) continue;
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const byPool = new Map<string, Ev[]>();
  let chunkMin = Infinity; let lastTs = 0;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, ...unknown[]];
    try { r = JSON.parse(line); } catch { continue; }
    if (r[1] < chunkMin) chunkMin = r[1];
    if (r[2] > lastTs) lastTs = r[2];
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
             b: BigInt(r[6]), q: BigInt(r[7]), qa: BigInt(r[8]), ua: BigInt(r[9]) });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [pool, evs] of byPool) {
    const born = firstSlot.get(pool);
    if (born === undefined || born < chunkMin) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const fee = poolFeeBps(evs);
    const v = resolveV(evs);
    if (fee === null || v === null) continue;
    pools += 1;
    const ladder: PoolFeeLadder = {
      lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n,
      chargedFeeBasisPoints: BigInt(Math.round(fee)),
    };
    for (const d of DELAYS) {
      let entry: Ev | null = null;
      for (const e of evs) { if (e.slot >= born + d && e.b > 0n && e.q > 0n) { entry = e; break; } }
      if (entry === null) continue;
      for (const h of HOLDS_S) {
        /** The hold must fit inside the chunk, else the absence is ours and not the pool's. */
        if (entry.ts + h > lastTs) continue;
        let exit: Ev | null = null;
        for (const e of evs) { if (e.ts >= entry.ts + h && e.b > 0n && e.q > 0n) { exit = e; break; } }
        if (exit === null) for (let i = evs.length - 1; i >= 0; i -= 1) { const e = evs[i]; if (e !== undefined && e.b > 0n && e.q > 0n) { exit = e; break; } }
        if (exit === null) continue;
        try {
          const bf = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, ladder);
          const sf = priceSell(
            { base: exit.b - bf.baseOut, quote: exit.q + (bf.reservesAfter.quote - entry.q), virtualQuote: v },
            bf.baseOut, ladder,
          );
          cells.get(`${d}|${h}`)?.push({
            v: 1e4 * Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL) - NONAMM_BPS,
            day: Math.floor(entry.ts / 86400),
          });
        } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; }
      }
    }
  }
  byPool.clear();
  console.log(`  pass2 ${w} — ${pools.toLocaleString()} pools`);
}

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const topShare = (x: number[]): number => {
  if (x.length < 100) return NaN;
  const s = [...x].sort((a, b) => b - a); const k = Math.max(1, Math.floor(s.length * 0.01));
  const tot = s.reduce((a, b) => a + b, 0);
  return tot === 0 ? NaN : s.slice(0, k).reduce((a, b) => a + b, 0) / tot;
};
function boot(items: { v: number; day: number }[]): [number, number] {
  const byDay = new Map<number, number[]>();
  for (const it of items) { const a = byDay.get(it.day) ?? []; a.push(it.v); byDay.set(it.day, a); }
  const days = [...byDay.values()];
  if (days.length < 2) return [NaN, NaN];
  let seed = 20260822;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ms: number[] = [];
  for (let r = 0; r < 2000; r += 1) {
    const pick: number[] = [];
    for (let i = 0; i < days.length; i += 1) { const dd = days[Math.floor(rnd() * days.length)]; if (dd) pick.push(...dd); }
    if (pick.length) ms.push(mean(pick));
  }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(0.025 * ms.length)] ?? NaN, ms[Math.floor(0.975 * ms.length)] ?? NaN];
}

console.log('');
console.log(`MT157 — a MECHANICAL entry rule, every pool, no selection. ${pools.toLocaleString()} pools, ${(Number(NOTIONAL) / 1e9).toFixed(3)} SOL`);
console.log('  net of the pool OWN unclamped charge on both legs, our own impact, and 23 bps non-AMM drag');
console.log('');
console.log('  delay  hold        n     MEAN  [95% day-clustered CI]    median    %pos   top1% share   clusters');
for (const d of DELAYS) {
  for (const h of HOLDS_S) {
    const a = cells.get(`${d}|${h}`) ?? [];
    if (a.length < 100) continue;
    const v = a.map((x) => x.v);
    const [lo, hi] = boot(a);
    const cl = new Set(a.map((x) => x.day)).size;
    console.log(
      `  ${String(d).padStart(5)} ${String(h + 's').padStart(6)} ${String(v.length).padStart(8)} ${mean(v).toFixed(0).padStart(8)}  [${lo.toFixed(0).padStart(7)},${hi.toFixed(0).padStart(7)}] ${med(v).toFixed(0).padStart(9)} ${(100 * v.filter((x) => x > 0).length / v.length).toFixed(1).padStart(7)}% ${(100 * topShare(v)).toFixed(0).padStart(11)}% ${String(cl).padStart(10)}`,
    );
  }
  console.log('');
}
console.log('  A cohort of wallets can profit where a rule that enters EVERY pool does not, because');
console.log('  the wallets were selecting and the rule is not. That gap is what this measures.');
