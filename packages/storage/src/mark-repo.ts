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

/**
 * P5 / P7.2 — a mark, written LOUDLY, carrying its own SLA verdict.
 *
 * Two defects at once:
 *
 * L-1: this was a bare `INSERT OR IGNORE` returning `void`. The audit wrote a
 * second, DIFFERENT price at a recorded offset — mark `(30f0a674, 1800000ms)`
 * kept `18678909` against an offered `123456789` — and the writer reported
 * success. With several daemons racing the same open trajectories, a discarded
 * write and a market fact were indistinguishable afterwards.
 *
 * P7.2: a mark carried `lateness_ms` and no verdict, so 697 of 1,448 marks more
 * than 60 s late sat in the corpus wearing the right offset label. A late mark
 * is `MISSED_HORIZON`. It is not interpolated, not backfilled, and not given a
 * horizon's name on a different instant.
 *
 * Same key + identical content is still idempotent — a restart re-marking a
 * recorded offset is normal and must not throw.
 */
export function insertMark(
  db: Db,
  trajectoryId: string,
  m: CollectedMark,
  sla: { dueUtcMs: number; status: 'ON_TIME' | 'MISSED_HORIZON'; boundMs: number } | null = null,
): void {
  const existing = db
    .prepare(
      `SELECT observed_utc_ms, executable_lamports, exit_capacity_lamports, effective_quote_reserve, refusal
         FROM trajectory_marks WHERE trajectory_id = ? AND offset_ms = ?`,
    )
    .get(trajectoryId, m.offsetMs) as
    | {
        observed_utc_ms: number;
        executable_lamports: string | null;
        exit_capacity_lamports: string | null;
        effective_quote_reserve: string | null;
        refusal: string | null;
      }
    | undefined;

  const offered = {
    executable: m.executableLamports === null ? null : m.executableLamports.toString(),
    capacity: m.exitCapacityLamports === null ? null : m.exitCapacityLamports.toString(),
    reserve: m.effectiveQuoteReserveLamports === null ? null : m.effectiveQuoteReserveLamports.toString(),
    refusal: m.refusal,
  };

  if (existing !== undefined) {
    const same =
      existing.executable_lamports === offered.executable &&
      existing.exit_capacity_lamports === offered.capacity &&
      existing.effective_quote_reserve === offered.reserve &&
      existing.refusal === offered.refusal;
    if (same) return;
    throw new MarkConflict(trajectoryId, m.offsetMs, existing.executable_lamports, offered.executable);
  }

  const r = db
    .prepare(
      `INSERT INTO trajectory_marks
         (trajectory_id, offset_ms, observed_utc_ms, executable_lamports,
          exit_capacity_lamports, effective_quote_reserve, refusal, lateness_ms,
          sla_status, due_utc_ms, sla_bound_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      trajectoryId,
      m.offsetMs,
      m.atMs,
      offered.executable,
      offered.capacity,
      offered.reserve,
      offered.refusal,
      m.latenessMs,
      sla?.status ?? null,
      sla?.dueUtcMs ?? null,
      sla?.boundMs ?? null,
    );
  if (Number(r.changes) !== 1) {
    throw new Error(
      `inserting mark (${trajectoryId.slice(0, 12)}, ${m.offsetMs}) changed ${r.changes} row(s), expected 1`,
    );
  }
}

export class MarkConflict extends Error {
  constructor(
    readonly trajectoryId: string,
    readonly offsetMs: number,
    readonly stored: string | null,
    readonly offered: string | null,
  ) {
    super(
      `a DIFFERENT mark already exists at (${trajectoryId.slice(0, 12)}, ${offsetMs}ms): ` +
        `stored ${stored ?? 'null'}, offered ${offered ?? 'null'}. ` +
        'One horizon has one price. A second, different answer is refused rather than discarded, because ' +
        'a discarded write and a market fact are indistinguishable afterwards.',
    );
    this.name = 'MarkConflict';
  }
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

/**
 * P5 — a policy outcome, written LOUDLY.
 *
 * `INSERT OR IGNORE` here meant a second, DIFFERENT outcome for the same
 * (trajectory, policy) was silently discarded. With several daemons racing the
 * same open trajectories that is indistinguishable from the first answer having
 * been right, and this row is a strategy result.
 *
 * Same key + identical content stays idempotent: re-running a settled path must
 * not throw.
 */
export function insertPolicyOutcome(
  db: Db,
  trajectoryId: string,
  entryCashOutLamports: bigint,
  o: PolicyOutcome,
  settledUtcMs: number,
  extra: { entryPolicy?: string | null; entryDecision?: string | null; evidenceClass?: string | null } = {},
): void {
  const existing = db
    .prepare(
      `SELECT triggered_offset_ms, exit_mark_lamports, gross_delta_lamports
         FROM trajectory_policy_outcomes WHERE trajectory_id = ? AND exit_policy = ?`,
    )
    .get(trajectoryId, o.exitPolicy) as
    | { triggered_offset_ms: number | null; exit_mark_lamports: string | null; gross_delta_lamports: string | null }
    | undefined;

  const offeredMark = o.exitMarkLamports === null ? null : o.exitMarkLamports.toString();
  const offeredDelta = o.grossDeltaLamports === null ? null : o.grossDeltaLamports.toString();

  if (existing !== undefined) {
    const same =
      existing.triggered_offset_ms === o.triggeredOffsetMs &&
      existing.exit_mark_lamports === offeredMark &&
      existing.gross_delta_lamports === offeredDelta;
    if (same) return;
    throw new PolicyOutcomeConflict(trajectoryId, o.exitPolicy, existing.exit_mark_lamports, offeredMark);
  }

  const r = db
    .prepare(
      `INSERT INTO trajectory_policy_outcomes
         (trajectory_id, exit_policy, triggered_utc_ms, triggered_offset_ms, reason,
          exit_mark_lamports, entry_cash_out_lamports, gross_delta_lamports, settled_utc_ms,
          entry_policy, entry_decision, evidence_class)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      trajectoryId,
      o.exitPolicy,
      o.triggeredAtMs,
      o.triggeredOffsetMs,
      o.reason,
      offeredMark,
      entryCashOutLamports.toString(),
      offeredDelta,
      settledUtcMs,
      extra.entryPolicy ?? null,
      extra.entryDecision ?? null,
      extra.evidenceClass ?? null,
    );
  if (Number(r.changes) !== 1) {
    throw new Error(
      `inserting policy outcome (${trajectoryId.slice(0, 12)}, ${o.exitPolicy}) changed ${r.changes} row(s), expected 1`,
    );
  }
}

