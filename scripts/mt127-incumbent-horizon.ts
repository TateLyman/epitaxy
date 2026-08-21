/**
 * MT127 — the incumbent strategy's own window, measured at last.
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT127 before this file existed, including the
 * prediction that it comes out NEGATIVE.
 *
 * `delayed-momentum-v0` holds 120s to 3600s. MT006 records that window was chosen FROM A
 * CONSTRAINT AND NOT FROM DATA — the master prompt forbids a first-block latency race, so the
 * strategy went long-horizon by elimination. 136 ledger rows later it has never been closed on
 * its own terms: MT101, MT104 and MT105 all target it and all three are still `preregistered`,
 * and every COMPLETED horizon test stops at or below 60 seconds (MT123 `TIMEOUT_S` is 60).
 * This is the strategy `config/canary.json` is configured for, at `maxTokenAgeMs` 3,600,000.
 *
 * THREE THINGS THIS DOES THAT A NAIVE LONG-HORIZON TEST WOULD GET WRONG:
 *
 *   INDEPENDENCE. Overlapping 1-hour holds in one pool are not 60 observations, they are close
 *   to one. Each horizon therefore carries ITS OWN non-overlap clock, so the 3600s column is
 *   built from genuinely disjoint holds rather than from the same hour counted sixty times.
 *
 *   CENSORING. A trigger whose horizon runs past the end of the cached window has no outcome and
 *   is EXCLUDED and COUNTED, not marked at the last event. Marking it would silently convert
 *   "we stopped looking" into "the price stopped moving".
 *
 *   SILENCE IS A DATUM. A pool that stops printing before the horizon is a different case from a
 *   window that ends. Those are marked at the last known reserves and counted SEPARATELY, because
 *   the pools that go quiet are exactly the ones a momentum entry would still be holding.
 *
 * Cost model, virtual-reserve resolution, notional and entry delay are carried over unchanged
 * from MT117-MT126 so the numbers are comparable.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const IMPACT_BAR = 0.05;
const DELAY_S = 2;
const NOTIONAL = 20_000_000n;
const V_CANDIDATES = [0n, 17_584_500_000n];
/** The incumbent's declared window, end to end. */
const HORIZONS = [120, 300, 600, 1800, 3600];

const FIT = ['stag1', 'stag2', 'stag3', 'stag4', 'stag5', 'stag6', 'stag7', 'stag8'];
const VAL = ['vstag1', 'vstag2', 'vstag3', 'vstag4', 'vstag5', 'vstag6'];

interface Ev { slot: number; ts: number; tx: number; addr: string; side: string; b: bigint; q: bigint; quote: bigint; user: bigint; lp: number; pro: number; cre: number }

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

/** Last index whose timestamp is at or before `t`. Events are slot-ordered, so ts is monotone. */
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

interface Bucket { rets: number[]; days: Map<string, number[]>; censored: number; silent: number }

