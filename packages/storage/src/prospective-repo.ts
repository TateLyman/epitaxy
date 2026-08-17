import type { DatabaseSync } from 'node:sqlite';

type Db = DatabaseSync;

/**
 * `reject:panel-v2` — the panel that is actually PROSPECTIVE.
 *
 * ## What v1 could not be
 *
 * `reject_tracking` records THAT a token was rejected — mint, reason, a price
 * and a liquidity figure. It does not record the STATE the rejection was made
 * on. Scoring a panel from state fetched later is a different experiment: the
 * pool has traded, the reserves have moved, and what gets scored is no longer
 * what the filter saw.
 *
 * ## What makes a panel prospective
 *
 * Two things, and both are enforced here rather than described in a document:
 *
 * 1. **The rule is frozen before the sample exists.** Horizons and metric go
 *    into `prospective_panels` once. `admitSample` refuses a panel that was
 *    declared after the rejection it is admitting, because a rule chosen after
 *    seeing a row is a rule chosen on it.
 *
 * 2. **Outcomes cannot reach a horizon the rule did not declare.** `markSample`
 *    refuses an undeclared horizon. Without that, a metric can always be read
 *    off whichever window turned out well — which is the same defect as moving
 *    a threshold after looking at the corpus, in a place nobody audits.
 *
 * The sample row itself carries NO outcome column. That is deliberate: a table
 * where the outcome can be written beside the sample is a table where the two
 * can be written in one statement, and the ordering that makes the panel
 * prospective stops being visible.
 */

export interface PanelDefinition {
  readonly panelId: string;
  readonly declaredUtcMs: number;
  readonly horizonsMs: readonly number[];
  readonly metric: string;
  readonly sourceCommit: string;
  readonly notes?: string;
}

export class PanelViolation extends Error {}

/**
 * Freeze a panel. Idempotent on identical content, and a REFUSAL on different
 * content — redeclaring a panel with new horizons is a new experiment wearing
 * an old name, and the corpus would carry both under one id.
 */
export function declarePanel(db: Db, p: PanelDefinition): void {
  const horizons = JSON.stringify([...p.horizonsMs].sort((a, b) => a - b));
  const existing = db
    .prepare('SELECT horizons_ms, metric, declared_utc_ms, source_commit FROM prospective_panels WHERE panel_id = ?')
    .get(p.panelId) as { horizons_ms: string; metric: string; declared_utc_ms: number; source_commit: string } | undefined;

  if (existing !== undefined) {
    if (existing.horizons_ms !== horizons || existing.metric !== p.metric) {
      throw new PanelViolation(
        `panel ${p.panelId} is already frozen with horizons ${existing.horizons_ms} and metric ` +
          `${existing.metric}. Redeclaring it with different ones is a new experiment; give it a new id.`,
      );
    }
    return;
  }

  db.prepare(
    `INSERT INTO prospective_panels (panel_id, declared_utc_ms, horizons_ms, metric, source_commit, notes)
     VALUES (?,?,?,?,?,?)`,
  ).run(p.panelId, p.declaredUtcMs, horizons, p.metric, p.sourceCommit, p.notes ?? null);
}

export interface SampleRow {
  readonly sampleId: string;
  readonly panelId: string;
  readonly mint: string;
  /** The screening snapshot. THE state, by reference — not a re-fetch. */
  readonly snapshotId: string;
  readonly rejectedUtcMs: number;
  readonly primaryReason: string;
  /** Every gate verdict, not only the one that fired first. */
  readonly gateVerdicts: unknown;
  readonly inclusionProbability?: number | null;
  readonly stratum?: string | null;
  readonly poolReservesLamports?: bigint | null;
  readonly executableQuoteLamports?: bigint | null;
  readonly routeExists?: boolean | null;
}

/**
 * Admit one rejection into the panel, at the instant of rejection.
 *
 * Returns false when the row is already present — a screening path that
 * re-examines a mint on the same snapshot must not enter it twice, or the
 * panel silently overweights whatever gets re-examined most.
 */
