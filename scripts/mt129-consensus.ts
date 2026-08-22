/**
 * MT129 — does CONSENSUS among proven winners select a pool that runs?
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT129 before this file existed, including the
 * prediction that it FAILS.
 *
 * The winner study answered why this system loses, and the answer is SELECTION: 65.3% of winner
 * profit comes from pools that ran more than +50%, 84% from pools up more than +10%, and only
 * 4.8% from flat pools — 0.9% for the top 100 wallets. Their contrarian entry (preBuy −4.86%
 * while others net −8.76 SOL of selling) is how they ACCUMULATE, not why they profit.
 *
 * So the only reachable question is whether their pool CHOICE is observable in time to act on.
 * MT128 tested that at K=1 — follow one decile-1 wallet — and got −8.695% [−11.887, −5.586].
 * It never tested consensus. Several independently-successful wallets converging on one pool
 * inside a minute is a categorically different signal from any one of them buying.
 *
 * TWO CONTROLS, BOTH FROZEN IN THE ROW:
 *   K=1 ON THE SAME WINDOWS. Consensus must beat single-follow, not merely beat zero.
 *   THE LOSER SET. The identical cluster rule on the BOTTOM 500 wallets. If loser-consensus looks
 *   as good, the signal is crowding — several wallets reacting to one visible event — and not skill.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;
const DELAY_S = 2;
const NOTIONAL = 20_000_000n;
const V_CANDIDATES = [0n, 17_584_500_000n];
const HORIZONS = [120, 300, 600, 1800, 3600];
const H_STAR = 600;
const T_CLUSTER = 120;
const KS = [1, 2, 3, 5];
const SET_SIZE = 500;
const MIN_ROUND_TRIPS = 4;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const FIT = (arg('fit') ?? '9,8,7').split(',').filter((s) => s.length > 0);
const VAL = (arg('val') ?? '3,2,1').split(',').filter((s) => s.length > 0);

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

function lastAtOrBefore(evs: Ev[], t: number, lo: number): number {
  let a = lo; let b = evs.length - 1; let r = -1;
  while (a <= b) { const m = (a + b) >> 1; const e = evs[m]; if (e === undefined) break; if (e.ts <= t) { r = m; a = m + 1; } else b = m - 1; }
  return r;
}

async function load(w: string): Promise<Map<string, Ev[]>> {
  const byPool = new Map<string, Ev[]>();
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`    (missing w${w})`); return byPool; }
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
  for (const evs of byPool.values()) evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  return byPool;
}

/** FIFO realised PnL per wallet — the statistic the winner study used, and the one that conserves. */
async function rankWallets(windows: string[]): Promise<{ top: Set<string>; bottom: Set<string>; net: number }> {
  const pnl = new Map<string, { p: number; rt: number }>();
  let net = 0;
  for (const w of windows) {
    const byPool = await load(w);
    for (const [, evs] of byPool) {
      if (evs.length < 30) continue;
      const lots = new Map<string, { base: number; cost: number }[]>();
      for (const e of evs) {
        if (e.base <= 0n) continue;
        const q = lots.get(e.who) ?? [];
        if (e.buy) { q.push({ base: Number(e.base), cost: Number(e.big) / LAMPORTS }); lots.set(e.who, q); continue; }
        let rem = Number(e.base);
        const per = (Number(e.small) / LAMPORTS) / Number(e.base);
        let got = 0; let closed = 0;
        while (rem > 0 && q.length > 0) {
          const lot = q[0];
          if (lot === undefined) break;
          const take = Math.min(rem, lot.base);
          const cost = lot.cost * (take / lot.base);
          got += per * take - cost; rem -= take;
          lot.base -= take; lot.cost -= cost;
          if (lot.base <= 0) { q.shift(); closed += 1; }
        }
        lots.set(e.who, q);
        if (got !== 0 && Number.isFinite(got)) {
          const cur = pnl.get(e.who) ?? { p: 0, rt: 0 };
          cur.p += got; cur.rt += Math.max(1, closed); pnl.set(e.who, cur);
          net += got;
        }
      }
    }
    byPool.clear();
    console.log(`    ranked on w${w} — ${pnl.size.toLocaleString()} wallets`);
  }
  const elig = [...pnl.entries()].filter(([, v]) => v.rt >= MIN_ROUND_TRIPS).sort((a, b) => b[1].p - a[1].p);
  return {
    top: new Set(elig.slice(0, SET_SIZE).map(([w]) => w)),
    bottom: new Set(elig.slice(-SET_SIZE).map(([w]) => w)),
    net,
  };
}

