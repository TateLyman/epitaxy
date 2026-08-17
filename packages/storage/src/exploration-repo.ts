import type { DatabaseSync } from 'node:sqlite';

type Db = DatabaseSync;

/**
 * Item 55 — the exploration entitlement ledger.
 *
 * `pnpm exploration:status` aliased `cohort:status`, which answers WHICH CELLS
 * ARE UNDER-FILLED. That is a different question from HOW MUCH EXPLORATION
 * BUDGET REMAINS, and the alias hid the fact that the exploration arm had never
 * run at all: `allocate()` existed, was tested, was pure, and no production
 * caller invoked it.
 *
 * ## Why a ledger rather than a counter in the process
 *
 * The collector is a daemon that restarts. An entitlement held in memory is an
 * entitlement that resets on every restart, which turns a 25% exploration
 * fraction into "25% of whatever happened between crashes" — and nothing in the
 * corpus would record that it had happened.
 *
 * All the state is here, so a restart RESUMES. That is the same property the
 * mark scheduler already relies on, for the same reason.
 */

/** FROZEN before collection. See `EXPLORATION_FRACTION`. */
export interface Entitlement {
  readonly windowId: string;
  readonly stratum: string;
  readonly fraction: number;
  readonly granted: number;
  readonly consumed: number;
  readonly remaining: number;
}

/**
 * Grant entitlement for `opens` selections in a stratum.
 *
 * Additive: each cycle grants its share, so the ledger accumulates over a
 * window rather than being recomputed from a total nobody knows in advance.
 * Granting is separate from consuming precisely so that an unspent entitlement
 * is visible instead of being lost when a cycle ends.
 */
export function grantExploration(
  db: Db,
  windowId: string,
  stratum: string,
  fraction: number,
  opens: number,
  nowMs: number,
): void {
  // Ceil, so a small budget still buys one exploration rather than rounding the
  // arm out of existence — which is how a 25% fraction becomes 0% in practice.
  const grant = Math.ceil(opens * fraction);
  db.prepare(
    `INSERT INTO exploration_entitlement (window_id, stratum, fraction, granted, consumed, updated_utc_ms)
     VALUES (?,?,?,?,0,?)
     ON CONFLICT(window_id, stratum) DO UPDATE SET
       granted = granted + excluded.granted,
       updated_utc_ms = excluded.updated_utc_ms`,
  ).run(windowId, stratum, fraction, grant, nowMs);
}

/**
 * Spend one unit, if any remains.
 *
 * Returns false when the stratum is out of budget, and the caller must then
 * take an exploit-arm candidate. A silent overspend would make the recorded
 * fraction a description of intent rather than of what happened.
 */
export function consumeExploration(db: Db, windowId: string, stratum: string, nowMs: number): boolean {
  const row = db
    .prepare('SELECT granted, consumed FROM exploration_entitlement WHERE window_id = ? AND stratum = ?')
    .get(windowId, stratum) as { granted: number; consumed: number } | undefined;
  if (row === undefined || row.consumed >= row.granted) return false;
  db.prepare(
    'UPDATE exploration_entitlement SET consumed = consumed + 1, updated_utc_ms = ? WHERE window_id = ? AND stratum = ?',
  ).run(nowMs, windowId, stratum);
  return true;
}

export function entitlements(db: Db, windowId?: string): Entitlement[] {
  const rows = (
    windowId === undefined
      ? db.prepare('SELECT * FROM exploration_entitlement ORDER BY window_id, stratum').all()
      : db
          .prepare('SELECT * FROM exploration_entitlement WHERE window_id = ? ORDER BY stratum')
          .all(windowId)
  ) as { window_id: string; stratum: string; fraction: number; granted: number; consumed: number }[];
  return rows.map((r) => ({
    windowId: r.window_id,
    stratum: r.stratum,
    fraction: r.fraction,
    granted: r.granted,
    consumed: r.consumed,
    remaining: Math.max(0, r.granted - r.consumed),
  }));
}

export interface ExplorationRealised {
  readonly trajectories: number;
  readonly explore: number;
  readonly exploit: number;
  readonly unassigned: number;
  /** What fraction of opened trajectories actually came from the random draw. */
  readonly realisedFraction: number | null;
}

/**
 * What the arm split actually WAS, from the trajectory rows.
 *
 * Separate from the ledger on purpose. The ledger says what was granted and
 * spent; this says what the corpus contains. They can disagree — a stratum can
 * run out of candidates with entitlement unspent — and only comparing them
 * shows it.
 */
export function explorationRealised(db: Db): ExplorationRealised {
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
  const total = one('SELECT COUNT(*) c FROM development_trajectories');
  const explore = one("SELECT COUNT(*) c FROM development_trajectories WHERE exploration_arm = 'explore'");
  const exploit = one("SELECT COUNT(*) c FROM development_trajectories WHERE exploration_arm = 'exploit'");
  const assigned = explore + exploit;
  return {
    trajectories: total,
    explore,
    exploit,
    // Rows opened before the arm was recorded. Counted, never folded into
    // `exploit`, because "we did not record it" is not "it was exploitation".
    unassigned: total - assigned,
    realisedFraction: assigned > 0 ? explore / assigned : null,
  };
}