export function admitSample(db: Db, s: SampleRow): boolean {
  const panel = db
    .prepare('SELECT declared_utc_ms FROM prospective_panels WHERE panel_id = ?')
    .get(s.panelId) as { declared_utc_ms: number } | undefined;
  if (panel === undefined) {
    throw new PanelViolation(`panel ${s.panelId} has not been declared. Freeze the rule before admitting rows.`);
  }
  // A rule declared after the rejection is a rule chosen with the row in view.
  if (panel.declared_utc_ms > s.rejectedUtcMs) {
    throw new PanelViolation(
      `panel ${s.panelId} was declared at ${panel.declared_utc_ms}, after a rejection at ${s.rejectedUtcMs}. ` +
        'A rule frozen after the row it admits is not prospective.',
    );
  }

  const already = db
    .prepare('SELECT 1 AS x FROM prospective_samples WHERE panel_id = ? AND mint = ? AND snapshot_id = ?')
    .get(s.panelId, s.mint, s.snapshotId);
  if (already !== undefined) return false;

  db.prepare(
    `INSERT INTO prospective_samples
       (sample_id, panel_id, mint, snapshot_id, rejected_utc_ms, primary_reason, gate_verdicts,
        inclusion_probability, stratum, pool_reserves_lamports, executable_quote_lamports, route_exists)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    s.sampleId,
    s.panelId,
    s.mint,
    s.snapshotId,
    s.rejectedUtcMs,
    s.primaryReason,
    JSON.stringify(s.gateVerdicts),
    s.inclusionProbability ?? null,
    s.stratum ?? null,
    // TEXT because SQLite INTEGER is 64-bit SIGNED. Null, never 0, when the
    // provider did not answer.
    s.poolReservesLamports === null || s.poolReservesLamports === undefined ? null : s.poolReservesLamports.toString(),
    s.executableQuoteLamports === null || s.executableQuoteLamports === undefined
      ? null
      : s.executableQuoteLamports.toString(),
    s.routeExists === null || s.routeExists === undefined ? null : s.routeExists ? 1 : 0,
  );
  return true;
}

export interface SampleMark {
  readonly sampleId: string;
  readonly horizonMs: number;
  readonly observedUtcMs: number;
  readonly executableLamports?: bigint | null;
  readonly refusal?: string | null;
}

/**
 * Record an outcome at a horizon the PANEL declared.
 *
 * Refuses an undeclared horizon. Without that refusal a metric can always be
 * read off whichever window turned out well, which is threshold-shopping in a
 * place no ledger covers.
 */
export function markSample(db: Db, m: SampleMark): void {
  const row = db
    .prepare(
      `SELECT s.rejected_utc_ms, p.horizons_ms
         FROM prospective_samples s JOIN prospective_panels p ON p.panel_id = s.panel_id
        WHERE s.sample_id = ?`,
    )
    .get(m.sampleId) as { rejected_utc_ms: number; horizons_ms: string } | undefined;
  if (row === undefined) throw new PanelViolation(`no prospective sample ${m.sampleId}`);

  const declared = JSON.parse(row.horizons_ms) as number[];
  if (!declared.includes(m.horizonMs)) {
    throw new PanelViolation(
      `horizon ${m.horizonMs}ms is not in this panel's frozen set [${declared.join(', ')}]. ` +
        'Scoring an undeclared horizon is choosing the window after seeing the outcome.',
    );
  }

  // A horizon reached late carries the right label and the wrong instant, so
  // the lateness is stored beside the number rather than left to be inferred.
  const lateness = m.observedUtcMs - (row.rejected_utc_ms + m.horizonMs);
  db.prepare(
    `INSERT INTO prospective_sample_marks
       (sample_id, horizon_ms, observed_utc_ms, lateness_ms, executable_lamports, refusal)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(sample_id, horizon_ms) DO NOTHING`,
  ).run(
    m.sampleId,
    m.horizonMs,
    m.observedUtcMs,
    lateness,
    m.executableLamports === null || m.executableLamports === undefined ? null : m.executableLamports.toString(),
    m.refusal ?? null,
  );
}