interface Out { rets: Map<number, number[]>; days: Map<number, Map<string, number[]>>; clusters: number }
const mkOut = (): Out => ({ rets: new Map(HORIZONS.map((h) => [h, [] as number[]])), days: new Map(HORIZONS.map((h) => [h, new Map<string, number[]>()])), clusters: 0 });

async function measure(windows: string[], set: Set<string>, k: number): Promise<Out> {
  const out = mkOut();
  for (const w of windows) {
    const byPool = await load(w);
    for (const [, evs] of byPool) {
      if (evs.length < 30) continue;
      const v = resolveV(evs);
      if (v === null) continue;
      const windowEnd = evs[evs.length - 1]?.ts ?? 0;

      const ch: number[] = [];
      for (const e of evs) {
        if (e.buy || e.big <= 0n || e.small <= 0n) continue;
        const c = 1e4 * Number(e.big - e.small) / Number(e.big);
        if (Number.isFinite(c) && c > 0 && c < 1000) ch.push(c);
      }
      if (ch.length < 5) continue;
      ch.sort((a, b) => a - b);
      const charged = ch[Math.floor(0.5 * (ch.length - 1))] ?? NaN;
      if (!Number.isFinite(charged)) continue;
      const e0 = evs[0];
      const fees: PoolFeeLadder = {
        lpFeeBasisPoints: 20n, protocolFeeBasisPoints: 5n, coinCreatorFeeBasisPoints: 0n,
        chargedFeeBasisPoints: BigInt(Math.round(charged)),
      };
      void e0;

      // Sliding cluster: distinct members of `set` buying inside T_CLUSTER seconds.
      const recent: { ts: number; who: string }[] = [];
      let fired = false;
      for (let i = 0; i < evs.length; i += 1) {
        const e = evs[i];
        if (e === undefined || !e.buy || e.base <= 0n) continue;
        if (!set.has(e.who)) continue;
        recent.push({ ts: e.ts, who: e.who });
        while (recent.length > 0 && (recent[0]?.ts ?? 0) < e.ts - T_CLUSTER) recent.shift();
        const distinct = new Set(recent.map((r) => r.who)).size;
        if (distinct < k || fired) continue;
        fired = true;                                     // one position per pool per window
        out.clusters += 1;

        let ei = -1;
        for (let j = i + 1; j < evs.length; j += 1) { const x = evs[j]; if (x !== undefined && x.ts >= e.ts + DELAY_S) { ei = j; break; } }
        if (ei < 0) break;
        const entry = evs[ei];
        if (entry === undefined || entry.b <= 0n || entry.q <= 0n) break;
        let bought;
        try { bought = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, fees); }
        catch (x) { if (x instanceof FillNotPriceable) break; throw x; }
        const added = bought.reservesAfter.quote - entry.q;
        const day = new Date(e.ts * 1000).toISOString().slice(0, 10);

        for (const h of HORIZONS) {
          const target = entry.ts + h;
          if (target > windowEnd) continue;
          const mi = lastAtOrBefore(evs, target, ei + 1);
          if (mi <= ei) continue;
          const m = evs[mi];
          if (m === undefined) continue;
          try {
            const s = priceSell({ base: m.b - bought.baseOut, quote: m.q + added, virtualQuote: v }, bought.baseOut, fees);
            const r = Number(s.quoteOut - NOTIONAL) / Number(NOTIONAL);
            if (!Number.isFinite(r)) continue;
            out.rets.get(h)?.push(r);
            const dm = out.days.get(h);
            if (dm !== undefined) { const d = dm.get(day) ?? []; d.push(r); dm.set(day, d); }
          } catch { /* unpriceable */ }
        }
        break;
      }
    }
    byPool.clear();
  }
  return out;
}

const wmean = (a: number[], p = 0.10): number => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  if (s.length < 20) return NaN;
  const k = Math.floor(p * (s.length - 1));
  const lo = s[k] ?? 0; const hi = s[s.length - 1 - k] ?? 0;
  return s.map((x) => (x < lo ? lo : x > hi ? hi : x)).reduce((x, y) => x + y, 0) / s.length;
};
const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');

