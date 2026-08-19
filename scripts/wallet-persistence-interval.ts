/**
 * MT073 H1 — the day-clustered interval, computed offline from the Dune panel.
 *
 * Query 3 returns per-(day, cohort, project) sufficient statistics for a mean:
 * n and sum. That is everything a day-clustered bootstrap of a mean needs, and
 * exporting one row per position instead would have cost more Dune credits than
 * the month allows while producing the identical interval — see
 * `clusterBootstrapAggregated`, whose unit test asserts that equality exactly
 * against the same `clusterBootstrap` Phase B used.
 *
 * THE PREREGISTERED RULE, and only it, decides H1:
 *
 *   MT073 metric: "mean return per position per wallet in the holdout, by fit
 *   decile, on a day-clustered 95% lower bound". Hypothesis: "the top decile by
 *   fit rank beats the rest in the holdout". action_taken froze "ranking on mean
 *   return per position with the median ranking reported beside it".
 *
 * So the test is the DIFFERENCE, top decile minus the rest, ranked on the fit
 * MEAN, and it passes only if the day-clustered 95% lower bound of that difference
 * is above zero.
 *
 * The median-ranked cut is reported beside it exactly as the ledger says, and it
 * is not a second chance for H1 to pass. It matters for a specific reason: query 1
 * found the mean of `ret_carryfwd` contaminated by residual marks on open pumpswap
 * positions, so the preregistered ranking statistic is partly a measurement
 * artifact, while a wallet's median across 20+ positions cannot be moved by one
 * bad mark. Agreement between the two cuts is therefore evidence that the result
 * is not the artifact; disagreement would have meant the preregistered test was
 * measuring the defect.
 *
 * Everything under "descriptive" is description. The per-project cut, the
 * SOL-weighted variant, and the level against the 2.69% round-trip floor (MT075)
 * are informative about magnitude and robustness and are NOT tests.
 *
 * Usage: pnpm wallet:interval [path-to-q3-results.json]
 */
import { readFileSync } from 'node:fs';
import {
  clusterBootstrapAggregated,
  clusterBootstrapDifference,
  type ClusterAggregate,
} from '../packages/research/src/robust-stats.js';

/** The D70B4A9A 1.1 round-trip cost floor, at the frozen notional. MT075. */
const ROUND_TRIP_FLOOR = 0.0269;
const RESAMPLES = 10_000;

/**
 * The four-way cohort. `top by mean` and `top by median` are unions of these, so
 * one export answers both the preregistered cut and the robust cut.
 */
type Cohort = 'TOP_BOTH' | 'TOP_MEAN_ONLY' | 'TOP_MEDIAN_ONLY' | 'REST_NEITHER';

interface PanelRow {
  readonly utc_day: string;
  readonly cohort: Cohort;
  readonly entry_project: string;
  /** Every holdout position in the cell, before any exclusion. */
  readonly n_all: number;
  readonly n_external_inflow: number;
  readonly n_below_min_size: number;
  readonly n_unmarkable: number;
  readonly wallets: number;
  /** The estimation set: in scope, own funding, usable mark. */
  readonly n: number;
  readonly n_positive: number;
  readonly sum_ret: number;
  readonly sum_ret_sq: number;
  readonly sum_ret_zero: number;
  readonly sum_sol_in: number;
  readonly sum_ret_times_sol_in: number;
  readonly median_ret: number | null;
  /** Sold >= 99% of what was bought: a realised return with no mark in it. */
  readonly n_closed: number;
  readonly sum_ret_closed: number;
  readonly sum_sol_in_closed: number;
}

const path = process.argv[2] ?? 'ops/dune/results/q3-holdout-day-panel.json';
const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
  execution_id?: string;
  query_id?: number;
  result: { rows: PanelRow[] };
};
const rows = parsed.result.rows;
const days = [...new Set(rows.map((r) => r.utc_day.slice(0, 10)))].sort();
const projects = [...new Set(rows.map((r) => r.entry_project))].sort();

const day = (r: PanelRow): string => r.utc_day.slice(0, 10);
const pct = (x: number | null): string =>
  x === null ? '     n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const tot = (where: (r: PanelRow) => boolean, f: (r: PanelRow) => number): number =>
  rows.filter(where).reduce((a, r) => a + f(r), 0);

type Pred = (r: PanelRow) => boolean;
const TOP_BY_MEAN: Pred = (r) => r.cohort === 'TOP_BOTH' || r.cohort === 'TOP_MEAN_ONLY';
const TOP_BY_MEDIAN: Pred = (r) => r.cohort === 'TOP_BOTH' || r.cohort === 'TOP_MEDIAN_ONLY';
const not = (p: Pred): Pred => (r) => !p(r);
const and = (a: Pred, b: Pred): Pred => (r) => a(r) && b(r);

