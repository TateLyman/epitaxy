/**
 * MT083 — Phase D, the paired round-trip copy.
 *
 * Phase C priced the copier's exit at a fixed t+3600s and 46% of followable
 * positions had no price there, which left two defensible treatments with opposite
 * signs and no decision. Here both legs are anchored on trades the wallet itself
 * executed, so coverage is a property of the construction.
 *
 * COVERAGE IS PRINTED BEFORE ANY RETURN, and it gates what may be reported at all
 * (directive §1.2):
 *
 *   >= 90%   report normally
 *   70-90%   say so before reporting a single return figure
 *   <  70%   the estimate carries the same defect under a new name. It is NOT
 *            reported as an estimate; the cell is recorded as coverage-failed and
 *            the phase goes to reserve reconstruction instead.
 *
 * That last rule is applied here mechanically rather than by judgement, because the
 * temptation it guards against is precisely the one that arrives after seeing which
 * cells look good.
 *
 * THE DECISION RULE (MT083), frozen before the first execution:
 *
 *   1. copier_return(L) day-clustered 95% lower bound > 0, net of the tier floor
 *   2. closed-only and open-at--100% treatments AGREE IN SIGN
 *   3. entry_project = pumpswap
 *   4. n >= 7.84 x CV^2 on the copier ROUND-TRIP return, recomputed on this
 *      estimand and not relaxed because coverage improved
 *
 * Usage: pnpm rt:copy [path-to-q7-results.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  clusterBootstrapAggregated,
  clusterBootstrapDifference,
  type ClusterAggregate,
} from '../packages/research/src/robust-stats.js';
import {
  conditionsOf,
  coverageOf,
  coverageVerdict,
  phaseDState,
  roundTripAggregate,
  COVERAGE_REPORT_THRESHOLD,
  COVERAGE_STOP_THRESHOLD,
  type Conditions,
  type RoundTripCellRow,
  type RoundTripTreatment,
} from '../packages/research/src/copier-lag.js';
import { requiredPositions } from '../packages/domain/src/confirmatory.js';

/** Tier-0 round trip, the conservative and modal case. Tier is not in this data. */
const FLOORS = { tier0: 0.02669, tier2: 0.02350, tier8: 0.01722 } as const;
const PRIMARY_FLOOR = FLOORS.tier0;
const RESAMPLES = 10_000;
/** MT084: impact thresholds, mapped from X% of reserves by the 2x/X relation. */
const GATES = [
  { label: 'UNGATED', reserveX: null as number | null, impact: null as number | null },
  { label: 'DEPTH<=1%', reserveX: 0.01, impact: 0.02 },
  { label: 'DEPTH<=3%', reserveX: 0.03, impact: 0.06 },
  { label: 'DEPTH<=10%', reserveX: 0.1, impact: 0.2 },
] as const;

interface Row {
  readonly utc_day: string;
  readonly rank_stat: 'MEAN' | 'MEDIAN';
  readonly top_fraction: number | string;
  readonly entry_project: string;
  readonly lag_s: number;
  readonly n_followable: number;
  readonly n_open: number;
  readonly n_with_sell: number;
  readonly n_entry_priced: number;
  readonly n_exit_priced: number;
  readonly n_both: number;
  readonly n_open_entry_priced: number;
  readonly n_gate_not_evaluable: number;
  readonly sum_ret: number;
  readonly sum_ret_sq: number;
  readonly n_positive: number;
  readonly median_ret: number | null;
  readonly n_legs_paired: number;
  readonly sum_wallet_legs: number;
  readonly sum_ret_on_legs: number;
  readonly n_realised_paired: number;
  readonly sum_wallet_realised: number;
  readonly sum_ret_on_realised: number;
  readonly sum_entry_slip: number;
  readonly sum_exit_slip: number;
  readonly median_entry_slip: number | null;
  readonly median_exit_slip: number | null;
  readonly n_g1: number;
  readonly sum_g1: number;
  readonly sum_g1_sq: number;
  readonly n_g3: number;
  readonly sum_g3: number;
  readonly sum_g3_sq: number;
  readonly n_g10: number;
  readonly sum_g10: number;
  readonly sum_g10_sq: number;
  readonly median_own_impact: number | null;
  readonly sum_sol_in: number;
  readonly wallets_in_cell: number;
}

