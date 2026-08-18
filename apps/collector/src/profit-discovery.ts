import { createHash } from 'node:crypto';
import {
  computeMicrostructureFeatures,
  MICROSTRUCTURE_FEATURE_VERSION,
  type MicrostructureFeatures,
  type MicrostructureResult,
} from '../../../packages/intelligence/src/migration-microstructure.js';
import {
  fetchPreMigrationHistory,
  DEFAULT_HISTORY_LIMITS,
  type HistoryRpc,
} from '../../../packages/intelligence/src/migration-history.js';
import { labelStrata, type Strata, type StratumInput } from '../../../packages/strategy/src/fee-strata.js';
import type { CoverageVerdict } from '../../../packages/strategy/src/policy-coverage.js';
import {
  chooseSize,
  CANDIDATE_SIZES_LAMPORTS,
  type SizeChoice,
  type SizeMechanics,
} from '../../../packages/strategy/src/size-rule.js';
import { quoteBuyFrom, quoteSellFrom } from '../../../packages/solana/src/pumpswap-offline.js';

/**
 * The profit-discovery layer's collector-facing surface.
 *
 * Kept out of `trajectory-collect.ts` deliberately. That file is 2,600 lines
 * and every previous phase added to it; a feature layer buried inside a cycle
 * loop is a feature layer that cannot be tested without a chain. Everything
 * here takes its inputs explicitly and returns data, so the tests drive the
 * same functions the collector does.
 */

export interface MigrationAnchor {
  readonly mint: string;
  readonly bondingCurve: string;
  readonly canonicalPool: string;
  readonly signature: string;
  readonly slot: number;
  readonly blockTimeMs: number | null;
  readonly creator: string | null;
  readonly isMayhem: boolean | null;
  readonly isCashback: boolean | null;
}

/** Minimal database surface. Keeps this module independent of the storage package. */
export interface DiscoveryDb {
  prepare(sql: string): {
    run(...p: unknown[]): unknown;
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown;
  };
}

/**
 * The newest confirmed migration for a mint, with the fields the feature layer
 * anchors on.
 *
 * Newest rather than first: a mint that somehow produced two migration events
 * has the later one as the state the market is actually trading, and anchoring
 * on the earlier would compute features over a curve that has since been
 * superseded.
 */
export function migrationAnchor(db: DiscoveryDb, mint: string): MigrationAnchor | null {
  const row = db
    .prepare(
      `SELECT mint, bonding_curve, canonical_pool, signature, slot, block_time, creator,
              is_mayhem_mode, is_cashback_coin
         FROM confirmed_migrations
        WHERE mint = ?
        ORDER BY slot DESC
        LIMIT 1`,
    )
    .get(mint) as
    | {
        mint: string;
        bonding_curve: string;
        canonical_pool: string;
        signature: string;
        slot: number;
        block_time: number | null;
        creator: string | null;
        is_mayhem_mode: number | null;
        is_cashback_coin: number | null;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    mint: row.mint,
    bondingCurve: row.bonding_curve,
    canonicalPool: row.canonical_pool,
    signature: row.signature,
    slot: row.slot,
    blockTimeMs: row.block_time === null ? null : row.block_time * 1000,
    creator: row.creator,
    isMayhem: row.is_mayhem_mode === null ? null : row.is_mayhem_mode === 1,
    isCashback: row.is_cashback_coin === null ? null : row.is_cashback_coin === 1,
  };
}

export interface CachedMicrostructure {
  readonly features: MicrostructureFeatures;
  readonly coverage: 'COMPLETE' | 'INCOMPLETE';
  readonly sourceSignaturesHash: string;
  readonly fromCache: boolean;
}

/**
 * Read the cached feature row for a mint, if this feature version computed one.
 *
 * The cache is the entire economic argument for P3.1: a migrated token's
 * pre-migration history cannot change, so re-fetching it is pure quota waste,
 * and quota is the binding constraint on how many mints a day this apparatus
 * can characterise.
 */
export function readCachedMicrostructure(db: DiscoveryDb, mint: string): CachedMicrostructure | null {
  const row = db
    .prepare(
      `SELECT features, coverage, source_signatures_hash
         FROM migration_microstructure_features
        WHERE mint = ? AND feature_version = ?`,
    )
    .get(mint, MICROSTRUCTURE_FEATURE_VERSION) as
    | { features: string; coverage: string; source_signatures_hash: string }
    | undefined;
  if (row === undefined) return null;
  return {
    features: JSON.parse(row.features) as MicrostructureFeatures,
    coverage: row.coverage === 'COMPLETE' ? 'COMPLETE' : 'INCOMPLETE',
    sourceSignaturesHash: row.source_signatures_hash,
    fromCache: true,
  };
}

