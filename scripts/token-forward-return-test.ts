/**
 * MT074 H2 — does a top-decile wallet buying in a token's first 10 minutes
 * predict that TOKEN's forward return, t0+10m mark to t0+70m mark.
 *
 * This is the version that maps onto the apparatus: it is a screening feature, it
 * needs no latency race, and it does not require getting the wallet's own fill.
 *
 * THE PREREGISTERED RULE IS TWO TESTS AND BOTH ARE REQUIRED (MT074 action_taken):
 *
 *   TEST A, the difference: TOP_PRESENT minus NO_RANKED_WALLET must exceed ZERO
 *   on a day-clustered 95% lower bound.
 *   TEST B, the level: TOP_PRESENT's own mean must exceed the round-trip floor for
 *   the tier those pools are in, on the same basis.
 *
 * The control is NO_RANKED_WALLET only. RANKED_NOT_TOP is a third population and
 * pooling it into the control would make the control a mixture — that was one of
 * the corrections to the delivered SQL, and it is reported here separately rather
 * than folded in.
 *
 * CENSORING IS THE WHOLE PROBLEM WITH THIS TEST AND IT IS NOT HIDDEN HERE.
 *
 * A mint has no exit price when nobody traded it in the t0+70m..t0+72m window. On
 * this sample that is 85-97% of mints off the AMM and 37-67% on it. `AVG` drops
 * those rows silently, which is why the query returns the count instead of the
 * average, and why every statistic below is computed twice:
 *
 *   AS PRICED  — censored mints excluded. This is what an AVG would report, and it
 *                is a survivor-only statistic: a token still trading an hour later
 *                is a different token from the median launch.
 *   DEAD       — censored mints entered at -100%. Not literally true (a position
 *                may be exitable at some price between the marks) but it is the
 *                right direction and it bounds the survivor bias.
 *
 * Neither is the truth. If the two disagree in sign, the test has no answer on this
 * data, and saying so is the result.
 *
 * Usage: pnpm token:h2 [path-to-q4-results.json]
 */
import { readFileSync } from 'node:fs';
import {
  clusterBootstrapAggregated,
  clusterBootstrapDifference,
  type ClusterAggregate,
} from '../packages/research/src/robust-stats.js';

/** MT075. The same floor the level test in MT074 names. */
const ROUND_TRIP_FLOOR = 0.0269;
const RESAMPLES = 10_000;

type Cohort =
  | 'TOP_BOTH'
  | 'TOP_MEAN_ONLY'
  | 'TOP_MEDIAN_ONLY'
  | 'RANKED_NOT_TOP'
  | 'NO_RANKED_WALLET';

interface Row {
  readonly utc_day: string;
  readonly cohort: Cohort;
  /** 1 if the mint was trading on pumpswap at the entry mark: the enterable side. */
  readonly amm_at_entry: number;
  readonly mints: number;
  readonly n_censored: number;
  readonly n: number;
  readonly sum_ret: number;
  readonly sum_ret_sq: number;
  readonly n_positive: number;
  readonly median_ret: number | null;
  readonly median_early_buyers: number | null;
}

const path = process.argv[2] ?? 'ops/dune/results/q4-token-forward-return.json';
const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
  execution_id?: string;
  query_id?: number;
  result: { rows: Row[] };
};
const rows = parsed.result.rows;
const days = [...new Set(rows.map((r) => r.utc_day.slice(0, 10)))].sort();

const day = (r: Row): string => r.utc_day.slice(0, 10);
const pct = (x: number | null): string =>
  x === null ? '      n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
type Pred = (r: Row) => boolean;
const tot = (w: Pred, f: (r: Row) => number): number => rows.filter(w).reduce((a, r) => a + f(r), 0);
const and = (a: Pred, b: Pred): Pred => (r) => a(r) && b(r);