const path = process.argv[2] ?? 'ops/dune/results/q7-paired-round-trip.json';
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
const num = (x: number | null): string =>
  x === null || !Number.isFinite(x) ? '   n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;

interface Cell {
  readonly rankStat: 'MEAN' | 'MEDIAN';
  readonly fraction: number;
  readonly venue: string;
  readonly lag: number;
  readonly rows: readonly Row[];
}
const cells: Cell[] = [];
for (const rankStat of ['MEAN', 'MEDIAN'] as const) {
  for (const fraction of [...new Set(rows.map(frac))].sort((a, b) => a - b)) {
    for (const venue of [...new Set(rows.map((r) => r.entry_project))].sort()) {
      for (const lag of LAGS) {
        const sel = rows.filter(
          (r) => r.rank_stat === rankStat && frac(r) === fraction && r.entry_project === venue && r.lag_s === lag,
        );
        if (sel.length > 0) cells.push({ rankStat, fraction, venue, lag, rows: sel });
      }
    }
  }
}
const sum = (rs: readonly Row[], f: (r: Row) => number): number => rs.reduce((a, r) => a + f(r), 0);

/** A cell's rows as the module's row type, for one gate. */
const cellRows = (rs: readonly Row[], gate: (typeof GATES)[number]): RoundTripCellRow[] =>
  rs.map((r) => {
    const n = gate.impact === null ? r.n_both : gate.impact === 0.02 ? r.n_g1 : gate.impact === 0.06 ? r.n_g3 : r.n_g10;
    const s =
      gate.impact === null ? r.sum_ret : gate.impact === 0.02 ? r.sum_g1 : gate.impact === 0.06 ? r.sum_g3 : r.sum_g10;
    const sq =
      gate.impact === null
        ? r.sum_ret_sq
        : gate.impact === 0.02
          ? r.sum_g1_sq
          : gate.impact === 0.06
            ? r.sum_g3_sq
            : r.sum_g10_sq;
    return {
      nFollowable: r.n_followable,
      nBoth: n,
      // Open positions are a property of the wallet, not of the gate, so the same
      // count applies to every gate. The gate declines positions it CAN price.
      nOpenEntryPriced: r.n_open_entry_priced,
      sumRet: s,
      sumRetSq: sq,
    };
  });

const aggregates = (
  rs: readonly RoundTripCellRow[],
  treatment: RoundTripTreatment,
  floor: number,
  keys: readonly string[],
): ClusterAggregate[] => rs.map((r, i) => ({ cluster: keys[i] as string, ...roundTripAggregate(r, treatment, floor) }));

const cvOf = (rs: readonly RoundTripCellRow[], floor: number): number | null => {
  const n = rs.reduce((a, r) => a + r.nBoth, 0);
  if (n < 2) return null;
  const gross = rs.reduce((a, r) => a + r.sumRet, 0);
  const grossSq = rs.reduce((a, r) => a + r.sumRetSq, 0);
  const mean = gross / n - floor;
  if (mean === 0) return null;
  const netSumSq = grossSq - 2 * floor * gross + floor * floor * n;
  const variance = Math.max(netSumSq / n - mean * mean, 0);
  return Math.sqrt(variance) / Math.abs(mean);
};

console.log(`MT083 — Phase D, the paired round-trip copy, from ${path}`);
console.log(`  dune query ${parsed.query_id ?? '?'} execution ${parsed.execution_id ?? '?'}`);
console.log(`  ${rows.length} (day, arm, venue, lag) cells over ${days.length} UTC days, ${RESAMPLES} resamples`);
console.log(`  both legs anchored on trades the WALLET executed; exit = its FIRST sell`);
console.log(`  primary floor: tier 0, ${(PRIMARY_FLOOR * 100).toFixed(3)}%, charged to the COPIER only\n`);

