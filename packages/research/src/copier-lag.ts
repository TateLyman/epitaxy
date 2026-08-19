/**
 * Phase C — the arithmetic of the copier's return, separated from the reporting.
 *
 * MT079 decides a lag on four conditions, and three of them are arithmetic on
 * counts that a bug would move silently: which positions are in the denominator,
 * what a censored position contributes, and what the coefficient of variation is
 * computed on. Those live here so they can be tested against hand-computed values
 * rather than eyeballed in a printed table.
 *
 * The estimand, for every treatment, is a MEAN over positions, so each treatment
 * reduces a cell to the (n, sum) pair a day-clustered bootstrap of a mean needs —
 * see `clusterBootstrapAggregated`, whose equality with the full-panel bootstrap is
 * asserted exactly rather than approximately.
 */

/** One (day, arm, venue, lag) cell's counts and sums, as query 5 returns them. */
export interface CopierCellRow {
  /** Positions that were followable: not window-truncated, and a copier entry price existed. */
  readonly n: number;
  /** Followable, but no exit price in the 60-second exit window. */
  readonly nCensored: number;
  /** Followable, with an exit price in the WIDE (5-minute) window. Superset of `n`. */
  readonly nWide: number;
  readonly sumCopierRet: number;
  readonly sumCopierRetSq: number;
  readonly sumCopierRetWide: number;
}

/**
 * AS_PRICED       censored positions excluded, as an AVG would report them.
 * CENSORED        censored positions entered at -100%.
 * *_WIDE          the same pair against the 5-minute exit window.
 *
 * The censored pair shares ONE denominator — `n + nCensored`, the followable set —
 * so the two treatments are two different fills of the same population and not two
 * different populations. That is what makes MT079's sign-agreement condition a
 * statement about censoring rather than about sample selection.
 */
export type Treatment = 'AS_PRICED' | 'CENSORED' | 'AS_PRICED_WIDE' | 'CENSORED_WIDE';

export interface Aggregate {
  readonly n: number;
  readonly sum: number;
}

/** Followable positions: the shared denominator of the censored treatments. */
export const followable = (r: CopierCellRow): number => r.n + r.nCensored;

/**
 * Positions censored under the wide window.
 *
 * `nWide` counts followable positions with a price in the 5-minute window, so the
 * wide-censored count is the followable set minus those. Clamped at zero because a
 * `nWide` larger than the followable set would be a query defect, and silently
 * producing a negative count would turn that defect into a plausible number.
 */
export const censoredWide = (r: CopierCellRow): number => Math.max(followable(r) - r.nWide, 0);

/**
 * Reduce a cell to (n, sum) under one treatment, with the cost floor applied.
 *
 * The floor is charged ONLY to positions that actually traded: a censored position
 * contributes exactly -1.0 (a total loss already includes every cost), and charging
 * the floor on top of -1 would report a loss greater than the capital deployed.
 */
export function treatmentAggregate(r: CopierCellRow, treatment: Treatment, floor: number): Aggregate {
  switch (treatment) {
    case 'AS_PRICED':
      return { n: r.n, sum: r.sumCopierRet - floor * r.n };
    case 'CENSORED':
      return { n: followable(r), sum: r.sumCopierRet - floor * r.n - r.nCensored };
    case 'AS_PRICED_WIDE':
      return { n: r.nWide, sum: r.sumCopierRetWide - floor * r.nWide };
    case 'CENSORED_WIDE':
      return {
        n: followable(r),
        sum: r.sumCopierRetWide - floor * r.nWide - censoredWide(r),
      };
  }
}

/**
 * Coefficient of variation of the NET copier return, pooled over a cell's days.
 *
 * MT079 condition 4 is `n >= 7.84 * CV^2` computed on the copier return, so the CV
 * has to be of the quantity being tested — net of the floor, not gross. Subtracting
 * a constant moves the mean and leaves the variance, which is exactly why it
 * matters here: the floor shrinks a small positive mean and inflates the CV, and
 * using the gross mean would understate the required sample.
 *
 * Returns null when the mean is zero (the CV is undefined) or n < 2.
 */
export function coefficientOfVariation(rows: readonly CopierCellRow[], floor: number): number | null {
  const n = rows.reduce((a, r) => a + r.n, 0);
  if (n < 2) return null;
  const gross = rows.reduce((a, r) => a + r.sumCopierRet, 0);
  const grossSq = rows.reduce((a, r) => a + r.sumCopierRetSq, 0);
  // sum((x - f)^2) = sum(x^2) - 2f*sum(x) + n*f^2
  const netSum = gross - floor * n;
  const netSumSq = grossSq - 2 * floor * gross + floor * floor * n;
  const mean = netSum / n;
  if (mean === 0) return null;
  const variance = Math.max(netSumSq / n - mean * mean, 0);
  return Math.sqrt(variance) / Math.abs(mean);
}

export interface ConditionInput {
  readonly asPricedPoint: number | null;
  readonly asPricedLower: number;
  readonly censoredPoint: number | null;
  readonly venue: string;
  readonly n: number;
  readonly requiredN: number | null;
}

export interface Conditions {
  /** Lower bound above zero, net of the floor. */
  readonly c1: boolean;
  /** As-priced and censored agree in sign. The condition H2 failed. */
  readonly c2: boolean;
  /** The venue this apparatus can enter. */
  readonly c3: boolean;
  /** Powered: n at or above 7.84 * CV^2. */
  readonly c4: boolean;
  readonly copyable: boolean;
}