export function persistMicrostructure(
  db: DiscoveryDb,
  anchor: MigrationAnchor,
  result: MicrostructureResult,
  coverageRecord: {
    newestSignature: string | null;
    oldestSignature: string | null;
    reachedCreation: boolean;
    pages: number;
    transactionsFetched: number;
    transactionsFailed: number;
    transactionsPruned: number;
    coverageReason: string | null;
  },
  nowMs: number,
): void {
  db.prepare(
    `INSERT INTO migration_history_coverage
       (mint, bonding_curve, migration_signature, migration_slot, feature_version,
        newest_signature, oldest_signature, reached_creation, pages, transactions_fetched,
        transactions_failed, transactions_pruned, coverage, coverage_reason,
        source_signatures_hash, fetched_utc_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint, feature_version) DO NOTHING`,
  ).run(
    anchor.mint,
    anchor.bondingCurve,
    anchor.signature,
    anchor.slot,
    MICROSTRUCTURE_FEATURE_VERSION,
    coverageRecord.newestSignature,
    coverageRecord.oldestSignature,
    coverageRecord.reachedCreation ? 1 : 0,
    coverageRecord.pages,
    coverageRecord.transactionsFetched,
    coverageRecord.transactionsFailed,
    coverageRecord.transactionsPruned,
    result.coverage,
    coverageRecord.coverageReason,
    result.sourceSignaturesHash,
    nowMs,
  );

  db.prepare(
    `INSERT INTO migration_microstructure_features
       (mint, feature_version, migration_signature, migration_slot, source_signatures_hash,
        coverage, features, features_hash, computed_at_utc_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint, feature_version) DO NOTHING`,
  ).run(
    anchor.mint,
    MICROSTRUCTURE_FEATURE_VERSION,
    anchor.signature,
    anchor.slot,
    result.sourceSignaturesHash,
    result.coverage,
    JSON.stringify(result.features),
    result.featuresHash,
    nowMs,
  );
}

/**
 * Fetch-once-then-cache. Returns null when the history could not be read at all.
 *
 * A THROWN error is not swallowed into a null: a quota refusal and a token with
 * no history are different facts, and the collector's breaker needs to see the
 * first one. Only an empty, readable history yields a feature row with
 * INCOMPLETE coverage.
 */
export async function ensureMicrostructure(
  db: DiscoveryDb,
  rpc: HistoryRpc,
  anchor: MigrationAnchor,
  opts: {
    migrationReserveLamports: bigint | null;
    entityOf?: (address: string) => string | null;
    mayhemAddresses?: ReadonlySet<string>;
    yieldTo?: () => Promise<void>;
    nowMs?: number;
  },
): Promise<CachedMicrostructure | null> {
  const cached = readCachedMicrostructure(db, anchor.mint);
  if (cached !== null) return cached;

  const history = await fetchPreMigrationHistory(
    rpc,
    {
      mint: anchor.mint,
      bondingCurve: anchor.bondingCurve,
      migrationSignature: anchor.signature,
      migrationSlot: anchor.slot,
    },
    DEFAULT_HISTORY_LIMITS,
    opts.yieldTo,
  );

  const result = computeMicrostructureFeatures({
    mint: anchor.mint,
    bondingCurve: anchor.bondingCurve,
    creator: anchor.creator,
    migrationSignature: anchor.signature,
    migrationSlot: anchor.slot,
    migrationBlockTimeMs: anchor.blockTimeMs,
    trades: history.trades,
    coverage: history.coverage.coverage,
    entityOf: opts.entityOf,
    mayhemAddresses: opts.mayhemAddresses,
    migrationReserveLamports: opts.migrationReserveLamports,
  });

  persistMicrostructure(db, anchor, result, history.coverage, opts.nowMs ?? Date.now());

  return {
    features: result.features,
    coverage: result.coverage,
    sourceSignaturesHash: result.sourceSignaturesHash,
    fromCache: false,
  };
}

