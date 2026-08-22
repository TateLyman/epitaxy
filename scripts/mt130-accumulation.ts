/**
 * MT130 — is accumulation visible in the tape itself?
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT130 before this file existed, including the
 * prediction: footprint REAL, trade ABSENT.
 *
 * The winner study established the winners' edge is SELECTION — 65.3% of their profit comes from
 * pools that ran >+50%, only 4.8% from flat pools (0.9% for the top 100). Their entry signature is
 * contrarian and concentrated: price −4.86% in the 60s before their buys, while every OTHER trader
 * nets −8.76 SOL of selling. Losers are the mirror: +0.35% and +5.24 SOL.
 *
 * MT128 tested whether following those WALLETS works. It does not: −8.695% [−11.887, −5.586].
 * That is a test of IDENTITY. This is a test of FOOTPRINT — and no wallet identity appears
 * anywhere in the trigger, deliberately, because identity is the thing already closed. If the
 * pattern is legible in the tape, it is computable live by any observer, needs no Dune query, no
 * watchlist, and survives the wallets rotating at the 36.7–46.6%/month rate MT073 measured.
 *
 * EVERY THRESHOLD TRACES TO A MEASUREMENT MADE BEFORE ANY MT130 RETURN EXISTED — lookback 60s
 * (the window winner drift was measured over), −3% (top-100 winner median is −3.54%), flow sign
 * (winners −8.76 vs losers +5.24, so the SIGN discriminates, not the magnitude), concentration
 * ≥0.50 (winners trade one pool 50–83 times), H* = 1800s (top-10 median hold is 1,924s). That is
 * the availability-driven / outcome-driven distinction CLAUDE.md requires.
 *
 * TWO CONTROLS, BOTH FROZEN:
 *   INVERTED FOOTPRINT — price UP, flow POSITIVE, same concentration. What the losing decile does.
 *   CONCENTRATION ONLY — drop price and flow. Separates "someone big is trading" from
 *   "someone big is ABSORBING".
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;
const LOOKBACK_S = 60;
const DROP_BAR = -0.03;
const CONC_BAR = 0.50;
const DELAY_S = 2;
const NOTIONAL = 20_000_000n;
const V_CANDIDATES = [0n, 17_584_500_000n];
const HORIZONS = [120, 300, 600, 1800, 3600];
const H_STAR = 1800;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const VAL = (arg('val') ?? '9,8,7,6,5,4,3,2,1').split(',').filter((s) => s.length > 0);

type Arm = 'accumulation' | 'inverted' | 'concentration-only';

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

interface Out { rets: Map<number, number[]>; days: Map<number, Map<string, number[]>>; fired: number }
const mkOut = (): Out => ({ rets: new Map(HORIZONS.map((h) => [h, [] as number[]])), days: new Map(HORIZONS.map((h) => [h, new Map<string, number[]>()])), fired: 0 });

async function run(windows: string[], arm: Arm): Promise<Out> {
  const out = mkOut();
  for (const w of windows) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) continue;
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

    for (const [, evs] of byPool) {
      if (evs.length < 30) continue;
      evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
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
      const fees: PoolFeeLadder = {
        lpFeeBasisPoints: 20n, protocolFeeBasisPoints: 5n, coinCreatorFeeBasisPoints: 0n,
        chargedFeeBasisPoints: BigInt(Math.round(charged)),
      };

      const n = evs.length;
      const px = new Array<number>(n);
      for (let i = 0; i < n; i += 1) { const e = evs[i]; px[i] = e !== undefined && e.b > 0n ? Number(e.q + v) / Number(e.b) : NaN; }

      let lo = 0;
      for (let i = 1; i < n; i += 1) {
        const e = evs[i];
        if (e === undefined) continue;
        while (lo < i && (evs[lo]?.ts ?? 0) < e.ts - LOOKBACK_S) lo += 1;
        if (i - lo < 4) continue;

        const p0 = px[lo]; const p1 = px[i];
        if (p0 === undefined || p1 === undefined || !Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0) continue;
        const drift = p1 / p0 - 1;

        // Flow and buy-side concentration over the lookback.
        let net = 0; let buyVol = 0;
        const perBuyer = new Map<string, number>();
        for (let j = lo; j <= i; j += 1) {
          const x = evs[j];
          if (x === undefined) continue;
          const sol = Number(x.big) / LAMPORTS;
          if (x.buy) { net += sol; buyVol += sol; perBuyer.set(x.who, (perBuyer.get(x.who) ?? 0) + sol); }
          else net -= sol;
        }
        if (buyVol <= 0) continue;
        let topShare = 0;
        for (const s of perBuyer.values()) if (s / buyVol > topShare) topShare = s / buyVol;

        let hit = false;
        if (arm === 'accumulation') hit = drift <= DROP_BAR && net < 0 && topShare >= CONC_BAR;
        else if (arm === 'inverted') hit = drift >= -DROP_BAR && net > 0 && topShare >= CONC_BAR;
        else hit = topShare >= CONC_BAR;
        if (!hit) continue;

        out.fired += 1;
        let ei = -1;
        for (let j = i + 1; j < n; j += 1) { const x = evs[j]; if (x !== undefined && x.ts >= e.ts + DELAY_S) { ei = j; break; } }
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
        break;                                            // one position per pool per window
      }
    }
    byPool.clear();
    console.log(`    ${arm}: w${w} done — ${out.fired.toLocaleString()} triggers so far`);
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

console.log('MT130 — is accumulation visible in the tape?');
console.log('  prediction recorded before running: footprint REAL, trade ABSENT');
console.log(`  trigger: 60s drift <= ${(100 * DROP_BAR).toFixed(0)}%, other-trader flow < 0, top buyer share >= ${CONC_BAR}`);
console.log(`  H* = ${H_STAR}s (the top-10 winner median hold is 1,924s)   cost model UNCLAMPED`);
console.log('');

const arms: Arm[] = ['accumulation', 'inverted', 'concentration-only'];
const got = new Map<Arm, Out>();
for (const a of arms) { console.log(`  running ${a}`); got.set(a, await run(VAL, a)); }

console.log('');
console.log(`RESULTS at H* = ${H_STAR}s — all three arms, none omitted`);
console.log('  arm                  triggers       n    median   WINSOR-10%     95% day-clustered CI');
const summary = new Map<Arm, { w: number; lo: number; n: number }>();
for (const a of arms) {
  const o = got.get(a);
  if (o === undefined) continue;
  const rets = o.rets.get(H_STAR) ?? [];
  const [lo, hi] = dayBoot(o.days.get(H_STAR) ?? new Map());
  const w = wmean(rets);
  summary.set(a, { w, lo, n: rets.length });
  console.log(
    `  ${a.padEnd(20)} ${String(o.fired).padStart(8)}  ${String(rets.length).padStart(6)}  ${F(med(rets))}  ${F(w)}   [${F(lo)}, ${F(hi)}]` +
    `${rets.length < 100 ? '   UNDERPOWERED (<100)' : ''}`,
  );
}

console.log('');
console.log('THE THREE FROZEN CONDITIONS — all must hold, because any two can be met by an artifact');
const acc = summary.get('accumulation'); const inv = summary.get('inverted'); const con = summary.get('concentration-only');
const c1 = acc !== undefined && Number.isFinite(acc.lo) && acc.lo > 0;
const c2 = acc !== undefined && inv !== undefined && Number.isFinite(acc.w) && Number.isFinite(inv.w) && acc.w > inv.w;
const c3 = acc !== undefined && con !== undefined && Number.isFinite(acc.w) && Number.isFinite(con.w) && acc.w > con.w;
console.log(`  1  accumulation own level above zero      ${c1 ? 'PASS' : 'FAIL'}`);
console.log(`  2  beats the INVERTED footprint control   ${c2 ? 'PASS' : 'FAIL'}`);
console.log(`  3  beats CONCENTRATION-ONLY control       ${c3 ? 'PASS' : 'FAIL'}`);
console.log('');
if (c1 && c2 && c3) {
  console.log('VERDICT: CANDIDATE — all three hold.');
  console.log('  DO NOT REPORT THIS AS A RESULT YET. MT130 froze the next step: re-probe the fee');
  console.log('  model against the chain first. MT127-DEFECT manufactured an edge exactly the size');
  console.log('  of its own error and survived seven tests because every one returned the expected');
  console.log('  negative. A positive is the case that has never exercised this instrument.');
} else {
  console.log('VERDICT: NOT SUPPORTED. The footprint may still be real; the trade is not there.');
}
console.log('');
console.log('SENSITIVITY (never decision-bearing): accumulation arm at every horizon');
const a0 = got.get('accumulation');
if (a0 !== undefined) console.log('  ' + HORIZONS.map((h) => `${h}s ${F(wmean(a0.rets.get(h) ?? []))}`).join('  '));
