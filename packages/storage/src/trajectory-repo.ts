import type { Db } from './db.js';
import type { SettledTrajectory, TrajectoryIdentity, TrajectoryState } from '../../pipeline/src/trajectory-kernel.js';
import type { EvidenceGrade } from '../../domain/src/trajectory-evidence.js';
import type { EntryImpactBound } from '../../domain/src/trajectory-evidence.js';
import type { MigrationEventIdentity, ReversalStatus } from '../../solana/src/migration.js';

/**
 * P8 — persistence for development trajectories and confirmed migrations.
 *
 * Every amount is TEXT because SQLite INTEGER is 64-bit SIGNED and these are
 * u64. A lamport figure stored as INTEGER is fine until it is not, and the
 * failure is silent.
 */

export interface OpenTrajectoryRow {
  readonly identity: TrajectoryIdentity;
  readonly entryPolicy: string;
  readonly exitPolicy: string;
  readonly state: TrajectoryState;
  readonly impact: EntryImpactBound;
  readonly maxAttainableGrade: EvidenceGrade;
  readonly refusals: readonly string[];
  readonly openedUtcMs: number;
}

export class EvidenceReplaceRefused extends Error {
  constructor(trajectoryId: string) {
    super(
      `refusing to replace trajectory ${trajectoryId.slice(0, 12)}: evidence is APPEND-ONLY. ` +
        'An outcome that can be overwritten is an outcome that can be improved after the fact.',
    );
    this.name = 'EvidenceReplaceRefused';
  }
}

/**
 * F17 — append only.
 *
 * This used to be `INSERT OR REPLACE`, so a second write silently replaced a
 * recorded outcome. Evidence that can be rewritten is not evidence.
 */
export function insertTrajectory(db: Db, r: OpenTrajectoryRow): void {
  const existing = db
    .prepare('SELECT 1 FROM development_trajectories WHERE trajectory_id = ?')
    .get(r.identity.trajectoryId);
  if (existing !== undefined) throw new EvidenceReplaceRefused(r.identity.trajectoryId);
  db.prepare(
    `INSERT INTO development_trajectories (
       trajectory_id, entry_observation_id, entry_simulation_job_id, entry_settlement_id,
       venue, pool, capability_fingerprint, snapshot_hash, mint, cohort, stratum,
       migration_age_ms, notional_lamports, entry_policy_inputs,
       entry_policy, exit_policy, state,
       evidence_grade, max_attainable_grade,
       quote_impact_ratio, base_impact_ratio, max_impact_ratio, haircut_bps, within_small_impact,
       opened_utc_ms, refusals
     ) VALUES (?,?,?,?, ?,?,?,?,?,?,?, ?,?,?, ?,?,?, ?,?, ?,?,?,?,?, ?,?)`,
  ).run(
    r.identity.trajectoryId,
    r.identity.entryObservationId,
    r.identity.entrySimulationJobId,
    r.identity.entrySettlementId,
    r.identity.venue,
    r.identity.pool,
    r.identity.capabilityFingerprint,
    r.identity.snapshotHash,
    r.identity.mint,
    r.identity.cohort,
    r.identity.stratum,
    r.identity.migrationAgeMs,
    r.identity.notionalLamports.toString(),
    JSON.stringify(r.identity.entryPolicyInputs),
    r.entryPolicy,
    r.exitPolicy,
    r.state,
    // An open trajectory has established its entry and nothing more.
    'SIMULATED_EXECUTION',
    r.maxAttainableGrade,
    finite(r.impact.quoteImpactRatio),
    finite(r.impact.baseImpactRatio),
    finite(r.impact.maxImpactRatio),
    r.impact.haircutBps,
    r.impact.withinSmallImpactBound ? 1 : 0,
    r.openedUtcMs,
    JSON.stringify(r.refusals),
  );
}

/**
 * An infinite ratio is what a zero reserve produces, and SQLite will not store
 * it. Null means "the denominator was zero", which is a different fact from a
 * ratio of zero and must not be flattened into one.
 */