export function persistStrata(
  db: DiscoveryDb,
  subjectId: string,
  subjectKind: 'TRAJECTORY' | 'OPPORTUNITY',
  mint: string,
  input: StratumInput,
  nowMs: number,
): Strata {
  const s = labelStrata(input);
  db.prepare(
    `INSERT INTO mechanics_strata
       (subject_id, subject_kind, mint, fee_tier_stratum, cashback_stratum, mayhem_stratum,
        token_program_stratum, fee_config_hash, market_cap_lamports, creator_fee_bps,
        protocol_fee_bps, lp_fee_bps, labelled_utc_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject_id) DO NOTHING`,
  ).run(
    subjectId,
    subjectKind,
    mint,
    s.feeTier,
    s.cashback,
    s.mayhem,
    s.tokenProgram,
    input.feeConfigHash,
    input.marketCapLamports?.toString() ?? null,
    null,
    null,
    null,
    nowMs,
  );
  return s;
}

export function persistPolicyCoverage(
  db: DiscoveryDb,
  subjectId: string,
  subjectKind: 'TRAJECTORY' | 'OPPORTUNITY',
  verdicts: readonly CoverageVerdict[],
  policyVersion: string,
  nowMs: number,
): void {
  const stmt = db.prepare(
    `INSERT INTO policy_field_coverage
       (subject_id, subject_kind, entry_policy, policy_version, known_fields, unknown_fields,
        required_fields, full_coverage, decision, evaluability, reason, recorded_utc_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject_id, entry_policy, policy_version) DO NOTHING`,
  );
  for (const v of verdicts) {
    stmt.run(
      subjectId,
      subjectKind,
      v.policy,
      policyVersion,
      JSON.stringify(v.knownFields),
      JSON.stringify(v.unknownFields),
      JSON.stringify(v.requiredFields),
      v.fullCoverage ? 1 : 0,
      v.decision.enter ? 'ENTER' : 'REJECT',
      v.evaluability,
      v.decision.reason.slice(0, 2_000),
      nowMs,
    );
  }
}

export function persistSizeEvaluations(db: DiscoveryDb, opportunityId: string, choice: SizeChoice, nowMs: number): void {
  const stmt = db.prepare(
    `INSERT INTO size_rule_evaluations
       (opportunity_id, candidate_lamports, admissible, bound_by, reserve_share_bps,
        price_impact_bps, counterfactual_impact_bps, round_trip_drag_bps, chosen, evaluated_utc_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(opportunity_id, candidate_lamports) DO NOTHING`,
  );
  for (const e of choice.evaluations) {
    stmt.run(
      opportunityId,
      e.candidateLamports.toString(),
      e.admissible ? 1 : 0,
      e.boundBy,
      e.mechanics.reserveShareBps,
      e.mechanics.priceImpactBps,
      e.mechanics.counterfactualImpactBps,
      e.mechanics.roundTripDragBps,
      choice.chosenLamports !== null && e.candidateLamports === choice.chosenLamports ? 1 : 0,
      nowMs,
    );
  }
}

/**
 * A deterministic opportunity id.
 *
 * Derived from (mint, clock, context) rather than random, so a restart that
 * re-derives the same opportunity collides with the existing row instead of
 * creating a second one. The unique index on those three columns is the
 * authority; this just makes the primary key agree with it.
 */
export function opportunityId(mint: string, clock: string, evidenceContextId: string): string {
  return `opp-${createHash('sha256').update(`${mint}|${clock}|${evidenceContextId}`).digest('hex').slice(0, 20)}`;
}

