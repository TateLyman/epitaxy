import type { Db } from './db.js';
import type { SimulationRequest, SimulationResponse } from '../../simulator/src/protocol.js';
import type { EffectVerdict } from '../../simulator/src/effect.js';

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
 * Whether a job measured anything, DERIVED from the request it actually sent.
 *
 * Not a flag the caller passes. A caller that could assert its own validity
 * would have asserted it for all 43 sells that failed because the simulator was
 * never given the token they spent -- those requests said `requestedAmount` was
 * zero and carried SOL and nothing else, and every one of them was recorded as
 * a result about a route.
 *
 * So the label is computed from the bytes: a request that names no amount, or
 * that spends a token it never provisioned, is measuring the instrument.
 */
export function simulationValidity(
  req: SimulationRequest,
): 'INSTRUMENT_DEVELOPMENT' | 'VALID_DEVELOPMENT' | 'VALID_CONFIRMATORY' {
  let amount: bigint;
  try {
    amount = BigInt(req.requestedAmount);
  } catch {
    amount = 0n;
  }
  // A leg that spends nothing is not a leg, and every bound over it is vacuous.
  if (amount <= 0n) return 'INSTRUMENT_DEVELOPMENT';

  // A leg that spends a token must have been GIVEN that token. This is the
  // exact condition the whole window failed, checked here against the request
  // rather than against the caller's belief about the request.
  const tokenProvisioned = req.balanceMutations.every(
    (m) => m.kind !== 'token' || ((m.tokenProgram ?? null) !== null && m.amount !== '0'),
  );
  if (!tokenProvisioned) return 'INSTRUMENT_DEVELOPMENT';

  // An unbounded run cannot violate an economic assertion, so it never made one.
  if (req.bounds.feePayer.length === 0 || req.bounds.maxLamportsSpent.length === 0) {
    return 'INSTRUMENT_DEVELOPMENT';
  }

  return req.mode === 'CONFIRMATORY_OFFLINE' ? 'VALID_CONFIRMATORY' : 'VALID_DEVELOPMENT';
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
        snapshot_manifest_hash,original_transaction_hash,original_blockhash,protocol_version,context_hash,
        validity)
     VALUES (?,?,?,?,'SIMULATION_REQUESTED',?,?,?,?,?,?,?)`,
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
    simulationValidity(req),
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

/**
 * P3 -- persist the economic verdict alongside the runtime one.
 *
 * Written even when the verdict FAILS, and especially then. A refusal that is
 * not recorded is indistinguishable from a check that was never run, and the
 * whole point of separating the four checks is that "nobody looked" and
 * "somebody looked and it did not hold" must never collapse into one value.
 */
export function recordSimulationEffect(db: Db, jobId: string, v: EffectVerdict, res: SimulationResponse): void {
  const n = (b: bigint | null): string | null => (b === null ? null : b.toString());
  db.prepare(
    `UPDATE simulation_jobs SET
       runtime_ok = ?, effect_ok = ?, fee_decomposition_ok = ?, account_coverage_ok = ?,
       simulated_effect_ok = ?, effect_refusals = ?,
       input_debit = ?, output_credit = ?,
       base_fee_lamports = ?, priority_fee_lamports = ?, tip_lamports = ?,
       rent_created_lamports = ?, rent_recovered_lamports = ?,
       transfer_fee_lamports = ?, withheld_fee_lamports = ?,
       unexpected_movement_lamports = ?, unexpected_recipients = ?,
       unobserved_accounts = ?, bounds_violations = ?,
       pre_sol_balances = ?, post_sol_balances = ?,
       pre_token_balances = ?, post_token_balances = ?,
       pre_token_accounts = ?, post_token_accounts = ?, token_deltas = ?,
       created_accounts = ?, closed_accounts = ?
     WHERE job_id = ?`,
  ).run(
    v.checks.RUNTIME_OK ? 1 : 0,
    v.checks.EFFECT_OK ? 1 : 0,
    v.checks.FEE_DECOMPOSITION_OK ? 1 : 0,
    v.checks.ACCOUNT_COVERAGE_OK ? 1 : 0,
    v.simulatedEffectOk ? 1 : 0,
    v.refusals.length === 0 ? null : JSON.stringify(v.refusals),
    n(v.inputDebit),
    n(v.outputCredit),
    n(v.baseFeeLamports),
    n(v.priorityFeeLamports),
    n(v.tipLamports),
    n(v.rentCreatedLamports),
    n(v.rentRecoveredLamports),
    n(v.transferFeeLamports),
    n(v.withheldFeeLamports),
    v.unexpectedMovementLamports.toString(),
    v.unexpectedRecipients.length === 0 ? null : JSON.stringify(v.unexpectedRecipients),
    v.unobservedAccounts.length === 0 ? null : JSON.stringify(v.unobservedAccounts),
    v.boundsViolations.length === 0 ? null : JSON.stringify(v.boundsViolations),
    JSON.stringify(res.preSolBalances),
    JSON.stringify(res.postSolBalances),
    JSON.stringify(res.preTokenBalances),
    JSON.stringify(res.postTokenBalances),
    JSON.stringify(res.preTokenAccounts ?? []),
    JSON.stringify(res.postTokenAccounts ?? []),
    // bigint deltas are stringified: a token amount through JSON.stringify's
    // default number path would round past 2^53 and look fine doing it.
    JSON.stringify(
      v.tokenDeltas.map((d) => ({
        owner: d.owner,
        mint: d.mint,
        tokenProgram: d.tokenProgram,
        accounts: d.accounts,
        preAtoms: d.preAtoms === null ? null : d.preAtoms.toString(),
        postAtoms: d.postAtoms === null ? null : d.postAtoms.toString(),
        delta: d.delta === null ? null : d.delta.toString(),
        created: d.created,
        closed: d.closed,
      })),
    ),
    JSON.stringify(res.createdAccounts),
    JSON.stringify(res.closedAccounts),
    jobId,
  );
}
