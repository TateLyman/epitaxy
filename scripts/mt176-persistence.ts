/**
 * MT176 — does being profitable in one period predict being profitable in the next?
 *
 * This is the test that decides whether "find the winners and copy them" is a strategy or a
 * superstition, and it is the only honest way to read MT175. That census found a top decile of
 * wallets that are not slot-zero, win 64% of their closed positions and made about 1.14 SOL over a
 * 0.8-day window. Nothing about that is evidence of skill. In any population of 30,000 wallets
 * trading a volatile asset for a day, a top decile EXISTS BY CONSTRUCTION and will look excellent in
 * hindsight whether or not anyone in it can do anything.
 *
 * SKILL PERSISTS AND LUCK DOES NOT. So rank wallets by realised profit in period one, then look at
 * what those same wallets earn in a LATER, NON-OVERLAPPING period. If the top decile of period one
 * goes on to earn more than the bottom decile in period two, there is something in the wallet - a
 * behaviour, an edge, an information source - and copying it is at least a coherent idea. If the
 * deciles converge, then last period's ranking carries no information about next period, the winners
 * were the tail of a distribution rather than a group of people doing something, and there is
 * nothing to copy no matter how impressive the leaderboard looks.
 *
 * THIS IS ALSO THE TEST THAT SURVIVES SURVIVORSHIP BIAS. Every wallet present in period one is
 * carried into period two, including the ones that stopped trading or blew up, so the measurement
 * cannot be flattered by quietly dropping the failures the way a leaderboard does.
 *
 * The accounting is MT175's, and it keeps MT175's control: only inventory whose purchase AND sale
 * were both observed is scored, because a sell is not evidence of a purchase and booking uncosted
 * proceeds as profit produced a venue-wide +661,755 SOL in the first version of that census.
 *
 * Reads tape. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const P1 = (arg('p1') ?? 'D0,D1,D2,D3').split(',').filter((s) => s.length > 0);
const P2 = (arg('p2') ?? 'D4,D5,D6,D7').split(',').filter((s) => s.length > 0);
/** A wallet must have closed this many positions in a period for that period's number to be quoted. */
const MIN_CLOSED = Number(arg('min-closed') ?? '3');
const CACHE = 'data/trade-cache';

interface Leg { qIn: number; qOut: number; bIn: number; bOut: number }
interface P { pnl: number; closed: number; wins: number }

async function period(windows: string[]): Promise<{ per: Map<string, P>; aggregate: number; trades: number }> {
  const legs = new Map<string, Leg>();
  let trades = 0;
  for (const w of windows) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) { console.log(`  missing ${f}`); continue; }
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
      try { r = JSON.parse(line) as typeof r; } catch { continue; }
      const user = r[13]; const uq = Number(r[9]); const base = Number(r[14]);
      if (user === undefined || !Number.isFinite(uq) || !Number.isFinite(base)) continue;
      trades += 1;
      const k = `${user}|${r[0]}`;
      let g = legs.get(k);
      if (g === undefined) { g = { qIn: 0, qOut: 0, bIn: 0, bOut: 0 }; legs.set(k, g); }
      if (r[5] === 1) { g.qIn += uq; g.bIn += base; } else { g.qOut += uq; g.bOut += base; }
    }
    rl.close();
  }
  const per = new Map<string, P>();
  let aggregate = 0;
  for (const [k, g] of legs) {
    const user = k.slice(0, k.indexOf('|'));
    /** Only inventory whose purchase and sale were both observed. See the note above. */
    const matched = Math.min(g.bIn, g.bOut);
    const realised = matched <= 0 ? 0 : g.qOut * (matched / g.bOut) - g.qIn * (matched / g.bIn);
    aggregate += realised;
    let p = per.get(user);
    if (p === undefined) { p = { pnl: 0, closed: 0, wins: 0 }; per.set(user, p); }
    p.pnl += realised;
    if (g.bIn > 0 && g.bOut > 0) { p.closed += 1; if (realised > 0) p.wins += 1; }
  }
  return { per, aggregate, trades };
}

