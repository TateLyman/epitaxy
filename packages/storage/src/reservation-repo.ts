import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';

/**
 * ATOMIC CANDIDATE RESERVATION.
 *
 * A process lock gives one WRITER. It does not give a per-mint sampling cap.
 * `migrationCandidates()` enforces `COUNT(*) < maxPerMint` correctly — per
 * cycle, in the process that asked. The 8f73cef audit measured what that is
 * worth when five daemons ask at the same instant:
 *
 *     15 mints exceeded a hard cap of 3
 *     the worst mint produced 58 trajectories — nineteen times the cap
 *     one mint accounted for a fifth of the entire sample
 *     three of those breaches happened inside 45 minutes
 *
 * A `SELECT count` followed by a later independent `INSERT` cannot express a
 * cap, no matter how carefully the SELECT is written, because the window
 * between them is where the other four processes live.
 *
 * So the cap is a DATABASE fact:
 *
 *   - `BEGIN IMMEDIATE` takes the write lock before the count is read, so two
 *     transactions cannot both observe the same count;
 *   - `UNIQUE(window_id, mint, reservation_ordinal)` means two reservations
 *     cannot claim ordinal 4;
 *   - `CHECK (reservation_ordinal <= max_per_mint)` means ordinal 4 cannot
 *     exist under a cap of 3 at all;
 *   - a partial `UNIQUE(window_id, mint) WHERE status='RESERVED'` means one
 *     mint cannot have two reservations in flight.
 *
 * A ten-process race therefore creates at most `maxPerMint` rows, and it does
 * so whether or not every process is running the same build.
 */

export class ReservationRefused extends Error {
  constructor(
    readonly mint: string,
    readonly code:
      | 'ALREADY_OPEN'
      | 'CAP_REACHED'
      | 'RACE_LOST'
      | 'NO_SESSION',
    reason: string,
  ) {
    super(reason);
    this.name = 'ReservationRefused';
  }
}

/**
 * How long an unresolved reservation must sit before a different session may
 * reclaim it. Long enough that a slow-but-alive collector is never robbed.
 */
export const STALE_RESERVATION_MS = 15 * 60 * 1_000;

/**
 * Is `pid` a live process? `EPERM` means it EXISTS and we may not signal it.
 *
 * The same rule the collector lock uses, and for the same reason: treating
 * EPERM as dead would let a reclamation take a reservation from a running
 * collector owned by another user.
 */
function defaultPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface Reservation {
  readonly reservationId: string;
  readonly windowId: string;
  readonly mint: string;
  readonly ordinal: number;
  readonly maxPerMint: number;
  readonly ownerSessionId: string;
  readonly reservedUtcMs: number;
}

/**
 * Deterministic, and unique per ATTEMPT.
 *
 * `attempt` is load-bearing. Without it the id is a function of
 * (window, mint, ordinal) alone, so an ABANDONED row permanently occupies the
 * key its own retry would need — and the retry fails on the PRIMARY KEY,
 * reporting a race in a window with one process and no race at all.
 *
 * Measured 2026-08-17: eleven admissible, deep, under-cap pools were refused
 * for exactly this on the pass after the one that abandoned them. A window
 * could only ever open the mints that succeeded on their FIRST attempt, and a
 * transient refusal removed a mint permanently.
 *
 * A refusal is a fact about an instant, not about a mint.
 */
export function reservationId(windowId: string, mint: string, ordinal: number, attempt = 1): string {
  return `resv-${createHash('sha256').update(`${windowId}|${mint}|${ordinal}|${attempt}`).digest('hex').slice(0, 32)}`;
}

/**
 * Reserve the next sampling slot for `mint`, or refuse.
 *
 * Everything below happens inside ONE `BEGIN IMMEDIATE`. The caller gets a
 * reservation it may open a trajectory against, or an exception naming which
 * rule refused. There is no third outcome, and in particular there is no
 * "probably fine" outcome.
 */