function finite(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

export function settleTrajectory(
  db: Db,
  t: SettledTrajectory,
  extra: { exitObservationId: string | null; fillLatencyMs: number | null; settledUtcMs: number },
): void {
  const s = t.settlement;
  db.prepare(
    `UPDATE development_trajectories SET
       state = ?, evidence_grade = ?,
       entry_cash_out_lamports = ?, exit_cash_in_lamports = ?, haircut_exit_lamports = ?,
       execution_cost_lamports = ?, net_pnl_lamports = ?, pnl_blocked_reasons = ?,
       cashback_accrued = ?, cashback_claimable = ?, cashback_claimed = ?, cashback_claim_cost = ?,
       exit_observation_id = ?, fill_latency_ms = ?, settled_utc_ms = ?
     WHERE trajectory_id = ?`,
  ).run(
    s.exitCashInLamports === null ? 'AWAITING_FILL_OBSERVATION' : 'SETTLED',
    t.evidenceGrade,
    s.entryCashOutLamports.toString(),
    s.exitCashInLamports === null ? null : s.exitCashInLamports.toString(),
    t.haircutExitCashInLamports === null ? null : t.haircutExitCashInLamports.toString(),
    s.executionCostLamports.toString(),
    s.netPnlLamports === null ? null : s.netPnlLamports.toString(),
    JSON.stringify(s.pnlBlockedReasons),
    s.cashbackAccruedLamports.toString(),
    s.cashbackClaimableLamports.toString(),
    s.cashbackClaimedLamports.toString(),
    s.cashbackClaimCostLamports.toString(),
    extra.exitObservationId,
    extra.fillLatencyMs,
    extra.settledUtcMs,
    t.identity.trajectoryId,
  );
}

export function trajectoryCounts(db: Db): Record<string, number> {
  const rows = db
    .prepare('SELECT state, COUNT(*) c FROM development_trajectories GROUP BY state')
    .all() as { state: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [r.state, r.c]));
}

export function settledTrajectories(
  db: Db,
  limit = 500,
): {
  trajectory_id: string;
  mint: string;
  stratum: string;
  entry_policy: string;
  exit_policy: string;
  evidence_grade: string;
  net_pnl_lamports: string | null;
  haircut_exit_lamports: string | null;
  entry_cash_out_lamports: string | null;
  fill_latency_ms: number | null;
}[] {
  return db
    .prepare(
      `SELECT trajectory_id, mint, stratum, entry_policy, exit_policy, evidence_grade,
              net_pnl_lamports, haircut_exit_lamports, entry_cash_out_lamports, fill_latency_ms
         FROM development_trajectories
        WHERE state = 'SETTLED'
        ORDER BY settled_utc_ms DESC
        LIMIT ?`,
    )
    .all(limit) as never;
}

