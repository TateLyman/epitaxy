/**
 * MT092 — Phase G, the coverage-selected horizon.
 *
 * H* = 120s was committed to the ledger, and to the git history, from the output of a
 * query that returned COUNTS ONLY. This script reads the returns query and applies
 * MT079's four conditions at H*. Every other horizon is sensitivity, never a
 * candidate: a cell that fails at H* and passes at some other H is a failure.
 *
 * THE COVERAGE BAR IS APPLIED MECHANICALLY. H* reaches 90% both-legs-priced coverage
 * in exactly one arm (MEDIAN f=0.001, 95.6%). The other three top out at 87.9%, and
 * per the directive the bar is not lowered to what the best horizon achieved — their
 * estimates are recorded and NOT presented as estimates.
 *
 * WHAT THIS MEASURES THAT NOTHING ELSE HAS. Phase C reported +24.45% at t+3600s on 54%
 * coverage; the external interpolation guessed the fully-covered value at somewhere
 * between -18.1% and -2.5%. The coverage route measures it directly, because
 * coverage rises as the horizon shortens.
 *
 * Usage: pnpm horizon [path-to-q12-results.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { clusterBootstrapAggregated, type ClusterAggregate } from '../packages/research/src/robust-stats.js';
import { conditionsOf, type Conditions } from '../packages/research/src/copier-lag.js';
import { requiredPositions } from '../packages/domain/src/confirmatory.js';

/** Frozen in MT092 before any return was read. */
const H_STAR = 120;
const COVERAGE_BAR = 0.9;
/** Tier-0 round trip, the conservative and modal case. */
const FLOOR = 0.02669;
const RESAMPLES = 10_000;

interface Row {
  readonly utc_day: string;
  readonly rank_stat: 'MEAN' | 'MEDIAN';
  readonly top_fraction: number | string;
  readonly lag_s: number;
  readonly horizon_s: number;
  readonly n_followable: number;
  readonly n_truncated: number;
  readonly n_entry_priced: number;
  readonly n: number;
  readonly n_censored: number;
  readonly sum_ret: number;
  readonly sum_ret_sq: number;
  readonly n_positive: number;
  readonly median_ret: number | null;
  readonly sum_sol_in: number;
  readonly wallets: number;
}

const path = process.argv[2] ?? 'ops/dune/results/q12-returns-by-horizon.json';
const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
  execution_id?: string;
  query_id?: number;
  result: { rows: Row[] };
};
const rows = parsed.result.rows;
const day = (r: Row): string => r.utc_day.slice(0, 10);
const frac = (r: Row): number => Number(r.top_fraction);
const days = [...new Set(rows.map(day))].sort();
const pct = (x: number | null): string =>
  x === null || !Number.isFinite(x) ? '      n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

interface Cell {
  readonly rankStat: 'MEAN' | 'MEDIAN';
  readonly fraction: number;
  readonly lag: number;
  readonly horizon: number;
  readonly rows: readonly Row[];
}
const cells: Cell[] = [];
for (const rankStat of ['MEAN', 'MEDIAN'] as const) {
  for (const fraction of [...new Set(rows.map(frac))].sort((a, b) => a - b)) {
    for (const lag of [...new Set(rows.map((r) => r.lag_s))].sort((a, b) => a - b)) {
      for (const horizon of [...new Set(rows.map((r) => r.horizon_s))].sort((a, b) => a - b)) {
        const sel = rows.filter(
          (r) => r.rank_stat === rankStat && frac(r) === fraction && r.lag_s === lag && r.horizon_s === horizon,
        );
        if (sel.length > 0) cells.push({ rankStat, fraction, lag, horizon, rows: sel });
      }
    }
  }
}
const sum = (rs: readonly Row[], f: (r: Row) => number): number => rs.reduce((a, r) => a + f(r), 0);

/**
 * As-priced and censored-at--100% share ONE denominator, the enterable set
 * `n + n_censored`. The floor is charged only to positions that traded: a censored
 * position at -1.0 has already lost everything, and charging the floor on top would
 * report a loss larger than the capital deployed.
 */
const asPriced = (rs: readonly Row[]): ClusterAggregate[] =>
  rs.map((r) => ({ cluster: day(r), n: r.n, sum: r.sum_ret - FLOOR * r.n }));