console.log(`MT176 — persistence of realised profit`);
console.log(`  period 1: ${P1.join(',')}`);
console.log(`  period 2: ${P2.join(',')}`);
const a = await period(P1);
const b = await period(P2);
const SOL = (x: number): string => (x / 1e9).toFixed(3);
console.log('');
console.log(`  period 1: ${a.trades.toLocaleString()} trades, ${a.per.size.toLocaleString()} wallets, aggregate ${SOL(a.aggregate)} SOL`);
console.log(`  period 2: ${b.trades.toLocaleString()} trades, ${b.per.size.toLocaleString()} wallets, aggregate ${SOL(b.aggregate)} SOL`);
if (a.aggregate > 0 || b.aggregate > 0) {
  console.log('  REFUSED: an aggregate is positive, so the accounting is wrong and nothing below it holds.');
  process.exit(1);
}

/** Carried forward whether or not they kept trading, so failures cannot be quietly dropped. */
const cohort = [...a.per.entries()].filter(([, p]) => p.closed >= MIN_CLOSED);
cohort.sort((x, y) => y[1].pnl - x[1].pnl);
console.log('');
console.log(`  cohort: ${cohort.length.toLocaleString()} wallets with >=${MIN_CLOSED} closed positions in period 1`);
const still = cohort.filter(([u]) => b.per.has(u)).length;
console.log(`  of those, ${still.toLocaleString()} (${(100 * still / cohort.length).toFixed(1)}%) traded again in period 2`);
console.log('');

const med = (arr: number[]): number => { if (arr.length === 0) return NaN; const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };
const mean = (arr: number[]): number => (arr.length === 0 ? NaN : arr.reduce((x, y) => x + y, 0) / arr.length);

console.log('  Ranked by PERIOD 1 profit. The question is what they earn in PERIOD 2.');
console.log('');
console.log('  period-1 decile      n     p1 median      p2 median       p2 mean    p2 %positive   returned');
const D = 10;
for (let i = 0; i < D; i += 1) {
  const lo = Math.floor((i * cohort.length) / D);
  const hi = Math.floor(((i + 1) * cohort.length) / D);
  const slice = cohort.slice(lo, hi);
  if (slice.length === 0) continue;
  const p1 = slice.map(([, p]) => p.pnl);
  /** Absent from period 2 means they earned nothing in it, not that they are excluded. */
  const p2 = slice.map(([u]) => b.per.get(u)?.pnl ?? 0);
  const ret = slice.filter(([u]) => b.per.has(u)).length;
  const pos = p2.filter((x) => x > 0).length;
  console.log(
    `  ${(i === 0 ? 'top 10%' : i === D - 1 ? 'bottom 10%' : `decile ${i + 1}`).padEnd(16)} ${String(slice.length).padStart(6)}  ` +
    `${SOL(med(p1)).padStart(11)}  ${SOL(med(p2)).padStart(12)}  ${SOL(mean(p2)).padStart(12)}  ` +
    `${(100 * pos / p2.length).toFixed(1).padStart(11)}%  ${(100 * ret / slice.length).toFixed(0).padStart(7)}%`,
  );
}

/** Spearman rank correlation between the two periods, over wallets present in both. */
const both = cohort.filter(([u]) => b.per.has(u));
const rank = (vals: number[]): number[] => {
  const idx = vals.map((v, i) => [v, i] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(vals.length);
  idx.forEach(([, i], r) => { out[i] = r; });
  return out;
};
if (both.length > 10) {
  const r1 = rank(both.map(([, p]) => p.pnl));
  const r2 = rank(both.map(([u]) => b.per.get(u)?.pnl ?? 0));
  const n = both.length;
  const m1 = mean(r1); const m2 = mean(r2);
  let num = 0; let d1 = 0; let d2 = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (r1[i] ?? 0) - m1; const y = (r2[i] ?? 0) - m2;
    num += x * y; d1 += x * x; d2 += y * y;
  }
  const rho = num / Math.sqrt(d1 * d2);
  console.log('');
  console.log(`  Spearman rank correlation of profit between periods, over the ${n.toLocaleString()} wallets in both: ${rho.toFixed(4)}`);
  console.log('  Near zero means last period\'s ranking carries no information about the next one.');
}