const TOP_BY_MEAN: Pred = (r) => r.cohort === 'TOP_BOTH' || r.cohort === 'TOP_MEAN_ONLY';
const TOP_BY_MEDIAN: Pred = (r) => r.cohort === 'TOP_BOTH' || r.cohort === 'TOP_MEDIAN_ONLY';
const CONTROL: Pred = (r) => r.cohort === 'NO_RANKED_WALLET';
const RANKED_NOT_TOP: Pred = (r) => r.cohort === 'RANKED_NOT_TOP';

/** Censored mints excluded, as an AVG would. */
const asPriced = (w: Pred): ClusterAggregate[] =>
  rows.filter(w).map((r) => ({ cluster: day(r), n: r.n, sum: r.sum_ret }));
/** Censored mints at -100%, bounding the survivor bias. */
const dead = (w: Pred): ClusterAggregate[] =>
  rows.filter(w).map((r) => ({ cluster: day(r), n: r.n + r.n_censored, sum: r.sum_ret - r.n_censored }));

console.log(`MT074 H2 — token forward return by early-buyer cohort, from ${path}`);
console.log(`  dune query ${parsed.query_id ?? '?'} execution ${parsed.execution_id ?? '?'}`);
console.log(`  ${rows.length} (day, cohort, venue) cells over ${days.length} UTC days, ${RESAMPLES} resamples\n`);

// -------------------------------------------------------------------------
// Base rates first. A flag that is almost always set cannot screen anything,
// and that is a property of the flag, not of the interval.
// -------------------------------------------------------------------------
const allMints = tot(() => true, (r) => r.mints);
console.log('  base rates — how often the flag is even set');
console.log('    cohort             mints   share   censored   priced   positive   median early buyers');
for (const c of ['TOP_BOTH', 'TOP_MEAN_ONLY', 'TOP_MEDIAN_ONLY', 'RANKED_NOT_TOP', 'NO_RANKED_WALLET'] as const) {
  const w: Pred = (r) => r.cohort === c;
  const m = tot(w, (r) => r.mints);
  const n = tot(w, (r) => r.n);
  const meds = rows.filter(w).map((r) => r.median_early_buyers).filter((x): x is number => x !== null).sort((a, b) => a - b);
  console.log(
    `    ${c.padEnd(17)} ${String(m).padStart(6)}  ${((m / allMints) * 100).toFixed(1).padStart(5)}%` +
      `   ${((tot(w, (r) => r.n_censored) / m) * 100).toFixed(1).padStart(5)}%` +
      `   ${String(n).padStart(6)}` +
      `   ${((tot(w, (r) => r.n_positive) / Math.max(n, 1)) * 100).toFixed(1).padStart(5)}%` +
      `      ${meds.length === 0 ? 'n/a' : (meds[Math.floor(meds.length / 2)] as number).toFixed(0)}`,
  );
}
const topShare = tot(TOP_BY_MEAN, (r) => r.mints) / allMints;
console.log(
  `\n    A top-decile wallet (mean-ranked) bought inside the first 10 minutes of ${(topShare * 100).toFixed(1)}% of all mints.`,
);
console.log('    SELECTIVITY IS THE FIRST THING THAT HAS TO HOLD and it does not. The frozen threshold is the');
console.log('    top 10% of the 211,225 wallets with 20+ fit positions, so 21,123 flagged addresses, and the');
console.log('    median flagged mint had 80 distinct flagged wallets buy inside its first 10 minutes. A');
console.log('    feature that is set on 4 of every 5 tokens cannot admit a subset of them.');

// -------------------------------------------------------------------------
// The two tests, applied as written, on both censoring treatments
// -------------------------------------------------------------------------
const line = (l: string, iv: { point: number | null; lower: number; upper: number }): void => {
  console.log(`      ${l.padEnd(40)} ${pct(iv.point).padStart(9)}   [${pct(iv.lower)}, ${pct(iv.upper)}]`);
};