/** P7 — a confirmed migration, keyed by signature + instruction index + program. */
export function insertConfirmedMigration(
  db: Db,
  m: MigrationEventIdentity,
  reversal: ReversalStatus | null,
  observedUtcMs: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO confirmed_migrations (
       signature, instruction_index, program_id,
       mint, bonding_curve, canonical_pool,
       pool_base_token_account, pool_quote_token_account, quote_mint, creator,
       is_mayhem_mode, is_cashback_coin,
       slot, block_time, commitment, reversal_status, identity_source, observed_utc_ms
     ) VALUES (?,?,?, ?,?,?, ?,?,?,?, ?,?, ?,?,?,?,?,?)`,
  ).run(
    m.signature,
    m.instructionIndex,
    m.programId,
    m.mint,
    m.bondingCurve,
    m.canonicalPool,
    m.poolBaseTokenAccount,
    m.poolQuoteTokenAccount,
    m.quoteMint,
    m.creator,
    m.isMayhemMode === null ? null : m.isMayhemMode ? 1 : 0,
    m.isCashbackCoin === null ? null : m.isCashbackCoin ? 1 : 0,
    m.slot,
    m.blockTime,
    m.commitment,
    reversal,
    m.identitySource,
    observedUtcMs,
  );
}

/**
 * The primary candidate queue.
 *
 * Confirmed migrations only, newest first. A `processed` sighting that has not
 * been reconciled is excluded rather than ranked lower: acting on a migration
 * that was rolled back means building a trajectory for a pool that does not
 * exist.
 */
export function migrationCandidates(
  db: Db,
  limit = 50,
  /**
   * How many trajectories one mint may ever contribute.
   *
   * A cap rather than a ban: the same pool at a different hour is a different
   * market, so a repeat is informative. It is not INDEPENDENT, though, and a
   * corpus dominated by one pool cannot support a claim about a population.
   */
  maxPerMint = 3,
): { mint: string; canonical_pool: string; slot: number; block_time: number | null; is_cashback_coin: number | null; is_mayhem_mode: number | null }[] {
  /**
   * Least-sampled first, and never a mint that is already open.
   *
   * This used to be `ORDER BY slot DESC LIMIT ?` with no reference to what had
   * already been sampled, so every cycle returned the same newest migrations
   * and opened a trajectory on each. Observed in the first ten minutes of the
   * first window: cycles 1 and 2 opened the SAME three mints, and the corpus was
   * filling with repeated measurements of three pools.
   *
   * That matters because the threshold is 100 valid paths per policy-cohort.
   * A hundred paths across three pools is three outcomes with a hundred
   * observations of them, and no amount of collection turns one into the other.
   *
   * Two rules:
   *
   * - a mint with an OPEN trajectory is excluded outright — two concurrent
   *   trajectories on one pool share a mark path and duplicate each other
   *   exactly;
   * - the rest are ordered by how many trajectories they have already produced,
   *   so coverage spreads before it deepens, with `slot DESC` breaking ties
   *   toward the fresher migration.
   */
  return db
    .prepare(
      `SELECT m.mint, m.canonical_pool, m.slot, m.block_time, m.is_cashback_coin, m.is_mayhem_mode,
              COALESCE(t.n, 0) AS sampled
         FROM confirmed_migrations m
         LEFT JOIN (
           SELECT mint, COUNT(*) n FROM development_trajectories GROUP BY mint
         ) t ON t.mint = m.mint
        WHERE m.reversal_status = 'CONFIRMED'
          AND COALESCE(t.n, 0) < ?
          AND m.mint NOT IN (
            SELECT mint FROM development_trajectories WHERE state != 'SETTLED'
          )
        ORDER BY sampled ASC, m.slot DESC
        LIMIT ?`,
    )
    .all(maxPerMint, limit) as never;
}

/** How concentrated the corpus is. A study of three pools is not a study. */
export function samplingSpread(db: Db): {
  trajectories: number;
  distinctMints: number;
  maxPerMint: number;
  topMints: { mint: string; n: number }[];
} {
  const rows = db
    .prepare('SELECT mint, COUNT(*) n FROM development_trajectories GROUP BY mint ORDER BY n DESC')
    .all() as { mint: string; n: number }[];
  return {
    trajectories: rows.reduce((a, r) => a + r.n, 0),
    distinctMints: rows.length,
    maxPerMint: rows[0]?.n ?? 0,
    topMints: rows.slice(0, 5),
  };
}

export function confirmedMigrationCounts(db: Db): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT COALESCE(reversal_status,'UNRECONCILED') s, COUNT(*) c FROM confirmed_migrations GROUP BY s",
    )
    .all() as { s: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [r.s, r.c]));
}

/**
 * P2/F12 — persist the exact plan of a leg's bytes.
 *
 * Append-only, like every other evidence row here. A plan that could be
 * rewritten would let a later rebuild redefine what the earlier execution was,
 * which is precisely the substitution freezing it exists to prevent.
 */
export function insertAccountPlan(
  db: Db,
  trajectoryId: string,
  plan: {
    leg: string;
    fingerprint: string;
    instructions: readonly unknown[];
    programIds: readonly string[];
    accounts: readonly string[];
    writableAccounts: readonly string[];
  },
  recordedUtcMs: number,
): void {
  const existing = db
    .prepare('SELECT fingerprint f FROM leg_account_plans WHERE trajectory_id = ? AND leg = ?')
    .get(trajectoryId, plan.leg) as { f: string } | undefined;
  if (existing !== undefined) {
    // The same plan recorded twice is a retry and is fine. A DIFFERENT plan
    // under the same identity means the leg was rebuilt, which is the defect.
    if (existing.f === plan.fingerprint) return;
    throw new EvidenceReplaceRefused(`${trajectoryId}/${plan.leg}`);
  }
  db.prepare(
    `INSERT INTO leg_account_plans (
       trajectory_id, leg, fingerprint, instruction_count,
       plan_json, program_ids, accounts, writable_accounts, recorded_utc_ms
     ) VALUES (?,?,?,?, ?,?,?,?,?)`,
  ).run(
    trajectoryId,
    plan.leg,
    plan.fingerprint,
    plan.instructions.length,
    JSON.stringify(plan.instructions),
    JSON.stringify(plan.programIds),
    JSON.stringify(plan.accounts),
    JSON.stringify(plan.writableAccounts),
    recordedUtcMs,
  );
}

export function accountPlanFor(
  db: Db,
  trajectoryId: string,
  leg: string,
): { fingerprint: string; instruction_count: number; plan_json: string; accounts: string } | undefined {
  return db
    .prepare(
      `SELECT fingerprint, instruction_count, plan_json, accounts
         FROM leg_account_plans WHERE trajectory_id = ? AND leg = ?`,
    )
    .get(trajectoryId, leg) as never;
}

export function accountPlanCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) c FROM leg_account_plans').get() as { c: number }).c;
}

/**
 * P6 — persist every account a leg created, with who benefits from it.
 *
 * Append-only via `INSERT OR IGNORE` on the (trajectory, leg, pubkey) key: a
 * retry of the same observation is idempotent, and nothing can rewrite what a
 * transaction was measured to have created. The alternative — an upsert — would
 * let a later, differently-scoped classification silently redefine an earlier
 * cost, which is the same class of defect as a rebuilt account plan.
 */
export function insertCreatedAccounts(
  db: Db,
  trajectoryId: string,
  leg: string,
  accounts: readonly {
    pubkey: string;
    owner: string;
    space: number;
    rentExemptMinimumLamports: bigint;
    excessLamports: bigint;
    scope: string;
    recoverability: string;
    sharedWithOtherTraders: boolean;
  }[],
  recordedUtcMs: number,
): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO created_accounts (
       trajectory_id, leg, pubkey, owner, space,
       rent_exempt_min, excess_lamports,
       economic_scope, recoverability, shared_with_other, recorded_utc_ms
     ) VALUES (?,?,?,?,?, ?,?, ?,?,?,?)`,
  );
  for (const a of accounts) {
    stmt.run(
      trajectoryId,
      leg,
      a.pubkey,
      a.owner,
      a.space,
      a.rentExemptMinimumLamports.toString(),
      a.excessLamports.toString(),
      a.scope,
      a.recoverability,
      a.sharedWithOtherTraders ? 1 : 0,
      recordedUtcMs,
    );
  }
}

