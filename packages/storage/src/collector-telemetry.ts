import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type Db = DatabaseSync;

/**
 * P11/P13 — the running collector's own record of what it did.
 *
 * Written by the process, read by `pnpm wss:status` and `pnpm rate:budget-v2`.
 * The split matters: a status command that can only report on a live in-process
 * watcher reports nothing the moment the process stops, which is exactly when
 * an operator asks it what happened.
 *
 * These are OPERATIONAL counters, not evidence. They are upserted and they
 * accumulate. Nothing downstream may treat a counter as a trade outcome — the
 * append-only rule protects measurements of the market, and a request tally is
 * not one.
 *
 * The one thing that is evidence-shaped here is `collector_sessions`, because
 * P13's whole arithmetic rests on it. Every rate is per ACTIVE SECOND, and
 * active seconds are the sum of these sessions' spans. The report this replaces
 * divided by elapsed wall time including downtime, so a process that ran twenty
 * minutes out of a day reported that quota was not its constraint — a statement
 * about the downtime, not about the capacity.
 */

export interface SessionHandle {
  readonly sessionId: string;
  readonly startedUtcMs: number;
}

export function openCollectorSession(
  db: Db,
  p: { mode: string; sourceCommit: string; dirty: boolean; pid: number; endpoint: string; nowMs: number },
): SessionHandle {
  const sessionId = randomUUID();
  db.prepare(
    `INSERT INTO collector_sessions
       (session_id, started_utc_ms, heartbeat_utc_ms, ended_utc_ms, mode, source_commit, dirty, pid, endpoint, cycles)
     VALUES (?,?,?,NULL,?,?,?,?,?,0)`,
  ).run(sessionId, p.nowMs, p.nowMs, p.mode, p.sourceCommit, p.dirty ? 1 : 0, p.pid, p.endpoint);
  return { sessionId, startedUtcMs: p.nowMs };
}

/**
 * Advance the heartbeat.
 *
 * A session whose heartbeat stopped without `ended_utc_ms` being set is one
 * that DIED. The distinction is the difference between "collection stopped" and
 * "the market produced nothing", and only the second is a fact about the market.
 */
export function heartbeat(db: Db, sessionId: string, nowMs: number, cycles: number): void {
  db.prepare('UPDATE collector_sessions SET heartbeat_utc_ms = ?, cycles = ? WHERE session_id = ?').run(
    nowMs,
    cycles,
    sessionId,
  );
}

export function closeCollectorSession(db: Db, sessionId: string, nowMs: number): void {
  db.prepare('UPDATE collector_sessions SET ended_utc_ms = ?, heartbeat_utc_ms = ? WHERE session_id = ?').run(
    nowMs,
    nowMs,
    sessionId,
  );
}

export function countResource(
  db: Db,
  sessionId: string,
  kind: string,
  p: { detail?: string; count?: number; errors429?: number; quotaErrors?: number } = {},
): void {
  db.prepare(
    `INSERT INTO collector_counters (session_id, kind, detail, count, errors_429, quota_errors)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(session_id, kind, detail) DO UPDATE SET
       count = count + excluded.count,
       errors_429 = errors_429 + excluded.errors_429,
       quota_errors = quota_errors + excluded.quota_errors`,
  ).run(sessionId, kind, p.detail ?? '', p.count ?? 1, p.errors429 ?? 0, p.quotaErrors ?? 0);
}

export function recordLatency(db: Db, sessionId: string, kind: string, ms: number, nowMs: number): void {
  db.prepare(
    'INSERT INTO collector_latency_samples (session_id, kind, ms, recorded_utc_ms) VALUES (?,?,?,?)',
  ).run(sessionId, kind, Math.max(0, Math.round(ms)), nowMs);
}

export function recordSubscription(
  db: Db,
  sessionId: string,
  p: { kind: string; address: string; trajectoryId?: string | null; nowMs: number },
): void {
  db.prepare(
    `INSERT INTO wss_subscriptions (session_id, kind, address, trajectory_id, subscribed_utc_ms)
     VALUES (?,?,?,?,?)
     ON CONFLICT(session_id, kind, address) DO UPDATE SET unsubscribed_utc_ms = NULL`,
  ).run(sessionId, p.kind, p.address, p.trajectoryId ?? null, p.nowMs);
}