async function run(windows: string[], label: string): Promise<Map<number, Bucket>> {
  const out = new Map<number, Bucket>();
  for (const h of HORIZONS) out.set(h, { rets: [], days: new Map(), censored: 0, silent: 0 });
  let triggers = 0;

  for (const w of windows) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) { console.log(`    (missing ${f})`); continue; }
    const byPool = new Map<string, Ev[]>();
    let windowEndTs = 0;
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let r: [string, number, number, number, string, number, string, string, string, string, number, number, number];
      try { r = JSON.parse(line); } catch { continue; }
      const a = byPool.get(r[0]) ?? [];
      a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], side: r[5] === 1 ? 'BUY' : 'SELL',
               b: BigInt(r[6]), q: BigInt(r[7]), quote: BigInt(r[8]), user: BigInt(r[9]),
               lp: r[10], pro: r[11], cre: r[12] });
      byPool.set(r[0], a);
      if (r[2] > windowEndTs) windowEndTs = r[2];
    }
    rl.close();

    for (const [, evs] of byPool) {
      if (evs.length < 40) continue;
      evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
      const v = resolveV(evs);
      if (v === null) continue;
      const poolEndTs = evs[evs.length - 1]?.ts ?? 0;

      const ch: number[] = [];
      for (const e of evs) {
        if (e.side !== 'SELL' || e.quote <= 0n || e.user <= 0n) continue;
        const c = 1e4 * (Number(e.quote) - Number(e.user)) / Number(e.quote);
        if (Number.isFinite(c) && c > 0 && c < 1000) ch.push(c);
      }
      if (ch.length < 5) continue;
      ch.sort((a, b) => a - b);
      const chargedBps = ch[Math.floor(0.5 * (ch.length - 1))] ?? NaN;
      if (!Number.isFinite(chargedBps)) continue;
      /**
       * MT127 CORRECTION TO AN INHERITED DEFECT. MT123 and everything that copied it carried
       * `Math.max(Math.min(chargedBps, 25), 1)`, which CLAMPS the fee at 25 bps. Probed on
       * wstag1: the observed median charge is 115 bps a leg and the clamp binds on 100% of
       * 228 pools, so the clamped model understates round-trip cost by roughly 180 bps.
       * `totalFeeBps` returns `chargedFeeBasisPoints` whenever it is present, so the clamp was
       * the whole cost model. The observed charge is now passed through unclamped, and the
       * decoded ladder is carried alongside it so the fallback sum is also correct.
       */
      const e0 = evs[0];
      const fees: PoolFeeLadder = {
        lpFeeBasisPoints: BigInt(e0?.lp ?? 20), protocolFeeBasisPoints: BigInt(e0?.pro ?? 5),
        coinCreatorFeeBasisPoints: BigInt(e0?.cre ?? 0),
        chargedFeeBasisPoints: BigInt(Math.round(chargedBps)),
      };

      /** One non-overlap clock PER HORIZON — see the header note on independence. */
      const lastEnd = new Map<number, number>();
      for (const h of HORIZONS) lastEnd.set(h, -1);

      for (let i = 1; i + 1 < evs.length; i += 1) {
        const pre = evs[i]; const post = evs[i + 1];
        if (pre === undefined || post === undefined) continue;
        if (pre.b <= 0n || pre.q <= 0n || post.b <= 0n || post.q <= 0n) continue;
        const p0 = Number(pre.q + v) / Number(pre.b);
        const p1 = Number(post.q + v) / Number(post.b);
        if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0 || p1 <= 0) continue;
        if (!(p1 / p0 - 1 > 0)) continue;                                    // the momentum side
        if (Math.abs(Number(post.q - pre.q)) / Number(pre.q) < IMPACT_BAR) continue;

        const live = HORIZONS.filter((h) => post.ts >= (lastEnd.get(h) ?? -1));
        if (live.length === 0) continue;
        triggers += 1;

        const ei = ((): number => {
          for (let j = i + 2; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= post.ts + DELAY_S) return j; }
          return -1;
        })();
        if (ei < 0) continue;
        const entry = evs[ei];
        if (entry === undefined) continue;

        let bought;
        try { bought = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, fees); }
        catch (e) { if (e instanceof FillNotPriceable) continue; throw e; }
        const quoteAdded = bought.reservesAfter.quote - entry.q;
        const day = new Date(post.ts * 1000).toISOString().slice(0, 10);

        for (const h of live) {
          lastEnd.set(h, post.ts + h);
          const bk = out.get(h);
          if (bk === undefined) continue;
          const target = entry.ts + h;
          // The window ran out before the horizon did: no outcome exists. Count it, drop it.
          if (target > windowEndTs) { bk.censored += 1; continue; }
          const mi = lastAtOrBefore(evs, target, ei + 1);
          if (mi <= ei) { bk.censored += 1; continue; }
          const m = evs[mi];
          if (m === undefined) continue;
          // The POOL went quiet before the horizon, though the window did not. Different fact.
          if (poolEndTs < target) bk.silent += 1;
          let ret: number;
          try {
            const s = priceSell({ base: m.b - bought.baseOut, quote: m.q + quoteAdded, virtualQuote: v }, bought.baseOut, fees);
            ret = Number(s.quoteOut - NOTIONAL) / Number(NOTIONAL);
          } catch { continue; }
          if (!Number.isFinite(ret)) continue;
          bk.rets.push(ret);
          const d = bk.days.get(day) ?? []; d.push(ret); bk.days.set(day, d);
        }
      }
    }
    byPool.clear();
  }
  console.log(`  ${label}: ${triggers.toLocaleString()} triggers`);
  return out;
}

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const mean = (a: number[]): number => { const s = a.filter(Number.isFinite); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
const wmean = (a: number[], p = 0.01): number => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  if (s.length < 20) return NaN;
  const k = Math.floor(p * (s.length - 1));
  const lo = s[k] ?? 0; const hi = s[s.length - 1 - k] ?? 0;
  return s.map((x) => (x < lo ? lo : x > hi ? hi : x)).reduce((x, y) => x + y, 0) / s.length;
};
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');
/** Share of the raw mean contributed by the largest 1% of outcomes. A lottery reads near 100%. */
const topShare = (a: number[]): number => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => y - x);
  if (s.length < 50) return NaN;
  const k = Math.max(1, Math.floor(0.01 * s.length));
  const tot = s.reduce((x, y) => x + y, 0);
  if (!(Math.abs(tot) > 0)) return NaN;
  return 100 * s.slice(0, k).reduce((x, y) => x + y, 0) / tot;
};

