/**
 * MT133 — the one axis the reversion family never varied.
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT133 before this file existed, including the
 * prediction that the decay ratio is flat and every decision-bearing cell is negative.
 *
 * MT117 established TWO things and followed only one. It established that the reversion is real
 * at ~95 bps gross AND SCALES WITH IMPACT, and that it decays 79 bps inside the first second. It
 * followed the decay and closed the family. It never varied the impact bar — and `MT119` states
 * the omission outright: "the depth cut of 120 SOL, the arrival cut of 1 second, the 2 second
 * delay, the 15 second hold and the 5% impact bar are all carried over UNCHANGED". Every script
 * in the family hardcodes `IMPACT_BAR = 0.05`. The family measured ONE point on the impact axis,
 * twelve times.
 *
 * THE MECHANISM THAT WOULD MAKE SIZE MATTER IS PHYSICAL, not statistical: arbitraging a
 * dislocation back requires capital proportional to its size, so a large one should take longer
 * to absorb. If the DECAY RATE is slower at large impact — not merely the level higher — the
 * profitable window widens with size and a reachable entry delay can sit inside it.
 *
 * THE DECAY RATIO IS THE DISCRIMINATOR, and the arithmetic is decided in advance. At the 5% bar
 * MT117 implies gross(2s)/gross(0s) ≈ 0.02. If that ratio is FLAT across bins the hypothesis is
 * dead regardless of levels: clearing a 71 bps floor at two seconds would need a 0-second gross
 * of ~3,550 bps, which at 93.7 bps per 5% of impact means ~190% impact, and no such event exists.
 * Only a RISING ratio can save it.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const NOTIONAL = 20_000_000n;
const HOLD_S = 15;
const V_CANDIDATES = [0n, 17_584_500_000n];
const DELAYS = [0, 1, 2, 5];
/** Frozen bins. Lower bound inclusive, upper exclusive. */
const BINS: [string, number, number][] = [
  ['5-10%', 0.05, 0.10],
  ['10-20%', 0.10, 0.20],
  ['20-40%', 0.20, 0.40],
  ['>40%', 0.40, Infinity],
];

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '1,2,3,4,5,6,7,8,9,10,11,12').split(',').filter((s) => s.length > 0);
const SIDE = arg('side') ?? 'down';                 // 'down' = reversion; 'up' = the MT123 control

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; big: bigint; small: bigint }

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

/** key = `${bin}|${delay}` */
const net = new Map<string, number[]>();
const gross = new Map<string, number[]>();
const days = new Map<string, Map<string, number[]>>();
const push = (m: Map<string, number[]>, k: string, v: number): void => { const a = m.get(k) ?? []; a.push(v); m.set(k, a); };

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const byPool = new Map<string, Ev[]>();
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number];
    try { r = JSON.parse(line); } catch { continue; }
    const qa = BigInt(r[8]); const ua = BigInt(r[9]);
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1, b: BigInt(r[6]), q: BigInt(r[7]),
             big: qa > ua ? qa : ua, small: qa > ua ? ua : qa });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [, evs] of byPool) {
    if (evs.length < 40) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const v = resolveV(evs);
    if (v === null) continue;

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
    /** Zero-fee twin, so GROSS can be reported alongside NET and the decay ratio is fee-free. */
    const feesZero: PoolFeeLadder = {
      lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: 0n,
    };

    let lastEnd = -1;
    for (let i = 1; i + 1 < evs.length; i += 1) {
      const pre = evs[i]; const post = evs[i + 1];
      if (pre === undefined || post === undefined) continue;
      if (pre.b <= 0n || pre.q <= 0n || post.b <= 0n || post.q <= 0n) continue;
      const p0 = Number(pre.q + v) / Number(pre.b);
      const p1 = Number(post.q + v) / Number(post.b);
      if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0 || p1 <= 0) continue;
      const moved = p1 / p0 - 1;
      if (SIDE === 'down' ? !(moved < 0) : !(moved > 0)) continue;

      const rel = Math.abs(Number(post.q - pre.q)) / Number(pre.q);
      const bin = BINS.find(([, lo, hi]) => rel >= lo && rel < hi);
      if (bin === undefined) continue;
      if (post.ts < lastEnd) continue;
      lastEnd = post.ts + HOLD_S + 5;
      const day = new Date(post.ts * 1000).toISOString().slice(0, 10);

      for (const d of DELAYS) {
        let ei = -1;
        for (let j = i + 2; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= post.ts + d) { ei = j; break; } }
        if (ei < 0) continue;
        const entry = evs[ei];
        if (entry === undefined || entry.b <= 0n || entry.q <= 0n) continue;

        const run = (fl: PoolFeeLadder): number | null => {
          let bought;
          try { bought = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, fl); }
          catch (e) { if (e instanceof FillNotPriceable) return null; throw e; }
          const added = bought.reservesAfter.quote - entry.q;
          for (let j = ei + 1; j < evs.length; j += 1) {
            const m = evs[j];
            if (m === undefined) continue;
            if (m.ts < entry.ts + HOLD_S) continue;
            try {
              const s = priceSell({ base: m.b - bought.baseOut, quote: m.q + added, virtualQuote: v }, bought.baseOut, fl);
              const r = Number(s.quoteOut - NOTIONAL) / Number(NOTIONAL);
              return Number.isFinite(r) ? r : null;
            } catch { return null; }
          }
          return null;
        };
        const n0 = run(fees);
        const g0 = run(feesZero);
        if (n0 === null || g0 === null) continue;
        const k = `${bin[0]}|${d}`;
        push(net, k, n0); push(gross, k, g0);
        const dm = days.get(k) ?? new Map<string, number[]>();
        const dd = dm.get(day) ?? []; dd.push(n0); dm.set(day, dd); days.set(k, dm);
      }
    }
  }
  byPool.clear();
  console.log(`  w${w} done`);
}

