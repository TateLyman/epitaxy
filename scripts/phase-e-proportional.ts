/**
 * MT087 — Phase E, mirroring the fraction of each wallet sell rather than the event.
 *
 * THE PAIRED DIFFERENCE IS PRINTED FIRST, before any absolute figure, because the
 * directive says so and because it is the only comparison that isolates what this
 * phase changes: proportional minus binary, on the identical position set, at the
 * identical lags, day-clustered and paired on the same drawn days.
 *
 *   "If proportional does not beat binary on a paired lower bound, nothing else in
 *    this phase matters and the report should say so in its first paragraph."
 *
 * THE DECISION RULE (MT087), frozen before the first execution — five conditions,
 * all required:
 *
 *   1. proportional return day-clustered 95% lower bound > 0, net of the floor
 *   2. closed-only and open-at--100% AGREE IN SIGN
 *   3. entry_project = pumpswap
 *   4. n >= 7.84 x CV^2 on the PROPORTIONAL round-trip return
 *   5. proportional-minus-binary paired difference lower bound > 0
 *
 * Condition 5 is new and gating: it stops a proportional arm that passes 1–4 on a
 * lucky window from being reported as an improvement it did not produce.
 *
 * Usage: pnpm prop:exit [path-to-q8-results.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  clusterBootstrapAggregated,
  clusterBootstrapDifference,
  type ClusterAggregate,
} from '../packages/research/src/robust-stats.js';
import { conditionsOf, type Conditions } from '../packages/research/src/copier-lag.js';
import { requiredPositions } from '../packages/domain/src/confirmatory.js';

/** Tier-0 round trip. The floor is already charged inside the query, per leg-value. */
const PRIMARY_FLOOR = 0.02669;
const RESAMPLES = 10_000;

interface Row {
  readonly utc_day: string;
  readonly rank_stat: 'MEAN' | 'MEDIAN';
  readonly top_fraction: number | string;
  readonly lag_s: number;
  readonly n_followable: number;
  readonly n_entry_priced: number;
  readonly n_wallet_closed: number;
  readonly n_any_priced_leg: number;
  readonly n_paired: number;
  readonly legs_total: number;
  readonly legs_priced: number;
  readonly sum_w_sold_paired: number;
  readonly n_conviction_not_evaluable: number;
  readonly sum_prop_closed: number;
  readonly sum_prop_closed_sq: number;
  readonly n_prop_closed_positive: number;
  readonly median_prop_closed: number | null;
  readonly sum_bin_closed: number;
  readonly sum_bin_closed_sq: number;
  readonly n_dead: number;
  readonly sum_prop_dead: number;
  readonly sum_prop_dead_sq: number;
  readonly sum_bin_dead: number;
  readonly n_wallet_realised: number;
  readonly sum_wallet_realised: number;
  readonly n_wallet_first: number;
  readonly sum_wallet_first_sell: number;
  readonly sum_entry_slip: number;
  readonly n_entry_slip: number;
  readonly sum_exit_slip_weighted: number;
  readonly sum_exit_slip_base: number;
  readonly median_entry_slip: number | null;
  readonly n_conv_gated: number;
  readonly sum_conv_gated: number;
  readonly sum_conv_gated_sq: number;
  readonly sum_conv_gated_bin: number;
  readonly sum_conviction_weight: number;
  readonly sum_conviction_weighted_ret: number;
  readonly median_own_impact: number | null;
  readonly sum_sol_in: number;
  readonly wallets_in_cell: number;
}

const path = process.argv[2] ?? 'ops/dune/results/q8-proportional-exit.json';
const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
  execution_id?: string;
  query_id?: number;
  result: { rows: Row[] };
};
const rows = parsed.result.rows;
const day = (r: Row): string => r.utc_day.slice(0, 10);
const frac = (r: Row): number => Number(r.top_fraction);
const days = [...new Set(rows.map(day))].sort();
const LAGS = [...new Set(rows.map((r) => r.lag_s))].sort((a, b) => a - b);

