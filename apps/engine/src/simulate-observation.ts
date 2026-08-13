import type { Db } from '../../../packages/storage/src/db.js';
import { BlobStore, type ExactTransactionBlob } from '../../../packages/storage/src/blobstore.js';
import {
  recordSimulationRequested,
  recordSimulationResult,
  markSimulationUnknown,
  cachedSimulation,
  JobHashConflict,
} from '../../../packages/storage/src/simulation-repo.js';
import {
  SimulationClient,
  SimulatorUnavailable,
  responseIsConfirmatory,
  IdentityMismatch,
} from '../../../packages/simulator/src/client.js';
import type { SimulationMode } from '../../../packages/simulator/src/protocol.js';
import { recordHealth } from '../../../packages/storage/src/repo.js';

/**
 * §9 — send one observation to the simulator, durably.
 *
 * The ordering is the whole design. `SIMULATION_REQUESTED` is written BEFORE
 * the request leaves, so a crash between send and reply leaves a row saying a
 * job was in flight rather than silence. A row stuck in REQUESTED is a known
 * unknown and can be reconciled by job id; a missing row is an unknown unknown
 * and cannot be reconciled by anything.
 *
 * The other half is what a failure means. A simulator that is down, out of
 * date, or returning something this engine cannot interpret is a fact about our
 * infrastructure. Writing that onto the observation as a route failure would
 * poison the corpus with our own outages — which this project has already done
 * once with provider errors, and spent a window discovering.
 */

export type SimulationAttempt =
  | { readonly kind: 'ok'; readonly status: string; readonly confirmatory: boolean; readonly reasons: readonly string[] }
  | { readonly kind: 'cached'; readonly status: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'skipped'; readonly reason: string };

export interface SimulateOptions {
  readonly mode: SimulationMode;
  /** Hypothetical SOL to fund the taker with inside the throwaway SVM. */
  readonly fundingLamports: bigint;
  readonly maxLamportsSpent: bigint;
  readonly contextHash: string | null;
}

/**
 * Simulate the exact bytes an observation was checked against.
 *
 * Returns rather than throws for every expected condition, because a caller in
 * the mark loop must be able to carry on. The only things that escape are
 * defects: a job id reused with different bytes, or a blob store that returns
 * content which is not what its key claims.
 */
export async function simulateObservation(
  db: Db,
  blobs: BlobStore,
  client: SimulationClient,
  observationId: string,
  exactTransactionBlobHash: string | null,
  taker: string,
  opts: SimulateOptions,
): Promise<SimulationAttempt> {
  // No bytes, nothing to simulate. This is not a failure of the route and is
  // not written as one.
  if (exactTransactionBlobHash === null) {
    return { kind: 'skipped', reason: 'no exact transaction was captured for this observation' };
  }

  let blob: ExactTransactionBlob;
  try {
    blob = blobs.get<ExactTransactionBlob>(exactTransactionBlobHash);
  } catch (e) {
    // A referenced blob that is missing or corrupt is a storage defect, not a
    // simulator one. It must be visible rather than retried into silence.
    recordHealth(
      db,
      'exact_transaction_blob_unreadable',
      'critical',
      `${observationId}: ${(e as Error).message}`,
    );
    return { kind: 'skipped', reason: `exact transaction blob unreadable: ${(e as Error).message}` };
  }

  const request = client.buildRequest({
    executionObservationId: observationId,
    mode: opts.mode,
    transactionBase64: blob.transactionBase64,
    originalTransactionHash: blob.transactionHash,
    originalMessageHash: blob.messageHash,
    originalBlockhash: blob.blockhash,
    originalLastValidBlockHeight: blob.lastValidBlockHeight,
    routeFamily: 'BUILD_CUSTOM',
    requestedAmount: '0',
    // JIT fetches its own state, so there is nothing frozen to name. A
    // confirmatory run would carry a real manifest and a real snapshot.
    targetSlot: blob.contextSlot,
    snapshotManifestHash: opts.mode === 'DEVELOPMENT_JIT' ? 'jit-no-frozen-snapshot' : blob.transactionHash,
    snapshotAccounts: [],
    balanceMutations: [{ kind: 'sol', owner: taker, amount: opts.fundingLamports.toString() }],
    bounds: { feePayer: taker, maxLamportsSpent: opts.maxLamportsSpent.toString() },
    contextHash: opts.contextHash,
  });

  // Already answered? The job id is derived from the request hash, so a repeat
  // of identical work is the same job and is served from the durable record
  // rather than re-run.
  const prior = cachedSimulation(db, request.jobId, request.requestHash);
  if (prior !== null) return { kind: 'cached', status: prior.status };

  // BEFORE the network call. This is the line that makes a crash recoverable.
  try {
    recordSimulationRequested(db, request, Date.now(), opts.contextHash);
  } catch (e) {
    if (e instanceof JobHashConflict) throw e;
    throw e;
  }

  try {
    const res = await client.simulate(request);

    // §9.5 — the observation is only updated when every identity matches. The
    // client already refuses a mismatched job id, request hash or snapshot; this
    // is the belt to that brace, and it exists because the cost of accepting
    // someone else's result is a row that looks measured and is not.
    if (res.jobId !== request.jobId || res.requestHash !== request.requestHash) {
      markSimulationUnknown(db, request.jobId, Date.now(), 'the daemon answered about a different job');
      return { kind: 'unavailable', reason: 'response identity mismatch' };
    }

    const confirmatory = responseIsConfirmatory(res, opts.mode);
    recordSimulationResult(db, res, confirmatory, Date.now());

    // A DEVELOPMENT_JIT run that succeeded is a real execution result and is
    // written as one. It is still not confirmatory, and `confirmatory` says so
    // in its own column rather than being inferred later from the mode.
    updateObservationSimulation(db, observationId, res.status, res.detail);

    return {
      kind: 'ok',
      status: res.status,
      confirmatory: confirmatory.ok,
      reasons: confirmatory.reasons,
    };
  } catch (e) {
    const reason = e instanceof IdentityMismatch ? `identity: ${e.message}` : (e as Error).message;
    // UNKNOWN, not FAILED. We do not know whether it ran, and a simulation whose
    // outcome is unknown is not a simulation that failed.
    markSimulationUnknown(db, request.jobId, Date.now(), reason.slice(0, 300));
    if (e instanceof SimulatorUnavailable || e instanceof IdentityMismatch) {
      recordHealth(db, 'simulator_unavailable', 'warn', reason.slice(0, 200));
      return { kind: 'unavailable', reason };
    }
    throw e;
  }
}