export function createdAccountsFor(
  db: Db,
  trajectoryId: string,
): {
  leg: string;
  pubkey: string;
  owner: string;
  space: number;
  rent_exempt_min: string;
  excess_lamports: string;
  economic_scope: string;
  recoverability: string;
  shared_with_other: number;
}[] {
  return db
    .prepare(
      `SELECT leg, pubkey, owner, space, rent_exempt_min, excess_lamports,
              economic_scope, recoverability, shared_with_other
         FROM created_accounts WHERE trajectory_id = ? ORDER BY leg, pubkey`,
    )
    .all(trajectoryId) as never;
}

/**
 * The corpus-level cold/warm picture, in lamports rather than in adjectives.
 *
 * `subsidy` is the number the P6 hypothesis is about: rent this system paid to
 * open accounts every later trader through the same pool gets for free.
 */
export function setupEconomicsTotals(db: Db): {
  accounts: number;
  trajectories: number;
  totalRentLamports: string;
  recoverableLamports: string;
  subsidyLamports: string;
  unknownScope: number;
} {
  const sum = (sql: string): bigint => {
    const rows = db.prepare(sql).all() as { v: string }[];
    let t = 0n;
    for (const r of rows) t += BigInt(r.v);
    return t;
  };
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;

  return {
    accounts: one('SELECT COUNT(*) c FROM created_accounts'),
    trajectories: one('SELECT COUNT(DISTINCT trajectory_id) c FROM created_accounts'),
    totalRentLamports: sum('SELECT rent_exempt_min v FROM created_accounts').toString(),
    recoverableLamports: sum(
      "SELECT rent_exempt_min v FROM created_accounts WHERE recoverability = 'RECOVERABLE_BY_US'",
    ).toString(),
    subsidyLamports: sum(
      'SELECT rent_exempt_min v FROM created_accounts WHERE shared_with_other = 1',
    ).toString(),
    unknownScope: one(
      "SELECT COUNT(*) c FROM created_accounts WHERE economic_scope = 'UNKNOWN' OR recoverability = 'UNKNOWN'",
    ),
  };
}