const runTests = (label: string, isTop: Pred, venue: Pred, venueLabel: string): void => {
  console.log(`\n  ${label}  —  ${venueLabel}`);
  for (const [treatment, build] of [
    ['AS PRICED (censored dropped)', asPriced],
    ['DEAD (censored at -100%)', dead],
  ] as const) {
    const top = build(and(isTop, venue));
    const ctl = build(and(CONTROL, venue));
    const a = clusterBootstrapDifference(top, ctl, RESAMPLES);
    const b = clusterBootstrapAggregated(top, RESAMPLES);
    const passA = a.point !== null && a.lower > 0;
    const passB = b.point !== null && b.lower > ROUND_TRIP_FLOOR;
    console.log(`    ${treatment}`);
    line('TEST A  top minus no-ranked-wallet', a);
    console.log(`        A passes (lower bound > 0): ${passA ? 'YES' : 'NO'}   days paired ${a.daysBothPresent}/${days.length}`);
    line('TEST B  top level', b);
    console.log(
      `        B passes (lower bound > ${(ROUND_TRIP_FLOOR * 100).toFixed(2)}%): ${passB ? 'YES' : 'NO'}`,
    );
    console.log(`        BOTH REQUIRED -> H2 ${passA && passB ? 'NOT REJECTED' : 'REJECTED'} on this treatment`);
    line('  control level, for context', clusterBootstrapAggregated(ctl, RESAMPLES));
    line('  ranked-not-top level, for context', clusterBootstrapAggregated(build(and(RANKED_NOT_TOP, venue)), RESAMPLES));
  }
  // Per-day medians, because the means below are not trustworthy on this sample.
  const medOf = (w: Pred): string => {
    const xs = rows.filter(and(w, venue)).map((r) => r.median_ret).filter((x): x is number => x !== null).sort((p, q) => p - q);
    return xs.length === 0 ? 'n/a' : pct(xs[Math.floor(xs.length / 2)] as number);
  };
  console.log(`      median of the per-day medians:  top ${medOf(isTop)}   control ${medOf(CONTROL)}`);
};

const AMM: Pred = (r) => r.amm_at_entry === 1;
const CURVE: Pred = (r) => r.amm_at_entry === 0;

runTests('PREREGISTERED — flag = mean-ranked top decile', TOP_BY_MEAN, AMM, 'on the AMM at the entry mark (the enterable side)');
runTests('PREREGISTERED — flag = mean-ranked top decile', TOP_BY_MEAN, CURVE, 'still on the curve at the entry mark (NOT enterable by this apparatus)');
runTests('reported beside it — flag = median-ranked top decile', TOP_BY_MEDIAN, AMM, 'on the AMM at the entry mark');

// -------------------------------------------------------------------------
// Why the means cannot be read at face value
// -------------------------------------------------------------------------
const worst = [...rows].sort((a, b) => b.sum_ret / Math.max(b.n, 1) - a.sum_ret / Math.max(a.n, 1))[0];
console.log('\n  WHY THE POINT ESTIMATES ABOVE ARE NOT USABLE NUMBERS');
console.log(
  `    - The largest cell mean is ${pct(worst === undefined ? null : worst.sum_ret / Math.max(worst.n, 1))} on ${worst?.n ?? 0} mints` +
    ` (${worst?.cohort ?? '?'}, ${worst?.utc_day.slice(0, 10) ?? '?'}, amm=${worst?.amm_at_entry ?? '?'}).`,
);
console.log('      A ratio of two 2-minute VWAPs on a token with almost no volume is unbounded above and');
console.log('      bounded at -100% below, so a cell mean is a tail draw, not a central tendency.');
console.log('    - Censoring runs 37% to 97% by cohort and venue, and it is NOT independent of the flag:');
console.log('      the flagged cohorts are the larger launches, which survive to the exit mark more often.');
console.log('      That correlation is the survivor bias the DEAD treatment exists to bound.');
console.log('    - Both treatments must agree in sign for the test to have an answer. Where they do not,');
console.log('      H2 is not decidable on this data and no threshold search would make it so.');
