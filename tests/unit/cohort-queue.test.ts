import { describe, it, expect } from 'vitest';
import { sweep, dueCohort, stillRelevant, armCompleteness } from '../../packages/domain/src/cohort-queue.js';
import { COHORTS } from '../../packages/domain/src/cohort.js';

/**
 * P18 — retained candidate queues.
 *
 * The runtime matured candidates only for the 2–60 minute band, so every
 * observation the corpus holds is about that band and the band's own edges are
 * invisible. If the real edge lives at four hours, nothing in the corpus can
 * say so, and every analysis concludes 2–60 minutes is where the edge is
 * because it is where the data is.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = 1_760_000_000_000;

const candidate = (over: Partial<Parameters<typeof dueCohort>[0]> = {}) => ({
  mint: 'Mint1',
  mintCreatedUtcMs: T0,
  cohortsSeen: [] as never,
  ...over,
});

describe('P18 — a candidate is due once per cohort', () => {
  it('is due for the young arm at ten minutes', () => {
    const d = dueCohort(candidate(), T0 + 10 * MINUTE);
    expect(d?.cohort).toBe('AGE_2M_60M');
  });

  it('is due for the next arm at two hours', () => {
    // The whole point: the same token, later, in a different arm. Without the
    // queue it was never looked at again.
    const d = dueCohort(candidate(), T0 + 2 * HOUR);
    expect(d?.cohort).toBe('AGE_1H_5H');
  });

  it('is due for the oldest arm at three days', () => {
    expect(dueCohort(candidate(), T0 + 3 * DAY)?.cohort).toBe('AGE_24H_7D');
  });

  it('is NOT due again for an arm already opened', () => {
    // Opening the same token twice in one arm double-counts a single signal,
    // and doing it more often for long-lived tokens would bias the older arms.
    const c = candidate({ cohortsSeen: ['AGE_1H_5H'] as never });
    expect(dueCohort(c, T0 + 2 * HOUR)).toBeNull();
  });

  it('is not due while too young to trade', () => {
    expect(dueCohort(candidate(), T0 + 30_000)).toBeNull();
  });

  it('is not due once past every arm', () => {
    expect(dueCohort(candidate(), T0 + 8 * DAY)).toBeNull();
  });
});

describe('P18 — retention', () => {
  it('keeps a candidate until it ages out of the LAST arm', () => {
    expect(stillRelevant(candidate(), T0 + 6 * DAY)).toBe(true);
    expect(stillRelevant(candidate(), T0 + 8 * DAY)).toBe(false);
  });

  it('sweeps expired candidates and reports them', () => {
    const { due, expired } = sweep([candidate({ mint: 'Old' })], T0 + 9 * DAY);
    expect(due).toEqual([]);
    expect(expired).toEqual(['Old']);
  });

  it('returns the oldest arm first when several are due', () => {
    // When the budget cannot serve everything, the arms with the least data
    // must not be the ones starved -- they are starved already, which is the
    // condition this exists to fix.
    const { due } = sweep(
      [
        candidate({ mint: 'Young', mintCreatedUtcMs: T0 - 10 * MINUTE }),
        candidate({ mint: 'Old', mintCreatedUtcMs: T0 - 3 * DAY }),
        candidate({ mint: 'Mid', mintCreatedUtcMs: T0 - 2 * HOUR }),
      ],
      T0,
    );
    expect(due.map((d) => d.mint)).toEqual(['Old', 'Mid', 'Young']);
  });

  it('carries the age it was due at, so the assignment is auditable', () => {
    const { due } = sweep([candidate({ mintCreatedUtcMs: T0 - 3 * HOUR })], T0);
    expect(due[0]?.ageMs).toBe(3 * HOUR);
  });
});

describe('P18 — arm completeness is per arm and never summed', () => {
  it('is incomplete while any arm is short', () => {
    // Four arms with 30 each is a comparison; one arm with 120 is not, and a
    // total cannot tell them apart.
    const r = armCompleteness({ AGE_2M_60M: 120 }, 30);
    expect(r.complete).toBe(false);
    expect(r.missing).toContain('AGE_1H_5H');
    expect(r.missing).toContain('AGE_5H_24H');
    expect(r.missing).toContain('AGE_24H_7D');
  });

  it('is complete only when every arm clears the bar', () => {
    const counts = Object.fromEntries(COHORTS.map((c) => [c, 30]));
    expect(armCompleteness(counts, 30).complete).toBe(true);
  });

  it('an absent arm counts as zero, not as satisfied', () => {
    expect(armCompleteness({}, 1).missing).toHaveLength(COHORTS.length);
  });
});
