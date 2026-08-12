import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { RunContext } from '../../domain/src/provenance.js';
import type { ImpactReading } from '../../domain/src/impact.js';
import type { DiagnosticVerdict } from '../../domain/src/exitdiagnostic.js';
import type { AtaRentVerdict, AtaState } from '../../domain/src/ata.js';
import type { SkewVerdict, ClockReading } from '../../domain/src/clock.js';

/**
 * Writers for everything migration 7 added.
 *
 * Kept out of `repo.ts` because that file is already the largest in the tree
 * and because these are all one concern: making a row say where it came from,
 * what was actually observed, and what could not be established. Nothing here
 * derives economics — it persists what the domain modules decided.
 */

/** bigint-or-null to TEXT-or-NULL. Every amount stays out of float space. */
const bn = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());
const bit = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);

// ---------------------------------------------------------------------------
// run contexts
// ---------------------------------------------------------------------------

/**
 * Record the context, and return its hash for stamping onto rows.
 *
 * Idempotent: the same code in the same regime writes one row however many
 * times the engine restarts, and `last_seen_utc_ms` moves. A restart is not a
 * new experiment.
 */
export function upsertRunContext(db: Db, ctx: RunContext, mode: string): string {
  db.prepare(
    `INSERT INTO run_contexts
       (context_hash,source_commit,strategy_version,strategy_config_hash,risk_policy_hash,
        schema_version,paper_engine_version,quote_adapter_version,data_regime_id,mode,
        first_seen_utc_ms,last_seen_utc_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(context_hash) DO UPDATE SET last_seen_utc_ms = excluded.last_seen_utc_ms`,
  ).run(
    ctx.contextHash,
    ctx.sourceCommit,
    ctx.strategyVersion,
    ctx.strategyConfigHash,
    ctx.riskPolicyHash,
    ctx.schemaVersion,
    ctx.paperEngineVersion,
    ctx.quoteAdapterVersion,
    ctx.dataRegimeId,
    mode,
    ctx.capturedUtcMs,
    ctx.capturedUtcMs,
  );
  return ctx.contextHash;
}

/**
 * Stamp a context onto a row that has already been written.
 *
 * The table name is not interpolated from caller input — it is selected from a
 * closed list. A dynamic identifier here would be a SQL injection surface in a
 * process that also holds a database of research it cannot reproduce.
 */
const STAMPABLE = {
  decision_snapshots: 'snapshot_id',
  screenings: 'screening_id',
  quotes: 'quote_id',
  positions: 'position_id',
  fills: 'fill_id',
  position_marks: 'mark_id',
  position_exits: 'position_id',
  build_attempts: 'build_id',
} as const;

export type StampableTable = keyof typeof STAMPABLE;

export function stampContext(db: Db, table: StampableTable, id: string, contextHash: string): void {
  const key = STAMPABLE[table];
  db.prepare(`UPDATE ${table} SET context_hash = ? WHERE ${key} = ? AND context_hash IS NULL`).run(contextHash, id);
}

export interface ContextCoverage {
  readonly table: string;
  readonly total: number;
  readonly tagged: number;
  readonly regimes: number;
}

/**
 * How much of each table can say which experiment produced it.
 *
 * Rows written before migration 7 are permanently untagged, and that is the
 * correct outcome: back-filling a guessed context would erase the only signal
 * that says those rows are not confirmatory data.
 */
