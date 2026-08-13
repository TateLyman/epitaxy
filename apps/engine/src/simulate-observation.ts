import type { Db } from '../../../packages/storage/src/db.js';
import { BlobStore, type ExactTransactionBlob } from '../../../packages/storage/src/blobstore.js';
import {
  recordSimulationRequested,
  recordSimulationResult,
  markSimulationUnknown,
  cachedSimulation,
  JobHashConflict,
  recordSimulationEffect,
} from '../../../packages/storage/src/simulation-repo.js';
import { verifyEffect } from '../../../packages/simulator/src/effect.js';
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
  | {
      readonly kind: 'ok';
      readonly status: string;
      readonly confirmatory: boolean;
      readonly reasons: readonly string[];
      /** P3 -- whether the run's ECONOMIC effect held, not merely its runtime. */
      readonly effectOk: boolean;
      readonly effectRefusals: readonly string[];
    }
  | { readonly kind: 'cached'; readonly status: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'skipped'; readonly reason: string };

/**
 * The economic leg a simulation is about.
 *
 * P2. The previous version described no leg at all: `requestedAmount` was the
 * string '0' and the only balance mutation was SOL, whatever the transaction
 * actually spent. Buys therefore worked and EVERY sell failed — 43 of 43, all
 * with the identical error at the identical instruction index — because the
 * simulator was asked to sell an asset it had never been given.
 *
 * That is not a route failure and not a fact about any token. It is the
 * instrument measuring itself.
 *
 * A leg now says which asset it spends, how much of it, and under which token
 * program, so the setup can fund the thing the transaction will actually debit.
 */
export interface SimulateOptions {
  readonly mode: SimulationMode;
  readonly side: 'buy' | 'sell';
  readonly inputMint: string;
  readonly outputMint: string;
  /** Exact input amount. Never zero: a leg that spends nothing is not a leg. */
  readonly inputAmount: bigint;
  /** Token program of the INPUT asset, when the input is a token. */
  readonly inputTokenProgram?: string | null;
  readonly outputTokenProgram?: string | null;
  /** Enough SOL for fees, rent and (on a buy) the input itself. */
  readonly fundingLamports: bigint;
  readonly maxLamportsSpent: bigint;
  /** What the route said it would return. Used as an economic bound. */
  readonly expectedOutput?: bigint | null;
  readonly minimumOutput?: bigint | null;
  readonly contextHash: string | null;
}

/** Wrapped SOL, which is an input a buy spends as lamports rather than tokens. */
const WSOL = 'So11111111111111111111111111111111111111112';

export class InvalidSimulationSetup extends Error {
  constructor(reason: string) {
    super(
      `refusing to simulate: ${reason}. A run whose setup does not match the leg cannot fail for a reason ` +
        'that means anything, and its result would be recorded as if it did.',
    );
    this.name = 'InvalidSimulationSetup';
  }
}

/**
 * Check the setup describes the leg BEFORE anything is sent.
 *
 * Fails here rather than at runtime, because a runtime failure is recorded as a
 * simulation outcome and this is not one — it is a caller defect. The 43 sells
 * would every one of them have been refused here.
 */
