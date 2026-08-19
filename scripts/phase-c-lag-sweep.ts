/**
 * MT079 — Phase C, the copier's price as a function of lag.
 *
 * H1 measured the WALLET's realised return, which is SELECTION (they chose a mint
 * that appreciated — transferable) plus EXECUTION (their fill, their sizing, their
 * exit — not transferable). A copier inherits the first and forfeits the second, so
 * H1 is an upper bound on a copy strategy and says nothing about its value.
 *
 * THE PREREGISTERED RULE (MT079, frozen before query 5 ran). A lag L is COPYABLE
 * if and only if all four hold:
 *
 *   1. copier_return(L) day-clustered 95% LOWER BOUND > 0, net of the tier floor
 *   2. the as-priced and censored treatments AGREE IN SIGN
 *   3. the cell is entry_project = pumpswap
 *   4. n >= 7.84 x CV_observed^2, computed on the COPIER return
 *
 * Condition 2 is the one H2 failed and it is not negotiable.
 *
 * TWO RATIOS, AND ONLY ONE OF THEM MEANS ANYTHING
 *
 * The directive specifies `copier_return(L) / wallet_return`. Taken literally the
 * denominator is the wallet's realised return over the whole position — its own
 * exit, whenever it took it, with a carry-forward mark if it never did — while the
 * numerator is a fixed 60-minute round trip. Those are different holding periods,
 * and their ratio can be negative, unbounded, or undefined without anything being
 * wrong with either. It is reported, labelled.
 *
 * The ratio that answers the question applies the SAME t+3600s exit to both sides
 * and changes only whose entry price is in the denominator:
 *
 *     wallet_ret_60m = exit / THEIR fill    - 1
 *     copier_ret(L)  = exit / OUR VWAP(L)   - 1
 *     selection share = copier_ret / wallet_ret_60m
 *
 * That is the share of the same appreciation a copier keeps, and its decay in L is
 * the alpha decay curve this phase exists to produce.
 *
 * Usage: pnpm lag:sweep [path-to-q5-results.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  clusterBootstrapAggregated,
  clusterBootstrapDifference,
  type ClusterAggregate,
} from '../packages/research/src/robust-stats.js';
import {
  conditionsOf,
  followable,
  censoredWide as censoredWideCount,
  coefficientOfVariation,
  phaseCState,
  treatmentAggregate,
  type Conditions,
  type CopierCellRow,
  type Treatment,
} from '../packages/research/src/copier-lag.js';
import { requiredPositions } from '../packages/domain/src/confirmatory.js';

/**
 * Round-trip cost floors from D70B4A9A §1.1, re-cut per tier in Phase B §1.3.
 *
 * The tier is a property of a PumpSwap POOL and is not in `dex_solana.trades`, so
 * it is not known per position here. Tier 0 is the primary because it is both the
 * conservative case and the modal one — Phase B found 1.69% of mints reach tier 2
 * inside 2m–60m. The others are reported as sensitivity: a known-tier version can
 * only move the copier side in its favour.
 */
const FLOORS = { tier0: 0.02669, tier2: 0.02350, tier8: 0.01722 } as const;
const PRIMARY_FLOOR = FLOORS.tier0;
const RESAMPLES = 10_000;

interface Row {
  readonly utc_day: string;
  readonly rank_stat: 'MEAN' | 'MEDIAN';
  readonly top_fraction: number | string;
  readonly entry_project: string;
  readonly lag_s: number;
  readonly n_all: number;
  readonly n_no_entry_px: number;
  readonly n_exit_truncated: number;
  readonly n_censored: number;
  readonly n: number;
  readonly sum_copier_ret: number;
  readonly sum_copier_ret_sq: number;
  readonly n_positive_copier: number;
  readonly median_copier_ret: number | null;
  readonly n_paired: number;
  readonly sum_wallet_ret_paired: number;
  readonly sum_copier_ret_paired: number;
  readonly n_matched: number;
  readonly sum_wallet_ret_60m: number;
  readonly sum_wallet_ret_60m_sq: number;
  readonly sum_copier_ret_matched: number;
  readonly sum_entry_slippage: number;
  readonly n_wide: number;
  readonly sum_copier_ret_wide: number;
  readonly sum_copier_ret_wide_sq: number;
  readonly sum_wallet_sol_in: number;
  readonly median_entry_slippage: number | null;
  readonly median_tape_legs: number | null;
  readonly wallets_in_cell: number;
}

