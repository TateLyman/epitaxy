import { describe, it, expect } from 'vitest';
import { cohortOf, cohortsComparable, COHORTS, COHORT_BOUNDS, isCohort } from '../../packages/domain/src/cohort.js';

/**
 * §16 — cohorts that do not overlap, do not pool, and do not guess.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('cohortOf', () => {
  it.each([
    [3 * MIN, 'AGE_2M_60M'],
    [59 * MIN, 'AGE_2M_60M'],
    [2 * HOUR, 'AGE_1H_5H'],
    [6 * HOUR, 'AGE_5H_24H'],
    [3 * DAY, 'AGE_24H_7D'],
  ])('puts %i ms in %s', (age, expected) => {
    expect(cohortOf(age)).toBe(expected);
  });

  it('is half-open at every boundary, so nothing lands in two cohorts', () => {
    // The boundary is where double counting would hide. A token exactly one
    // hour old belongs to the older cohort and to nothing else.
    expect(cohortOf(60 * MIN)).toBe('AGE_1H_5H');
    expect(cohortOf(60 * MIN - 1)).toBe('AGE_2M_60M');
    expect(cohortOf(5 * HOUR)).toBe('AGE_5H_24H');
    expect(cohortOf(5 * HOUR - 1)).toBe('AGE_1H_5H');
    expect(cohortOf(24 * HOUR)).toBe('AGE_24H_7D');
    expect(cohortOf(24 * HOUR - 1)).toBe('AGE_5H_24H');
  });

  it('assigns every cohort exactly one interval, with no gaps between them', () => {
    // A gap would silently drop tokens; an overlap would double count them.
    for (let i = 0; i < COHORTS.length - 1; i++) {
      const a = COHORT_BOUNDS[COHORTS[i] as (typeof COHORTS)[number]];
      const b = COHORT_BOUNDS[COHORTS[i + 1] as (typeof COHORTS)[number]];
      expect(a.toMs).toBe(b.fromMs);
    }
  });

  it('refuses to guess an unknown age', () => {
    // Absent is not young. This project has been bitten by absent-means-zero
    // enough times that the default gets its own value.
    expect(cohortOf(null)).toBe('AGE_UNKNOWN');
    expect(cohortOf(Number.NaN)).toBe('AGE_UNKNOWN');
    expect(cohortOf(-1)).toBe('AGE_UNKNOWN');
    expect(isCohort(cohortOf(null))).toBe(false);
  });

  it('separates too young and too old from unknown', () => {
    // Three different facts. A token 30 seconds old is not a token whose age we
    // failed to read, and neither is a two-week-old one.
    expect(cohortOf(30_000)).toBe('TOO_YOUNG');
    expect(cohortOf(14 * DAY)).toBe('TOO_OLD');
    expect(cohortOf(7 * DAY)).toBe('TOO_OLD');
  });
});

describe('cohortsComparable', () => {
  it('refuses a comparison when any cohort is short, and names it', () => {
    const v = cohortsComparable({ AGE_2M_60M: 50, AGE_1H_5H: 3 }, 10);
    expect(v.ok).toBe(false);
    // Naming which cohort is short is the difference between a report that can
    // be acted on and one that just declines.
    expect(v.reasons.join(' ')).toContain('AGE_1H_5H has 3 of the 10');
    expect(v.reasons.join(' ')).toContain('AGE_5H_24H has 0');
  });

  it('permits it when every cohort carries its own evidence', () => {
    expect(
      cohortsComparable({ AGE_2M_60M: 10, AGE_1H_5H: 10, AGE_5H_24H: 10, AGE_24H_7D: 10 }, 10).ok,
    ).toBe(true);
  });

  it('counts a missing cohort as zero rather than skipping it', () => {
    // Skipping would let a comparison pass by simply never collecting one arm.
    expect(cohortsComparable({}, 1).reasons).toHaveLength(COHORTS.length);
  });
});