/**
 * P7 — persist what each leg moved through the cashback accounts.
 *
 * Append-only on (trajectory, leg), like every other evidence table here: a
 * retry of the same observation is idempotent, and a later measurement cannot
 * silently redefine an earlier one.
 *
 * Nothing is summed on the way in. One number across both legs is exactly what
 * cannot answer the question the F13 correction raises — whether the SELL
 * accrued — and a sum written here could never be taken apart again.
 */
export function insertLegCashback(
  db: Db,
  trajectoryId: string,
  isCashbackCoin: boolean,
  legs: readonly {
    leg: string;
    accumulatorWsolDeltaLamports: bigint | null;
    accumulatorDeltaLamports: bigint | null;
    creatorVaultDeltaLamports: bigint | null;
    feeRecipientDeltaLamports: bigint | null;
    accruedToUs: boolean | null;
  }[],
  recordedUtcMs: number,
): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO leg_cashback (
       trajectory_id, leg,
       accumulator_wsol_delta, accumulator_delta, creator_vault_delta, fee_recipient_delta,
       accrued_to_us, is_cashback_coin, recorded_utc_ms
     ) VALUES (?,?, ?,?,?,?, ?,?,?)`,
  );
  // An unobserved account is NULL, never '0'. Zero is a measurement, and the
  // whole class of defect this schema guards against is one standing in for the
  // other.
  const s = (v: bigint | null): string | null => (v === null ? null : v.toString());
  for (const l of legs) {
    stmt.run(
      trajectoryId,
      l.leg,
      s(l.accumulatorWsolDeltaLamports),
      s(l.accumulatorDeltaLamports),
      s(l.creatorVaultDeltaLamports),
      s(l.feeRecipientDeltaLamports),
      l.accruedToUs === null ? null : l.accruedToUs ? 1 : 0,
      isCashbackCoin ? 1 : 0,
      recordedUtcMs,
    );
  }
}

export function legCashbackFor(
  db: Db,
  trajectoryId: string,
): {
  leg: string;
  accumulator_wsol_delta: string | null;
  accumulator_delta: string | null;
  creator_vault_delta: string | null;
  fee_recipient_delta: string | null;
  accrued_to_us: number | null;
  is_cashback_coin: number;
}[] {
  return db
    .prepare(
      `SELECT leg, accumulator_wsol_delta, accumulator_delta, creator_vault_delta,
              fee_recipient_delta, accrued_to_us, is_cashback_coin
         FROM leg_cashback WHERE trajectory_id = ? ORDER BY leg DESC`,
    )
    .all(trajectoryId) as never;
}

/**
 * Did BOTH legs accrue, across the corpus?
 *
 * The count that settles F13 empirically. If `sellAccrued` stays at zero while
 * `buyAccrued` climbs, the old one-leg model was right after all and this
 * correction is wrong — which is the point of measuring rather than asserting.
 */
export function cashbackLegTotals(db: Db): {
  legs: number;
  cashbackCoinLegs: number;
  buyAccrued: number;
  sellAccrued: number;
  undetermined: number;
  accumulatorGainLamports: string;
} {
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
  const rows = db
    .prepare("SELECT accumulator_wsol_delta v FROM leg_cashback WHERE accumulator_wsol_delta IS NOT NULL")
    .all() as { v: string }[];
  let gain = 0n;
  for (const r of rows) {
    const d = BigInt(r.v);
    if (d > 0n) gain += d;
  }
  return {
    legs: one('SELECT COUNT(*) c FROM leg_cashback'),
    cashbackCoinLegs: one('SELECT COUNT(*) c FROM leg_cashback WHERE is_cashback_coin = 1'),
    buyAccrued: one("SELECT COUNT(*) c FROM leg_cashback WHERE leg = 'buy' AND accrued_to_us = 1"),
    sellAccrued: one("SELECT COUNT(*) c FROM leg_cashback WHERE leg = 'sell' AND accrued_to_us = 1"),
    undetermined: one('SELECT COUNT(*) c FROM leg_cashback WHERE accrued_to_us IS NULL'),
    accumulatorGainLamports: gain.toString(),
  };
}

/**
 * P10 — persist the risk facts, admitted or refused.
 *
 * The refusals are the larger half and the more useful one. A screening row is
 * written for every token screened; the same rule applies here, because a
 * filter whose rejects are not stored can never be evaluated.
 *
 * Keyed on (mint, collected_utc_ms) so re-examining the same mint later is a
 * new observation rather than an overwrite. The facts were true at a time, and
 * a token whose freeze authority was renounced yesterday should not retroactively
 * rewrite yesterday's refusal.
 */
export function insertCandidateRiskFacts(
  db: Db,
  f: {
    mint: string;
    pool: string;
    collectedAtMs: number;
    mint2022: {
      overall: string;
      freezeAuthority: string;
      mintAuthority: string;
      permanentDelegate: string;
      transferHook: string;
      decodeFailure: string | null;
      transferFeeBps: number | null;
    };
    transferFee: { kind: string };
    mayhem: { enabled: boolean | null; source: string };
    breadth: string;
    isCashbackCoin: boolean | null;
    accumulatorWsolAta: string | null;
    concentration: { kind: string; entityAdjustedShare?: number };
    canonicalPool: boolean;
    requiresSharedSetup: boolean | null;
  },
  admission: { admit: boolean; refusals: readonly string[]; stratum: string },
  trajectoryId: string | null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO candidate_risk_facts (
       mint, pool, collected_utc_ms, trajectory_id,
       mint_overall, freeze_authority, mint_authority, permanent_delegate, transfer_hook, mint_decode_failure,
       transfer_fee_kind, transfer_fee_bps,
       mayhem_enabled, mayhem_source, breadth_usability,
       is_cashback_coin, accumulator_wsol_ata,
       concentration_kind, entity_adjusted_share,
       canonical_pool, requires_shared_setup, stratum, admitted, refusals
     ) VALUES (?,?,?,?, ?,?,?,?,?,?, ?,?, ?,?,?, ?,?, ?,?, ?,?,?,?,?)`,
  ).run(
    f.mint,
    f.pool,
    f.collectedAtMs,
    trajectoryId,
    f.mint2022.overall,
    f.mint2022.freezeAuthority,
    f.mint2022.mintAuthority,
    f.mint2022.permanentDelegate,
    f.mint2022.transferHook,
    f.mint2022.decodeFailure,
    f.transferFee.kind,
    f.mint2022.transferFeeBps,
    // NULL, not 0. A token neither venue could be read for has not been shown
    // to be non-Mayhem; it has not been looked at.
    f.mayhem.enabled === null ? null : f.mayhem.enabled ? 1 : 0,
    f.mayhem.source,
    f.breadth,
    f.isCashbackCoin === null ? null : f.isCashbackCoin ? 1 : 0,
    f.accumulatorWsolAta,
    f.concentration.kind,
    f.concentration.entityAdjustedShare ?? null,
    f.canonicalPool ? 1 : 0,
    f.requiresSharedSetup === null ? null : f.requiresSharedSetup ? 1 : 0,
    admission.stratum,
    admission.admit ? 1 : 0,
    JSON.stringify(admission.refusals),
  );
}