/**
 * Close subscriptions by the addresses that were STORED.
 *
 * Never by a re-derivation. A derivation that changed between subscribe and
 * unsubscribe leaks the old address silently, and a leaked subscription is
 * indistinguishable from an account that simply went quiet.
 */
export function recordUnsubscribe(db: Db, sessionId: string, addresses: readonly string[], nowMs: number): void {
  const stmt = db.prepare(
    'UPDATE wss_subscriptions SET unsubscribed_utc_ms = ? WHERE session_id = ? AND address = ? AND unsubscribed_utc_ms IS NULL',
  );
  for (const a of addresses) stmt.run(nowMs, sessionId, a);
}

export function countSubscriptionEvent(db: Db, sessionId: string, address: string, n = 1): void {
  db.prepare('UPDATE wss_subscriptions SET events = events + ? WHERE session_id = ? AND address = ?').run(
    n,
    sessionId,
    address,
  );
}

export function openGap(db: Db, sessionId: string, reason: string, nowMs: number): void {
  db.prepare('INSERT INTO wss_gaps (session_id, gap_start_utc_ms, reason) VALUES (?,?,?)').run(
    sessionId,
    nowMs,
    reason.slice(0, 300),
  );
}

export function closeGap(
  db: Db,
  sessionId: string,
  p: { nowMs: number; resynced: number; changed: number; unreadable: number },
): void {
  db.prepare(
    `UPDATE wss_gaps SET gap_end_utc_ms = ?, addresses_resynced = ?, addresses_changed = ?, still_unreadable = ?
      WHERE rowid = (SELECT rowid FROM wss_gaps WHERE session_id = ? AND gap_end_utc_ms IS NULL ORDER BY gap_start_utc_ms DESC LIMIT 1)`,
  ).run(p.nowMs, p.resynced, p.changed, p.unreadable, sessionId);
}

export function queueUrgentMark(
  db: Db,
  sessionId: string,
  p: { trajectoryId: string; address: string; before: bigint | null; after: bigint | null; nowMs: number },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO urgent_marks
       (session_id, trajectory_id, address, before_balance, after_balance, queued_utc_ms)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    sessionId,
    p.trajectoryId,
    p.address,
    p.before === null ? null : p.before.toString(),
    p.after === null ? null : p.after.toString(),
    p.nowMs,
  );
}

/** Trajectories with an urgent mark still waiting. Drained before ordinary marks. */
export function pendingUrgent(db: Db, sessionId: string): { trajectory_id: string; queued_utc_ms: number }[] {
  return db
    .prepare(
      `SELECT trajectory_id, MIN(queued_utc_ms) queued_utc_ms
         FROM urgent_marks WHERE session_id = ? AND consumed_utc_ms IS NULL
        GROUP BY trajectory_id ORDER BY queued_utc_ms ASC`,
    )
    .all(sessionId) as never;
}

export function consumeUrgent(db: Db, sessionId: string, trajectoryId: string, nowMs: number): void {
  db.prepare(
    'UPDATE urgent_marks SET consumed_utc_ms = ? WHERE session_id = ? AND trajectory_id = ? AND consumed_utc_ms IS NULL',
  ).run(nowMs, sessionId, trajectoryId);
}

export interface SessionSpans {
  readonly activeSeconds: number;
  readonly wallSeconds: number;
  readonly sessions: number;
  readonly diedWithoutClosing: number;
}

/**
 * Active seconds across every session, and wall seconds spanned.
 *
 * Overlapping sessions are MERGED rather than summed. Two collectors running
 * concurrently for an hour are one active hour of calendar time, and summing
 * them would report a duty cycle above 1 — which then divides every rate by too
 * large a number and understates the load on the quota.
 */
