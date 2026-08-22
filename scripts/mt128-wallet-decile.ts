/**
 * MT128 — does WHO bought change the answer, when WHEN to sell does not?
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT128 before this file existed, including the
 * prediction: a real decile gradient (TEST 1 passes) with both arms below zero after costs
 * (TEST 2 fails).
 *
 * MT127 closed the incumbent hold window as negative at every horizon it declares. The one thing
 * it formally left open is whether a different SELECTION rule picks a subpopulation on which
 * those same holds are positive. `MT101` and `MT104` were both preregistered to answer that and
 * neither ran: MT101 died on a polled source that returned zero buys in 39 minutes, MT104 needs
 * 6-25 days of prospective collection plus a Dune query.
 *
 * THE INSTRUMENT IS FREE AND WAS ALREADY ON DISK. The PumpSwap trade event carries `user` at
 * byte offset 152, so every buy in the backfill names its buyer. Adding that one field to the
 * trade cache turns a 25-day prospective experiment into arithmetic.
 *
 * THE SPLIT IS TEMPORAL AND BY CALENDAR, NOT AT RANDOM. Wallets are RANKED on the nine older
 * windows (w18..w10) and MEASURED on the nine newer ones (w9..w1). Ranking and measuring the same
 * rows would be circular; ranking on a random half would leak, because a wallet's good day is a
 * market's good day.
 *
 * THE BOTTOM DECILE IS THE CONTROL, and it is what makes this stronger than any single arm. It
 * shares the venue, clock, cost model, notional, horizon and entry lag, and differs only in which
 * wallets fired the signal — so a gradient cannot be blamed on market conditions or on the cost
 * model being wrong. That last point matters especially here: MT127-DEFECT showed a cost model
 * wrong in the cheap direction manufactures an edge the size of its error, and this uses the same
 * pricing path. A DIFFERENCE between two arms priced identically is immune to that; a LEVEL is not.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const DELAY_S = 2;
const NOTIONAL = 20_000_000n;
const V_CANDIDATES = [0n, 17_584_500_000n];
const HORIZONS = [120, 300, 600, 1800, 3600];
/** Decision-bearing. Frozen in the MT128 row before any decile return existed. */
const H_STAR = 600;
const MIN_FIT_BUYS = 10;

const FIT = [18, 17, 16, 15, 14, 13, 12, 11, 10];
const VAL = [9, 8, 7, 6, 5, 4, 3, 2, 1];

interface Ev {
  slot: number; ts: number; tx: number; addr: string; buy: boolean;
  b: bigint; q: bigint; quote: bigint; user: bigint; lp: number; pro: number; cre: number; who: string;
}

function resolveV(evs: Ev[]): bigint | null {
  let best: bigint | null = null; let bestBad = Infinity;
  for (const v of V_CANDIDATES) {
    let bad = 0; let n = 0;
    for (let i = 0; i + 1 < evs.length && n < 60; i += 1) {
      const a = evs[i]; const c = evs[i + 1];
      if (a === undefined || c === undefined || a.b <= 0n || a.q <= 0n || c.b <= 0n || c.q <= 0n) continue;
      const k0 = Number(a.b) * Number(a.q + v);
      const k1 = Number(c.b) * Number(c.q + v);
      if (!(k0 > 0) || !(k1 > 0)) continue;
      n += 1; if (k1 < k0) bad += 1;
    }
    if (n >= 10 && bad < bestBad) { bestBad = bad; best = v; }
  }
  return best;
}

function lastAtOrBefore(evs: Ev[], t: number, lo: number): number {
  let a = lo; let b = evs.length - 1; let r = -1;
  while (a <= b) {
    const m = (a + b) >> 1;
    const e = evs[m];
    if (e === undefined) break;
    if (e.ts <= t) { r = m; a = m + 1; } else b = m - 1;
  }
  return r;
}

/** One copy outcome: what we would have made following `who` into this pool. */
interface Copy { who: string; day: string; mint: string; rets: Map<number, number> }