/**
 * Write the simulation outcome onto the observation.
 *
 * Only ever moves a row from NOT_SIMULATED to a real outcome. A simulator
 * outage leaves the row exactly as it was, because "we could not check" is not
 * a property of the route.
 */
export function updateObservationSimulation(db: Db, observationId: string, status: string, detail: string): void {
  const mapped =
    status === 'SIMULATED_OK' ? 'SIMULATED_OK' : status === 'SIMULATION_FAILED' ? 'SIMULATION_FAILURE' : null;
  if (mapped === null) return;
  db.prepare(
    `UPDATE execution_observations
     SET simulation = ?, simulation_detail = ?
     WHERE observation_id = ? AND simulation = 'NOT_SIMULATED'`,
  ).run(mapped === 'SIMULATION_FAILURE' ? 'SIMULATION_FAILED' : 'SIMULATED_OK', detail.slice(0, 1000), observationId);
}

export interface SimulatorHealth {
  readonly reachable: boolean;
  readonly identityMatch: boolean;
  readonly queueDepth: number;
  readonly lastSuccessUtcMs: number | null;
  readonly parityStatus: string;
  readonly snapshotFreezeStatus: string;
  readonly detail: string;
}

/**
 * §9 — the health surface, answered by asking rather than by assuming.
 *
 * `parityStatus` and `snapshotFreezeStatus` are deliberately blunt strings and
 * deliberately pessimistic: until execution parity is established and snapshots
 * are frozen, no amount of green elsewhere makes a run confirmatory.
 */
export async function simulatorHealth(db: Db, client: SimulationClient): Promise<SimulatorHealth> {
  try {
    const h = (await client.health()) as { ok: boolean; queued?: number; active?: number };
    let identityMatch = false;
    let detail = '';
    try {
      await client.identity();
      identityMatch = true;
    } catch (e) {
      detail = (e as Error).message.slice(0, 200);
    }
    const row = db
      .prepare(
        `SELECT MAX(completed_utc_ms) AS t FROM simulation_jobs WHERE status = 'SIMULATED_OK'`,
      )
      .get() as { t: number | null } | undefined;
    return {
      reachable: h.ok === true,
      identityMatch,
      queueDepth: Number(h.queued ?? 0) + Number(h.active ?? 0),
      lastSuccessUtcMs: row?.t ?? null,
      parityStatus: 'EXECUTION_PARITY_NOT_ESTABLISHED',
      snapshotFreezeStatus: 'NO_FROZEN_SNAPSHOTS',
      detail,
    };
  } catch (e) {
    return {
      reachable: false,
      identityMatch: false,
      queueDepth: 0,
      lastSuccessUtcMs: null,
      parityStatus: 'EXECUTION_PARITY_NOT_ESTABLISHED',
      snapshotFreezeStatus: 'NO_FROZEN_SNAPSHOTS',
      detail: (e as Error).message.slice(0, 200),
    };
  }
}
