/**
 * P11 — make cohorts and scores comparable, or refuse to compare them.
 *
 * A "first-hour freshness" feature cannot rank a seven-day cohort. Its value is
 * near-constant there, so ranking on it orders a seven-day cohort by noise while
 * looking like it ordered by freshness. That is worse than not scoring at all,
 * because a noisy ranking is still a ranking and something downstream will act
 * on it.
 *
 * Two remedies are acceptable, and this module implements the first while making
 * the second expressible:
 *
 *   cohort-relative feature transforms  (rank within cohort, not across)
 *   separate score calibration by cohort
 *
 * What is NOT acceptable is comparing a raw first-hour figure across all four
 * cohorts, and `assertNoCrossCohortRawComparison` exists to make that a loud
 * failure rather than a silent one.
 */

export const COHORTS = ['FIRST_HOUR', 'FIRST_DAY', 'FIRST_WEEK', 'OLDER'] as const;
export type Cohort = (typeof COHORTS)[number];

/**
 * FOUR SEPARATE CLOCKS, deliberately.
 *
 * Token age, migration age, pool age and Mayhem elapsed time are different
 * facts and routinely disagree. A token minted a week ago can migrate five
 * minutes ago into a pool created five minutes ago; collapsing those into "age"
 * makes a fresh pool look stale and a stale token look fresh.
 */
export interface AgeFacts {
  readonly tokenAgeMs: number | null;
  readonly timeSinceMigrationMs: number | null;
  readonly timeSinceCurrentPoolCreationMs: number | null;
  readonly mayhemElapsedMs: number | null;
}

export interface CohortBounds {
  readonly cohort: Cohort;
  readonly lowerMs: number;
  readonly upperMs: number | null;
  /** Which clock the bounds are on. Never implicit. */
  readonly clock: keyof AgeFacts;
}

export const MIGRATION_AGE_BANDS: readonly CohortBounds[] = [
  { cohort: 'FIRST_HOUR', lowerMs: 0, upperMs: 3_600_000, clock: 'timeSinceMigrationMs' },
  { cohort: 'FIRST_DAY', lowerMs: 3_600_000, upperMs: 86_400_000, clock: 'timeSinceMigrationMs' },
  { cohort: 'FIRST_WEEK', lowerMs: 86_400_000, upperMs: 604_800_000, clock: 'timeSinceMigrationMs' },
  { cohort: 'OLDER', lowerMs: 604_800_000, upperMs: null, clock: 'timeSinceMigrationMs' },
];

export interface CohortAssignment {
  readonly cohort: Cohort | null;
  readonly bounds: CohortBounds | null;
  readonly reason: string;
}

/**
 * Assign on ONE named clock.
 *
 * Returns null rather than a default cohort when the clock is unknown. A token
 * assigned to `OLDER` because nothing was known about it would be scored against
 * a population it may not belong to.
 */
export function assignCohort(
  ages: AgeFacts,
  bands: readonly CohortBounds[] = MIGRATION_AGE_BANDS,
): CohortAssignment {
  const clock = bands[0]?.clock ?? 'timeSinceMigrationMs';
  const v = ages[clock];
  if (v === null || v === undefined) {
    return { cohort: null, bounds: null, reason: `${clock} is unknown, so no cohort applies` };
  }
  for (const b of bands) {
    if (v >= b.lowerMs && (b.upperMs === null || v < b.upperMs)) {
      return { cohort: b.cohort, bounds: b, reason: `${clock}=${v}ms` };
    }
  }
  return { cohort: null, bounds: null, reason: `${clock}=${v}ms falls outside every band` };
}

export class CrossCohortComparison extends Error {
  constructor(feature: string, cohorts: readonly string[]) {
    super(
      `refusing to compare raw ${feature} across cohorts ${cohorts.join(', ')}: ` +
        'the feature does not mean the same thing in each, so the ranking would order by noise while looking like it ordered by the feature',
    );
    this.name = 'CrossCohortComparison';
  }
}

export function assertNoCrossCohortRawComparison(
  feature: string,
  rows: readonly { cohort: Cohort | null }[],
): void {
  const distinct = [...new Set(rows.map((r) => r.cohort ?? 'UNASSIGNED'))];
  if (distinct.length > 1) throw new CrossCohortComparison(feature, distinct);
}