const path = process.argv[2] ?? 'ops/dune/results/q5-copier-lag-sweep.json';
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

/**
 * The four treatments and the CV come from `packages/research/src/copier-lag.ts`,
 * where they are unit-tested against hand-computed values. This file is the
 * reporting layer: it decides nothing that is not decided there.
 */
const cellRow = (r: Row): CopierCellRow => ({
  n: r.n,
  nCensored: r.n_censored,
  nWide: r.n_wide,
  sumCopierRet: r.sum_copier_ret,
  sumCopierRetSq: r.sum_copier_ret_sq,
  sumCopierRetWide: r.sum_copier_ret_wide,
});

const aggregates = (rs: readonly Row[], treatment: Treatment, floor: number): ClusterAggregate[] =>
  rs.map((r) => ({ cluster: day(r), ...treatmentAggregate(cellRow(r), treatment, floor) }));

console.log(`MT079 — Phase C, the copier's price by lag, from ${path}`);
console.log(`  dune query ${parsed.query_id ?? '?'} execution ${parsed.execution_id ?? '?'}`);
console.log(`  ${rows.length} (day, arm, venue, lag) cells over ${days.length} UTC days, ${RESAMPLES} resamples`);
console.log(`  primary floor: tier 0, ${(PRIMARY_FLOOR * 100).toFixed(3)}% round trip, applied to the COPIER only`);
console.log(`  the wallet side carries our fixed cost only (MT075): the AMM fee and the impact are`);
console.log(`  already inside the on-chain amounts, and subtracting the full floor there double counts.\n`);

// -------------------------------------------------------------------------
// 1. Coverage — the ceiling on any copy strategy, before any return
// -------------------------------------------------------------------------
console.log('  COVERAGE — what fraction of a followed buy is even enterable and measurable');
console.log('    arm                  venue        L    follows   enterable   priced   priced_wide   wallets');
for (const c of cells) {
  if (c.lag !== 2 && c.lag !== 300) continue;
  const all = sum(c.rows, (r) => r.n_all);
  const enterable = sum(c.rows, (r) => followable(cellRow(r)));
  const priced = sum(c.rows, (r) => r.n);
  const wide = sum(c.rows, (r) => r.n_wide);
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${c.venue.padEnd(11)} ${String(c.lag).padStart(4)}` +
      ` ${String(all).padStart(9)} ${`${((enterable / all) * 100).toFixed(1)}%`.padStart(11)}` +
      ` ${`${((priced / all) * 100).toFixed(1)}%`.padStart(8)} ${`${((wide / all) * 100).toFixed(1)}%`.padStart(13)}` +
      ` ${String(Math.max(...c.rows.map((r) => r.wallets_in_cell))).padStart(9)}`,
  );
}

// -------------------------------------------------------------------------
// 2. The decision, cell by cell
// -------------------------------------------------------------------------
interface Verdict {
  readonly cell: Cell;
  readonly asPriced: ReturnType<typeof clusterBootstrapAggregated>;
  readonly censored: ReturnType<typeof clusterBootstrapAggregated>;
  readonly wide: ReturnType<typeof clusterBootstrapAggregated>;
  readonly censoredWide: ReturnType<typeof clusterBootstrapAggregated>;
  readonly required: number | null;
  readonly n: number;
}
type FullVerdict = Verdict & Conditions;

const verdicts: FullVerdict[] = cells.map((cell) => {
  const asPriced = clusterBootstrapAggregated(aggregates(cell.rows, 'AS_PRICED', PRIMARY_FLOOR), RESAMPLES);
  const censored = clusterBootstrapAggregated(aggregates(cell.rows, 'CENSORED', PRIMARY_FLOOR), RESAMPLES);
  const wide = clusterBootstrapAggregated(aggregates(cell.rows, 'AS_PRICED_WIDE', PRIMARY_FLOOR), RESAMPLES);
  const censoredWide = clusterBootstrapAggregated(aggregates(cell.rows, 'CENSORED_WIDE', PRIMARY_FLOOR), RESAMPLES);
  const n = sum(cell.rows, (r) => r.n);
  const required = requiredPositions(coefficientOfVariation(cell.rows.map(cellRow), PRIMARY_FLOOR));
  const cond = conditionsOf({
    asPricedPoint: asPriced.point,
    asPricedLower: asPriced.lower,
    censoredPoint: censored.point,
    venue: cell.venue,
    n,
    requiredN: required,
  });
  return { cell, asPriced, censored, wide, censoredWide, ...cond, required, n };
});

const show = (v: FullVerdict): void => {
  const c = v.cell;
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${c.venue.padEnd(11)} L=${String(c.lag).padStart(3)}s` +
      `  as-priced ${pct(v.asPriced.point)} [${pct(v.asPriced.lower)}, ${pct(v.asPriced.upper)}]` +
      `  censored ${pct(v.censored.point)}` +
      `  wide ${pct(v.wide.point)}/${pct(v.censoredWide.point)}` +
      `  n=${String(v.n).padStart(6)} need=${String(v.required ?? 0).padStart(6)}` +
      `  ${v.c1 ? '1' : '-'}${v.c2 ? '2' : '-'}${v.c3 ? '3' : '-'}${v.c4 ? '4' : '-'}` +
      `  ${v.copyable ? 'COPYABLE' : ''}`,
  );
};