export interface PanelStatus {
  readonly panelId: string;
  readonly declaredUtcMs: number;
  readonly horizonsMs: readonly number[];
  readonly metric: string;
  readonly samples: number;
  readonly marked: number;
  /** Sample-horizon pairs still owed a mark. The panel is incomplete until zero. */
  readonly outstanding: number;
  readonly byReason: readonly { reason: string; n: number }[];
}

export function panelStatus(db: Db, panelId: string): PanelStatus | null {
  const p = db.prepare('SELECT * FROM prospective_panels WHERE panel_id = ?').get(panelId) as
    | { panel_id: string; declared_utc_ms: number; horizons_ms: string; metric: string }
    | undefined;
  if (p === undefined) return null;

  const horizons = JSON.parse(p.horizons_ms) as number[];
  const one = (sql: string, ...args: unknown[]): number =>
    ((db.prepare(sql).get(...(args as never[])) as { c: number } | undefined)?.c ?? 0);

  const samples = one('SELECT COUNT(*) c FROM prospective_samples WHERE panel_id = ?', panelId);
  const marked = one(
    `SELECT COUNT(*) c FROM prospective_sample_marks m
       JOIN prospective_samples s ON s.sample_id = m.sample_id
      WHERE s.panel_id = ?`,
    panelId,
  );

  const byReason = db
    .prepare(
      'SELECT primary_reason reason, COUNT(*) n FROM prospective_samples WHERE panel_id = ? GROUP BY 1 ORDER BY 2 DESC',
    )
    .all(panelId) as { reason: string; n: number }[];

  return {
    panelId: p.panel_id,
    declaredUtcMs: p.declared_utc_ms,
    horizonsMs: horizons,
    metric: p.metric,
    samples,
    marked,
    outstanding: samples * horizons.length - marked,
    byReason,
  };
}

/** Samples whose horizon is due and unmarked. Least-recent first, so nothing starves. */
export function dueMarks(
  db: Db,
  panelId: string,
  nowMs: number,
  limit = 50,
): { sampleId: string; mint: string; horizonMs: number; dueUtcMs: number }[] {
  const p = db.prepare('SELECT horizons_ms FROM prospective_panels WHERE panel_id = ?').get(panelId) as
    | { horizons_ms: string }
    | undefined;
  if (p === undefined) return [];
  const horizons = JSON.parse(p.horizons_ms) as number[];

  const rows = db
    .prepare('SELECT sample_id, mint, rejected_utc_ms FROM prospective_samples WHERE panel_id = ? ORDER BY rejected_utc_ms')
    .all(panelId) as { sample_id: string; mint: string; rejected_utc_ms: number }[];
  const have = new Set(
    (
      db
        .prepare(
          `SELECT m.sample_id || ':' || m.horizon_ms k FROM prospective_sample_marks m
             JOIN prospective_samples s ON s.sample_id = m.sample_id WHERE s.panel_id = ?`,
        )
        .all(panelId) as { k: string }[]
    ).map((r) => r.k),
  );

  const out: { sampleId: string; mint: string; horizonMs: number; dueUtcMs: number }[] = [];
  for (const r of rows) {
    for (const h of horizons) {
      const due = r.rejected_utc_ms + h;
      // Only horizons that have ACTUALLY arrived. A mark taken early is a
      // 15-minute number observed at four minutes wearing the right label.
      if (due > nowMs) continue;
      if (have.has(`${r.sample_id}:${h}`)) continue;
      out.push({ sampleId: r.sample_id, mint: r.mint, horizonMs: h, dueUtcMs: due });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