/**
 * The cohort-relative transform: a within-cohort rank in [0,1].
 *
 * This is what makes a feature comparable across cohorts. The raw value is not,
 * and never becomes so; what transfers is the token's standing among its own
 * kind.
 *
 * Ties share the average rank, so a feature that is constant within a cohort
 * yields 0.5 for everyone — correctly saying "this feature does not
 * discriminate here" rather than inventing an order.
 */
export function cohortRelativeRank(values: readonly (number | null)[]): (number | null)[] {
  const known = values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v !== null);
  if (known.length === 0) return values.map(() => null);
  if (known.length === 1) return values.map((v) => (v === null ? null : 0.5));

  const sorted = [...known].sort((a, b) => a.v - b.v);
  const rankById = new Map<number, number>();
  let k = 0;
  while (k < sorted.length) {
    let j = k;
    while (j + 1 < sorted.length && sorted[j + 1]?.v === sorted[k]?.v) j++;
    // Average rank across the tie, normalised to [0,1].
    const avg = (k + j) / 2 / (sorted.length - 1);
    for (let m = k; m <= j; m++) {
      const item = sorted[m];
      if (item !== undefined) rankById.set(item.i, avg);
    }
    k = j + 1;
  }
  return values.map((v, i) => (v === null ? null : (rankById.get(i) ?? null)));
}

export type CoverageVerdict = 'ELIGIBLE' | 'LOW_COVERAGE_STRATUM' | 'NOT_ELIGIBLE';

/**
 * `insufficientCoverage` is enforced, not annotated.
 *
 * A score computed from two of nine features is not a weak score, it is a
 * different measurement. It is either ineligible or explicitly assigned to a
 * low-coverage stratum — never silently pooled with fully-covered scores, where
 * it would drag the population mean around while looking like an ordinary row.
 */
export function coverageVerdict(p: {
  featuresPresent: number;
  featuresRequired: number;
  lowCoverageStratumEnabled: boolean;
}): { verdict: CoverageVerdict; coverage: number; reason: string } {
  const coverage = p.featuresRequired === 0 ? 0 : p.featuresPresent / p.featuresRequired;
  if (coverage >= 1) {
    return { verdict: 'ELIGIBLE', coverage, reason: 'every required feature is present' };
  }
  if (p.lowCoverageStratumEnabled) {
    return {
      verdict: 'LOW_COVERAGE_STRATUM',
      coverage,
      reason: `${p.featuresPresent} of ${p.featuresRequired} features; kept separate, never pooled`,
    };
  }
  return {
    verdict: 'NOT_ELIGIBLE',
    coverage,
    reason: `${p.featuresPresent} of ${p.featuresRequired} features and no low-coverage stratum is open`,
  };
}

/**
 * A screening in one cohort must not suppress later eligibility in another.
 *
 * A token rejected at five minutes old is a token rejected as a five-minute-old
 * token. At six hours it is a different candidate with different facts, and
 * carrying the earlier verdict forward would make the corpus a record of first
 * impressions.
 */
export function eligibilitySuppressed(p: {
  priorRejections: readonly { cohort: Cohort | null; utcMs: number }[];
  currentCohort: Cohort | null;
}): { suppressed: boolean; reason: string } {
  const sameCohort = p.priorRejections.filter((r) => r.cohort === p.currentCohort);
  if (sameCohort.length === 0) {
    return {
      suppressed: false,
      reason: 'no prior rejection in THIS cohort; a rejection in another cohort judged a different candidate',
    };
  }
  return { suppressed: true, reason: `${sameCohort.length} prior rejection(s) in the same cohort` };
}

/**
 * Allocation priority: the LEAST-COMPLETE cell first.
 *
 * Sampling where candidates are densest fills the cells that are already full
 * and leaves the rest permanently unmeasured — which then reads as "we have no
 * evidence for cashback coins at high tiers" rather than "we never looked".
 */
export interface Cell {
  readonly cohort: Cohort;
  readonly cashback: boolean;
  readonly mayhem: boolean;
  readonly feeTierBps: number;
  readonly completed: number;
}

export function allocationPriority(cells: readonly Cell[]): readonly Cell[] {
  return [...cells].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed - b.completed;
    // Deterministic tiebreak so the order is reproducible across runs.
    return cellKey(a) < cellKey(b) ? -1 : 1;
  });
}

export function cellKey(c: Pick<Cell, 'cohort' | 'cashback' | 'mayhem' | 'feeTierBps'>): string {
  return `${c.cohort}|${c.cashback ? 'CB' : 'NOCB'}|${c.mayhem ? 'MH' : 'NOMH'}|${c.feeTierBps}`;
}