/**
 * MT079's rule, applied as written: a lag is copyable only if ALL FOUR hold.
 *
 * A null point estimate fails everything rather than defaulting to true — an
 * absent number is not a passed condition, and this is the one place where a
 * missing cell could otherwise be read as a clearance.
 */
export function conditionsOf(x: ConditionInput): Conditions {
  const c1 = x.asPricedPoint !== null && x.asPricedLower > 0;
  const c2 =
    x.asPricedPoint !== null &&
    x.censoredPoint !== null &&
    Math.sign(x.asPricedPoint) === Math.sign(x.censoredPoint);
  const c3 = x.venue === 'pumpswap';
  const c4 = x.requiredN !== null && x.n >= x.requiredN;
  return { c1, c2, c3, c4, copyable: c1 && c2 && c3 && c4 };
}

/**
 * The final state, from the primary-arm verdicts alone.
 *
 * The order is not arbitrary. A copyable cell wins outright; failing that, a sign
 * disagreement means the data cannot answer the question, which is a different
 * statement from "the answer is no" and must not be collapsed into it; only when
 * every cell is decidable AND none is copyable has the branch actually closed.
 */
export type PhaseCState = 'COPYABLE_LAG_IDENTIFIED' | 'UNDECIDABLE_CENSORING' | 'EDGE_IS_EXECUTION_ONLY';

export function phaseCState(primary: readonly Conditions[]): PhaseCState {
  if (primary.some((c) => c.copyable)) return 'COPYABLE_LAG_IDENTIFIED';
  if (primary.some((c) => !c.c2)) return 'UNDECIDABLE_CENSORING';
  return 'EDGE_IS_EXECUTION_ONLY';
}

// ---------------------------------------------------------------------------
// Phase D — the paired round trip
// ---------------------------------------------------------------------------

/**
 * One (day, arm, venue, lag) cell of the Phase D estimand.
 *
 * The difference from Phase C is where the exit comes from: both legs are anchored
 * on trades the WALLET executed, so a position is priced or not for reasons about
 * that wallet's own activity rather than about whether a stranger happened to trade
 * at an arbitrary wall-clock instant.
 */
export interface RoundTripCellRow {
  /** Top-cohort holdout positions in the cell, before any pricing. */
  readonly nFollowable: number;
  /** Both legs priced: the estimation set. */
  readonly nBoth: number;
  /** The wallet never sold, and the copier's entry was priced: genuinely OPEN. */
  readonly nOpenEntryPriced: number;
  readonly sumRet: number;
  readonly sumRetSq: number;
}

/**
 * CLOSED_ONLY        open positions excluded, counted beside the estimate.
 * OPEN_AT_MINUS_100  open positions entered at -1.0.
 *
 * The third treatment the directive names — open priced at a reconstructed reserve
 * mark — is deliberately absent: it exists only if the reserve reconstruction runs,
 * and a treatment that silently falls back to one of the other two would make the
 * sign-agreement condition compare a thing to itself.
 */
export type RoundTripTreatment = 'CLOSED_ONLY' | 'OPEN_AT_MINUS_100';

export function roundTripAggregate(
  r: RoundTripCellRow,
  treatment: RoundTripTreatment,
  floor: number,
): Aggregate {
  switch (treatment) {
    case 'CLOSED_ONLY':
      return { n: r.nBoth, sum: r.sumRet - floor * r.nBoth };
    case 'OPEN_AT_MINUS_100':
      // The floor is charged only to the round trips that happened. An open
      // position entered at -1.0 has already lost everything.
      return { n: r.nBoth + r.nOpenEntryPriced, sum: r.sumRet - floor * r.nBoth - r.nOpenEntryPriced };
  }
}

/**
 * Coverage thresholds, from the directive rather than from the data.
 *
 * Below 90%: say so before reporting a single return.
 * Below 70%: the estimate carries the same defect under a new name, and the phase
 * goes to reserve reconstruction instead of reporting it.
 */
export const COVERAGE_REPORT_THRESHOLD = 0.9;
export const COVERAGE_STOP_THRESHOLD = 0.7;

export type CoverageVerdict = 'OK' | 'BELOW_REPORT_THRESHOLD' | 'BELOW_STOP_THRESHOLD';

export function coverageOf(r: RoundTripCellRow): number | null {
  return r.nFollowable === 0 ? null : r.nBoth / r.nFollowable;
}

export function coverageVerdict(coverage: number | null): CoverageVerdict {
  if (coverage === null || coverage < COVERAGE_STOP_THRESHOLD) return 'BELOW_STOP_THRESHOLD';
  if (coverage < COVERAGE_REPORT_THRESHOLD) return 'BELOW_REPORT_THRESHOLD';
  return 'OK';
}

/**
 * Phase D's three states. Same structure as Phase C's, with the closed branch
 * renamed: NO_COPYABLE_LAG says the conditions failed while the treatments AGREED,
 * which is a decision; UNDECIDABLE_CENSORING says they disagreed, which is not.
 */
export type PhaseDState = 'COPYABLE_LAG_IDENTIFIED' | 'NO_COPYABLE_LAG' | 'UNDECIDABLE_CENSORING';

export function phaseDState(primary: readonly Conditions[]): PhaseDState {
  if (primary.some((c) => c.copyable)) return 'COPYABLE_LAG_IDENTIFIED';
  if (primary.some((c) => !c.c2)) return 'UNDECIDABLE_CENSORING';
  return 'NO_COPYABLE_LAG';
}
