import type { Db } from '../../storage/src/db.js';
import {
  EvidenceStore,
  appendOnly,
  expectRows,
  recordTransition,
} from '../../storage/src/evidence-repo.js';
import { computeSnapshotHash } from '../../solana/src/coherent-snapshot.js';
import type { ObservedAccount } from './leg-settlement.js';

/**
 * P2.4 / P2.5 — PERSIST BEFORE EXECUTION, AND OPEN ATOMICALLY.
 *
 * The 8f73cef audit's C-4: the buy and sell pre/post account sets existed only
 * inside the worker process and were reduced to the aggregate columns of
 * `trajectory_settlements` before anything was persisted. `entry_cash_out`,
 * `exit_cash_in`, rent and the venue skim were each recorded exactly once and
 * were UNFALSIFIABLE FROM THE DATABASE — the condition the directive requires
 * to be impossible.
 *
 * This module is the writer that makes it possible. Every raw account state
 * goes to the content-addressed blob store, is read back and re-hashed, and is
 * linked by (job, step, leg, address) with ABSENT represented explicitly on
 * both sides.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE:
 *
 *   1. blobs written and READ BACK
 *   2. snapshot row
 *   3. observation rows
 *   4. worker job + steps, progressing through named states
 *   5. account manifests
 *   6. leg settlements
 *   7. the link row, whose foreign keys refuse if any of the above is missing
 *   8. the trajectory becomes OPEN
 *
 * Step 7 is the load-bearing one. `trajectory_evidence_links` declares a real
 * foreign key on every identifier, so SQLite refuses the insert if anything
 * dangles. The 292 legacy rows cannot be represented here at all.
 */

export const SIMULATION_STEP_STATES = [
  'REQUESTED',
  'RUNTIME_RETURNED',
  'RAW_STATE_DURABLE',
  'EFFECT_VERIFIED',
  'SETTLEMENT_DERIVED',
  'COMPLETE',
] as const;

export type SimulationStepState = (typeof SIMULATION_STEP_STATES)[number] | 'FAILED';

export class EvidenceGraphIncomplete extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `the evidence graph is incomplete and the trajectory may not open: ${missing.join('; ')}. ` +
        'A trajectory whose evidence does not resolve is a row pointing at nothing, which is the ' +
        'condition 0 of 292 pre-repair rows were in.',
    );
    this.name = 'EvidenceGraphIncomplete';
  }
}

/** One account, on one side of one leg. ABSENT is a value, not a missing row. */
export interface AccountSideState {
  readonly address: string;
  readonly role: string;
  readonly writable: boolean;
  readonly keySource: 'STATIC' | 'ALT_LOADED' | 'SYSVAR' | 'DERIVED';
  readonly pre: ObservedAccount | null;
  readonly post: ObservedAccount | null;
}

/**
 * P3.2 — pair a leg's pre and post observations by address.
 *
 * An account that appears only in `post` was CREATED by the leg: its pre state
 * is ABSENT, which is a measurement, not a gap. One that appears only in `pre`
 * was CLOSED: its post state is ABSENT. Neither is silently added to the
 * unobserved set — that conflation is what let 292 of 292 trajectories settle
 * while carrying an unmeasured lamport flow.
 */