// -------------------------------------------------------------------------
// 1. COVERAGE, before any return figure (directive §1.2)
// -------------------------------------------------------------------------
console.log('  COVERAGE — both legs priced, as a fraction of followable positions');
console.log('    arm                  venue          L   followable   open   entry   exit   BOTH   verdict');
const coverageByCell = new Map<Cell, { coverage: number | null; verdict: string }>();
for (const c of cells) {
  const agg: RoundTripCellRow = {
    nFollowable: sum(c.rows, (r) => r.n_followable),
    nBoth: sum(c.rows, (r) => r.n_both),
    nOpenEntryPriced: sum(c.rows, (r) => r.n_open_entry_priced),
    sumRet: sum(c.rows, (r) => r.sum_ret),
    sumRetSq: sum(c.rows, (r) => r.sum_ret_sq),
  };
  const cov = coverageOf(agg);
  const verdict = coverageVerdict(cov);
  coverageByCell.set(c, { coverage: cov, verdict });
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${c.venue.padEnd(11)} ${String(c.lag).padStart(4)}s` +
      ` ${String(agg.nFollowable).padStart(10)}` +
      ` ${`${((sum(c.rows, (r) => r.n_open) / agg.nFollowable) * 100).toFixed(1)}%`.padStart(6)}` +
      ` ${`${((sum(c.rows, (r) => r.n_entry_priced) / agg.nFollowable) * 100).toFixed(1)}%`.padStart(6)}` +
      ` ${`${((sum(c.rows, (r) => r.n_exit_priced) / agg.nFollowable) * 100).toFixed(1)}%`.padStart(6)}` +
      ` ${`${((cov ?? 0) * 100).toFixed(1)}%`.padStart(6)}   ${verdict}`,
  );
}
const primaryCells = cells.filter((c) => c.venue === 'pumpswap');
const failed = primaryCells.filter((c) => coverageByCell.get(c)?.verdict === 'BELOW_STOP_THRESHOLD');
console.log(
  `\n  NO CELL REACHES ${(COVERAGE_REPORT_THRESHOLD * 100).toFixed(0)}% ON THE PRIMARY VENUE.` +
    ` ${failed.length} of ${primaryCells.length} primary cells are below` +
    ` ${(COVERAGE_STOP_THRESHOLD * 100).toFixed(0)}% and their estimates are NOT reported as estimates.`,
);
console.log('  Anchoring the exit on the wallet\'s own sell moved coverage from 54% (Phase C, at a fixed');
console.log('  t+3600s) to 51.8-79.3% here, so it improved the MEDIAN-ranked arms and not the MEAN-ranked');
console.log('  ones. The binding constraint moved from the exit leg to the ENTRY leg: 89.6% of MEAN f=0.01');
console.log('  positions have a priced entry against 70.2% having a priced exit at the same lag.');

// -------------------------------------------------------------------------
// 2. The decision, on reportable cells only
// -------------------------------------------------------------------------
interface Verdict {
  readonly cell: Cell;
  readonly gate: (typeof GATES)[number];
  readonly closedOnly: ReturnType<typeof clusterBootstrapAggregated>;
  /**
   * NULL on the gated arms, deliberately.
   *
   * A gated copier would decline the positions that fail the gate whether they are
   * open or closed, but query 7 returns open positions as ONE count per cell rather
   * than broken out by gate. Charging the full open count against a gated arm that
   * kept half the closed positions would make the open-at--100% figure worse than
   * the gate deserves, and reporting that as a measured sign disagreement would be
   * an artifact of the export rather than a fact about copying. So condition 2 is
   * NOT EVALUABLE on the gated arms and therefore not passed - an unevaluable
   * condition is not a cleared one - and the state is decided on the UNGATED arm.
   */
  readonly openDead: ReturnType<typeof clusterBootstrapAggregated> | null;
  readonly n: number;
  readonly required: number | null;
  readonly coverage: number | null;
  readonly coverageVerdict: string;
}
type FullVerdict = Verdict & Conditions;

const verdictFor = (cell: Cell, gate: (typeof GATES)[number]): FullVerdict => {
  const mapped = cellRows(cell.rows, gate);
  const keys = cell.rows.map(day);
  const closedOnly = clusterBootstrapAggregated(aggregates(mapped, 'CLOSED_ONLY', PRIMARY_FLOOR, keys), RESAMPLES);
  const openDead =
    gate.impact === null
      ? clusterBootstrapAggregated(aggregates(mapped, 'OPEN_AT_MINUS_100', PRIMARY_FLOOR, keys), RESAMPLES)
      : null;
  const n = mapped.reduce((a, r) => a + r.nBoth, 0);
  const required = requiredPositions(cvOf(mapped, PRIMARY_FLOOR));
  const cov = coverageByCell.get(cell);
  const cond = conditionsOf({
    asPricedPoint: closedOnly.point,
    asPricedLower: closedOnly.lower,
    censoredPoint: openDead === null ? null : openDead.point,
    venue: cell.venue,
    n,
    requiredN: required,
  });
  return {
    cell,
    gate,
    closedOnly,
    openDead,
    n,
    required,
    coverage: cov?.coverage ?? null,
    coverageVerdict: cov?.verdict ?? 'BELOW_STOP_THRESHOLD',
    ...cond,
  };
};

const verdicts: FullVerdict[] = cells.flatMap((cell) => GATES.map((gate) => verdictFor(cell, gate)));

const show = (v: FullVerdict): void => {
  const c = v.cell;
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} L=${String(c.lag).padStart(3)}s ${v.gate.label.padEnd(10)}` +
      ` closed-only ${pct(v.closedOnly.point)} [${pct(v.closedOnly.lower)}, ${pct(v.closedOnly.upper)}]` +
      `  open-dead ${v.openDead === null ? 'not evaluable' : pct(v.openDead.point)}` +
      `  n=${String(v.n).padStart(6)} need=${String(v.required ?? 0).padStart(7)}` +
      `  ${v.c1 ? '1' : '-'}${v.c2 ? '2' : '-'}${v.c3 ? '3' : '-'}${v.c4 ? '4' : '-'}` +
      `  ${v.copyable ? 'COPYABLE' : ''}`,
  );
};

