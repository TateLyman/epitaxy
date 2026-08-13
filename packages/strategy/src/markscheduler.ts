/**
 * Which positions get marked this cycle.
 *
 * §12.4 — "no oldest-first starvation".
 *
 * The mark loop took `openShadowPositions(db).slice(0, cap)`, and that query is
 * `ORDER BY opened_utc_ms`. With 179 open shadows and a per-cycle cap, the same
 * oldest positions were marked every cycle and the newest were never marked at
 * all. Their exits could not trigger, their peaks never updated, and their
 * eventual outcomes would have been recorded against prices from whenever the
 * backlog happened to reach them.
 *
 * That is not a slow book. It is a book where the newest half is not being
 * observed, and nothing in the data says so — a position with no marks looks
 * identical to a position whose value did not move.
 *
 * The order here is by URGENCY:
 *
 *   1. anything blocked or near a trigger, because those are the marks that can
 *      still change a decision;
 *   2. most overdue, measured against when the mark was DUE rather than when
 *      the position opened;
 *   3. newer positions, which move fastest and whose marks decay quickest.
 *
 * Age is the tiebreak, never the sort key.
 */

export type MarkUrgency = 'BLOCKED' | 'NEAR_TRIGGER' | 'OVERDUE' | 'DUE' | 'NOT_DUE';

export interface MarkCandidate {
  readonly id: string;
  readonly openedUtcMs: number;
  /** Null when it has never been marked, which is maximally overdue. */
  readonly lastMarkUtcMs: number | null;
  /** Exit could not be built last time, so it needs watching more, not less. */
  readonly blocked: boolean;
  /**
   * Within a frozen distance of a stop, trail or take-profit level. A mark here
   * can still change what happens; a mark on something sitting mid-range
   * cannot.
   */
  readonly nearTrigger: boolean;
}

export interface ScheduledMark {
  readonly id: string;
  readonly urgency: MarkUrgency;
  /** When this mark was due. Never-marked positions are due at open. */
  readonly dueAtUtcMs: number;
  /** How late it is. Negative means not yet due. */
  readonly lagMs: number;
  /** Whole intervals missed. The number that says a book is falling behind. */
  readonly missedMarks: number;
}

const TIER: Readonly<Record<MarkUrgency, number>> = {
  BLOCKED: 0,
  NEAR_TRIGGER: 1,
  OVERDUE: 2,
  DUE: 3,
  NOT_DUE: 4,
};

export function urgencyOf(c: MarkCandidate, dueAtUtcMs: number, nowUtcMs: number): MarkUrgency {
  if (c.blocked) return 'BLOCKED';
  if (c.nearTrigger) return 'NEAR_TRIGGER';
  const lag = nowUtcMs - dueAtUtcMs;
  if (lag <= 0) return 'NOT_DUE';
  return lag >= 0 ? 'OVERDUE' : 'DUE';
}

/**
 * Order the whole book, then take the cap.
 *
 * Returns EVERY candidate ranked rather than just the winners, so a caller can
 * report what it skipped. A scheduler that silently drops the tail is how a
 * backlog becomes invisible.
 */
export function scheduleMarks(
  candidates: readonly MarkCandidate[],
  markIntervalMs: number,
  nowUtcMs: number,
): ScheduledMark[] {
  const scored = candidates.map((c) => {
    // A position that has never been marked was due the moment it opened. It is
    // the most overdue thing in the book, not the least.
    const dueAtUtcMs = c.lastMarkUtcMs === null ? c.openedUtcMs : c.lastMarkUtcMs + markIntervalMs;
    const lagMs = nowUtcMs - dueAtUtcMs;
    return {
      id: c.id,
      urgency: urgencyOf(c, dueAtUtcMs, nowUtcMs),
      dueAtUtcMs,
      lagMs,
      missedMarks: lagMs <= 0 || markIntervalMs <= 0 ? 0 : Math.floor(lagMs / markIntervalMs),
      openedUtcMs: c.openedUtcMs,
    };
  });

  scored.sort((a, b) => {
    const tier = TIER[a.urgency] - TIER[b.urgency];
    if (tier !== 0) return tier;
    // Most overdue first.
    if (a.lagMs !== b.lagMs) return b.lagMs - a.lagMs;
    // Then NEWER first: a young memecoin moves faster, so its mark decays
    // quicker and its stale mark is more wrong.
    return b.openedUtcMs - a.openedUtcMs;
  });

  return scored.map(({ id, urgency, dueAtUtcMs, lagMs, missedMarks }) => ({
    id,
    urgency,
    dueAtUtcMs,
    lagMs,
    missedMarks,
  }));
}

export interface BacklogState {
  readonly due: number;
  readonly marked: number;
  readonly skipped: number;
  readonly worstLagMs: number;
  readonly totalMissedMarks: number;
  /** True when the book cannot be maintained at this cadence and budget. */
  readonly overCapacity: boolean;
  readonly detail: string;
}

/**
 * Can this book be maintained at all?
 *
 * §12.4 — "if backlog exceeds capacity, stop opening new shadows and record
 * skipped episodes". A book that cannot be marked at its own cadence is not
 * producing marks that mean anything, and the correct response is to stop
 * adding to it rather than to spread the shortfall across everything.
 */
export function assessBacklog(
  scheduled: readonly ScheduledMark[],
  capacityPerCycle: number,
  nowUtcMs: number,
): BacklogState {
  const due = scheduled.filter((s) => s.urgency !== 'NOT_DUE').length;
  const marked = Math.min(due, capacityPerCycle);
  const worstLagMs = scheduled.reduce((a, s) => (s.lagMs > a ? s.lagMs : a), 0);
  const totalMissedMarks = scheduled.reduce((a, s) => a + s.missedMarks, 0);
  const overCapacity = due > capacityPerCycle;
  return {
    due,
    marked,
    skipped: due - marked,
    worstLagMs,
    totalMissedMarks,
    overCapacity,
    detail: overCapacity
      ? `${due} positions due against a capacity of ${capacityPerCycle}; worst lag ${Math.round(worstLagMs / 1000)}s. ` +
        'Stop opening new shadows: a book that cannot be marked at its own cadence produces marks that do not ' +
        'mean what they say, and spreading the shortfall makes every position slightly wrong instead of ' +
        'making the problem visible.'
      : `${due} due, capacity ${capacityPerCycle}, worst lag ${Math.round(worstLagMs / 1000)}s (as of ${nowUtcMs})`,
  };
}