const pct = (x: number | null): string =>
  x === null || !Number.isFinite(x) ? '      n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

interface Cell {
  readonly rankStat: 'MEAN' | 'MEDIAN';
  readonly fraction: number;
  readonly lag: number;
  readonly rows: readonly Row[];
}
const cells: Cell[] = [];
for (const rankStat of ['MEAN', 'MEDIAN'] as const) {
  for (const fraction of [...new Set(rows.map(frac))].sort((a, b) => a - b)) {
    for (const lag of LAGS) {
      const sel = rows.filter((r) => r.rank_stat === rankStat && frac(r) === fraction && r.lag_s === lag);
      if (sel.length > 0) cells.push({ rankStat, fraction, lag, rows: sel });
    }
  }
}
const sum = (rs: readonly Row[], f: (r: Row) => number): number => rs.reduce((a, r) => a + f(r), 0);

/** Per-day (n, sum) for one series. */
const agg = (rs: readonly Row[], n: (r: Row) => number, s: (r: Row) => number): ClusterAggregate[] =>
  rs.map((r) => ({ cluster: day(r), n: n(r), sum: s(r) }));

const cv = (n: number, s1: number, s2: number): number | null => {
  if (n < 2) return null;
  const mean = s1 / n;
  if (mean === 0) return null;
  return Math.sqrt(Math.max(s2 / n - mean * mean, 0)) / Math.abs(mean);
};

console.log(`MT087 — Phase E, proportional exit mirroring, from ${path}`);
console.log(`  dune query ${parsed.query_id ?? '?'} execution ${parsed.execution_id ?? '?'}`);
console.log(`  ${rows.length} (day, arm, lag) cells over ${days.length} UTC days, ${RESAMPLES} resamples`);
console.log(`  pumpswap only; the copier sells fraction_k of ITS OWN remaining at each T_k + L\n`);

// -------------------------------------------------------------------------
// 1. THE PAIRED DIFFERENCE, FIRST (directive §5.1, MT087 condition 5)
// -------------------------------------------------------------------------
console.log('  CONDITION 5 FIRST — proportional minus binary, identical positions, paired by day');
console.log('    arm                  L   n_paired   proportional     binary   difference   95% CI');
const diffByCell = new Map<Cell, { point: number | null; lower: number; upper: number }>();
for (const c of cells) {
  const n = sum(c.rows, (r) => r.n_paired);
  const d = clusterBootstrapDifference(
    agg(c.rows, (r) => r.n_paired, (r) => r.sum_prop_closed),
    agg(c.rows, (r) => r.n_paired, (r) => r.sum_bin_closed),
    RESAMPLES,
  );
  diffByCell.set(c, d);
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${String(c.lag).padStart(3)}s ${String(n).padStart(8)}` +
      ` ${pct(sum(c.rows, (r) => r.sum_prop_closed) / Math.max(n, 1)).padStart(13)}` +
      ` ${pct(sum(c.rows, (r) => r.sum_bin_closed) / Math.max(n, 1)).padStart(10)}` +
      ` ${pct(d.point).padStart(12)}   [${pct(d.lower)}, ${pct(d.upper)}]` +
      `${d.point !== null && d.lower > 0 ? '  PASSES 5' : ''}`,
  );
}
const passing5 = cells.filter((c) => {
  const d = diffByCell.get(c);
  return d !== undefined && d.point !== null && d.lower > 0;
});
console.log(
  `\n  cells whose paired difference clears zero: ${passing5.length} of ${cells.length}` +
    (passing5.length === 0
      ? '  ->  proportional does not beat binary, and nothing else in this phase matters'
      : ''),
);

// -------------------------------------------------------------------------
// 2. COVERAGE (directive §5.2)
// -------------------------------------------------------------------------
console.log('\n  COVERAGE — before any absolute return figure');
console.log('    arm                  L   followable   entry px   wallet closed   PAIRED   legs/pos   mirrored');
for (const c of cells) {
  const f = sum(c.rows, (r) => r.n_followable);
  const paired = sum(c.rows, (r) => r.n_paired);
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${String(c.lag).padStart(3)}s ${String(f).padStart(10)}` +
      ` ${`${((sum(c.rows, (r) => r.n_entry_priced) / f) * 100).toFixed(1)}%`.padStart(10)}` +
      ` ${`${((sum(c.rows, (r) => r.n_wallet_closed) / f) * 100).toFixed(1)}%`.padStart(15)}` +
      ` ${`${((paired / f) * 100).toFixed(1)}%`.padStart(8)}` +
      ` ${(sum(c.rows, (r) => r.legs_total) / Math.max(f, 1)).toFixed(2).padStart(10)}` +
      ` ${`${((sum(c.rows, (r) => r.sum_w_sold_paired) / Math.max(paired, 1)) * 100).toFixed(1)}%`.padStart(10)}`,
  );
}