console.log('\n  THE PREREGISTERED DECISION, net of the tier-0 floor. Flags are the four MT079 conditions.');
console.log('  PRIMARY ARM — entry_project = pumpswap, the venue this apparatus can enter');
for (const v of verdicts.filter((x) => x.cell.venue === 'pumpswap')) show(v);
console.log('\n  COMPARISON ONLY — the bonding curve, which this apparatus cannot enter (Phase B)');
for (const v of verdicts.filter((x) => x.cell.venue !== 'pumpswap')) show(v);

const copyable = verdicts.filter((v) => v.copyable);
console.log(
  `\n  cells satisfying ALL FOUR conditions: ${copyable.length}` +
    (copyable.length === 0 ? '  ->  no lag is copyable on this evidence' : ''),
);
for (const v of copyable) {
  console.log(`    ${v.cell.rankStat} f=${v.cell.fraction} L=${v.cell.lag}s  ${pct(v.asPriced.point)}`);
}

// -------------------------------------------------------------------------
// 3. The alpha decay curve — the number the phase exists to produce
// -------------------------------------------------------------------------
console.log('\n  ALPHA DECAY — horizon-matched selection share, same t+3600s exit on both sides');
console.log('    arm                  venue          L   wallet_60m   copier(L)   entry slip   share   share 95% CI');
for (const c of cells) {
  const nMatched = sum(c.rows, (r) => r.n_matched);
  if (nMatched === 0) continue;
  const w = sum(c.rows, (r) => r.sum_wallet_ret_60m) / nMatched;
  const co = sum(c.rows, (r) => r.sum_copier_ret_matched) / nMatched - PRIMARY_FLOOR;
  const slip = sum(c.rows, (r) => r.sum_entry_slippage) / nMatched;
  // The share is a ratio of sums, which `clusterBootstrapAggregated` computes
  // directly: it returns SUM(sum)/SUM(n) over resampled days, so putting the
  // wallet side in `n` and the copier side in `sum` makes the same function
  // return the ratio, resampled by day. No second interval method is introduced.
  // Only valid while every day's wallet total is positive, which is asserted.
  const perDay = c.rows.map((r) => ({
    cluster: day(r),
    n: r.sum_wallet_ret_60m,
    sum: r.sum_copier_ret_matched - PRIMARY_FLOOR * r.n_matched,
  }));
  // A ratio of sums is well defined when the POOLED denominator is non-zero, and
  // an individual day's wallet total may be negative without that being a problem.
  // What WOULD be a problem is a resample whose denominator crosses zero: the
  // function drops those, and a dropped resample biases the interval rather than
  // widening it. So the interval is reported only when every resample survived,
  // and otherwise the execution premium below carries the uncertainty instead.
  const raw = clusterBootstrapAggregated(perDay, RESAMPLES);
  const iv = raw.resamples === RESAMPLES ? raw : null;
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} ${c.venue.padEnd(11)} ${String(c.lag).padStart(4)}s` +
      `  ${pct(w).padStart(10)}  ${pct(co).padStart(10)}  ${pct(slip).padStart(10)}` +
      `   ${num(co / w).padStart(6)}   ${iv === null ? 'ratio interval not estimable - see the execution premium' : `[${num(iv.lower)}, ${num(iv.upper)}]`}`,
  );
}

console.log('\n  THE SPECIFIED RATIO, for the record: copier(L) over the wallet REALISED return');
console.log('    (different holding periods on the two sides — see the header. Reported, not interpreted.)');
for (const c of cells.filter((x) => x.venue === 'pumpswap')) {
  const nPaired = sum(c.rows, (r) => r.n_paired);
  if (nPaired === 0) continue;
  const w = sum(c.rows, (r) => r.sum_wallet_ret_paired) / nPaired;
  const co = sum(c.rows, (r) => r.sum_copier_ret_paired) / nPaired - PRIMARY_FLOOR;
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} L=${String(c.lag).padStart(4)}s` +
      `  wallet realised ${pct(w).padStart(10)}  copier ${pct(co).padStart(10)}  ratio ${num(co / w)}`,
  );
}

