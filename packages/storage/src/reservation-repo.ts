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

export interface Reservation {
  readonly reservationId: string;
  readonly windowId: string;
  readonly mint: string;
  readonly ordinal: number;
  readonly maxPerMint: number;
  readonly ownerSessionId: string;
  readonly reservedUtcMs: number;
}

/** Deterministic, so the same (window, mint, ordinal) is always the same id. */
export function reservationId(windowId: string, mint: string, ordinal: number): string {
  return `resv-${createHash('sha256').update(`${windowId}|${mint}|${ordinal}`).digest('hex').slice(0, 32)}`;
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

    const heldOpen = db
      .prepare(
        `SELECT COUNT(*) AS c FROM trajectory_reservations
          WHERE window_id = ? AND mint = ? AND status = 'RESERVED'`,
      )
      .get(windowId, mint) as { c: number };
    if (Number(heldOpen.c) > 0) {
      throw new ReservationRefused(mint, 'ALREADY_OPEN', `${mint} already holds an unresolved reservation`);
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
    const id = reservationId(windowId, mint, ordinal);
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
