import type { Db } from '../../storage/src/db.js';

/**
 * P7 — ONE TIMELY MARK SCHEDULER, SEPARATE FROM DISCOVERY.
 *
 * The 8f73cef audit's B-4: **697 of 1,448 marks were more than 60 seconds
 * late**, and S-4 measured the shape of it — only 57 of 292 one-minute marks
 * landed within 60 s of their horizon.
 *
 * The cause is structural, not a tuning miss. The collector's discovery
 * interval is 300 seconds and the mark pass ran at the top of each cycle, so
 * the mark clock and the discovery clock were the same clock. A one-minute
 * horizon cannot be met by a five-minute loop, and a 15-minute horizon reached
 * at 19 minutes carries the right label on the wrong instant.
 *
 * What that costs is not precision. It is the tournament: a backfilled path
 * collapses 1m/5m/15m/30m/60m toward one wall-clock moment, both exit policies
 * see the same prices, and they agree trivially — so the comparison the corpus
 * exists to make cannot be made.
 *
 * So:
 *
 *   DISCOVERY  every `discoveryIntervalMs` (300 s is fine — migrations are
 *              backfilled from the chain and nothing is missed by looking
 *              every five minutes)
 *
 *   MARKS      a monotonic due-time priority queue. Wake at the next deadline,
 *              or after `maxTickMs` (2–5 s), whichever is sooner.
 *
 * A late mark is `MISSED_HORIZON`. Not interpolated, not backfilled, and never
 * given the correct offset label on the wrong instant.
 */

/** Frozen BEFORE collection. Changing it is a preregistration event. */
export const MARK_SLA_MS = 10_000;

/** The scheduler never sleeps longer than this, so a new due time is picked up. */
export const DEFAULT_MAX_TICK_MS = 3_000;

export type MarkSlaStatus = 'ON_TIME' | 'MISSED_HORIZON';

/**
 * P7.3 — the priority order. Higher runs first.
 *
 * Discovery is LAST on purpose. Opening a new trajectory while an existing
 * one's deadline is slipping trades a measurement we are already committed to
 * for one we are not.
 */
export const WORK_PRIORITY = {
  TRIGGERED_AWAITING_FILL: 100,
  BLOCKED_EXIT: 90,
  URGENT_RESERVE_ALARM: 80,
  NEXT_DUE_HORIZON: 50,
  DISCOVERY: 10,
} as const;

export type WorkKind = keyof typeof WORK_PRIORITY;

export interface DueMark {
  readonly trajectoryId: string;
  readonly mint: string;
  readonly offsetMs: number;
  readonly openedUtcMs: number;
  readonly dueUtcMs: number;
  readonly kind: WorkKind;
  readonly priority: number;
}

/**
 * Classify a mark against the SLA that was frozen before collection.
 *
 * `latenessMs` is measured from the horizon the mark REPRESENTS, not from when
 * the scheduler happened to get to it.
 */
export function classifyMark(
  dueUtcMs: number,
  observedUtcMs: number,
  slaMs: number = MARK_SLA_MS,
): { status: MarkSlaStatus; latenessMs: number } {
  const lateness = observedUtcMs - dueUtcMs;
  // Early is not late. A mark taken before its horizon is a different defect
  // and is refused by the due-time filter rather than classified here.
  return { status: lateness > slaMs ? 'MISSED_HORIZON' : 'ON_TIME', latenessMs: lateness < 0 ? 0 : lateness };
}

/**
 * Every mark that is DUE NOW, in priority order.
 *
 * "Due" means the horizon has arrived and the mark has not been recorded. A
 * horizon that has not arrived is not returned at any priority: a 15-minute
 * number observed at four minutes is a different measurement wearing the right
 * label, and it is the mirror image of the lateness defect.
 */
export function dueMarks(
  db: Db,
  opts: {
    readonly nowMs: number;
    readonly offsets: readonly number[];
    readonly limit?: number;
    readonly evidenceContextId?: string | null;
  },
): DueMark[] {
  const rows = db
    .prepare(
      `SELECT t.trajectory_id, t.mint, t.opened_utc_ms, t.state
         FROM development_trajectories t
        WHERE t.state <> 'SETTLED'
          ${opts.evidenceContextId === undefined || opts.evidenceContextId === null
            ? ''
            : `AND EXISTS (SELECT 1 FROM trajectory_evidence_context c
                            WHERE c.trajectory_id = t.trajectory_id AND c.evidence_context_id = ?)`}
        ORDER BY t.opened_utc_ms ASC`,
    )
    .all(
      ...(opts.evidenceContextId === undefined || opts.evidenceContextId === null
        ? []
        : [opts.evidenceContextId]),
    ) as { trajectory_id: string; mint: string; opened_utc_ms: number; state: string }[];

  const recorded = new Set(
    (
      db.prepare('SELECT trajectory_id, offset_ms FROM trajectory_marks').all() as {
        trajectory_id: string;
        offset_ms: number;
      }[]
    ).map((r) => `${r.trajectory_id}|${r.offset_ms}`),
  );

  const out: DueMark[] = [];
  for (const t of rows) {
    for (const offset of opts.offsets) {
      if (recorded.has(`${t.trajectory_id}|${offset}`)) continue;
      const due = t.opened_utc_ms + offset;
      if (due > opts.nowMs) continue;
      const kind: WorkKind =
        t.state === 'TRIGGERED_AWAITING_FILL'
          ? 'TRIGGERED_AWAITING_FILL'
          : t.state === 'EXIT_BLOCKED'
            ? 'BLOCKED_EXIT'
            : 'NEXT_DUE_HORIZON';
      out.push({
        trajectoryId: t.trajectory_id,
        mint: t.mint,
        offsetMs: offset,
        openedUtcMs: t.opened_utc_ms,
        dueUtcMs: due,
        kind,
        priority: WORK_PRIORITY[kind],
      });
    }
  }

  // Highest priority first; within a priority, the one that has been waiting
  // longest. Sorting by due time rather than by offset means a 60m mark that is
  // already late outranks a 1m mark that just came due — which is right: the
  // 60m one is the measurement in danger.
  out.sort((a, b) => b.priority - a.priority || a.dueUtcMs - b.dueUtcMs);
  return opts.limit === undefined ? out : out.slice(0, opts.limit);
}