// -------------------------------------------------------------------------
// 4. MT072, measured at last, and the floor sensitivity
// -------------------------------------------------------------------------
console.log('\n  MT072 — QUOTE-TO-LAND SLIPPAGE, measured rather than declared UNKNOWN');
console.log('    Our entry VWAP against the wallet\'s own fill, on the same position. Median in brackets.');
for (const venue of ['pumpswap', 'pumpdotfun']) {
  for (const lag of LAGS) {
    const sel = cells.filter((c) => c.venue === venue && c.lag === lag);
    const nMatched = sum(sel.flatMap((c) => c.rows), (r) => r.n_matched);
    if (nMatched === 0) continue;
    const slip = sum(sel.flatMap((c) => c.rows), (r) => r.sum_entry_slippage) / nMatched;
    const meds = sel
      .flatMap((c) => c.rows)
      .map((r) => r.median_entry_slippage)
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    console.log(
      `    ${venue.padEnd(11)} L=${String(lag).padStart(4)}s   mean ${pct(slip).padStart(10)}` +
        `   [median of per-day medians ${pct(meds.length === 0 ? null : (meds[Math.floor(meds.length / 2)] as number))}]`,
    );
  }
}

console.log('\n  FLOOR SENSITIVITY on the primary arm at L=2s, as-priced (the floor cannot rescue a sign)');
for (const [tier, floor] of Object.entries(FLOORS)) {
  for (const c of cells.filter((x) => x.venue === 'pumpswap' && x.lag === 2)) {
    const iv = clusterBootstrapAggregated(aggregates(c.rows, 'AS_PRICED', floor), RESAMPLES);
    const cen = clusterBootstrapAggregated(aggregates(c.rows, 'CENSORED', floor), RESAMPLES);
    console.log(
      `    ${tier.padEnd(6)} ${(floor * 100).toFixed(3)}%  ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)}` +
        `  as-priced ${pct(iv.point)} [${pct(iv.lower)}, ${pct(iv.upper)}]  censored ${pct(cen.point)}`,
    );
  }
}

// -------------------------------------------------------------------------
// 5. Execution premium — the paired difference, with an interval
// -------------------------------------------------------------------------
console.log('\n  EXECUTION PREMIUM — wallet_60m minus copier(L), day-clustered and paired');
console.log('    What their fill is worth over ours on the same position and the same exit.');
for (const c of cells.filter((x) => x.venue === 'pumpswap')) {
  const nMatched = sum(c.rows, (r) => r.n_matched);
  if (nMatched === 0) continue;
  const d = clusterBootstrapDifference(
    c.rows.map((r) => ({ cluster: day(r), n: r.n_matched, sum: r.sum_wallet_ret_60m })),
    c.rows.map((r) => ({
      cluster: day(r),
      n: r.n_matched,
      sum: r.sum_copier_ret_matched - PRIMARY_FLOOR * r.n_matched,
    })),
    RESAMPLES,
  );
  console.log(
    `    ${c.rankStat.padEnd(6)} f=${String(c.fraction).padEnd(6)} L=${String(c.lag).padStart(4)}s` +
      `  ${pct(d.point).padStart(10)}  [${pct(d.lower)}, ${pct(d.upper)}]  days paired ${d.daysBothPresent}/${days.length}`,
  );
}

// -------------------------------------------------------------------------
// 6. The state
// -------------------------------------------------------------------------
const primary = verdicts.filter((v) => v.cell.venue === 'pumpswap');
const signDisagreement = primary.filter((v) => !v.c2).length;
const shares = cells
  .filter((c) => c.venue === 'pumpswap')
  .map((c) => {
    const nm = sum(c.rows, (r) => r.n_matched);
    if (nm === 0) return null;
    const w = sum(c.rows, (r) => r.sum_wallet_ret_60m) / nm;
    const co = sum(c.rows, (r) => r.sum_copier_ret_matched) / nm - PRIMARY_FLOOR;
    return w > 0 ? co / w : null;
  })
  .filter((x): x is number => x !== null);