export function contextCoverage(db: Db): ContextCoverage[] {
  return (Object.keys(STAMPABLE) as StampableTable[]).map((table) => {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN context_hash IS NOT NULL THEN 1 ELSE 0 END) AS tagged,
                COUNT(DISTINCT context_hash) AS regimes
         FROM ${table}`,
      )
      .get() as Record<string, number | null>;
    return {
      table,
      total: r['total'] ?? 0,
      tagged: r['tagged'] ?? 0,
      regimes: r['regimes'] ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// raw payloads
// ---------------------------------------------------------------------------

export function payloadHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Persist a raw provider response, deduplicated by content hash.
 *
 * §P1.1: "Persist the raw response or a durable raw blob plus hash. Never
 * preserve only the derived number." Until now a parser bug was unrecoverable —
 * the derived value was stored and the bytes were discarded, so history could
 * never be re-derived. Storage cost is bounded by deduplication: identical
 * responses collapse to one row and a reference count.
 */
export function storeRawPayload(db: Db, source: string, endpoint: string, body: string, utcMs: number): string {
  const hash = payloadHash(body);
  db.prepare(
    `INSERT INTO raw_payloads (payload_hash,source,endpoint,first_seen_utc_ms,last_seen_utc_ms,ref_count,byte_length,body)
     VALUES (?,?,?,?,?,1,?,?)
     ON CONFLICT(payload_hash) DO UPDATE SET
       last_seen_utc_ms = excluded.last_seen_utc_ms,
       ref_count = raw_payloads.ref_count + 1`,
  ).run(hash, source, endpoint, utcMs, utcMs, Buffer.byteLength(body, 'utf8'), body);
  return hash;
}

export function rawPayload(db: Db, hash: string): string | null {
  const r = db.prepare('SELECT body FROM raw_payloads WHERE payload_hash = ?').get(hash) as { body: string } | undefined;
  return r?.body ?? null;
}

// ---------------------------------------------------------------------------
// mark analysis — the P1 fields
// ---------------------------------------------------------------------------

export interface MarkAnalysis {
  readonly impact: ImpactReading | null;
  readonly diagnostic: DiagnosticVerdict;
  readonly executableSellValueLamports: bigint | null;
  readonly allInCostLamports: bigint;
  /** Signed. Negative is a real loss and is never made positive. */
  readonly signedMarkReturnBps: number | null;
  readonly roundTripRouteLossBps: number | null;
  readonly quoteAgeMs: number | null;
  readonly routeExists: boolean;
  readonly routeBuildable: boolean | null;
  readonly rawPayloadHash: string | null;
  readonly contextHash: string | null;
}

export function recordMarkAnalysis(db: Db, markId: string, a: MarkAnalysis): void {
  db.prepare(
    `UPDATE position_marks SET
       raw_impact_source_field = ?, raw_impact_string = ?, impact_schema_status = ?,
       adverse_impact_bps = ?, favourable_impact_bps = ?, impact_parser_version = ?,
       executable_sell_value_lamports = ?, all_in_cost_lamports = ?, executable_value_ratio_bps = ?,
       signed_mark_return_bps = ?, round_trip_route_loss_bps = ?, quote_age_ms = ?,
       route_exists = ?, route_buildable = ?, raw_payload_hash = ?,
       diagnostic = ?, diagnostic_detail = ?, diagnostic_version = ?, context_hash = ?
     WHERE mark_id = ?`,
  ).run(
    a.impact?.sourceField ?? null,
    a.impact?.rawString ?? null,
    a.impact?.status ?? null,
    a.impact?.adverseBps ?? null,
    a.impact?.favourableBps ?? null,
    a.impact?.parserVersion ?? null,
    bn(a.executableSellValueLamports),
    a.allInCostLamports.toString(),
    a.diagnostic.executableValueRatioBps,
    a.signedMarkReturnBps,
    a.roundTripRouteLossBps,
    a.quoteAgeMs,
    a.routeExists ? 1 : 0,
    bit(a.routeBuildable),
    a.rawPayloadHash,
    a.diagnostic.diagnostic,
    a.diagnostic.detail,
    a.diagnostic.version,
    a.contextHash,
    markId,
  );
}

// ---------------------------------------------------------------------------
// exit annotation — diagnostics, ATA settlement, actual fees
// ---------------------------------------------------------------------------

export interface ActualFees {
  readonly feeBps: number | null;
  readonly feeMint: string | null;
  readonly platformFeeAmount: bigint | null;
  readonly platformFeeBps: number | null;
  readonly signatureFeeLamports: bigint | null;
  readonly prioritizationFeeLamports: bigint | null;
  readonly rentFeeLamports: bigint | null;
}

export interface ExitAnnotation {
  readonly diagnostic: DiagnosticVerdict;
  readonly ata: AtaState;
  readonly ataVerdict: AtaRentVerdict;
  readonly ataAccountingVersion: string;
  readonly fees: ActualFees;
  readonly contextHash: string | null;
}

export function annotateExit(db: Db, positionId: string, a: ExitAnnotation): void {
  db.prepare(
    `UPDATE position_exits SET
       diagnostic = ?, diagnostic_detail = ?, diagnostic_version = ?, executable_value_ratio_bps = ?,
       ata_created = ?, ata_rent_locked_lamports = ?, ata_close_buildable = ?, ata_close_simulated = ?,
       ata_close_attempted = ?, ata_close_confirmed = ?, ata_rent_recovered_lamports = ?,
       ata_close_fee_lamports = ?, ata_close_failure_reason = ?, withheld_transfer_fee_lamports = ?,
       residual_token_amount = ?, ata_accounting_version = ?,
       actual_fee_bps = ?, actual_fee_mint = ?, actual_platform_fee_amount = ?, actual_platform_fee_bps = ?,
       actual_signature_fee_lamports = ?, actual_prioritization_fee_lamports = ?, actual_rent_fee_lamports = ?,
       context_hash = ?
     WHERE position_id = ?`,
  ).run(
    a.diagnostic.diagnostic,
    a.diagnostic.detail,
    a.diagnostic.version,
    a.diagnostic.executableValueRatioBps,
    a.ata.ataCreated ? 1 : 0,
    a.ata.ataRentLockedLamports.toString(),
    bit(a.ata.ataCloseBuildable),
    bit(a.ata.ataCloseSimulated),
    a.ata.ataCloseAttempted ? 1 : 0,
    a.ata.ataCloseConfirmed ? 1 : 0,
    a.ataVerdict.ataRentRecoveredLamports.toString(),
    a.ata.ataCloseFeeLamports.toString(),
    a.ataVerdict.ataCloseFailureReason,
    bn(a.ata.withheldTransferFeeLamports),
    bn(a.ata.residualTokenAmount),
    a.ataAccountingVersion,
    a.fees.feeBps,
    a.fees.feeMint,
    bn(a.fees.platformFeeAmount),
    a.fees.platformFeeBps,
    bn(a.fees.signatureFeeLamports),
    bn(a.fees.prioritizationFeeLamports),
    bn(a.fees.rentFeeLamports),
    a.contextHash,
    positionId,
  );
}

/** Counts by diagnostic, for the report and for `pnpm capability`. */
export function diagnosticBreakdown(db: Db, table: 'position_marks' | 'position_exits'): { diagnostic: string; count: number }[] {
  return db
    .prepare(
      `SELECT COALESCE(diagnostic,'UNCLASSIFIED') AS diagnostic, COUNT(*) AS count
       FROM ${table} GROUP BY 1 ORDER BY count DESC`,
    )
    .all() as { diagnostic: string; count: number }[];
}

// ---------------------------------------------------------------------------
// dual ledgers
// ---------------------------------------------------------------------------

export type LedgerName = 'portfolio_paper' | 'alpha_shadow';

export interface LedgerEntry {
  readonly ledger: LedgerName;
  readonly positionId: string | null;
  readonly mint: string;
  /** entry | exit | refused | mark */
  readonly event: string;
  readonly utcMs: number;
  readonly notionalLamports: bigint | null;
  readonly realizedLamports: bigint | null;
  readonly navLamports: bigint | null;
  readonly freeLamports: bigint | null;
  readonly lockedRentLamports: bigint | null;
  readonly refusal: string | null;
  readonly detail: string;
  readonly contextHash: string | null;
}

export function insertLedgerEntry(db: Db, e: LedgerEntry): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ledger_entries
       (entry_id,ledger,position_id,mint,event,utc_ms,notional_lamports,realized_lamports,
        nav_lamports,free_lamports,locked_rent_lamports,refusal,detail,context_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    e.ledger,
    e.positionId,
    e.mint,
    e.event,
    e.utcMs,
    bn(e.notionalLamports),
    bn(e.realizedLamports),
    bn(e.navLamports),
    bn(e.freeLamports),
    bn(e.lockedRentLamports),
    e.refusal,
    e.detail,
    e.contextHash,
  );
  return id;
}

export interface LedgerSummary {
  readonly ledger: LedgerName;
  readonly entries: number;
  readonly exits: number;
  readonly refusals: number;
  readonly realizedLamports: bigint;
}

/**
 * Summarise one ledger. Summed in bigint from TEXT, never through SQL SUM:
 * `SUM(CAST(x AS INTEGER))` read back as a double is how exact money stops
 * being exact.
 */
export function ledgerSummary(db: Db, ledger: LedgerName): LedgerSummary {
  const rows = db
    .prepare('SELECT event, realized_lamports AS r FROM ledger_entries WHERE ledger = ?')
    .all(ledger) as { event: string; r: string | null }[];
  let realized = 0n;
  let entries = 0;
  let exits = 0;
  let refusals = 0;
  for (const row of rows) {
    if (row.event === 'entry') entries += 1;
    else if (row.event === 'exit') exits += 1;
    else if (row.event === 'refused') refusals += 1;
    if (row.r !== null) realized += BigInt(row.r);
  }
  return { ledger, entries, exits, refusals, realizedLamports: realized };
}

// ---------------------------------------------------------------------------
// clock checkpoints
// ---------------------------------------------------------------------------

export function recordClockCheckpoint(
  db: Db,
  reading: ClockReading,
  skew: SkewVerdict | null,
  resyncRequired: boolean,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO clock_checkpoints
       (checkpoint_id,pid,monotonic_ms,wall_utc_ms,wall_delta_ms,monotonic_delta_ms,skew_ms,
        discontinuity,detail,resync_required,resync_done_utc_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).run(
    id,
    process.pid,
    reading.monotonicMs,
    reading.wallUtcMs,
    skew === null ? null : Math.round(skew.wallDeltaMs),
    skew?.monotonicDeltaMs ?? null,
    skew?.skewMs ?? null,
    skew?.discontinuity ?? null,
    skew?.detail ?? null,
    resyncRequired ? 1 : 0,
  );
  return id;
}

export function markResyncDone(db: Db, checkpointId: string, utcMs: number): void {
  db.prepare('UPDATE clock_checkpoints SET resync_done_utc_ms = ? WHERE checkpoint_id = ?').run(utcMs, checkpointId);
}

/**
 * Whether a discontinuity has been recorded that nothing has resynchronised.
 *
 * Read at startup as well as in the loop: a process that died during a resume
 * left a row saying the world may have moved, and the replacement process must
 * not assume otherwise just because it is new.
 */
export function outstandingResync(db: Db): { checkpointId: string; detail: string; wallUtcMs: number } | null {
  const r = db
    .prepare(
      `SELECT checkpoint_id AS checkpointId, detail, wall_utc_ms AS wallUtcMs
       FROM clock_checkpoints
       WHERE resync_required = 1 AND resync_done_utc_ms IS NULL
       ORDER BY wall_utc_ms DESC LIMIT 1`,
    )
    .get() as { checkpointId: string; detail: string; wallUtcMs: number } | undefined;
  return r ?? null;
}

// ---------------------------------------------------------------------------
// daily accounting
// ---------------------------------------------------------------------------

export interface DayRecord {
  readonly utcDate: string;
  readonly dayStartUtcMs: number;
  readonly realizedLamports: bigint;
  readonly positionsClosed: number;
  readonly rolledUtcMs: number;
}

/**
 * Persist the day's realized total, recomputed from immutable closed positions.
 *
 * Idempotent by construction: the value is derived from rows that never change,
 * keyed by the UTC date, so running it twice — or at midnight, or after a
 * backwards clock step — writes the same number. That is what makes a clock
 * rollback unable to double-reset the daily loss budget: there is no counter to
 * reset, only a query to repeat.
 */
export function recordDay(db: Db, day: DayRecord, contextHash: string | null): void {
  db.prepare(
    `INSERT INTO daily_accounting (utc_date,day_start_utc_ms,realized_lamports,positions_closed,rolled_utc_ms,context_hash)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(utc_date) DO UPDATE SET
       realized_lamports = excluded.realized_lamports,
       positions_closed  = excluded.positions_closed,
       rolled_utc_ms     = excluded.rolled_utc_ms`,
  ).run(
    day.utcDate,
    day.dayStartUtcMs,
    day.realizedLamports.toString(),
    day.positionsClosed,
    day.rolledUtcMs,
    contextHash,
  );
}

export function dayRecord(db: Db, utcDate: string): DayRecord | null {
  const r = db
    .prepare(
      `SELECT utc_date AS utcDate, day_start_utc_ms AS dayStartUtcMs, realized_lamports AS realized,
              positions_closed AS positionsClosed, rolled_utc_ms AS rolledUtcMs
       FROM daily_accounting WHERE utc_date = ?`,
    )
    .get(utcDate) as
    | { utcDate: string; dayStartUtcMs: number; realized: string; positionsClosed: number; rolledUtcMs: number }
    | undefined;
  if (r === undefined) return null;
  return {
    utcDate: r.utcDate,
    dayStartUtcMs: r.dayStartUtcMs,
    realizedLamports: BigInt(r.realized),
    positionsClosed: r.positionsClosed,
    rolledUtcMs: r.rolledUtcMs,
  };
}