const wmean = (a: number[], p = 0.10): number => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  if (s.length < 20) return NaN;
  const k = Math.floor(p * (s.length - 1));
  const lo = s[k] ?? 0; const hi = s[s.length - 1 - k] ?? 0;
  return s.map((x) => (x < lo ? lo : x > hi ? hi : x)).reduce((x, y) => x + y, 0) / s.length;
};
function dayBoot(byDay: Map<string, number[]> | undefined, iters = 2000): [number, number] {
  if (byDay === undefined) return [NaN, NaN];
  const dz = [...byDay.keys()];
  if (dz.length < 3) return [NaN, NaN];
  let seed = 20260822;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const draws: number[] = [];
  for (let it = 0; it < iters; it += 1) {
    const pool: number[] = [];
    for (let i = 0; i < dz.length; i += 1) {
      const pick = dz[Math.floor(rnd() * dz.length)];
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
const B = (v: number): string => (Number.isFinite(v) ? (1e4 * v).toFixed(0).padStart(8) : '     n/a');

console.log('');
console.log(`MT133 — impact sweep, side=${SIDE}, hold ${HOLD_S}s, cost = each pool's own observed charge`);
console.log('  prediction recorded before running: decay ratio FLAT, every decision cell negative');
console.log('');
console.log('  bin          delay        n   GROSS bps    NET bps      95% day-clustered CI on NET');
for (const [name] of BINS) {
  for (const d of DELAYS) {
    const k = `${name}|${d}`;
    const nn = net.get(k) ?? [];
    if (nn.length === 0) { console.log(`  ${name.padEnd(8)} ${String(d)}s ${String(0).padStart(9)}`); continue; }
    const [lo, hi] = d >= 2 ? dayBoot(days.get(k)) : [NaN, NaN];
    console.log(
      `  ${name.padEnd(8)} ${String(d)}s ${String(nn.length).padStart(9)}  ${B(wmean(gross.get(k) ?? []))}  ${B(wmean(nn))}` +
      `${d >= 2 ? `   [${B(lo)}, ${B(hi)}]` : '   (unreachable, not decision-bearing)'}` +
      `${nn.length < 100 ? '  UNDERPOWERED' : ''}`,
    );
  }
}

console.log('');
console.log('THE DECAY RATIO — gross at 2s divided by gross at 0s, per bin. THIS is the discriminator.');
for (const [name] of BINS) {
  const g0 = wmean(gross.get(`${name}|0`) ?? []);
  const g2 = wmean(gross.get(`${name}|2`) ?? []);
  const ratio = Number.isFinite(g0) && Number.isFinite(g2) && g0 !== 0 ? g2 / g0 : NaN;
  console.log(`  ${name.padEnd(8)} gross0 ${B(g0)}   gross2 ${B(g2)}   ratio ${Number.isFinite(ratio) ? ratio.toFixed(3) : 'n/a'}`);
}
console.log('');
console.log('  A FLAT ratio kills the hypothesis whatever the levels do: clearing a 71 bps floor at');
console.log('  two seconds would need ~3,550 bps of gross at zero, i.e. ~190% impact, which does not');
console.log('  exist. Only a RISING ratio means large dislocations take longer to absorb.');
console.log('');
const cands: string[] = [];
for (const [name] of BINS) for (const d of DELAYS) {
  if (d < 2) continue;
  const k = `${name}|${d}`;
  const nn = net.get(k) ?? [];
  if (nn.length < 100) continue;
  const [lo] = dayBoot(days.get(k));
  if (Number.isFinite(lo) && lo > 0) cands.push(`${name} @ ${d}s`);
}
console.log(cands.length === 0
  ? 'VERDICT: NOT SUPPORTED — no reachable cell clears zero on a day-clustered lower bound.'
  : `CANDIDATES: ${cands.join(', ')}  — re-probe the cost model on THOSE pools before reporting anything.`);