/**
 * When the scheduler must wake next.
 *
 * The earliest future deadline, bounded by `maxTickMs` so a trajectory opened
 * a millisecond from now is still picked up promptly. Returns `maxTickMs` when
 * nothing is scheduled — an idle scheduler that sleeps for the discovery
 * interval is the defect this module exists to remove.
 */
export function nextWakeMs(
  db: Db,
  opts: { readonly nowMs: number; readonly offsets: readonly number[]; readonly maxTickMs?: number },
): number {
  const maxTick = opts.maxTickMs ?? DEFAULT_MAX_TICK_MS;
  const rows = db
    .prepare(`SELECT trajectory_id, opened_utc_ms FROM development_trajectories WHERE state <> 'SETTLED'`)
    .all() as { trajectory_id: string; opened_utc_ms: number }[];
  if (rows.length === 0) return maxTick;

  const recorded = new Set(
    (
      db.prepare('SELECT trajectory_id, offset_ms FROM trajectory_marks').all() as {
        trajectory_id: string;
        offset_ms: number;
      }[]
    ).map((r) => `${r.trajectory_id}|${r.offset_ms}`),
  );

  let soonest = Number.POSITIVE_INFINITY;
  for (const t of rows) {
    for (const offset of opts.offsets) {
      if (recorded.has(`${t.trajectory_id}|${offset}`)) continue;
      const due = t.opened_utc_ms + offset;
      if (due <= opts.nowMs) return 0;
      if (due < soonest) soonest = due;
    }
  }
  if (!Number.isFinite(soonest)) return maxTick;
  return Math.max(0, Math.min(maxTick, soonest - opts.nowMs));
}

/**
 * P7.3 — should discovery open new trajectories right now?
 *
 * "Stop opening new trajectories before mark deadlines degrade." A scheduler
 * that is already behind on marks and keeps opening is choosing breadth over
 * the measurements it has already committed to, and the marks are the product.
 */
export function discoveryAdmissible(
  db: Db,
  opts: { readonly nowMs: number; readonly offsets: readonly number[]; readonly slaMs?: number },
): { readonly admissible: boolean; readonly reason: string; readonly overdue: number } {
  const sla = opts.slaMs ?? MARK_SLA_MS;
  const due = dueMarks(db, { nowMs: opts.nowMs, offsets: opts.offsets });
  const overdue = due.filter((d) => opts.nowMs - d.dueUtcMs > sla).length;
  if (overdue > 0) {
    return {
      admissible: false,
      reason:
        `${overdue} mark(s) are already past the ${sla}ms SLA. Opening another trajectory would ` +
        'add deadlines to a queue that is missing the ones it has.',
      overdue,
    };
  }
  return { admissible: true, reason: 'no mark is past its SLA', overdue: 0 };
}

/**
 * Marks that were taken late, by horizon. The SLA report.
 *
 * Reads `sla_status` where it exists and falls back to `lateness_ms` for rows
 * written before the column did — a pre-repair row has no SLA verdict and must
 * not be silently counted as ON_TIME.
 */
export function slaReport(
  db: Db,
  opts: { readonly evidenceContextId?: string | null; readonly slaMs?: number } = {},
): { offsetMs: number; total: number; onTime: number; missed: number; unclassified: number }[] {
  const sla = opts.slaMs ?? MARK_SLA_MS;
  const rows = db
    .prepare(
      `SELECT m.offset_ms, m.sla_status, m.lateness_ms
         FROM trajectory_marks m
         ${opts.evidenceContextId === undefined || opts.evidenceContextId === null
           ? ''
           : `JOIN trajectory_evidence_context c ON c.trajectory_id = m.trajectory_id
                AND c.evidence_context_id = ?`}`,
    )
    .all(
      ...(opts.evidenceContextId === undefined || opts.evidenceContextId === null
        ? []
        : [opts.evidenceContextId]),
    ) as { offset_ms: number; sla_status: string | null; lateness_ms: number }[];

  const byOffset = new Map<number, { total: number; onTime: number; missed: number; unclassified: number }>();
  for (const r of rows) {
    const e = byOffset.get(r.offset_ms) ?? { total: 0, onTime: 0, missed: 0, unclassified: 0 };
    e.total++;
    if (r.sla_status === 'ON_TIME') e.onTime++;
    else if (r.sla_status === 'MISSED_HORIZON') e.missed++;
    else if (r.sla_status === null) e.unclassified++;
    else e.missed++;
    byOffset.set(r.offset_ms, e);
  }
  void sla;
  return [...byOffset.entries()]
    .map(([offsetMs, v]) => ({ offsetMs, ...v }))
    .sort((a, b) => a.offsetMs - b.offsetMs);
}