async function harvest(windows: number[], label: string): Promise<Copy[]> {
  const out: Copy[] = [];
  for (const w of windows) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) { console.log(`    (missing w${w})`); continue; }
    const byPool = new Map<string, Ev[]>();
    let windowEndTs = 0;
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string];
      try { r = JSON.parse(line); } catch { continue; }
      if (r.length < 14) continue;                    // pre-`user` cache line: unusable here
      const a = byPool.get(r[0]) ?? [];
      a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
               b: BigInt(r[6]), q: BigInt(r[7]), quote: BigInt(r[8]), user: BigInt(r[9]),
               lp: r[10], pro: r[11], cre: r[12], who: r[13] });
      byPool.set(r[0], a);
      if (r[2] > windowEndTs) windowEndTs = r[2];
    }
    rl.close();

    for (const [mint, evs] of byPool) {
      if (evs.length < 40) continue;
      evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
      const v = resolveV(evs);
      if (v === null) continue;

      const ch: number[] = [];
      for (const e of evs) {
        if (e.buy || e.quote <= 0n || e.user <= 0n) continue;
        const c = 1e4 * (Number(e.quote) - Number(e.user)) / Number(e.quote);
        if (Number.isFinite(c) && c > 0 && c < 1000) ch.push(c);
      }
      if (ch.length < 5) continue;
      ch.sort((a, b) => a - b);
      const chargedBps = ch[Math.floor(0.5 * (ch.length - 1))] ?? NaN;
      if (!Number.isFinite(chargedBps)) continue;
      /** MT127-DEFECT: the observed charge passes through UNCLAMPED. The 25 bps clamp that
       *  MT123 carried binds on 100% of pools and understates round trip by ~180 bps. */
      const e0 = evs[0];
      const fees: PoolFeeLadder = {
        lpFeeBasisPoints: BigInt(e0?.lp ?? 20), protocolFeeBasisPoints: BigInt(e0?.pro ?? 5),
        coinCreatorFeeBasisPoints: BigInt(e0?.cre ?? 0),
        chargedFeeBasisPoints: BigInt(Math.round(chargedBps)),
      };

      /** One copy per wallet per mint per window — MT101's rule, so a wallet that spams one
       *  pool cannot dominate its own decile with a single pool's outcome. */
      const taken = new Set<string>();
      for (let i = 0; i + 1 < evs.length; i += 1) {
        const sig = evs[i];
        if (sig === undefined || !sig.buy) continue;
        if (taken.has(sig.who)) continue;

        let ei = -1;
        for (let j = i + 1; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= sig.ts + DELAY_S) { ei = j; break; } }
        if (ei < 0) continue;
        const entry = evs[ei];
        if (entry === undefined || entry.b <= 0n || entry.q <= 0n) continue;

        let bought;
        try { bought = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, fees); }
        catch (e) { if (e instanceof FillNotPriceable) continue; throw e; }
        const quoteAdded = bought.reservesAfter.quote - entry.q;

        const rets = new Map<number, number>();
        for (const h of HORIZONS) {
          const target = entry.ts + h;
          if (target > windowEndTs) continue;                 // censored: no outcome exists
          const mi = lastAtOrBefore(evs, target, ei + 1);
          if (mi <= ei) continue;
          const m = evs[mi];
          if (m === undefined) continue;
          try {
            const s = priceSell({ base: m.b - bought.baseOut, quote: m.q + quoteAdded, virtualQuote: v }, bought.baseOut, fees);
            const r = Number(s.quoteOut - NOTIONAL) / Number(NOTIONAL);
            if (Number.isFinite(r)) rets.set(h, r);
          } catch { /* unpriceable at this mark */ }
        }
        if (!rets.has(H_STAR)) continue;                      // no decision-bearing outcome
        taken.add(sig.who);
        out.push({ who: sig.who, day: new Date(sig.ts * 1000).toISOString().slice(0, 10), mint, rets });
      }
    }
    byPool.clear();
  }
  console.log(`  ${label}: ${out.length.toLocaleString()} copy outcomes over ${new Set(out.map((c) => c.who)).size.toLocaleString()} wallets`);
  return out;
}

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const mean = (a: number[]): number => { const s = a.filter(Number.isFinite); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
const wmean = (a: number[], p = 0.10): number => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  if (s.length < 20) return NaN;
  const k = Math.floor(p * (s.length - 1));
  const lo = s[k] ?? 0; const hi = s[s.length - 1 - k] ?? 0;
  return s.map((x) => (x < lo ? lo : x > hi ? hi : x)).reduce((x, y) => x + y, 0) / s.length;
};
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');