type Weighting = 'EQUAL' | 'SOL';

/**
 * A cohort as per-day (n, sum) pairs.
 *
 * `weighting` picks the unit: EQUAL gives one weight per position, which is the
 * preregistered "mean return per position"; SOL weights by size, which answers a
 * different question (what a capital-weighted copier would have earned).
 *
 * `net` subtracts the round-trip floor from every position, which shifts the mean
 * by a constant and therefore cancels exactly in a difference — the reason MT074
 * had to be split into a difference test and a level test.
 */
const aggregates = (where: Pred, weighting: Weighting, net: boolean): ClusterAggregate[] =>
  rows.filter(where).map((r) => {
    const weight = weighting === 'EQUAL' ? r.n : r.sum_sol_in;
    const sum = weighting === 'EQUAL' ? r.sum_ret : r.sum_ret_times_sol_in;
    return { cluster: day(r), n: weight, sum: sum - (net ? ROUND_TRIP_FLOOR * weight : 0) };
  });

/** Realised only: sold >= 99% of what was bought, so no mark enters the return. */
const closedOnly = (where: Pred): ClusterAggregate[] =>
  rows.filter(where).map((r) => ({ cluster: day(r), n: r.n_closed, sum: r.sum_ret_closed }));

/**
 * Unmarkable positions added back at -100%.
 *
 * The top cohort loses a larger fraction of its positions to unmarkability than
 * the rest does, so those exclusions are not neutral — they are the one channel
 * that could generate this result on its own. Deliberately over-conservative:
 * `n_unmarkable` counts unmarkable rows including ones also excluded as dust or
 * externally funded, so more -100% rows are added back than were dropped, and
 * more to the top cohort than to the rest.
 */
const unmarkableDead = (where: Pred): ClusterAggregate[] =>
  rows.filter(where).map((r) => ({
    cluster: day(r),
    n: r.n + r.n_unmarkable,
    sum: r.sum_ret - r.n_unmarkable,
  }));

console.log(`MT073 H1 — day-clustered 95% intervals from ${path}`);
console.log(`  dune query ${parsed.query_id ?? '?'} execution ${parsed.execution_id ?? '?'}`);
console.log(
  `  ${rows.length} (day, cohort, project) cells, ${days.length} UTC days, ${RESAMPLES} resamples\n`,
);

// -------------------------------------------------------------------------
// Composition, including what was excluded and at what rate per cohort
// -------------------------------------------------------------------------
// `wallets` is COUNT(DISTINCT trader_id) WITHIN a (day, cohort, project) cell, so
// summing it counts a wallet once per day it traded on each venue. It is labelled
// wal-days for that reason and it is NOT a wallet count.
console.log('  the four-way cohort, and what was excluded from each');
console.log(
  '    cohort            kept n  wal-days   ext_inflow   dust  UNMARKABLE  closed  positive   mean ret',
);
for (const c of ['TOP_BOTH', 'TOP_MEAN_ONLY', 'TOP_MEDIAN_ONLY', 'REST_NEITHER'] as const) {
  const w: Pred = (r) => r.cohort === c;
  const all = tot(w, (r) => r.n_all);
  const n = tot(w, (r) => r.n);
  const share = (f: (r: PanelRow) => number): string => `${((tot(w, f) / all) * 100).toFixed(2)}%`;
  console.log(
    `    ${c.padEnd(16)} ${String(n).padStart(8)}  ${String(tot(w, (r) => r.wallets)).padStart(7)}` +
      `      ${share((r) => r.n_external_inflow).padStart(6)} ${share((r) => r.n_below_min_size).padStart(6)}` +
      `      ${share((r) => r.n_unmarkable).padStart(6)}` +
      `  ${((tot(w, (r) => r.n_closed) / n) * 100).toFixed(1)}%` +
      `    ${((tot(w, (r) => r.n_positive) / n) * 100).toFixed(1)}%` +
      `   ${pct(tot(w, (r) => r.sum_ret) / n).padStart(8)}`,
  );
}
console.log(
  '\n    TOP_MEAN_ONLY vs TOP_MEDIAN_ONLY is the interesting row pair: they are the wallets the two',
  '\n    ranking statistics disagree about, so whichever performs better in the holdout is the better',
  '\n    predictor. Query 1 found the mean contaminated, which predicts TOP_MEDIAN_ONLY wins.',
);