const censored = (rs: readonly Row[]): ClusterAggregate[] =>
  rs.map((r) => ({
    cluster: day(r),
    n: r.n + r.n_censored,
    sum: r.sum_ret - FLOOR * r.n - r.n_censored,
  }));

const cvOf = (rs: readonly Row[]): number | null => {
  const n = sum(rs, (r) => r.n);
  if (n < 2) return null;
  const gross = sum(rs, (r) => r.sum_ret);
  const grossSq = sum(rs, (r) => r.sum_ret_sq);
  const mean = gross / n - FLOOR;
  if (mean === 0) return null;
  const varNet = Math.max((grossSq - 2 * FLOOR * gross + FLOOR * FLOOR * n) / n - mean * mean, 0);
  return Math.sqrt(varNet) / Math.abs(mean);
};

const coverageOf = (c: Cell): number => {
  const f = sum(c.rows, (r) => r.n_followable) - sum(c.rows, (r) => r.n_truncated);
  return f === 0 ? 0 : sum(c.rows, (r) => r.n) / f;
};

console.log(`MT092 — Phase G, evaluation at the coverage-selected horizon, from ${path}`);
console.log(`  dune query ${parsed.query_id ?? '?'} execution ${parsed.execution_id ?? '?'}`);
console.log(`  H* = ${H_STAR}s, frozen in MT092 before any return was computed or read`);
console.log(`  ${rows.length} cells over ${days.length} UTC days, ${RESAMPLES} resamples, tier-0 floor ${(FLOOR * 100).toFixed(3)}%\n`);

