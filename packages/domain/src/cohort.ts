/**
 * Age cohorts, kept apart.
 *
 * §16 — a token four minutes old and a token four days old are not the same
 * experiment. The four-day-old one has survived, and conditioning on survival
 * changes everything downstream: its holder set is real, its creator has had
 * time to dump and did not, its liquidity has been tested by someone other than
 * us. Pooling them produces an average over two populations that answers a
 * question nobody asked.
 *
 * The boundaries are frozen here rather than configured, because a cohort
 * boundary chosen after looking at returns is a threshold spent on the data. If
 * a boundary needs to move, it moves through the multiple-testing ledger like
 * any other threshold.
 */

export const COHORTS = ['AGE_2M_60M', 'AGE_1H_5H', 'AGE_5H_24H', 'AGE_24H_7D'] as const;
export type Cohort = (typeof COHORTS)[number];

/** Outside every cohort: too new to trade, or too old to be this strategy. */
export type CohortAssignment = Cohort | 'TOO_YOUNG' | 'TOO_OLD' | 'AGE_UNKNOWN';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const COHORT_BOUNDS: Readonly<Record<Cohort, { fromMs: number; toMs: number }>> = {
  AGE_2M_60M: { fromMs: 2 * MINUTE, toMs: 60 * MINUTE },
  AGE_1H_5H: { fromMs: 1 * HOUR, toMs: 5 * HOUR },
  AGE_5H_24H: { fromMs: 5 * HOUR, toMs: 24 * HOUR },
  AGE_24H_7D: { fromMs: 24 * HOUR, toMs: 7 * DAY },
};

/**
 * Which cohort a token belongs to at the moment it is considered.
 *
 * Half-open intervals: `[from, to)`. A token exactly one hour old is in
 * AGE_1H_5H and not in AGE_2M_60M, so no token is ever in two cohorts and the
 * boundary is not a place where counts can be inflated by rounding.
 *
 * An unknown age is `AGE_UNKNOWN`, never a guess and never the youngest
 * cohort. This system has been bitten by absent-means-zero often enough that
 * the default is its own value.
 */
export function cohortOf(ageMs: number | null): CohortAssignment {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return 'AGE_UNKNOWN';
  if (ageMs < COHORT_BOUNDS.AGE_2M_60M.fromMs) return 'TOO_YOUNG';
  for (const c of COHORTS) {
    const b = COHORT_BOUNDS[c];
    if (ageMs >= b.fromMs && ageMs < b.toMs) return c;
  }
  return 'TOO_OLD';
}

export function isCohort(a: CohortAssignment): a is Cohort {
  return (COHORTS as readonly string[]).includes(a);
}

/**
 * Whether a set of cohort counts is ready to be compared.
 *
 * §16 — "do not pool". Comparing cohorts requires each to carry its own
 * evidence, so a comparison is refused until every cohort being compared has
 * enough of it. Returning the reason rather than a boolean means a report can
 * say WHICH cohort is short instead of just declining.
 */
export function cohortsComparable(
  counts: Readonly<Partial<Record<Cohort, number>>>,
  minimumPerCohort: number,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const c of COHORTS) {
    const n = counts[c] ?? 0;
    if (n < minimumPerCohort) reasons.push(`${c} has ${n} of the ${minimumPerCohort} required`);
  }
  return { ok: reasons.length === 0, reasons };
}