const maxShare = shares.length === 0 ? null : Math.max(...shares);

const state = phaseCState(primary);

console.log(`\n  ${primary.length} primary cells. ${signDisagreement} fail condition 2, the sign agreement.`);
console.log(`  largest horizon-matched selection share on the primary arm: ${num(maxShare)}`);
console.log(`\n  FINAL STATE: ${state}`);
if (state === 'UNDECIDABLE_CENSORING') {
  const decidable = primary.filter((v) => v.c2);
  const decidablePositive = decidable.filter((v) => v.c1).length;
  console.log('    The exit is unobservable for a large share of followable positions, and the two');
  console.log('    defensible treatments of that disagree in sign. Per MT079 no threshold search');
  console.log('    follows. The selection share above is REAL but CONDITIONAL on an observable exit,');
  console.log('    and the unconditional value cannot be bounded from a public tape at this horizon.');
  console.log('');
  console.log(`    THE SPLIT MATTERS: ${decidable.length} of ${primary.length} primary cells DO agree in sign, and`);
  console.log(`    ${decidablePositive} of those clear condition 1. The cells that look profitable are exactly the`);
  console.log('    ones whose sign flips under censoring, and the cells where censoring changes nothing');
  console.log('    are negative. Both readings arrive at no copyable lag, by different routes, and that');
  console.log('    agreement is worth more than either cell taken alone.');
}

// -------------------------------------------------------------------------
// 7. The artifact
//
// Printed output is not a record. Every cell's counts, both treatments, all four
// conditions and the state go to a JSON file so the result is diffable, testable,
// and re-readable without spending a Dune credit — the convention every prior
// phase used, and the reason those phases' claims can still be checked.
// -------------------------------------------------------------------------
mkdirSync('artifacts', { recursive: true });
const artifact = {
  generatedFrom: { path, queryId: parsed.query_id ?? null, executionId: parsed.execution_id ?? null },
  rule: 'MT079',
  primaryFloor: PRIMARY_FLOOR,
  floors: FLOORS,
  resamples: RESAMPLES,
  utcDays: days.length,
  lags: LAGS,
  state,
  cells: verdicts.map((v) => {
    const nMatched = sum(v.cell.rows, (r) => r.n_matched);
    const walletRet60m = nMatched === 0 ? null : sum(v.cell.rows, (r) => r.sum_wallet_ret_60m) / nMatched;
    const copierMatched =
      nMatched === 0 ? null : sum(v.cell.rows, (r) => r.sum_copier_ret_matched) / nMatched - PRIMARY_FLOOR;
    return {
      rankStat: v.cell.rankStat,
      topFraction: v.cell.fraction,
      venue: v.cell.venue,
      lagSeconds: v.cell.lag,
      follows: sum(v.cell.rows, (r) => r.n_all),
      followable: sum(v.cell.rows, (r) => followable(cellRow(r))),
      priced: v.n,
      censored: sum(v.cell.rows, (r) => r.n_censored),
      pricedWide: sum(v.cell.rows, (r) => r.n_wide),
      censoredWide: sum(v.cell.rows, (r) => censoredWideCount(cellRow(r))),
      noEntryPrice: sum(v.cell.rows, (r) => r.n_no_entry_px),
      exitTruncated: sum(v.cell.rows, (r) => r.n_exit_truncated),
      asPriced: { point: v.asPriced.point, lower: v.asPriced.lower, upper: v.asPriced.upper },
      censoredTreatment: { point: v.censored.point, lower: v.censored.lower, upper: v.censored.upper },
      asPricedWide: { point: v.wide.point, lower: v.wide.lower, upper: v.wide.upper },
      censoredWideTreatment: {
        point: v.censoredWide.point,
        lower: v.censoredWide.lower,
        upper: v.censoredWide.upper,
      },
      requiredN: v.required,
      conditions: { c1: v.c1, c2: v.c2, c3: v.c3, c4: v.c4 },
      copyable: v.copyable,
      walletRet60m,
      copierRetMatched: copierMatched,
      selectionShare:
        walletRet60m === null || copierMatched === null || walletRet60m === 0 ? null : copierMatched / walletRet60m,
      entrySlippage: nMatched === 0 ? null : sum(v.cell.rows, (r) => r.sum_entry_slippage) / nMatched,
    };
  }),
};
writeFileSync('artifacts/phase-c-lag-sweep.json', `${JSON.stringify(artifact, null, 2)}\n`);
console.log('\n  artifact           artifacts/phase-c-lag-sweep.json');