// -------------------------------------------------------------------------
// 3. The decision
// -------------------------------------------------------------------------
type SizeArm = 'UNGATED' | 'CONVICTION_GATED' | 'CONVICTION_WEIGHTED';
const armSeries = (arm: SizeArm): { n: (r: Row) => number; s: (r: Row) => number; sq: (r: Row) => number } => {
  switch (arm) {
    case 'UNGATED':
      return { n: (r) => r.n_paired, s: (r) => r.sum_prop_closed, sq: (r) => r.sum_prop_closed_sq };
    case 'CONVICTION_GATED':
      return { n: (r) => r.n_conv_gated, s: (r) => r.sum_conv_gated, sq: (r) => r.sum_conv_gated_sq };
    case 'CONVICTION_WEIGHTED':
      // A weighted mean IS a ratio of sums, so the weight goes in `n`.
      return { n: (r) => r.sum_conviction_weight, s: (r) => r.sum_conviction_weighted_ret, sq: () => 0 };
  }
};

interface Verdict extends Conditions {
  readonly cell: Cell;
  readonly arm: SizeArm;
  readonly closed: ReturnType<typeof clusterBootstrapAggregated>;
  readonly dead: ReturnType<typeof clusterBootstrapAggregated> | null;
  readonly diff: { point: number | null; lower: number; upper: number } | null;
  readonly n: number;
  readonly required: number | null;
  readonly c5: boolean;
}

const verdictFor = (c: Cell, arm: SizeArm): Verdict => {
  const ser = armSeries(arm);
  const closed = clusterBootstrapAggregated(agg(c.rows, ser.n, ser.s), RESAMPLES);
  // The dead treatment exists only for the ungated arm: the query returns the
  // residual-worthless series over every entry-priced position, not broken out by
  // conviction gate, so charging it against a gated arm would be an export artifact.
  const dead =
    arm === 'UNGATED'
      ? clusterBootstrapAggregated(agg(c.rows, (r) => r.n_dead, (r) => r.sum_prop_dead), RESAMPLES)
      : null;
  const n = sum(c.rows, ser.n);
  const required =
    arm === 'CONVICTION_WEIGHTED'
      ? null
      : requiredPositions(cv(n, sum(c.rows, ser.s), sum(c.rows, ser.sq)));
  const base = conditionsOf({
    asPricedPoint: closed.point,
    asPricedLower: closed.lower,
    censoredPoint: dead === null ? null : dead.point,
    venue: 'pumpswap',
    n,
    requiredN: required,
  });
  const diff =
    arm === 'UNGATED'
      ? (diffByCell.get(c) ?? null)
      : clusterBootstrapDifference(agg(c.rows, ser.n, ser.s), agg(c.rows, ser.n, (r) =>
          arm === 'CONVICTION_GATED' ? r.sum_conv_gated_bin : r.sum_conviction_weighted_ret,
        ), RESAMPLES);
  const c5 = diff !== null && diff.point !== null && diff.lower > 0;
  return { cell: c, arm, closed, dead, diff, n, required, ...base, c5, copyable: base.copyable && c5 };
};