console.log('MT127 — the incumbent 120s-3600s window, measured on its own terms');
console.log('  fee model CORRECTED: observed charge passed unclamped (MT123 clamped it at 25 bps)');
console.log('  prediction recorded before running: NEGATIVE');
console.log('');
const fit = await run(FIT, 'FIT   (8 staggered windows)');
const val = await run(VAL, 'VALID (6 staggered windows)');

const table = (label: string, m: Map<number, Bucket>): void => {
  console.log('');
  console.log(label);
  console.log('  hold        n     median       MEAN  WINSOR-1%  WINSOR-5% WINSOR-10%   %pos  daysPos  top1%ofMean  censored  silent');
  for (const h of HORIZONS) {
    const e = m.get(h);
    if (e === undefined) continue;
    const dp = [...e.days.values()].filter((d) => d.length >= 5);
    const pos = dp.filter((d) => (d.length >= 20 ? wmean(d) > 0 : mean(d) > 0)).length;
    const pct = e.rets.length ? (100 * e.rets.filter((x) => x > 0).length / e.rets.length).toFixed(1) : 'n/a';
    const ts = topShare(e.rets);
    console.log(`  ${String(h).padStart(4)}s ${String(e.rets.length).padStart(6)}  ${F(med(e.rets))}  ${F(mean(e.rets))}  ${F(wmean(e.rets, 0.01))}  ${F(wmean(e.rets, 0.05))}  ${F(wmean(e.rets, 0.10))}  ${pct.padStart(5)}%  ${String(pos)}/${String(dp.length)}  ${(Number.isFinite(ts) ? ts.toFixed(0) + '%' : 'n/a').padStart(10)}  ${String(e.censored).padStart(8)}  ${String(e.silent).padStart(6)}`);
  }
};
table('FIT', fit);
table('VALIDATION', val);

console.log('');
const anyPos = HORIZONS.filter((h) => {
  const e = fit.get(h);
  return e !== undefined && wmean(e.rets, 0.10) > 0;
});
if (anyPos.length === 0) {
  console.log(`VERDICT: CLOSED NEGATIVE — 0 of ${HORIZONS.length} horizons positive on fit.`);
  console.log('  The incumbent window is negative at every horizon it declares.');
} else {
  console.log(`CANDIDATE horizons positive on fit: ${anyPos.join('s, ')}s — check the VALIDATION rows above.`);
  console.log(`  ${anyPos.length} of ${HORIZONS.length} cells; that is the multiplicity bar.`);
}
console.log('');
console.log('READ THE CENSORED AND wentSilent COLUMNS BEFORE THE RETURN COLUMNS. A horizon whose');
console.log('censored count dwarfs its n is measuring the few pools that stayed alive and printing,');
console.log('which is a survivorship-selected sample and not the population a live entry would face.');