export function persistEntryOpportunity(
  db: DiscoveryDb,
  o: {
    opportunityId: string;
    mint: string;
    pool: string;
    entryClock: string;
    evidenceContextId: string;
    snapshotHash: string;
    decisionUtcMs: number;
    migrationSlot: number;
    ageSinceMigrationMs: number;
    mechanicallyViable: boolean;
    refusal: string | null;
    trajectoryId: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO entry_opportunities
       (opportunity_id, mint, pool, entry_clock, evidence_context_id, snapshot_hash,
        decision_utc_ms, migration_slot, age_since_migration_ms, mechanically_viable,
        refusal, trajectory_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(opportunity_id) DO NOTHING`,
  ).run(
    o.opportunityId,
    o.mint,
    o.pool,
    o.entryClock,
    o.evidenceContextId,
    o.snapshotHash,
    o.decisionUtcMs,
    o.migrationSlot,
    o.ageSinceMigrationMs,
    o.mechanicallyViable ? 1 : 0,
    o.refusal,
    o.trajectoryId,
  );
}

/**
 * P7 — evaluate every candidate size from ONE coherent snapshot, offline.
 *
 * No extra RPC per size. `quoteBuyFrom` and `quoteSellFrom` price against
 * whatever state the snapshot source holds, so four sizes cost four pure
 * computations rather than four round trips — which is what makes a size RULE
 * affordable inside a cycle that also has a 10-second mark SLA to hit.
 *
 * ## The round-trip drag is an UPPER bound, deliberately
 *
 * The sell is priced against the PRE-buy state, so it does not see the impact
 * our own buy just caused. That understates the drag, and understating a
 * quantity that is being tested against a MAXIMUM is the unsafe direction — it
 * would admit sizes that should have been refused.
 *
 * So the entry's measured price impact is added back. Selling into a pool our
 * buy has already moved gets us less by roughly that impact, so the corrected
 * figure is an upper bound and the true drag is smaller. A maximum test against
 * an upper bound is conservative, which is the direction this repository errs in
 * everywhere else.
 *
 * A size whose quote THROWS is not admissible. `evaluateSize` refuses on any
 * unmeasured bound, and an undecodable fee config or an incomplete snapshot is
 * exactly the state in which a confident number would be wrong.
 */
export function evaluateSizesOffline(p: {
  source: Parameters<typeof quoteBuyFrom>[0];
  pool: string;
  effectiveQuoteReserveLamports: bigint | null;
  slippagePct: number;
  candidates?: readonly bigint[];
}): SizeChoice {
  const sizes = p.candidates ?? CANDIDATE_SIZES_LAMPORTS;
  const mechanics: SizeMechanics[] = [];

  for (const size of sizes) {
    let m: SizeMechanics = {
      candidateLamports: size,
      mechanicsComplete: false,
      reserveShareBps: null,
      priceImpactBps: null,
      counterfactualImpactBps: null,
      roundTripDragBps: null,
      capacitySufficient: false,
    };
    try {
      const buy = quoteBuyFrom(p.source, p.pool, size, p.slippagePct);
      if (buy.baseOutAtoms <= 0n) {
        // The pool cannot fill this size at all. Not a bound: a capacity fact.
        mechanics.push(m);
        continue;
      }
      const sell = quoteSellFrom(p.source, p.pool, buy.baseOutAtoms, p.slippagePct);

      const reserveShareBps =
        p.effectiveQuoteReserveLamports === null || p.effectiveQuoteReserveLamports === 0n
          ? null
          : Number((size * 10_000n) / p.effectiveQuoteReserveLamports);

      /**
       * Price impact, from the round trip itself.
       *
       * `quoteOutLamports` is what the same tokens fetch back at the SAME
       * state, so the gap between what we paid and what they are worth is the
       * fee-and-curve cost of crossing — which is the quantity the impact bound
       * is written about.
       */
      const priceImpactBps = size === 0n ? null : Number(((size - sell.quoteOutLamports) * 10_000n) / size);

      /**
       * The counterfactual entry impact: how far our own entry moves the pool.
       * The larger of the two sides, because a future exit is priced against
       * whichever reserve our entry disturbed more.
       */
      const quoteSideBps =
        sell.poolQuoteReserveRaw + sell.virtualQuoteReserves === 0n
          ? null
          : Number((size * 10_000n) / (sell.poolQuoteReserveRaw + sell.virtualQuoteReserves));
      const baseSideBps =
        sell.poolBaseReserve === 0n ? null : Number((buy.baseOutAtoms * 10_000n) / sell.poolBaseReserve);
      const counterfactualImpactBps =
        quoteSideBps === null || baseSideBps === null ? null : Math.max(quoteSideBps, baseSideBps);

      const roundTripDragBps = priceImpactBps === null ? null : priceImpactBps + Math.max(0, priceImpactBps);

      m = {
        candidateLamports: size,
        mechanicsComplete: true,
        reserveShareBps,
        priceImpactBps,
        counterfactualImpactBps,
        roundTripDragBps,
        capacitySufficient: buy.baseOutAtoms > 0n && sell.quoteOutLamports > 0n,
      };
    } catch {
      // Left as the unmeasured shape above. `evaluateSize` refuses it, which is
      // the fail-closed reading: a size whose economics could not be computed
      // has not been shown to be safe.
    }
    mechanics.push(m);
  }

  return chooseSize(mechanics);
}
