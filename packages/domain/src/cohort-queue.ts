import { COHORTS, COHORT_BOUNDS, cohortOf, type Cohort, type CohortAssignment } from './cohort.js';

/**
 * P18 — retained candidate queues, so a cohort other than the traded one can
 * ever have data.
 *
 * The runtime matures candidates only for the configured 2–60 minute band. Every
 * observation the corpus holds is therefore about that band, and the band's own
 * edges are invisible: if the real edge lives at four hours, nothing in the
 * corpus can say so, and every analysis concludes 2–60 minutes is where the
 * edge is because it is where the data is.
 *
 * A candidate is kept until it ages out of the LAST cohort, and is re-considered
 * when it enters each one. That is the only way the four arms are comparable:
 * the same token, the same fixed notional, the same route family, the same
 * accounting, seen at four different ages.
 *
 * What this deliberately does NOT do is re-screen. A candidate that failed a
 * hard gate at two minutes is not resurrected at four hours by a queue; it is
 * resurrected by being screened again, which is the caller's job. The queue
 * only says WHEN a token is due to be looked at again.
 */

export interface QueuedCandidate {
  readonly mint: string;
  /** When the token itself was created, not when we first saw it. */
  readonly mintCreatedUtcMs: number;
  /** Cohorts already opened for this candidate. Never re-opened. */
  readonly cohortsSeen: readonly Cohort[];
}

export interface DueCandidate {
  readonly mint: string;
  readonly cohort: Cohort;
  readonly ageMs: number;
}

/** The last moment any cohort still admits a token. */
const LAST_EXIT_MS = Math.max(...COHORTS.map((c) => COHORT_BOUNDS[c].toMs));

/**
 * Whether a candidate is worth keeping.
 *
 * False once it is older than every cohort. Keeping it beyond that costs memory
 * and buys nothing, because no arm will ever admit it again.
 */
export function stillRelevant(c: QueuedCandidate, nowUtcMs: number): boolean {
  return nowUtcMs - c.mintCreatedUtcMs < LAST_EXIT_MS;
}

/**
 * Which cohort a candidate has just become due for, if any.
 *
 * Returns null when the token is inside a cohort already opened for it, or
 * outside every cohort. A cohort is opened ONCE per candidate: opening the same
 * token twice in one arm would double-count a single signal, and doing that
 * more often for long-lived tokens would bias the older arms.
 */
export function dueCohort(c: QueuedCandidate, nowUtcMs: number): DueCandidate | null {
  const ageMs = nowUtcMs - c.mintCreatedUtcMs;
  const assignment: CohortAssignment = cohortOf(ageMs);
  if (assignment === 'AGE_UNKNOWN' || assignment === 'TOO_YOUNG' || assignment === 'TOO_OLD') return null;
  if (c.cohortsSeen.includes(assignment)) return null;
  return { mint: c.mint, cohort: assignment, ageMs };
}

/**
 * The candidates due right now, and the ones to forget.
 *
 * Pure: the caller owns the queue and decides what to do with the answer. A
 * function that both decided and mutated would be one nobody could test at the
 * boundary that matters, which is what "the 2–60 band is the only arm with
 * data" looked like as a bug.
 */
export function sweep(
  queue: readonly QueuedCandidate[],
  nowUtcMs: number,
): { due: readonly DueCandidate[]; expired: readonly string[] } {
  const due: DueCandidate[] = [];
  const expired: string[] = [];
  for (const c of queue) {
    if (!stillRelevant(c, nowUtcMs)) {
      expired.push(c.mint);
      continue;
    }
    const d = dueCohort(c, nowUtcMs);
    if (d !== null) due.push(d);
  }
  // Oldest cohort first. When the budget cannot serve everything, the arms with
  // the least data should not be the ones starved: they are starved already,
  // which is the condition this exists to fix.
  const order = new Map(COHORTS.map((c, i) => [c, i]));
  due.sort((a, b) => (order.get(b.cohort) ?? 0) - (order.get(a.cohort) ?? 0));
  return { due, expired };
}

/**
 * How complete the experiment is.
 *
 * Reported per arm and NEVER summed. Four arms with 30 closed positions each is
 * a comparison; one arm with 120 is not, and a total cannot tell them apart.
 */
export function armCompleteness(
  counts: Readonly<Record<string, number>>,
  minimumPerArm: number,
): { readonly complete: boolean; readonly missing: readonly string[] } {
  const missing = COHORTS.filter((c) => (counts[c] ?? 0) < minimumPerArm);
  return { complete: missing.length === 0, missing };
}