export function riskFactsFor(db: Db, mint: string): Record<string, unknown>[] {
  return db
    .prepare('SELECT * FROM candidate_risk_facts WHERE mint = ? ORDER BY collected_utc_ms DESC')
    .all(mint) as never;
}

/** Admission counts by stratum, and the refusal histogram. Refusals are the product. */
export function admissionTotals(db: Db): {
  examined: number;
  admitted: number;
  byStratum: { stratum: string; n: number; admitted: number }[];
  topRefusals: { reason: string; n: number }[];
} {
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
  const rows = db.prepare('SELECT refusals FROM candidate_risk_facts WHERE admitted = 0').all() as {
    refusals: string;
  }[];
  const hist = new Map<string, number>();
  for (const r of rows) {
    let parsed: string[] = [];
    try {
      parsed = JSON.parse(r.refusals) as string[];
    } catch {
      parsed = ['(unparseable refusal row)'];
    }
    for (const reason of parsed) hist.set(reason, (hist.get(reason) ?? 0) + 1);
  }
  return {
    examined: one('SELECT COUNT(*) c FROM candidate_risk_facts'),
    admitted: one('SELECT COUNT(*) c FROM candidate_risk_facts WHERE admitted = 1'),
    byStratum: db
      .prepare(
        `SELECT stratum, COUNT(*) n, SUM(admitted) admitted FROM candidate_risk_facts
          GROUP BY stratum ORDER BY n DESC`,
      )
      .all() as never,
    topRefusals: [...hist.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, n]) => ({ reason, n })),
  };
}