export function sessionSpans(db: Db, sinceUtcMs = 0): SessionSpans {
  const rows = db
    .prepare(
      `SELECT started_utc_ms s, COALESCE(ended_utc_ms, heartbeat_utc_ms) e, ended_utc_ms
         FROM collector_sessions WHERE COALESCE(ended_utc_ms, heartbeat_utc_ms) >= ?
        ORDER BY started_utc_ms ASC`,
    )
    .all(sinceUtcMs) as { s: number; e: number; ended_utc_ms: number | null }[];

  if (rows.length === 0) {
    return { activeSeconds: 0, wallSeconds: 0, sessions: 0, diedWithoutClosing: 0 };
  }

  let activeMs = 0;
  let curStart = rows[0]?.s ?? 0;
  let curEnd = rows[0]?.e ?? 0;
  for (const r of rows.slice(1)) {
    if (r.s <= curEnd) {
      if (r.e > curEnd) curEnd = r.e;
    } else {
      activeMs += curEnd - curStart;
      curStart = r.s;
      curEnd = r.e;
    }
  }
  activeMs += curEnd - curStart;

  const first = Math.min(...rows.map((r) => r.s));
  const last = Math.max(...rows.map((r) => r.e));
  return {
    activeSeconds: activeMs / 1_000,
    wallSeconds: (last - first) / 1_000,
    sessions: rows.length,
    diedWithoutClosing: rows.filter((r) => r.ended_utc_ms === null).length,
  };
}

export function counterTotals(db: Db): { kind: string; detail: string; count: number; errors_429: number; quota_errors: number }[] {
  return db
    .prepare(
      `SELECT kind, detail, SUM(count) count, SUM(errors_429) errors_429, SUM(quota_errors) quota_errors
         FROM collector_counters GROUP BY kind, detail ORDER BY count DESC`,
    )
    .all() as never;
}

export function latencySamples(db: Db, kind: string, limit = 5_000): number[] {
  return (
    db
      .prepare('SELECT ms FROM collector_latency_samples WHERE kind = ? ORDER BY recorded_utc_ms DESC LIMIT ?')
      .all(kind, limit) as { ms: number }[]
  ).map((r) => r.ms);
}

export interface WssCoverage {
  readonly sessions: number;
  readonly openSubscriptions: number;
  readonly closedSubscriptions: number;
  readonly byKind: { kind: string; open: number; events: number }[];
  readonly gaps: number;
  readonly openGaps: number;
  readonly addressesChangedWhileBlind: number;
  readonly urgentQueued: number;
  readonly urgentConsumed: number;
  readonly urgentPending: number;
}

export function wssCoverage(db: Db): WssCoverage {
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
  return {
    sessions: one('SELECT COUNT(*) c FROM collector_sessions'),
    openSubscriptions: one('SELECT COUNT(*) c FROM wss_subscriptions WHERE unsubscribed_utc_ms IS NULL'),
    closedSubscriptions: one('SELECT COUNT(*) c FROM wss_subscriptions WHERE unsubscribed_utc_ms IS NOT NULL'),
    byKind: db
      .prepare(
        `SELECT kind, SUM(CASE WHEN unsubscribed_utc_ms IS NULL THEN 1 ELSE 0 END) open, SUM(events) events
           FROM wss_subscriptions GROUP BY kind ORDER BY kind`,
      )
      .all() as never,
    gaps: one('SELECT COUNT(*) c FROM wss_gaps'),
    openGaps: one('SELECT COUNT(*) c FROM wss_gaps WHERE gap_end_utc_ms IS NULL'),
    addressesChangedWhileBlind: one('SELECT COALESCE(SUM(addresses_changed),0) c FROM wss_gaps'),
    urgentQueued: one('SELECT COUNT(*) c FROM urgent_marks'),
    urgentConsumed: one('SELECT COUNT(*) c FROM urgent_marks WHERE consumed_utc_ms IS NOT NULL'),
    urgentPending: one('SELECT COUNT(*) c FROM urgent_marks WHERE consumed_utc_ms IS NULL'),
  };
}