export class PolicyOutcomeConflict extends Error {
  constructor(
    readonly trajectoryId: string,
    readonly exitPolicy: string,
    readonly stored: string | null,
    readonly offered: string | null,
  ) {
    super(
      `a DIFFERENT outcome already exists for (${trajectoryId.slice(0, 12)}, ${exitPolicy}): ` +
        `stored exit mark ${stored ?? 'null'}, offered ${offered ?? 'null'}. ` +
        'A second different exit for one policy on one trajectory is refused, not discarded.',
    );
    this.name = 'PolicyOutcomeConflict';
  }
}

/**
 * P5 — close exactly one trajectory, or say why not.
 *
 * The audit's L-1 ran a single UPDATE that settled 64 open trajectories at
 * once, with nothing bounding it, and a zero-row update that reported success.
 * Both are silent, and both produce a corpus nobody can question afterwards.
 *
 * Zero rows is NOT an error here — a trajectory already SETTLED is closed, and
 * a retry must be idempotent — but it is reported so the caller can tell the
 * difference between closing something and closing nothing.
 */
export function closeTrajectory(db: Db, trajectoryId: string, settledUtcMs: number): { closed: boolean } {
  const r = db
    .prepare(
      `UPDATE development_trajectories
          SET state = 'SETTLED', settled_utc_ms = ?
        WHERE trajectory_id = ? AND state = 'AWAITING_FILL_OBSERVATION'`,
    )
    .run(settledUtcMs, trajectoryId);
  const changed = Number(r.changes);
  if (changed > 1) {
    throw new Error(
      `closing ${trajectoryId.slice(0, 12)} changed ${changed} rows. The key did not identify one trajectory.`,
    );
  }
  return { closed: changed === 1 };
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