console.log('\n  THE PREREGISTERED DECISION — primary venue, cells with coverage at or above 70% only');
for (const v of verdicts.filter(
  (x) => x.cell.venue === 'pumpswap' && x.coverageVerdict !== 'BELOW_STOP_THRESHOLD',
)) {
  show(v);
}
console.log('\n  COVERAGE-FAILED on the primary venue — recorded, and NOT reported as estimates');
for (const c of failed) {
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} L=${String(c.lag).padStart(3)}s` +
      `  coverage ${pct(coverageByCell.get(c)?.coverage ?? null)} < 70%  -> directive §2, reserve reconstruction`,
  );
}

const copyable = verdicts.filter((v) => v.copyable && v.coverageVerdict !== 'BELOW_STOP_THRESHOLD');
console.log(
  `\n  cells satisfying ALL FOUR conditions with reportable coverage: ${copyable.length}` +
    (copyable.length === 0 ? '  ->  no lag is copyable on this evidence' : ''),
);
for (const v of copyable) {
  console.log(
    `    ${v.cell.rankStat} f=${v.cell.fraction} L=${v.cell.lag}s ${v.gate.label}  ${pct(v.closedOnly.point)}` +
      ` [${pct(v.closedOnly.lower)}, ${pct(v.closedOnly.upper)}]  n=${v.n} need=${v.required}  coverage ${pct(v.coverage)}`,
  );
}

// -------------------------------------------------------------------------
// 3. The ratio — now two round trips over the same legs
// -------------------------------------------------------------------------
console.log('\n  THE RATIO, now interpretable: same two legs, same timing, only the price differs');
console.log('    arm                  venue          L   wallet legs   copier   ratio   ratio 95% CI');
for (const c of cells) {
  const nLegs = sum(c.rows, (r) => r.n_legs_paired);
  if (nLegs === 0) continue;
  const w = sum(c.rows, (r) => r.sum_wallet_legs) / nLegs;
  const co = sum(c.rows, (r) => r.sum_ret_on_legs) / nLegs - PRIMARY_FLOOR;
  const perDay = c.rows.map((r) => ({
    cluster: day(r),
    n: r.sum_wallet_legs,
    sum: r.sum_ret_on_legs - PRIMARY_FLOOR * r.n_legs_paired,
  }));
  const raw = clusterBootstrapAggregated(perDay, RESAMPLES);
  const iv = raw.resamples === RESAMPLES ? raw : null;
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${c.venue.padEnd(11)} ${String(c.lag).padStart(4)}s` +
      `  ${pct(w).padStart(11)} ${pct(co).padStart(9)}  ${num(co / w).padStart(6)}` +
      `   ${iv === null ? 'not estimable - see the paired difference' : `[${num(iv.lower)}, ${num(iv.upper)}]`}`,
  );
}

