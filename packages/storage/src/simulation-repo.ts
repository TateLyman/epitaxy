import type { Db } from './db.js';
import type { SimulationRequest, SimulationResponse } from '../../simulator/src/protocol.js';

/**
 * The durable record of every simulation this engine asked for.
 *
 * Windows is the only writer and the authoritative ledger. The daemon's
 * in-memory cache serves retries and does not survive a restart; this does.
 */

export class JobHashConflict extends Error {
  constructor(jobId: string, stored: string, incoming: string) {
    super(
      `job ${jobId} already exists with request hash ${stored.slice(0, 16)} but was re-sent with ` +
        `${incoming.slice(0, 16)}. The same job id must mean the same bytes; reconciling these would be ` +
        'inventing a history.',
    );
    this.name = 'JobHashConflict';
  }
}

/**
 * Record the intent BEFORE the request leaves.
 *
 * A crash between send and reply then leaves a row saying a job was in flight,
 * rather than silence. A row stuck in `SIMULATION_REQUESTED` is a known unknown
 * and can be reconciled; a missing row is an unknown unknown and cannot.
 *
 * Returns false when this exact job and hash were already recorded, which is
 * the idempotent retry path.
 */
export function recordSimulationRequested(
  db: Db,
  req: SimulationRequest,
  nowUtcMs: number,
  contextHash: string | null,
): boolean {
  const existing = db
    .prepare('SELECT request_hash AS h, status FROM simulation_jobs WHERE job_id = ?')
    .get(req.jobId) as { h: string; status: string } | undefined;

  if (existing !== undefined) {
    if (existing.h !== req.requestHash) throw new JobHashConflict(req.jobId, existing.h, req.requestHash);
    return false;
  }

  db.prepare(
    `INSERT INTO simulation_jobs
       (job_id,request_hash,execution_observation_id,mode,status,requested_utc_ms,
        snapshot_manifest_hash,original_transaction_hash,original_blockhash,protocol_version,context_hash)
     VALUES (?,?,?,?,'SIMULATION_REQUESTED',?,?,?,?,?,?)`,
  ).run(
    req.jobId,
    req.requestHash,
    req.executionObservationId,
    req.mode,
    nowUtcMs,
    req.snapshotManifestHash,
    req.originalTransactionHash,
    req.originalBlockhash,
    req.protocolVersion,
    contextHash,
  );
  return true;
}

export function recordSimulationResult(
  db: Db,
  res: SimulationResponse,
  confirmatory: { ok: boolean; reasons: string[] },
  nowUtcMs: number,
): void {
  const r = res.blockhashReplacement;
  db.prepare(
    `UPDATE simulation_jobs SET
       status = ?, completed_utc_ms = ?,
       blockhash_replaced = ?, blockhash_proof_ok = ?,
       simulator_source_sha = ?, simulator_binary_hash = ?, simulator_runtime = ?, simulator_feature_set = ?,
       units_consumed = ?, transaction_error = ?, runtime_event_digest = ?,
       startup_ms = ?, simulate_ms = ?, total_ms = ?,
       confirmatory = ?, confirmatory_refusal = ?, detail = ?
     WHERE job_id = ? AND request_hash = ?`,
  ).run(
    res.status,
    nowUtcMs,
    r === null ? 0 : 1,
    r === null ? null : r.instructionsUnchanged && r.accountsUnchanged && r.headerUnchanged ? 1 : 0,
    res.identity.sourceSha,
    res.identity.surfpoolBinaryHash,
    res.identity.runtimeVersion,
    res.identity.featureSet,
    res.unitsConsumed,
    res.transactionError,
    res.runtimeEventDigest,
    res.startupMs,
    res.simulateMs,
    res.totalMs,
    confirmatory.ok ? 1 : 0,
    confirmatory.ok ? null : confirmatory.reasons.join('; '),
    res.detail,
    res.jobId,
    res.requestHash,
  );
}

/**
 * A job that was sent and never answered.
 *
 * Marked UNKNOWN rather than failed: we do not know whether it ran, and a
 * simulation whose outcome is unknown is not a simulation that failed.
 */
export function markSimulationUnknown(db: Db, jobId: string, nowUtcMs: number, detail: string): void {
  db.prepare(
    `UPDATE simulation_jobs SET status = 'SIMULATION_UNKNOWN', completed_utc_ms = ?, detail = ?
     WHERE job_id = ? AND status = 'SIMULATION_REQUESTED'`,
  ).run(nowUtcMs, detail, jobId);
}

export function cachedSimulation(db: Db, jobId: string, requestHash: string): { status: string; confirmatory: number } | null {
  const r = db
    .prepare(
      `SELECT status, confirmatory FROM simulation_jobs
       WHERE job_id = ? AND request_hash = ? AND status != 'SIMULATION_REQUESTED'`,
    )
    .get(jobId, requestHash) as { status: string; confirmatory: number } | undefined;
  return r ?? null;
}

export interface SimulationStats {
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
  readonly unavailable: number;
  readonly unknown: number;
  readonly inFlight: number;
  readonly confirmatory: number;
  readonly medianTotalMs: number | null;
}

export function simulationStats(db: Db): SimulationStats {
  const rows = db.prepare('SELECT status, confirmatory, total_ms FROM simulation_jobs').all() as {
    status: string;
    confirmatory: number;
    total_ms: number | null;
  }[];
  const times = rows.map((r) => r.total_ms).filter((t): t is number => t !== null).sort((a, b) => a - b);
  const count = (s: string): number => rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    ok: count('SIMULATED_OK'),
    failed: count('SIMULATION_FAILED'),
    unavailable: count('SIMULATOR_UNAVAILABLE'),
    unknown: count('SIMULATION_UNKNOWN'),
    inFlight: count('SIMULATION_REQUESTED'),
    confirmatory: rows.filter((r) => r.confirmatory === 1).length,
    medianTotalMs: times.length === 0 ? null : (times[Math.floor(times.length / 2)] ?? null),
  };
}