function dayBoot(byDay: Map<string, number[]>, iters = 2000): [number, number] {
  const days = [...byDay.keys()];
  if (days.length < 3) return [NaN, NaN];
  let seed = 20260821;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const draws: number[] = [];
  for (let it = 0; it < iters; it += 1) {
    const pool: number[] = [];
    for (let d = 0; d < days.length; d += 1) {
      const pick = days[Math.floor(rnd() * days.length)];
      if (pick === undefined) continue;
      const rows = byDay.get(pick);
      if (rows !== undefined) pool.push(...rows);
    }
    const s = wmean(pool);
    if (Number.isFinite(s)) draws.push(s);
  }
  if (draws.length < 100) return [NaN, NaN];
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * (draws.length - 1))] ?? NaN, draws[Math.floor(0.975 * (draws.length - 1))] ?? NaN];
}

console.log('MT129 — consensus among proven winners');
console.log('  prediction recorded before running: FAIL');
console.log(`  fit ${FIT.join(',')}   holdout ${VAL.join(',')}   T=${T_CLUSTER}s   H*=${H_STAR}s   cost model UNCLAMPED`);
console.log('');
console.log('RANKING on the fit windows by FIFO realised PnL');
const { top, bottom, net } = await rankWallets(FIT);
console.log(`  net realised PnL across all ranked wallets: ${net.toFixed(1)} SOL`);
if (net > 0) { console.log('  *** POSITIVE. Impossible. Ranking is broken; nothing measured. ***'); process.exit(2); }
console.log(`  winner set ${top.size}   loser set ${bottom.size}`);

console.log('');
console.log(`HOLDOUT — every K reported, and the loser set is the crowding control`);
console.log('  arm            K  clusters       n   median   WINSOR-10%     95% day-clustered CI');
const results = new Map<string, { lo: number; w: number }>();
for (const k of KS) {
  for (const [label, set] of [['winners', top], ['losers ', bottom]] as [string, Set<string>][]) {
    const o = await measure(VAL, set, k);
    const rets = o.rets.get(H_STAR) ?? [];
    const dm = o.days.get(H_STAR) ?? new Map<string, number[]>();
    const [lo, hi] = dayBoot(dm);
    const w = wmean(rets);
    results.set(`${label}${k}`, { lo, w });
    console.log(
      `  ${label}  ${String(k).padStart(4)}  ${String(o.clusters).padStart(8)}  ${String(rets.length).padStart(6)}  ` +
      `${F(med(rets))}  ${F(w)}   [${F(lo)}, ${F(hi)}]${rets.length < 100 ? '   UNDERPOWERED (<100)' : ''}`,
    );
  }
}

console.log('');
console.log('THE TWO FROZEN CONTROLS');
const k1 = results.get('winners1');
for (const k of KS.filter((x) => x > 1)) {
  const wk = results.get(`winners${k}`); const lk = results.get(`losers ${k}`);
  if (wk === undefined || k1 === undefined) continue;
  const beatsK1 = Number.isFinite(wk.w) && Number.isFinite(k1.w) && wk.w > k1.w;
  const aboveZero = Number.isFinite(wk.lo) && wk.lo > 0;
  const beatsLosers = lk !== undefined && Number.isFinite(wk.w) && Number.isFinite(lk.w) && wk.w > lk.w;
  console.log(`  K=${k}: beats K=1 ${beatsK1 ? 'YES' : 'no'}   own level above zero ${aboveZero ? 'YES' : 'no'}   beats loser-consensus ${beatsLosers ? 'YES' : 'no'}`);
  if (aboveZero && beatsK1) console.log(`    ^ CANDIDATE. Re-probe the fee model and the loser control BEFORE reporting this as anything.`);
}
console.log('');
console.log('SENSITIVITY (never decision-bearing): winner arm at every horizon');
for (const k of KS) {
  const o = await measure(VAL, top, k);
  const parts = HORIZONS.map((h) => `${h}s ${F(wmean(o.rets.get(h) ?? []))}`).join('  ');
  console.log(`  K=${k}  ${parts}`);
}
