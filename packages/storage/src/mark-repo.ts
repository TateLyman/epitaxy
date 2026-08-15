import type { Db } from './db.js';
import type { CollectedMark, PolicyOutcome } from '../../pipeline/src/mark-path.js';

/**
 * P9 — persistence for the shared mark path and the paired policy outcomes.
 *
 * Append-only in the same sense the trajectory rows are: the primary keys
 * include the offset and the policy, so a re-run cannot add a second
 * 15-minute observation to one path or replace a recorded outcome. An outcome
 * that can be overwritten is an outcome that can be improved after the fact.
 */

export interface OpenTrajectoryForMarking {
  readonly trajectoryId: string;
  readonly mint: string;
  readonly acquiredAtoms: bigint;
  readonly openedUtcMs: number;
  readonly entryCashOutLamports: bigint;
}

/** Trajectories still awaiting marks, oldest first so no path starves. */
export function openTrajectories(db: Db, limit = 50): OpenTrajectoryForMarking[] {
  const rows = db
    .prepare(
      `SELECT trajectory_id, mint, notional_lamports, opened_utc_ms, entry_policy_inputs
         FROM development_trajectories
        WHERE state = 'AWAITING_FILL_OBSERVATION'
        ORDER BY opened_utc_ms ASC
        LIMIT ?`,
    )
    .all(limit) as {
    trajectory_id: string;
    mint: string;
    notional_lamports: string;
    opened_utc_ms: number;
    entry_policy_inputs: string;
  }[];

  return rows.map((r) => {
    let acquired = 0n;
    try {
      const inputs = JSON.parse(r.entry_policy_inputs) as Record<string, string>;
      acquired = BigInt(inputs['baseVaultDeltaAtoms'] ?? '0');
    } catch {
      acquired = 0n;
    }
    return {
      trajectoryId: r.trajectory_id,
      mint: r.mint,
      acquiredAtoms: acquired,
      openedUtcMs: r.opened_utc_ms,
      entryCashOutLamports: BigInt(r.notional_lamports),
    };
  });
}

export function recordedOffsets(db: Db, trajectoryId: string): Set<number> {
  const rows = db
    .prepare('SELECT offset_ms FROM trajectory_marks WHERE trajectory_id = ?')
    .all(trajectoryId) as { offset_ms: number }[];
  return new Set(rows.map((r) => r.offset_ms));
}

export function insertMark(db: Db, trajectoryId: string, m: CollectedMark): void {
  db.prepare(
    `INSERT OR IGNORE INTO trajectory_marks
       (trajectory_id, offset_ms, observed_utc_ms, executable_lamports,
        exit_capacity_lamports, effective_quote_reserve, refusal, lateness_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    trajectoryId,
    m.offsetMs,
    m.atMs,
    m.executableLamports === null ? null : m.executableLamports.toString(),
    m.exitCapacityLamports === null ? null : m.exitCapacityLamports.toString(),
    m.effectiveQuoteReserveLamports === null ? null : m.effectiveQuoteReserveLamports.toString(),
    m.refusal,
    m.latenessMs,
  );
}

export function marksFor(db: Db, trajectoryId: string): CollectedMark[] {
  const rows = db
    .prepare(
      `SELECT offset_ms, observed_utc_ms, executable_lamports, exit_capacity_lamports,
              effective_quote_reserve, refusal
         FROM trajectory_marks WHERE trajectory_id = ? ORDER BY offset_ms ASC`,
    )
    .all(trajectoryId) as {
    offset_ms: number;
    observed_utc_ms: number;
    executable_lamports: string | null;
    exit_capacity_lamports: string | null;
    effective_quote_reserve: string | null;
    refusal: string | null;
    lateness_ms: number | null;
  }[];
  return rows.map((r) => ({
    atMs: r.observed_utc_ms,
    offsetMs: r.offset_ms,
    executableLamports: r.executable_lamports === null ? null : BigInt(r.executable_lamports),
    exitCapacityLamports: r.exit_capacity_lamports === null ? null : BigInt(r.exit_capacity_lamports),
    effectiveQuoteReserveLamports: r.effective_quote_reserve === null ? null : BigInt(r.effective_quote_reserve),
    refusal: r.refusal,
    latenessMs: r.lateness_ms ?? 0,
  }));
}

export function insertPolicyOutcome(
  db: Db,
  trajectoryId: string,
  entryCashOutLamports: bigint,
  o: PolicyOutcome,
  settledUtcMs: number,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO trajectory_policy_outcomes
       (trajectory_id, exit_policy, triggered_utc_ms, triggered_offset_ms, reason,
        exit_mark_lamports, entry_cash_out_lamports, gross_delta_lamports, settled_utc_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    trajectoryId,
    o.exitPolicy,
    o.triggeredAtMs,
    o.triggeredOffsetMs,
    o.reason,
    o.exitMarkLamports === null ? null : o.exitMarkLamports.toString(),
    entryCashOutLamports.toString(),
    o.grossDeltaLamports === null ? null : o.grossDeltaLamports.toString(),
    settledUtcMs,
  );
}

export function closeTrajectory(db: Db, trajectoryId: string, settledUtcMs: number): void {
  db.prepare(
    `UPDATE development_trajectories
        SET state = 'SETTLED', settled_utc_ms = ?
      WHERE trajectory_id = ? AND state = 'AWAITING_FILL_OBSERVATION'`,
  ).run(settledUtcMs, trajectoryId);
}

export function markAndOutcomeCounts(db: Db): { marks: number; outcomes: number; settled: number } {
  const one = (sql: string): number => {
    try {
      return (db.prepare(sql).get() as { c: number }).c;
    } catch {
      return 0;
    }
  };
  return {
    marks: one('SELECT COUNT(*) c FROM trajectory_marks'),
    outcomes: one('SELECT COUNT(*) c FROM trajectory_policy_outcomes'),
    settled: one("SELECT COUNT(*) c FROM development_trajectories WHERE state='SETTLED'"),
  };
}
