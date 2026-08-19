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