export function reserveCandidate(
  db: Db,
  opts: {
    readonly windowId: string;
    readonly mint: string;
    readonly maxPerMint: number;
    readonly ownerSessionId: string;
    readonly nowMs: number;
    /** Count trajectories already recorded for this mint outside the window. */
    readonly includeHistoric?: boolean;
    readonly staleReservationMs?: number;
    readonly pidAlive?: (pid: number) => boolean;
  },
): Reservation {
  const { windowId, mint, maxPerMint, ownerSessionId, nowMs } = opts;
  if (maxPerMint < 1) throw new ReservationRefused(mint, 'CAP_REACHED', `maxPerMint is ${maxPerMint}`);

  db.exec('BEGIN IMMEDIATE');
  try {
    // 1 — no open trajectory for this mint. Two concurrent trajectories on one
    //     pool share a mark path and duplicate each other exactly.
    const open = db
      .prepare(
        `SELECT COUNT(*) AS c FROM development_trajectories
          WHERE mint = ? AND state <> 'SETTLED'`,
      )
      .get(mint) as { c: number };
    if (Number(open.c) > 0) {
      throw new ReservationRefused(mint, 'ALREADY_OPEN', `${mint} already has ${open.c} open trajectory(ies)`);
    }

    /**
     * An unresolved reservation from a DEAD session is not a reservation.
     *
     * A collector that crashes between reserving and opening leaves the row
     * `RESERVED`, and the partial unique index then blocks that mint FOREVER.
     * Measured during this window: three mints were permanently unreachable
     * after runs that died on a serialisation error, a reserved word and a hash
     * mismatch — none of which is a reason to retire a candidate.
     *
     * Reclaimed only when BOTH are true, which is the same rule the collector
     * lock uses and for the same reason: a half-signal is not permission.
     *
     *   - the owning session has ENDED, or is not the session asking now;
     *   - the reservation is older than the stale bound.
     *
     * Reclamation is an ABANDONMENT, so the row is preserved as history and the
     * retry gets a fresh attempt id.
     */
    const held = db
      .prepare(
        `SELECT r.reservation_id, r.reserved_utc_ms, r.owner_session_id,
                s.ended_utc_ms, s.heartbeat_utc_ms, s.pid
           FROM trajectory_reservations r
           LEFT JOIN collector_sessions s ON s.session_id = r.owner_session_id
          WHERE r.window_id = ? AND r.mint = ? AND r.status = 'RESERVED'`,
      )
      .all(windowId, mint) as {
      reservation_id: string;
      reserved_utc_ms: number;
      owner_session_id: string;
      ended_utc_ms: number | null;
      heartbeat_utc_ms: number | null;
      pid: number | null;
    }[];

    const alive = opts.pidAlive ?? defaultPidAlive;
    const staleMs = opts.staleReservationMs ?? STALE_RESERVATION_MS;

    for (const h of held) {
      const isOurs = h.owner_session_id === ownerSessionId;
      if (isOurs) {
        throw new ReservationRefused(mint, 'ALREADY_OPEN', `${mint} already holds a reservation from this session`);
      }

      const ownerEnded = h.ended_utc_ms !== null;
      const ownerPidDead = h.pid !== null && !alive(h.pid);
      const ownerSilent = h.heartbeat_utc_ms === null || nowMs - h.heartbeat_utc_ms >= staleMs;
      const old = nowMs - h.reserved_utc_ms >= staleMs;

      /**
       * A DEAD OWNER'S RESERVATION IS NOT A RESERVATION.
       *
       * Three independent signals, any one of which is sufficient, and the
       * reason they can be independent is the `trajectory_collector` lock: this
       * process holds it EXCLUSIVELY, so no other trajectory collector is
       * running and a RESERVED row owned by a different session is not being
       * worked on by anyone.
       *
       *   ownerEnded     the session wrote ended_utc_ms — an orderly exit that
       *                  should have abandoned it and did not, i.e. a crash
       *                  between reserving and opening;
       *   ownerPidDead   the process is gone. Same rule the lock uses, and EPERM
       *                  still counts as ALIVE;
       *   ownerSilent+old  a host we cannot see the pid on, bounded by time.
       *
       * Measured during the first clean window: four mints were unreachable
       * behind reservations from runs that died seconds earlier, and a
       * fifteen-minute timer would have made each of those failures cost
       * fifteen minutes of collection.
       */
      if (ownerEnded || ownerPidDead || (ownerSilent && old)) {
        db.prepare(
          `UPDATE trajectory_reservations
              SET status = 'ABANDONED', resolved_utc_ms = ?
            WHERE reservation_id = ? AND status = 'RESERVED'`,
        ).run(nowMs, h.reservation_id);
        continue;
      }
      throw new ReservationRefused(
        mint,
        'ALREADY_OPEN',
        `${mint} already holds an unresolved reservation from LIVE session ${h.owner_session_id.slice(0, 12)} ` +
          `(pid ${h.pid ?? '?'}, reserved ${Math.round((nowMs - h.reserved_utc_ms) / 1000)}s ago)`,
      );
    }

    // 2 — the next ordinal, counted inside the same write transaction.
    const used = db
      .prepare(
        `SELECT COUNT(*) AS c FROM trajectory_reservations
          WHERE window_id = ? AND mint = ? AND status <> 'ABANDONED'`,
      )
      .get(windowId, mint) as { c: number };
    const historic = opts.includeHistoric
      ? Number(
          (db.prepare('SELECT COUNT(*) AS c FROM development_trajectories WHERE mint = ?').get(mint) as { c: number })
            .c,
        )
      : 0;
    const ordinal = Number(used.c) + historic + 1;

    // 3 — the cap, before the insert rather than after it.
    if (ordinal > maxPerMint) {
      throw new ReservationRefused(
        mint,
        'CAP_REACHED',
        `${mint} would be sample ${ordinal} against a cap of ${maxPerMint}`,
      );
    }

    // 4 — insert. The unique indexes are the real enforcement; if a concurrent
    //     transaction beat us here despite BEGIN IMMEDIATE, this throws rather
    //     than producing an over-cap row.
    /**
     * Which attempt this is at this exact slot. Counts EVERY prior row for
     * (window, mint, ordinal), abandoned ones included, because those are the
     * rows whose keys are already taken.
     */
    const priorAttempts = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM trajectory_reservations
              WHERE window_id = ? AND mint = ? AND reservation_ordinal = ?`,
          )
          .get(windowId, mint, ordinal) as { c: number }
      ).c,
    );
    const id = reservationId(windowId, mint, ordinal, priorAttempts + 1);
    try {
      db.prepare(
        `INSERT INTO trajectory_reservations
           (reservation_id, window_id, mint, reservation_ordinal, max_per_mint, trajectory_id,
            status, reserved_utc_ms, resolved_utc_ms, owner_session_id)
         VALUES (?, ?, ?, ?, ?, NULL, 'RESERVED', ?, NULL, ?)`,
      ).run(id, windowId, mint, ordinal, maxPerMint, nowMs, ownerSessionId);
    } catch (e) {
      throw new ReservationRefused(
        mint,
        'RACE_LOST',
        `another process reserved ${mint} ordinal ${ordinal} first: ${(e as Error).message}`,
      );
    }

    // 5 — commit.
    db.exec('COMMIT');
    return { reservationId: id, windowId, mint, ordinal, maxPerMint, ownerSessionId, reservedUtcMs: nowMs };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already unwound */
    }
    throw e;
  }
}

/** Bind a reservation to the trajectory it produced. */
export function resolveReservation(
  db: Db,
  reservationId: string,
  trajectoryId: string,
  nowMs: number,
): void {
  const r = db
    .prepare(
      `UPDATE trajectory_reservations
          SET trajectory_id = ?, status = 'OPENED', resolved_utc_ms = ?
        WHERE reservation_id = ? AND status = 'RESERVED'`,
    )
    .run(trajectoryId, nowMs, reservationId);
  if (Number(r.changes) !== 1) {
    throw new Error(
      `resolving reservation ${reservationId} changed ${r.changes} rows, expected exactly 1. ` +
        'A reservation that is not RESERVED cannot be opened, and a zero-row update is how a ' +
        'trajectory ends up attached to nothing.',
    );
  }
}

/** Release a reservation whose candidate did not open. */
export function abandonReservation(db: Db, reservationId: string, nowMs: number, reason: string): void {
  const r = db
    .prepare(
      `UPDATE trajectory_reservations
          SET status = 'ABANDONED', resolved_utc_ms = ?
        WHERE reservation_id = ? AND status = 'RESERVED'`,
    )
    .run(nowMs, reservationId);
  if (Number(r.changes) !== 1) {
    throw new Error(`abandoning reservation ${reservationId} (${reason}) changed ${r.changes} rows, expected 1`);
  }
}

/** Every mint that has breached its cap in this window. Empty is the invariant. */
export function capBreaches(db: Db, windowId: string): { mint: string; count: number; cap: number }[] {
  return (
    db
      .prepare(
        `SELECT mint, COUNT(*) AS n, MAX(max_per_mint) AS cap
           FROM trajectory_reservations
          WHERE window_id = ? AND status <> 'ABANDONED'
          GROUP BY mint
         HAVING n > cap`,
      )
      .all(windowId) as { mint: string; n: number; cap: number }[]
  ).map((r) => ({ mint: r.mint, count: Number(r.n), cap: Number(r.cap) }));
}

/** A window id that is stable for one collection window and unique across them. */
export function newWindowId(contractId: string): string {
  return `win-${createHash('sha256').update(`${contractId}|${randomUUID()}`).digest('hex').slice(0, 24)}`;
}