const verdicts: Verdict[] = cells.flatMap((c) =>
  (['UNGATED', 'CONVICTION_GATED', 'CONVICTION_WEIGHTED'] as const).map((arm) => verdictFor(c, arm)),
);

console.log('\n  THE FIVE CONDITIONS. Flags are 1..5; the dead treatment and power are ungated-only.');
for (const v of verdicts) {
  console.log(
    `    ${v.cell.rankStat.padEnd(6)} f=${String(v.cell.fraction).padEnd(6)} ${String(v.cell.lag).padStart(3)}s` +
      ` ${v.arm.padEnd(19)} closed ${pct(v.closed.point)} [${pct(v.closed.lower)}, ${pct(v.closed.upper)}]` +
      `  dead ${v.dead === null ? 'n/e' : pct(v.dead.point)}` +
      `  n=${String(Math.round(v.n)).padStart(6)} need=${v.required === null ? 'n/e' : String(v.required).padStart(6)}` +
      `  ${v.c1 ? '1' : '-'}${v.c2 ? '2' : '-'}${v.c3 ? '3' : '-'}${v.c4 ? '4' : '-'}${v.c5 ? '5' : '-'}` +
      `${v.copyable ? '  COPYABLE' : ''}`,
  );
}
const copyable = verdicts.filter((v) => v.copyable);
console.log(`\n  cells satisfying ALL FIVE conditions: ${copyable.length}`);

// -------------------------------------------------------------------------
// 4. Slippage under multi-leg exit (directive §5.4)
// -------------------------------------------------------------------------
console.log('\n  SLIPPAGE UNDER MULTI-LEG EXIT — more legs means more slippage events');
console.log('    arm                  L   legs/pos   entry mean   entry med   exit (weighted)');
for (const c of cells) {
  const nEntry = sum(c.rows, (r) => r.n_entry_slip);
  const exitBase = sum(c.rows, (r) => r.sum_exit_slip_base);
  const meds = c.rows.map((r) => r.median_entry_slip).filter((x): x is number => x !== null).sort((a, b) => a - b);
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${String(c.lag).padStart(3)}s` +
      ` ${(sum(c.rows, (r) => r.legs_total) / Math.max(sum(c.rows, (r) => r.n_followable), 1)).toFixed(2).padStart(10)}` +
      ` ${pct(nEntry === 0 ? null : sum(c.rows, (r) => r.sum_entry_slip) / nEntry).padStart(12)}` +
      ` ${pct(meds.length === 0 ? null : (meds[Math.floor(meds.length / 2)] as number)).padStart(11)}` +
      ` ${pct(exitBase === 0 ? null : sum(c.rows, (r) => r.sum_exit_slip_weighted) / exitBase).padStart(17)}`,
  );
}

// -------------------------------------------------------------------------
// 5. The first-sell-to-realised gap, on THIS population (directive §5.5)
// -------------------------------------------------------------------------
console.log('\n  THE GAP THIS PHASE SET OUT TO RECOVER, measured on the paired closed set');
console.log('    arm                  L   wallet first-sell   wallet realised        gap   copier prop   recovered');
for (const c of cells) {
  const nF = sum(c.rows, (r) => r.n_wallet_first);
  const nR = sum(c.rows, (r) => r.n_wallet_realised);
  const nP = sum(c.rows, (r) => r.n_paired);
  if (nF === 0 || nR === 0) continue;
  const first = sum(c.rows, (r) => r.sum_wallet_first_sell) / nF;
  const realised = sum(c.rows, (r) => r.sum_wallet_realised) / nR;
  const gap = realised - first;
  const prop = sum(c.rows, (r) => r.sum_prop_closed) / Math.max(nP, 1);
  const bin = sum(c.rows, (r) => r.sum_bin_closed) / Math.max(nP, 1);
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${String(c.lag).padStart(3)}s` +
      ` ${pct(first).padStart(17)} ${pct(realised).padStart(17)} ${pct(gap).padStart(10)}` +
      ` ${pct(prop).padStart(13)}` +
      ` ${gap === 0 ? '     n/a' : `${(((prop - bin) / gap) * 100).toFixed(1)}%`.padStart(11)}`,
  );
}