/**
 * Day-clustered bootstrap. Resamples DAYS, not rows: rows inside a day share a market, so
 * resampling rows would treat one market draw as hundreds of independent ones.
 *
 * `arms` is bootstrapped JOINTLY — each resampled day contributes its rows from every arm at
 * once. That is what makes the difference PAIRED, as MT128 froze it: a day that was good for
 * everyone moves both arms together and cancels in the difference, instead of inflating it.
 */
function dayBoot(
  arms: Map<string, number[]>[], stat: (a: number[]) => number, combine: (v: number[]) => number, iters = 2000,
): [number, number] {
  const days = [...new Set(arms.flatMap((m) => [...m.keys()]))];
  if (days.length < 3) return [NaN, NaN];
  const draws: number[] = [];
  // Deterministic LCG — Math.random is banned in this repo's scripts and a seeded draw replays.
  let seed = 20260821;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iters; it += 1) {
    const pools: number[][] = arms.map(() => []);
    for (let d = 0; d < days.length; d += 1) {
      const pick = days[Math.floor(rnd() * days.length)];
      if (pick === undefined) continue;
      for (let k = 0; k < arms.length; k += 1) {
        const rows = arms[k]?.get(pick);
        if (rows !== undefined) pools[k]?.push(...rows);
      }
    }
    const v = pools.map((p) => stat(p));
    if (v.every((x) => Number.isFinite(x))) {
      const c = combine(v);
      if (Number.isFinite(c)) draws.push(c);
    }
  }
  if (draws.length < 100) return [NaN, NaN];
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * (draws.length - 1))] ?? NaN, draws[Math.floor(0.975 * (draws.length - 1))] ?? NaN];
}

console.log('MT128 — wallet deciles, ranked on w18-w10, measured on w9-w1');
console.log('  prediction recorded before running: gradient YES (test 1), tradable NO (test 2)');
console.log(`  cost model: observed charge UNCLAMPED per MT127-DEFECT; decision horizon H* = ${H_STAR}s`);
console.log('');

const fit = await harvest(FIT, 'FIT  ');
const val = await harvest(VAL, 'VALID');

// ---- rank on the fit half only ----
const fitBy = new Map<string, number[]>();
for (const c of fit) {
  const r = c.rets.get(H_STAR);
  if (r === undefined) continue;
  const a = fitBy.get(c.who) ?? []; a.push(r); fitBy.set(c.who, a);
}
const rankable = [...fitBy.entries()].filter(([, a]) => a.length >= MIN_FIT_BUYS)
  .map(([w, a]) => ({ w, s: med(a), n: a.length }))
  .filter((x) => Number.isFinite(x.s))
  .sort((a, b) => b.s - a.s);
console.log('');
console.log(`RANKABLE WALLETS (>=${MIN_FIT_BUYS} fit copies): ${rankable.length.toLocaleString()}`);
if (rankable.length < 20) {
  console.log('  TOO FEW TO CUT DECILES. Reported as an instrument limit, not as a result.');
  process.exit(0);
}
const dsize = Math.floor(rankable.length / 10);
const decile = new Map<string, number>();
for (let d = 0; d < 10; d += 1) for (const x of rankable.slice(d * dsize, (d + 1) * dsize)) decile.set(x.w, d + 1);
console.log(`  decile size ${dsize}   fit median-return spread: d1 ${(100 * (rankable[0]?.s ?? NaN)).toFixed(1)}% ... d10 ${(100 * (rankable[rankable.length - 1]?.s ?? NaN)).toFixed(1)}%`);