// -------------------------------------------------------------------------
// 1. The coverage-and-return relationship: the measurement the interpolation guessed
// -------------------------------------------------------------------------
console.log('  COVERAGE AGAINST RETURN — the quantity the external interpolation guessed at');
console.log('    arm                  L      H   coverage        n   as-priced net   censored net');
for (const c of cells.filter((x) => x.lag === 2)) {
  const ap = clusterBootstrapAggregated(asPriced(c.rows), 2_000);
  const ce = clusterBootstrapAggregated(censored(c.rows), 2_000);
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${String(c.lag).padStart(3)}s ${String(c.horizon).padStart(5)}s` +
      `   ${(coverageOf(c) * 100).toFixed(1).padStart(6)}%  ${String(sum(c.rows, (r) => r.n)).padStart(7)}` +
      `   ${pct(ap.point).padStart(13)}   ${pct(ce.point).padStart(12)}`,
  );
}

// -------------------------------------------------------------------------
// 2. The evaluation at H*
// -------------------------------------------------------------------------
interface Verdict extends Conditions {
  readonly cell: Cell;
  readonly coverage: number;
  readonly coverageQualifies: boolean;
  readonly ap: ReturnType<typeof clusterBootstrapAggregated>;
  readonly ce: ReturnType<typeof clusterBootstrapAggregated>;
  readonly n: number;
  readonly required: number | null;
}

const verdictFor = (c: Cell): Verdict => {
  const ap = clusterBootstrapAggregated(asPriced(c.rows), RESAMPLES);
  const ce = clusterBootstrapAggregated(censored(c.rows), RESAMPLES);
  const n = sum(c.rows, (r) => r.n);
  const required = requiredPositions(cvOf(c.rows));
  const cond = conditionsOf({
    asPricedPoint: ap.point,
    asPricedLower: ap.lower,
    censoredPoint: ce.point,
    venue: 'pumpswap',
    n,
    requiredN: required,
  });
  const coverage = coverageOf(c);
  return { cell: c, coverage, coverageQualifies: coverage >= COVERAGE_BAR, ap, ce, n, required, ...cond };
};

const verdicts = cells.map(verdictFor);
const atStar = verdicts.filter((v) => v.cell.horizon === H_STAR);

console.log(`\n  THE FOUR CONDITIONS AT H* = ${H_STAR}s`);
for (const v of atStar) {
  console.log(
    `    ${v.cell.rankStat.padEnd(6)} f=${String(v.cell.fraction).padEnd(6)} L=${String(v.cell.lag).padStart(2)}s` +
      `  coverage ${(v.coverage * 100).toFixed(1)}%${v.coverageQualifies ? ' QUALIFIES' : ' below 90%'}` +
      `  as-priced ${pct(v.ap.point)} [${pct(v.ap.lower)}, ${pct(v.ap.upper)}]` +
      `  censored ${pct(v.ce.point)}` +
      `  n=${String(v.n).padStart(6)} need=${String(v.required ?? 0).padStart(7)}` +
      `  ${v.c1 ? '1' : '-'}${v.c2 ? '2' : '-'}${v.c3 ? '3' : '-'}${v.c4 ? '4' : '-'}`,
  );
}

const qualifying = atStar.filter((v) => v.coverageQualifies);
console.log(`\n  arms whose coverage QUALIFIES at H*: ${qualifying.length} of ${atStar.length}`);
console.log('  the rest are coverage-failed and their estimates are NOT presented as estimates.');

const copyable = qualifying.filter((v) => v.copyable);
console.log(`  qualifying cells satisfying all four conditions: ${copyable.length}`);

// -------------------------------------------------------------------------
// 3. Sensitivity — labelled, never a candidate
// -------------------------------------------------------------------------
console.log('\n  SENSITIVITY across the other horizons. NOT candidates: a cell that fails at H*');
console.log('  and passes elsewhere is a failure, and this table is where that would be visible.');
console.log('    arm                  L      H   coverage   as-priced net [95% CI]                 conds');
for (const v of verdicts.filter((x) => x.cell.horizon !== H_STAR && x.cell.lag === 2)) {
  console.log(
    `    ${v.cell.rankStat.padEnd(6)} f=${String(v.cell.fraction).padEnd(6)} ${String(v.cell.lag).padStart(3)}s ${String(v.cell.horizon).padStart(5)}s` +
      `   ${(v.coverage * 100).toFixed(1).padStart(6)}%   ${pct(v.ap.point)} [${pct(v.ap.lower)}, ${pct(v.ap.upper)}]` +
      `   ${v.c1 ? '1' : '-'}${v.c2 ? '2' : '-'}${v.c3 ? '3' : '-'}${v.c4 ? '4' : '-'}${v.coverageQualifies ? '' : '  (coverage-failed)'}`,
  );
}

// -------------------------------------------------------------------------
// 4. The state
// -------------------------------------------------------------------------
const anyHorizonReaches = verdicts.some((v) => v.coverageQualifies);
const state = !anyHorizonReaches
  ? 'NO_HORIZON_REACHES_COVERAGE'
  : copyable.length > 0
    ? 'COPYABLE_HORIZON_IDENTIFIED'
    : 'NO_COPYABLE_HORIZON';
console.log(`\n  FINAL STATE: ${state}`);
if (state === 'NO_COPYABLE_HORIZON') {
  const agree = qualifying.filter((v) => v.c2).length;
  console.log(`    ${agree} of ${qualifying.length} qualifying cells have the two treatments AGREEING in sign,`);
  console.log('    which at 95.6% coverage they nearly must: the treatments converge as coverage rises,');
  console.log('    and that convergence is what the horizon was selected for.');
}

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/phase-g-horizon.json',
  `${JSON.stringify(
    {
      generatedFrom: { path, queryId: parsed.query_id ?? null, executionId: parsed.execution_id ?? null },
      rule: 'MT092',
      hStarSeconds: H_STAR,
      coverageBar: COVERAGE_BAR,
      floor: FLOOR,
      resamples: RESAMPLES,
      utcDays: days.length,
      state,
      cells: verdicts.map((v) => ({
        rankStat: v.cell.rankStat,
        topFraction: v.cell.fraction,
        lagSeconds: v.cell.lag,
        horizonSeconds: v.cell.horizon,
        isHStar: v.cell.horizon === H_STAR,
        followable: sum(v.cell.rows, (r) => r.n_followable),
        truncated: sum(v.cell.rows, (r) => r.n_truncated),
        entryPriced: sum(v.cell.rows, (r) => r.n_entry_priced),
        n: v.n,
        censoredCount: sum(v.cell.rows, (r) => r.n_censored),
        coverage: v.coverage,
        coverageQualifies: v.coverageQualifies,
        asPriced: { point: v.ap.point, lower: v.ap.lower, upper: v.ap.upper },
        censoredAtMinus100: { point: v.ce.point, lower: v.ce.lower, upper: v.ce.upper },
        requiredN: v.required,
        conditions: { c1: v.c1, c2: v.c2, c3: v.c3, c4: v.c4 },
        copyable: v.copyable,
      })),
    },
    null,
    2,
  )}\n`,
);
console.log('\n  artifact           artifacts/phase-g-horizon.json');