// -------------------------------------------------------------------------
// The test, then the same test on the robust cut
// -------------------------------------------------------------------------
const battery = (label: string, isTop: Pred): void => {
  const isRest = not(isTop);
  const main = clusterBootstrapDifference(
    aggregates(isTop, 'EQUAL', false),
    aggregates(isRest, 'EQUAL', false),
    RESAMPLES,
  );
  const passes = main.point !== null && main.lower > 0;
  console.log(`\n  ${label}`);
  console.log(
    `    difference in mean return per position   ${pct(main.point).padStart(8)}   [${pct(main.lower)}, ${pct(main.upper)}]` +
      `   days paired ${main.daysBothPresent}/${days.length}`,
  );
  console.log(`    lower bound above zero: ${passes ? 'YES' : 'NO'}`);

  const show = (l: string, iv: { point: number | null; lower: number; upper: number }): void => {
    console.log(`      ${l.padEnd(44)} ${pct(iv.point).padStart(8)}   [${pct(iv.lower)}, ${pct(iv.upper)}]`);
  };
  show('top level, gross of our costs', clusterBootstrapAggregated(aggregates(isTop, 'EQUAL', false), RESAMPLES));
  show('top level, net of the 2.69% floor', clusterBootstrapAggregated(aggregates(isTop, 'EQUAL', true), RESAMPLES));
  show('rest level, gross', clusterBootstrapAggregated(aggregates(isRest, 'EQUAL', false), RESAMPLES));
  show('difference, SOL-weighted', clusterBootstrapDifference(aggregates(isTop, 'SOL', false), aggregates(isRest, 'SOL', false), RESAMPLES));
  show('difference, CLOSED only (no marks at all)', clusterBootstrapDifference(closedOnly(isTop), closedOnly(isRest), RESAMPLES));
  show('difference, unmarkable back at -100%', clusterBootstrapDifference(unmarkableDead(isTop), unmarkableDead(isRest), RESAMPLES));
  show(
    'top level, unmarkable dead, net of floor',
    clusterBootstrapAggregated(
      unmarkableDead(isTop).map((a) => ({ ...a, sum: a.sum - ROUND_TRIP_FLOOR * a.n })),
      RESAMPLES,
    ),
  );
  show(
    'difference, unsold remainder worthless',
    clusterBootstrapDifference(
      rows.filter(isTop).map((r) => ({ cluster: day(r), n: r.n, sum: r.sum_ret_zero })),
      rows.filter(isRest).map((r) => ({ cluster: day(r), n: r.n, sum: r.sum_ret_zero })),
      RESAMPLES,
    ),
  );
  for (const p of projects) {
    const inProject: Pred = (r) => r.entry_project === p;
    show(
      `difference, entry_project=${p}`,
      clusterBootstrapDifference(
        aggregates(and(isTop, inProject), 'EQUAL', false),
        aggregates(and(isRest, inProject), 'EQUAL', false),
        RESAMPLES,
      ),
    );
  }

  // Per-day sign count and drop-the-best-day, because an interval says nothing
  // about whether one day carried the result.
  const perDay = days.map((d) => {
    const onDay: Pred = (r) => day(r) === d;
    const m = (p: Pred): number => tot(and(onDay, p), (r) => r.sum_ret) / tot(and(onDay, p), (r) => r.n);
    return { d, diff: m(isTop) - m(isRest) };
  });
  const ranked = [...perDay].sort((a, b) => b.diff - a.diff);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  console.log(
      `      per-day difference positive on ${perDay.filter((x) => x.diff > 0).length}/${perDay.length} days` +
      `  (best ${best?.d} ${pct(best?.diff ?? null)}, worst ${worst?.d} ${pct(worst?.diff ?? null)})`,
  );
  const keep: Pred = (r) => day(r) !== best?.d;
  const dropBest = clusterBootstrapDifference(
    aggregates(and(isTop, keep), 'EQUAL', false),
    aggregates(and(isRest, keep), 'EQUAL', false),
    RESAMPLES,
  );
  show('difference, dropping the single best day', dropBest);
};

battery('PREREGISTERED TEST — top decile ranked on the fit MEAN (MT073 as frozen)', TOP_BY_MEAN);
battery('REPORTED BESIDE IT — top decile ranked on the fit MEDIAN (robust to the query 1 defect)', TOP_BY_MEDIAN);

console.log('\n  WHAT THESE INTERVALS DO NOT COVER');
console.log('    - Our entry price. Every return here is the WALLET position at ITS OWN fill. A copier');
console.log('      enters after it, in the same pool, against the impact it just caused. Quote-to-land');
console.log('      slippage and crowding are UNKNOWN (MT072) and they bite hardest exactly here.');
console.log('    - Survival. A wallet contributes holdout positions only if it traded in the holdout, and');
console.log('      query 2 found the top deciles vanish FASTEST. This is the return conditional on the');
console.log('      wallet still being there, which is the right conditional for a copier and is not the');
console.log('      unconditional return of the cohort.');
console.log('    - Rotation. Stopped, rotated to a new address, and blew up are one column in this data');
console.log('      and cannot be separated (MT073 notes). Persistence OF ADDRESSES is what is measured.');
console.log('    - A median or a percentile: not a function of (n, sum), so not available from this panel.');