// -------------------------------------------------------------------------
// 6. The state
// -------------------------------------------------------------------------
const ungated = verdicts.filter((v) => v.arm === 'UNGATED');
const state = ungated.some((v) => v.copyable)
  ? 'COPYABLE_LAG_IDENTIFIED'
  : ungated.some((v) => !v.c2)
    ? 'UNDECIDABLE_CENSORING'
    : 'NO_COPYABLE_LAG';
console.log(`\n  ${ungated.length} ungated cells. c1 ${ungated.filter((v) => v.c1).length},`);
console.log(`  c2 ${ungated.filter((v) => v.c2).length}, c4 ${ungated.filter((v) => v.c4).length}, c5 ${ungated.filter((v) => v.c5).length}.`);
console.log(`\n  FINAL STATE: ${state}`);

// -------------------------------------------------------------------------
// 7. The artifact
// -------------------------------------------------------------------------
mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/phase-e-proportional.json',
  `${JSON.stringify(
    {
      generatedFrom: { path, queryId: parsed.query_id ?? null, executionId: parsed.execution_id ?? null },
      rule: 'MT087',
      sizeArmRule: 'MT088',
      primaryFloor: PRIMARY_FLOOR,
      resamples: RESAMPLES,
      utcDays: days.length,
      lags: LAGS,
      state,
      reserveMarkRan: false,
      cells: verdicts.map((v) => ({
        rankStat: v.cell.rankStat,
        topFraction: v.cell.fraction,
        lagSeconds: v.cell.lag,
        sizeArm: v.arm,
        followable: sum(v.cell.rows, (r) => r.n_followable),
        entryPriced: sum(v.cell.rows, (r) => r.n_entry_priced),
        walletClosed: sum(v.cell.rows, (r) => r.n_wallet_closed),
        paired: sum(v.cell.rows, (r) => r.n_paired),
        legsPerPosition:
          sum(v.cell.rows, (r) => r.legs_total) / Math.max(sum(v.cell.rows, (r) => r.n_followable), 1),
        mirroredWeight:
          sum(v.cell.rows, (r) => r.sum_w_sold_paired) / Math.max(sum(v.cell.rows, (r) => r.n_paired), 1),
        n: v.n,
        closedOnly: { point: v.closed.point, lower: v.closed.lower, upper: v.closed.upper },
        openAtMinus100: v.dead === null ? null : { point: v.dead.point, lower: v.dead.lower, upper: v.dead.upper },
        pairedDifference: v.diff === null ? null : { point: v.diff.point, lower: v.diff.lower, upper: v.diff.upper },
        requiredN: v.required,
        conditions: { c1: v.c1, c2: v.c2, c3: v.c3, c4: v.c4, c5: v.c5 },
        copyable: v.copyable,
        walletFirstSell:
          sum(v.cell.rows, (r) => r.sum_wallet_first_sell) / Math.max(sum(v.cell.rows, (r) => r.n_wallet_first), 1),
        walletRealised:
          sum(v.cell.rows, (r) => r.sum_wallet_realised) / Math.max(sum(v.cell.rows, (r) => r.n_wallet_realised), 1),
      })),
    },
    null,
    2,
  )}\n`,
);
console.log('\n  artifact           artifacts/phase-e-proportional.json');