export function pairLegAccounts(
  pre: readonly ObservedAccount[],
  post: readonly ObservedAccount[],
  roles: Readonly<Record<string, string>>,
  writable: ReadonlySet<string>,
  altLoaded: ReadonlySet<string> = new Set(),
): AccountSideState[] {
  const byAddress = new Map<string, { pre: ObservedAccount | null; post: ObservedAccount | null }>();
  for (const a of pre) byAddress.set(a.pubkey, { pre: a, post: null });
  for (const a of post) {
    const e = byAddress.get(a.pubkey);
    if (e === undefined) byAddress.set(a.pubkey, { pre: null, post: a });
    else byAddress.set(a.pubkey, { pre: e.pre, post: a });
  }
  return [...byAddress.entries()]
    .map(([address, sides]) => ({
      address,
      role: roles[address] ?? 'UNCLASSIFIED',
      writable: writable.has(address),
      keySource: (altLoaded.has(address) ? 'ALT_LOADED' : 'STATIC') as AccountSideState['keySource'],
      pre: sides.pre,
      post: sides.post,
    }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

/**
 * Every writable that was not observed on BOTH sides.
 *
 * G-2: 292 of 292 trajectories carried at least one, and 275 of them were
 * SETTLED. An unobserved writable is a lamport flow nobody measured, and it is
 * precisely what reappears as the unexplained remainder.
 *
 * An ABSENT side counts as OBSERVED. An account that did not exist cannot be
 * read, and calling that missing coverage confuses an impossibility with an
 * omission.
 */
export function unobservedWritables(
  states: readonly AccountSideState[],
  declaredUnobserved: readonly string[],
): string[] {
  const unobserved = new Set(declaredUnobserved);
  return states
    .filter((s) => s.writable && unobserved.has(s.address))
    .map((s) => s.address);
}

export interface PersistedLeg {
  readonly leg: 'buy' | 'sell';
  readonly stepIndex: number;
  readonly observationId: string;
  readonly transactionBase64: string;
  readonly accountStates: readonly AccountSideState[];
  readonly declaredUnobserved: readonly string[];
  readonly runtimeOk: boolean;
  readonly effectOk: boolean;
  readonly unitsConsumed: number | null;
  readonly transactionError: string | null;
  readonly mint: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly requestedAmount: bigint;
}

export interface PersistEvidenceRequest {
  readonly trajectoryId: string;
  readonly evidenceContextId: string;
  readonly reservationId: string;
  readonly jobId: string;
  readonly canonicalRequest: unknown;
  readonly workerResponse: unknown;
  readonly snapshot: {
    readonly hash: string;
    readonly slot: number;
    readonly capturedUtcMs: number;
    readonly mint: string;
    readonly pool: string;
    /** The ordered (pubkey, hash) rows the snapshot hash was computed over. */
    readonly manifest: readonly { pubkey: string; hash: string }[];
    readonly clock: unknown;
    readonly rent: unknown;
    readonly epochSchedule: unknown;
    readonly feeConfigHash: string | null;
    readonly capabilityFingerprint: string;
    readonly programDataHashes: Readonly<Record<string, string>>;
    readonly sdkVersions: Readonly<Record<string, string>>;
    readonly workerBinaryHash: string | null;
  };
  readonly accountPlanHash: string;
  readonly selectedTier: string | null;
  readonly legs: readonly PersistedLeg[];
  readonly endpoint: string;
  readonly nowMs: number;
}

export interface PersistedEvidence {
  readonly blobCount: number;
  readonly manifestRows: number;
  readonly unobservedWritables: readonly string[];
  readonly rawStateDurable: boolean;
  readonly legBlobs: Readonly<Record<string, { transaction: string }>>;
}

/**
 * Write the whole entry (and, when it ran, exit) evidence graph.
 *
 * Returns what was written and whether the raw state is durable, which is an
 * input to `isPnlEligible` and must be established by reading the store rather
 * than by the write having returned.
 */
export function persistEvidence(db: Db, store: EvidenceStore, req: PersistEvidenceRequest): PersistedEvidence {
  const now = req.nowMs;

  // ---- 1. BLOBS, written and read back ------------------------------------
  //
  // Outside the transaction on purpose: a blob is content-addressed and
  // idempotent, so writing one twice is harmless, while holding a write
  // transaction open across filesystem IO on a 7 GB WAL database is not.
  const blobs = new Set<string>();
  const track = (h: string): string => {
    blobs.add(h);
    return h;
  };

  const manifestBlob = track(store.putDurable('snapshot_manifest', req.snapshot.manifest, now));
  const requestBlob = track(store.putDurable('worker_request', req.canonicalRequest, now));
  const responseBlob = track(store.putDurable('worker_response', req.workerResponse, now));

  const legBlobs: Record<string, { transaction: string }> = {};
  const accountBlobs = new Map<string, { pre: string | null; post: string | null }>();
  for (const leg of req.legs) {
    legBlobs[leg.leg] = { transaction: track(store.putDurable('exact_transaction', leg.transactionBase64, now)) };
    for (const s of leg.accountStates) {
      accountBlobs.set(`${leg.leg}|${s.address}`, {
        pre: s.pre === null ? null : track(store.putDurable('account_state', s.pre, now)),
        post: s.post === null ? null : track(store.putDurable('account_state', s.post, now)),
      });
    }
  }

  /**
   * The snapshot hash must be the hash OF THIS MANIFEST.
   *
   * Recomputed rather than trusted: a caller that passed a slot number would
   * otherwise write it, which is exactly what 292 pre-repair rows did.
   *
   * With `computeSnapshotHash` — the SAME function that produced the value —
   * not a parallel implementation. A verifier with its own definition of the
   * hash verifies nothing except that two functions disagree, which is how the
   * first real trajectory refused with a mismatch between two correct answers
   * to different questions.
   */
  const recomputed = computeSnapshotHash(
    req.snapshot.manifest,
    req.snapshot.clock as never,
    req.snapshot.rent as never,
    req.snapshot.epochSchedule as never,
  );
  if (recomputed !== req.snapshot.hash) {
    throw new EvidenceGraphIncomplete([
      `snapshot_hash ${req.snapshot.hash.slice(0, 16)} is not the hash of the manifest it names ` +
        `(${recomputed.slice(0, 16)})`,
    ]);
  }

  // ---- 2..7. ONE TRANSACTION ----------------------------------------------
  db.exec('BEGIN IMMEDIATE');
  try {
    // 2 — the coherent snapshot. The table's own triggers refuse a slot number.
    appendOnly(db, {
      entity: 'coherent_snapshots',
      key: req.snapshot.hash,
      nowMs: now,
      content: {
        slot: req.snapshot.slot,
        mint: req.snapshot.mint,
        pool: req.snapshot.pool,
        manifest: manifestBlob,
        capabilityFingerprint: req.snapshot.capabilityFingerprint,
      },
      readExisting: () => {
        const r = db
          .prepare(
            `SELECT slot, mint, pool, manifest_blob_sha256 AS manifest, capability_fingerprint AS cf
               FROM coherent_snapshots WHERE snapshot_hash = ?`,
          )
          .get(req.snapshot.hash) as
          | { slot: number; mint: string; pool: string; manifest: string; cf: string }
          | undefined;
        return r === undefined
          ? null
          : { slot: r.slot, mint: r.mint, pool: r.pool, manifest: r.manifest, capabilityFingerprint: r.cf };
      },
      insert: () =>
        Number(
          db
            .prepare(
              `INSERT INTO coherent_snapshots
                 (snapshot_hash, slot, captured_utc_ms, mint, pool, manifest_blob_sha256, account_count,
                  fee_config_hash, capability_fingerprint, programdata_hashes, sdk_versions, worker_binary_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              req.snapshot.hash,
              req.snapshot.slot,
              req.snapshot.capturedUtcMs,
              req.snapshot.mint,
              req.snapshot.pool,
              manifestBlob,
              req.snapshot.manifest.length,
              req.snapshot.feeConfigHash,
              req.snapshot.capabilityFingerprint,
              JSON.stringify(req.snapshot.programDataHashes),
              JSON.stringify(req.snapshot.sdkVersions),
              req.snapshot.workerBinaryHash,
            ).changes,
        ),
    });

    // 3 — the worker job, as REQUESTED first. The row exists before the run.
    const jobExists =
      db.prepare('SELECT 1 AS x FROM simulation_jobs WHERE job_id = ?').get(req.jobId) !== undefined;
    if (!jobExists) {
      expectRows(
        'inserting the simulation job',
        1,
        db
          .prepare(
            `INSERT INTO simulation_jobs
               (job_id, request_hash, mode, status, requested_utc_ms, completed_utc_ms,
                snapshot_manifest_hash, protocol_version, validity, context_hash)
             VALUES (?, ?, 'SEQUENTIAL_RUNTIME', 'SIMULATION_REQUESTED', ?, NULL, ?, NULL, ?, ?)`,
          )
          .run(req.jobId, req.jobId.replace(/^job-/, ''), now, req.snapshot.hash, 'VALID_DEVELOPMENT', req.evidenceContextId)
          .changes,
      );
    }

    // 4 — observations and steps.
    const allUnobserved: string[] = [];
    for (const leg of req.legs) {
      appendOnly(db, {
        entity: 'execution_observations',
        key: leg.observationId,
        nowMs: now,
        content: {
          mint: leg.mint,
          side: leg.leg,
          requested: leg.requestedAmount.toString(),
          transaction: legBlobs[leg.leg]?.transaction ?? '',
        },
        readExisting: () => {
          const r = db
            .prepare(
              `SELECT mint, side, requested_amount AS requested, exact_transaction_blob AS transaction
                 FROM execution_observations WHERE observation_id = ?`,
            )
            .get(leg.observationId) as
            | { mint: string; side: string; requested: string; transaction: string | null }
            | undefined;
          return r === undefined
            ? null
            : { mint: r.mint, side: r.side, requested: r.requested, transaction: r.transaction ?? '' };
        },
        insert: () =>
          Number(
            db
              .prepare(
                `INSERT INTO execution_observations
                   (observation_id, family, mint, side, purpose, input_mint, output_mint, requested_amount,
                    endpoint, instruction_policy, transaction_policy, simulation, simulation_effect,
                    requested_utc_ms, received_utc_ms, context_hash, exact_transaction_blob)
                 VALUES (?, 'DIRECT_VENUE', ?, ?, ?, ?, ?, ?, ?, 'PASS', 'PASS', ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                leg.observationId,
                leg.mint,
                leg.leg,
                leg.leg === 'buy' ? 'DIRECT_VENUE_ENTRY' : 'DIRECT_VENUE_EXIT',
                leg.inputMint,
                leg.outputMint,
                leg.requestedAmount.toString(),
                req.endpoint,
                leg.runtimeOk ? 'SIMULATED_OK' : 'SIMULATION_FAILED',
                leg.effectOk ? 'SIMULATED_EFFECT_OK' : 'EFFECT_REFUSED',
                now,
                now,
                req.evidenceContextId,
                legBlobs[leg.leg]?.transaction ?? null,
              ).changes,
          ),
      });

      appendOnly(db, {
        entity: 'simulation_steps',
        key: `${req.jobId}#${leg.stepIndex}`,
        nowMs: now,
        content: {
          leg: leg.leg,
          observation: leg.observationId,
          transaction: legBlobs[leg.leg]?.transaction ?? '',
        },
        readExisting: () => {
          const r = db
            .prepare(
              `SELECT leg, observation_id AS obs, transaction_blob_sha256 AS tx
                 FROM simulation_steps WHERE job_id = ? AND step_index = ?`,
            )
            .get(req.jobId, leg.stepIndex) as { leg: string; obs: string | null; tx: string } | undefined;
          return r === undefined ? null : { leg: r.leg, observation: r.obs ?? '', transaction: r.tx };
        },
        insert: () =>
          Number(
            db
              .prepare(
                `INSERT INTO simulation_steps
                   (job_id, step_index, leg, observation_id, transaction_blob_sha256, request_blob_sha256,
                    response_blob_sha256, status, runtime_ok, effect_ok, units_consumed, transaction_error,
                    started_utc_ms, completed_utc_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNTIME_RETURNED', ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                req.jobId,
                leg.stepIndex,
                leg.leg,
                leg.observationId,
                legBlobs[leg.leg]?.transaction ?? '',
                requestBlob,
                responseBlob,
                leg.runtimeOk ? 1 : 0,
                leg.effectOk ? 1 : 0,
                leg.unitsConsumed,
                leg.transactionError,
                now,
                now,
              ).changes,
          ),
      });

      // 5 — the account manifests. ABSENT on either side is explicit.
      for (const s of leg.accountStates) {
        const b = accountBlobs.get(`${leg.leg}|${s.address}`) ?? { pre: null, post: null };
        const existing = db
          .prepare(
            `SELECT 1 AS x FROM account_state_manifests
              WHERE job_id = ? AND step_index = ? AND leg = ? AND address = ?`,
          )
          .get(req.jobId, leg.stepIndex, leg.leg, s.address);
        if (existing !== undefined) continue;
        expectRows(
          `inserting the account manifest for ${s.address}`,
          1,
          db
            .prepare(
              `INSERT INTO account_state_manifests
                 (manifest_id, job_id, step_index, leg, address, role, writable, key_source,
                  pre_state, post_state, pre_blob_sha256, post_blob_sha256, pre_lamports, post_lamports,
                  recorded_utc_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              `asm-${req.jobId}-${leg.stepIndex}-${leg.leg}-${s.address}`.slice(0, 190),
              req.jobId,
              leg.stepIndex,
              leg.leg,
              s.address,
              s.role,
              s.writable ? 1 : 0,
              s.keySource,
              s.pre === null ? 'ABSENT' : 'PRESENT',
              s.post === null ? 'ABSENT' : 'PRESENT',
              b.pre,
              b.post,
              s.pre === null ? null : s.pre.lamports.toString(),
              s.post === null ? null : s.post.lamports.toString(),
              now,
            ).changes,
        );
      }

      allUnobserved.push(...unobservedWritables(leg.accountStates, leg.declaredUnobserved));

      db.prepare(
        `UPDATE simulation_steps SET status = 'RAW_STATE_DURABLE' WHERE job_id = ? AND step_index = ?`,
      ).run(req.jobId, leg.stepIndex);
      recordTransition(db, {
        entity: 'simulation_steps',
        key: `${req.jobId}#${leg.stepIndex}`,
        from: 'RUNTIME_RETURNED',
        to: 'RAW_STATE_DURABLE',
        content: { accounts: leg.accountStates.length },
        nowMs: now,
      });
    }

    db.prepare(`UPDATE simulation_jobs SET status = 'SIMULATED_OK', completed_utc_ms = ? WHERE job_id = ?`).run(
      now,
      req.jobId,
    );

    db.exec('COMMIT');

    // Durability is established by READING the store back, not by the writes
    // having returned. `putDurable` already round-tripped each blob; this
    // re-checks against the registry so a blob that was never marked verified
    // cannot pass.
    const durable = [...blobs].every((h) => store.isDurable(h));

    return {
      blobCount: blobs.size,
      manifestRows: req.legs.reduce((n, l) => n + l.accountStates.length, 0),
      unobservedWritables: [...new Set(allUnobserved)],
      rawStateDurable: durable,
      legBlobs,
    };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already unwound */
    }
    throw e;
  }
}

/**
 * P2.3 — the link row, whose foreign keys are the whole point.
 *
 * Written LAST and inside the same transaction as the trajectory's transition
 * to OPEN. If any identifier does not resolve, SQLite refuses and the
 * trajectory does not open — which is the difference between this build and one
 * where 0 of 292 links resolved and every row opened anyway.
 */
export function linkTrajectoryEvidence(
  db: Db,
  link: {
    readonly trajectoryId: string;
    readonly evidenceContextId: string;
    readonly reservationId: string;
    readonly snapshotHash: string;
    readonly capabilityFingerprint: string;
    readonly accountPlanHash: string;
    readonly feeConfigHash: string | null;
    readonly selectedTier: string | null;
    readonly entryObservationId: string;
    readonly entryJobId: string;
    readonly entryStepIndex: number;
    readonly entrySettlementId: string;
    readonly exitObservationId: string | null;
    readonly exitJobId: string | null;
    readonly exitStepIndex: number | null;
    readonly exitSettlementId: string | null;
    readonly nowMs: number;
  },
): void {
  expectRows(
    'linking the trajectory evidence',
    1,
    db
      .prepare(
        `INSERT INTO trajectory_evidence_links
           (trajectory_id, evidence_context_id, reservation_id, snapshot_hash, capability_fingerprint,
            account_plan_hash, fee_config_hash, selected_tier,
            entry_observation_id, entry_job_id, entry_step_index, entry_settlement_id,
            exit_observation_id, exit_job_id, exit_step_index, exit_settlement_id, linked_utc_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        link.trajectoryId,
        link.evidenceContextId,
        link.reservationId,
        link.snapshotHash,
        link.capabilityFingerprint,
        link.accountPlanHash,
        link.feeConfigHash,
        link.selectedTier,
        link.entryObservationId,
        link.entryJobId,
        link.entryStepIndex,
        link.entrySettlementId,
        link.exitObservationId,
        link.exitJobId,
        link.exitStepIndex,
        link.exitSettlementId,
        link.nowMs,
      ).changes,
  );
}

/**
 * A leg settlement, stored as its own row so the trajectory settlement can be
 * derived from measured legs rather than recomputed from aggregates.
 */
export function insertLegSettlement(
  db: Db,
  s: {
    readonly settlementId: string;
    readonly trajectoryId: string;
    readonly leg: 'buy' | 'sell';
    readonly observationId: string;
    readonly jobId: string;
    readonly stepIndex: number;
    readonly settlementVersion: string;
    readonly cashOutLamports: bigint | null;
    readonly cashInLamports: bigint | null;
    readonly grossCreditLamports: bigint | null;
    readonly baseFeeLamports: bigint;
    readonly priorityFeeLamports: bigint;
    readonly tipLamports: bigint;
    readonly transferFeeLamports: bigint;
    readonly failedAttemptFeeLamports: bigint;
    readonly rentCreatedLamports: bigint;
    readonly rentRecoveredLamports: bigint;
    readonly rentStillLockedLamports: bigint;
    readonly cashbackAccruedLamports: bigint;
    readonly cashbackClaimableLamports: bigint;
    readonly cashbackClaimedLamports: bigint;
    readonly cashbackClaimCostLamports: bigint;
    readonly residualTokenAtoms: bigint;
    readonly unexplainedLamports: bigint;
    readonly complete: boolean;
    readonly effectValid: boolean;
    readonly fullAccountCoverage: boolean;
    readonly residualSemanticsKnown: boolean;
    readonly transferFeeStatus: 'MEASURED' | 'NOT_APPLICABLE' | 'UNKNOWN';
    readonly rawStateDurable: boolean;
    readonly pnlEligible: boolean;
    readonly ineligibilityReasons: readonly string[];
    readonly nowMs: number;
  },
): void {
  appendOnly(db, {
    entity: 'leg_settlements',
    key: s.settlementId,
    nowMs: s.nowMs,
    content: {
      cashOut: s.cashOutLamports?.toString() ?? null,
      cashIn: s.cashInLamports?.toString() ?? null,
      unexplained: s.unexplainedLamports.toString(),
      eligible: s.pnlEligible,
    },
    readExisting: () => {
      const r = db
        .prepare(
          `SELECT cash_out_lamports AS cashOut, cash_in_lamports AS cashIn,
                  unexplained_lamports AS unexplained, pnl_eligible AS eligible
             FROM leg_settlements WHERE settlement_id = ?`,
        )
        .get(s.settlementId) as
        | { cashOut: string | null; cashIn: string | null; unexplained: string; eligible: number }
        | undefined;
      return r === undefined
        ? null
        : { cashOut: r.cashOut, cashIn: r.cashIn, unexplained: r.unexplained, eligible: r.eligible === 1 };
    },
    insert: () =>
      Number(
        db
          .prepare(
            `INSERT INTO leg_settlements
               (settlement_id, trajectory_id, leg, observation_id, job_id, step_index, settlement_version,
                cash_out_lamports, cash_in_lamports, gross_credit_lamports,
                base_fee_lamports, priority_fee_lamports, tip_lamports, transfer_fee_lamports,
                failed_attempt_fee_lamports, rent_created_lamports, rent_recovered_lamports,
                rent_still_locked_lamports, cashback_accrued_lamports, cashback_claimable_lamports,
                cashback_claimed_lamports, cashback_claim_cost_lamports, residual_token_atoms,
                unexplained_lamports, complete, effect_valid, full_account_coverage,
                residual_semantics_known, transfer_fee_status, raw_state_durable, pnl_eligible,
                ineligibility_reasons, derived_utc_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            s.settlementId,
            s.trajectoryId,
            s.leg,
            s.observationId,
            s.jobId,
            s.stepIndex,
            s.settlementVersion,
            s.cashOutLamports?.toString() ?? null,
            s.cashInLamports?.toString() ?? null,
            s.grossCreditLamports?.toString() ?? null,
            s.baseFeeLamports.toString(),
            s.priorityFeeLamports.toString(),
            s.tipLamports.toString(),
            s.transferFeeLamports.toString(),
            s.failedAttemptFeeLamports.toString(),
            s.rentCreatedLamports.toString(),
            s.rentRecoveredLamports.toString(),
            s.rentStillLockedLamports.toString(),
            s.cashbackAccruedLamports.toString(),
            s.cashbackClaimableLamports.toString(),
            s.cashbackClaimedLamports.toString(),
            s.cashbackClaimCostLamports.toString(),
            s.residualTokenAtoms.toString(),
            s.unexplainedLamports.toString(),
            s.complete ? 1 : 0,
            s.effectValid ? 1 : 0,
            s.fullAccountCoverage ? 1 : 0,
            s.residualSemanticsKnown ? 1 : 0,
            s.transferFeeStatus,
            s.rawStateDurable ? 1 : 0,
            s.pnlEligible ? 1 : 0,
            JSON.stringify(s.ineligibilityReasons),
            s.nowMs,
          ).changes,
      ),
  });
}