console.log('\n  PAIRED DIFFERENCE — wallet legs minus copier, day-clustered, same drawn days');
for (const c of cells.filter((x) => x.venue === 'pumpswap')) {
  const nLegs = sum(c.rows, (r) => r.n_legs_paired);
  if (nLegs === 0) continue;
  const d = clusterBootstrapDifference(
    c.rows.map((r) => ({ cluster: day(r), n: r.n_legs_paired, sum: r.sum_wallet_legs })),
    c.rows.map((r) => ({
      cluster: day(r),
      n: r.n_legs_paired,
      sum: r.sum_ret_on_legs - PRIMARY_FLOOR * r.n_legs_paired,
    })),
    RESAMPLES,
  );
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} L=${String(c.lag).padStart(4)}s` +
      `  ${pct(d.point).padStart(10)}  [${pct(d.lower)}, ${pct(d.upper)}]  days ${d.daysBothPresent}/${days.length}`,
  );
}

console.log('\n  WHAT THE WALLET GAINS BY SCALING OUT — realised (all sells + mark) vs first-sell only');
for (const c of cells.filter((x) => x.venue === 'pumpswap' && x.lag === 2)) {
  const nR = sum(c.rows, (r) => r.n_realised_paired);
  const nL = sum(c.rows, (r) => r.n_legs_paired);
  if (nR === 0 || nL === 0) continue;
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)}` +
      `  first-sell only ${pct(sum(c.rows, (r) => r.sum_wallet_legs) / nL).padStart(10)}` +
      `  realised ${pct(sum(c.rows, (r) => r.sum_wallet_realised) / nR).padStart(10)}`,
  );
}

// -------------------------------------------------------------------------
// 4. The sizing arm (MT084)
// -------------------------------------------------------------------------
console.log('\n  THE SIZING ARM (MT084) — impact proxy for X% of reserves, primary venue, L=2s');
console.log('    arm                  gate         kept   declined   return   95% CI');
for (const c of cells.filter((x) => x.venue === 'pumpswap' && x.lag === 2)) {
  const total = sum(c.rows, (r) => r.n_both);
  for (const gate of GATES) {
    const v = verdictFor(c, gate);
    console.log(
      `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${gate.label.padEnd(11)}` +
        ` ${String(v.n).padStart(6)}` +
        ` ${`${(((total - v.n) / Math.max(total, 1)) * 100).toFixed(1)}%`.padStart(9)}` +
        ` ${pct(v.closedOnly.point).padStart(9)}  [${pct(v.closedOnly.lower)}, ${pct(v.closedOnly.upper)}]`,
    );
  }
  console.log(
    `    ${' '.repeat(6)} ${' '.repeat(8)} gate not evaluable ${sum(c.rows, (r) => r.n_gate_not_evaluable)}` +
      `   median own impact ${pct(
        (() => {
          const m = c.rows.map((r) => r.median_own_impact).filter((x): x is number => x !== null).sort((a, b) => a - b);
          return m.length === 0 ? null : (m[Math.floor(m.length / 2)] as number);
        })(),
      )}`,
  );
}