// ---- measure on the holdout half ----
const holdBy = new Map<number, number[]>();
const holdDay = new Map<number, Map<string, number[]>>();
for (const c of val) {
  const d = decile.get(c.who);
  if (d === undefined) continue;
  const r = c.rets.get(H_STAR);
  if (r === undefined) continue;
  const a = holdBy.get(d) ?? []; a.push(r); holdBy.set(d, a);
  const dm = holdDay.get(d) ?? new Map<string, number[]>();
  const dd = dm.get(c.day) ?? []; dd.push(r); dm.set(c.day, dd); holdDay.set(d, dm);
}
console.log('');
console.log(`HOLDOUT, H* = ${H_STAR}s — every decile reported, not the best`);
console.log('  decile      n     median       MEAN  WINSOR-10%    %pos   days');
for (let d = 1; d <= 10; d += 1) {
  const a = holdBy.get(d) ?? [];
  if (a.length === 0) { console.log(`  d${String(d).padEnd(2)}         0        —          —          —        —      0`); continue; }
  const pct = (100 * a.filter((x) => x > 0).length / a.length).toFixed(1);
  console.log(`  d${String(d).padEnd(2)} ${String(a.length).padStart(7)}  ${F(med(a))}  ${F(mean(a))}  ${F(wmean(a))}  ${pct.padStart(6)}%  ${String((holdDay.get(d) ?? new Map()).size).padStart(5)}`);
}

// ---- the two frozen tests ----
const d1 = holdBy.get(1) ?? []; const d10 = holdBy.get(10) ?? [];
console.log('');
console.log('THE CONJUNCTION, frozen in MT128 before any of the above existed');
const m1 = holdDay.get(1) ?? new Map<string, number[]>();
const m10 = holdDay.get(10) ?? new Map<string, number[]>();
// PAIRED difference, exactly as frozen: both arms drawn on the SAME resampled days.
const [ld, ud] = dayBoot([m1, m10], (a) => wmean(a), (v) => (v[0] ?? NaN) - (v[1] ?? NaN));
const [l1, u1] = dayBoot([m1], (a) => wmean(a), (v) => v[0] ?? NaN);
const diff = wmean(d1) - wmean(d10);
console.log(`  TEST 1  gradient: d1 ${F(wmean(d1))}%  minus  d10 ${F(wmean(d10))}%  =  ${F(diff)}%`);
console.log(`            paired day-clustered 95% CI on the DIFFERENCE [${F(ld)}%, ${F(ud)}%]`);
const t1 = Number.isFinite(ld) && ld > 0;
console.log(`            ${t1 ? 'PASS — lower bound above zero' : 'FAIL — lower bound at or below zero'}`);
const t2 = Number.isFinite(l1) && l1 > 0;
console.log(`  TEST 2  d1 own LEVEL after corrected costs: ${F(wmean(d1))}%  95% CI [${F(l1)}%, ${F(u1)}%]`);
console.log(`            ${t2 ? 'PASS — lower bound above zero' : 'FAIL — lower bound at or below zero'}`);
console.log('');
console.log(`VERDICT: ${t1 && t2 ? 'SUPPORTED — both tests pass. Re-probe the cost model BEFORE believing this.' : t1 ? 'GRADIENT WITHOUT A TRADE — wallet skill is real here, the level is not above cost.' : 'NOT SUPPORTED.'}`);
console.log('');
console.log('SENSITIVITY (never decision-bearing): d1 winsorised mean at every horizon');
process.stdout.write('  ');
for (const h of HORIZONS) {
  const a = val.filter((c) => decile.get(c.who) === 1).map((c) => c.rets.get(h)).filter((x): x is number => x !== undefined);
  process.stdout.write(`${h}s ${F(wmean(a))}%  `);
}
console.log('');