export function validateSetup(opts: SimulateOptions): void {
  if (opts.inputAmount <= 0n) throw new InvalidSimulationSetup('the input amount is zero');
  if (opts.inputMint === opts.outputMint) throw new InvalidSimulationSetup('input and output mints are the same');
  const spendsToken = opts.inputMint !== WSOL;
  if (spendsToken && (opts.inputTokenProgram ?? null) === null) {
    throw new InvalidSimulationSetup(
      `a ${opts.side} spending ${opts.inputMint.slice(0, 8)} needs its token program, or the inventory cannot be provisioned`,
    );
  }
  if (opts.side === 'sell' && !spendsToken) {
    throw new InvalidSimulationSetup('a sell whose input is SOL is not a sell');
  }
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

  // P2 — refuse a setup that does not describe the leg, before sending it.
  try {
    validateSetup(opts);
  } catch (e) {
    recordHealth(db, 'simulation_setup_invalid', 'critical', `${observationId}: ${(e as Error).message}`);
    return { kind: 'skipped', reason: (e as Error).message };
  }

  // Provision the asset the transaction will actually DEBIT.
  //
  // A buy spends lamports, so SOL funding is the whole story. A sell spends
  // tokens, and funding it with SOL alone is what produced 43 identical
  // failures: the token account existed with a zero balance, and the venue
  // rejected the transfer at the same instruction every time.
  const spendsToken = opts.inputMint !== WSOL;
  const mutations: { kind: 'sol' | 'token'; owner: string; mint?: string; amount: string; tokenProgram?: string | null }[] =
    [{ kind: 'sol', owner: taker, amount: opts.fundingLamports.toString() }];
  if (spendsToken) {
    mutations.push({
      kind: 'token',
      owner: taker,
      mint: opts.inputMint,
      // EXACTLY the hypothetical position. Funding more would let a sell
      // succeed that the real balance could not cover; funding less would fail
      // for a reason that is ours again.
      amount: opts.inputAmount.toString(),
      tokenProgram: opts.inputTokenProgram ?? null,
    });
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
    // The exact input. Zero described no leg and made every bound vacuous.
    requestedAmount: opts.inputAmount.toString(),
    // JIT fetches its own state, so there is nothing frozen to name. A
    // confirmatory run would carry a real manifest and a real snapshot.
    targetSlot: blob.contextSlot,
    snapshotManifestHash: opts.mode === 'DEVELOPMENT_JIT' ? 'jit-no-frozen-snapshot' : blob.transactionHash,
    snapshotAccounts: [],
    balanceMutations: mutations,
    bounds: {
      feePayer: taker,
      maxLamportsSpent: opts.maxLamportsSpent.toString(),
      // The output side of the bound, so a run that executes but delivers
      // nothing is caught. Absent when the route did not state a minimum.
      ...(opts.minimumOutput !== undefined && opts.minimumOutput !== null && opts.minimumOutput > 0n
        ? { mint: opts.outputMint, minTokenDelta: opts.minimumOutput.toString() }
        : {}),
    },
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

    // P3 -- what the run actually DID, which the runtime status never said.
    //
    // Computed for every completed job, including failures, because a failure
    // whose effect was never examined cannot be distinguished later from one
    // nobody looked at.
    const verdict = verifyEffect(request, res, {
      taker,
      side: opts.side,
      inputMint: opts.inputMint,
      outputMint: opts.outputMint,
      // P2 -- naming the programs turns a near-enough match into an assertion.
      // An owner can hold one mint under both legacy Token and Token-2022, and
      // adding those together is a balance in an asset that does not exist.
      inputTokenProgram: opts.inputTokenProgram ?? null,
      outputTokenProgram: opts.outputTokenProgram ?? null,
    });
    recordSimulationEffect(db, request.jobId, verdict, res);

    // A DEVELOPMENT_JIT run that succeeded is a real execution result and is
    // written as one. It is still not confirmatory, and `confirmatory` says so
    // in its own column rather than being inferred later from the mode.
    updateObservationSimulation(db, observationId, res.status, res.detail, verdict);

    return {
      kind: 'ok',
      status: res.status,
      confirmatory: confirmatory.ok,
      reasons: confirmatory.reasons,
      effectOk: verdict.simulatedEffectOk,
      effectRefusals: verdict.refusals,
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
export function updateObservationSimulation(
  db: Db,
  observationId: string,
  status: string,
  detail: string,
  verdict?: { simulatedEffectOk: boolean; refusals: readonly string[] },
): void {
  const mapped =
    status === 'SIMULATED_OK' ? 'SIMULATED_OK' : status === 'SIMULATION_FAILED' ? 'SIMULATION_FAILURE' : null;
  if (mapped === null) return;
  // P3 -- absent verdict stays NOT_VERIFIED. A caller that did not check does
  // not get to leave the row looking as though the check passed.
  const effect =
    verdict === undefined ? 'NOT_VERIFIED' : verdict.simulatedEffectOk ? 'SIMULATED_EFFECT_OK' : 'EFFECT_REFUSED';
  db.prepare(
    `UPDATE execution_observations
     SET simulation = ?, simulation_detail = ?, simulation_effect = ?, simulation_effect_refusals = ?
     WHERE observation_id = ? AND simulation = 'NOT_SIMULATED'`,
  ).run(
    mapped === 'SIMULATION_FAILURE' ? 'SIMULATION_FAILED' : 'SIMULATED_OK',
    detail.slice(0, 1000),
    effect,
    verdict === undefined || verdict.refusals.length === 0 ? null : JSON.stringify(verdict.refusals).slice(0, 2000),
    observationId,
  );
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

/**
 * The exact-transaction blob an observation was stored with.
 *
 * Read back from the row rather than threaded through observeRoute's return
 * type, which a dozen call sites share. Null means no bytes were captured,
 * which is the condition that must stop the leg being simulated at all.
 */
export function exactBlobFor(db: Db, observationId: string): string | null {
  const r = db
    .prepare('SELECT exact_transaction_blob AS b FROM execution_observations WHERE observation_id = ?')
    .get(observationId) as { b: string | null } | undefined;
  return r?.b ?? null;
}

/**
 * Simulate a leg and report whether it may be filled.
 *
 * The one rule: an unavailable simulator NEVER makes a leg unfillable for a
 * reason attributed to the token. It makes it unfillable for a reason
 * attributed to us, and the caller must be able to tell those apart.
 */
export async function simulateLeg(
  db: Db,
  blobs: BlobStore,
  client: SimulationClient | null,
  observationId: string,
  taker: string,
  opts: SimulateOptions,
): Promise<{ simulated: boolean; attempt: SimulationAttempt | null }> {
  if (client === null) return { simulated: false, attempt: null };
  const blobHash = exactBlobFor(db, observationId);
  const attempt = await simulateObservation(db, blobs, client, observationId, blobHash, taker, opts);
  return { simulated: attempt.kind === 'ok' && attempt.status === 'SIMULATED_OK', attempt };
}