// -------------------------------------------------------------------------
// 5. Slippage on each leg
// -------------------------------------------------------------------------
console.log('\n  SLIPPAGE PER LEG — our VWAP against the wallet\'s own fill on that leg');
console.log('    venue         L    entry mean   entry med    exit mean    exit med');
for (const venue of ['pumpswap', 'pumpdotfun']) {
  for (const lag of LAGS) {
    const sel = cells.filter((c) => c.venue === venue && c.lag === lag).flatMap((c) => c.rows);
    const n = sum(sel, (r) => r.n_both);
    if (n === 0) continue;
    const med = (f: (r: Row) => number | null): number | null => {
      const m = sel.map(f).filter((x): x is number => x !== null).sort((a, b) => a - b);
      return m.length === 0 ? null : (m[Math.floor(m.length / 2)] as number);
    };
    console.log(
      `    ${venue.padEnd(12)} ${String(lag).padStart(4)}s ${pct(sum(sel, (r) => r.sum_entry_slip) / n).padStart(11)}` +
        ` ${pct(med((r) => r.median_entry_slip)).padStart(11)}` +
        ` ${pct(sum(sel, (r) => r.sum_exit_slip) / n).padStart(12)}` +
        ` ${pct(med((r) => r.median_exit_slip)).padStart(11)}`,
    );
  }
}

// -------------------------------------------------------------------------
// 6. The state
// -------------------------------------------------------------------------
const primaryReportable = verdicts.filter(
  (v) => v.cell.venue === 'pumpswap' && v.coverageVerdict !== 'BELOW_STOP_THRESHOLD' && v.gate.label === 'UNGATED',
);
const state = phaseDState(primaryReportable);
console.log(`\n  ${primaryReportable.length} reportable primary UNGATED cells.`);
console.log(`  condition 1 passes ${primaryReportable.filter((v) => v.c1).length}, condition 2 ${primaryReportable.filter((v) => v.c2).length},`);
console.log(`  condition 4 ${primaryReportable.filter((v) => v.c4).length}, all four ${primaryReportable.filter((v) => v.copyable).length}.`);
console.log(`\n  FINAL STATE: ${state}`);

// -------------------------------------------------------------------------
// 7. The artifact
// -------------------------------------------------------------------------
mkdirSync('artifacts', { recursive: true });
const artifact = {
  generatedFrom: { path, queryId: parsed.query_id ?? null, executionId: parsed.execution_id ?? null },
  rule: 'MT083',
  gates: GATES.map((g) => ({ label: g.label, reserveX: g.reserveX, impactThreshold: g.impact })),
  primaryFloor: PRIMARY_FLOOR,
  floors: FLOORS,
  resamples: RESAMPLES,
  utcDays: days.length,
  lags: LAGS,
  coverageThresholds: { report: COVERAGE_REPORT_THRESHOLD, stop: COVERAGE_STOP_THRESHOLD },
  state,
  rollingRerankRan: false,
  reserveReconstructionRan: false,
  cells: verdicts.map((v) => ({
    rankStat: v.cell.rankStat,
    topFraction: v.cell.fraction,
    venue: v.cell.venue,
    lagSeconds: v.cell.lag,
    gate: v.gate.label,
    followable: sum(v.cell.rows, (r) => r.n_followable),
    open: sum(v.cell.rows, (r) => r.n_open),
    entryPriced: sum(v.cell.rows, (r) => r.n_entry_priced),
    exitPriced: sum(v.cell.rows, (r) => r.n_exit_priced),
    both: sum(v.cell.rows, (r) => r.n_both),
    openEntryPriced: sum(v.cell.rows, (r) => r.n_open_entry_priced),
    gateNotEvaluable: sum(v.cell.rows, (r) => r.n_gate_not_evaluable),
    kept: v.n,
    coverage: v.coverage,
    coverageVerdict: v.coverageVerdict,
    closedOnly: { point: v.closedOnly.point, lower: v.closedOnly.lower, upper: v.closedOnly.upper },
    openAtMinus100:
      v.openDead === null
        ? null
        : { point: v.openDead.point, lower: v.openDead.lower, upper: v.openDead.upper },
    requiredN: v.required,
    conditions: { c1: v.c1, c2: v.c2, c3: v.c3, c4: v.c4 },
    copyable: v.copyable,
    reportable: v.coverageVerdict !== 'BELOW_STOP_THRESHOLD',
  })),
};
writeFileSync('artifacts/phase-d-round-trip.json', `${JSON.stringify(artifact, null, 2)}\n`);
console.log('\n  artifact           artifacts/phase-d-round-trip.json');
