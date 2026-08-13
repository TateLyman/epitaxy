import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { ExecutionObservation } from '../../domain/src/execution.js';
import type { ObservationFailure } from '../../domain/src/execution.js';

/**
 * Writers for `execution_observations`, `shadow_positions` and the repaired
 * position lifecycle.
 *
 * Nothing here derives economics. It persists what one response said, and it
 * refuses to persist a shape that two responses were needed to produce.
 */

const bn = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());

export interface ObservationSidecar {
  readonly positionId: string | null;
  readonly shadowPositionId: string | null;
  readonly purpose: string;
  readonly failure: ObservationFailure | null;
  readonly impactStatus: string;
  readonly impactRawString: string | null;
  readonly adverseImpactBps: number | null;
  readonly writableAccounts: readonly string[];
  readonly lookupTables: readonly string[];
  /**
   * The exact assembled transaction, when assembly succeeded.
   *
   * Null means no bytes existed, which is why `transaction_policy` cannot be a
   * pass in that case: there was nothing for the byte-level policy to read.
   */
  readonly assembled?: {
    readonly serializedHash: string;
    readonly messageHash: string;
    readonly packetBytes: number;
    readonly feePayer: string;
    readonly requiredSignatures: number;
    readonly staticAccountKeys: readonly string[];
    readonly writableAccounts: readonly string[];
    readonly readonlyAccounts: readonly string[];
    readonly base64: string;
  } | null;
}

export function insertObservation(db: Db, o: ExecutionObservation, side: ObservationSidecar): string {
  db.prepare(
    `INSERT INTO execution_observations
      (observation_id,family,mint,side,position_id,shadow_position_id,purpose,
       input_mint,output_mint,requested_amount,expected_output,minimum_output,slippage_bps,
       platform_fee_bps,platform_fee_amount,platform_fee_mint,
       signature_fee_lamports,prioritization_fee_lamports,rent_fee_lamports,broadcaster_tip_lamports,
       route_plan_hash,route_labels,instruction_set_hash,instruction_count,compute_unit_limit,
       estimated_transaction_bytes,writable_accounts,lookup_tables,
       raw_impact_string,impact_schema_status,adverse_impact_bps,
       blockhash,last_valid_block_height,expire_at,context_slot,
       raw_payload_hash,endpoint,request_id,
       instruction_policy,transaction_policy,simulation,policy_detail,simulation_detail,failure,
       requested_utc_ms,received_utc_ms,latency_ms,context_hash,
       serialized_transaction_hash,message_hash,actual_packet_bytes,fee_payer,
       required_signature_count,static_account_keys,readonly_accounts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.observationId,
    o.family,
    o.mint,
    o.side,
    side.positionId,
    side.shadowPositionId,
    side.purpose,
    o.inputMint,
    o.outputMint,
    o.requestedAmount.toString(),
    bn(o.expectedOutput),
    bn(o.minimumOutput),
    o.slippageBps,
    o.platformFeeBps,
    bn(o.platformFeeAmount),
    o.platformFeeMint,
    bn(o.signatureFeeLamports),
    bn(o.prioritizationFeeLamports),
    bn(o.rentFeeLamports),
    bn(o.broadcasterTipLamports),
    o.routePlanHash,
    o.routeLabels.join('>'),
    o.instructionSetHash,
    o.instructionCount,
    o.computeUnitLimit,
    o.transactionBytes,
    JSON.stringify(side.writableAccounts),
    JSON.stringify(side.lookupTables),
    side.impactRawString,
    side.impactStatus,
    side.adverseImpactBps,
    null,
    o.lastValidBlockHeight,
    o.expireAt,
    o.contextSlot,
    o.rawPayloadHash,
    o.endpoint,
    o.requestId,
    o.instructionPolicy,
    o.transactionPolicy,
    o.simulation,
    o.policyDetail,
    o.simulationDetail,
    side.failure,
    o.requestedUtcMs,
    o.receivedUtcMs,
    o.latencyMs,
    o.contextHash,
    side.assembled?.serializedHash ?? null,
    side.assembled?.messageHash ?? null,
    side.assembled?.packetBytes ?? null,
    side.assembled?.feePayer ?? null,
    side.assembled?.requiredSignatures ?? null,
    side.assembled === null || side.assembled === undefined
      ? null
      : JSON.stringify(side.assembled.staticAccountKeys),
    side.assembled === null || side.assembled === undefined
      ? null
      : JSON.stringify(side.assembled.readonlyAccounts),
  );
  return o.observationId;
}

export interface ObservationStats {
  readonly total: number;
  readonly built: number;
  readonly policyPass: number;
  readonly simulated: number;
  readonly providerFailures: number;
  readonly noRoute: number;
  /** Observations for which exact transaction bytes were produced. */
  readonly assembled: number;
}

export function observationStats(db: Db, sinceUtcMs: number | null): ObservationStats {
  const where = sinceUtcMs === null ? '' : ' WHERE requested_utc_ms >= ?';
  const args = sinceUtcMs === null ? [] : [sinceUtcMs];
  const r = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN instruction_set_hash IS NOT NULL THEN 1 ELSE 0 END),0) AS built,
              COALESCE(SUM(CASE WHEN instruction_policy='PASS' AND transaction_policy='PASS' THEN 1 ELSE 0 END),0) AS policyPass,
              COALESCE(SUM(CASE WHEN simulation='SIMULATED_OK' THEN 1 ELSE 0 END),0) AS simulated,
              COALESCE(SUM(CASE WHEN failure IN ('HTTP_429','HTTP_4XX','HTTP_5XX','TIMEOUT','SCHEMA_DRIFT') THEN 1 ELSE 0 END),0) AS providerFailures,
              COALESCE(SUM(CASE WHEN failure='NO_ROUTE' THEN 1 ELSE 0 END),0) AS noRoute,
              COALESCE(SUM(CASE WHEN serialized_transaction_hash IS NOT NULL THEN 1 ELSE 0 END),0) AS assembled
       FROM execution_observations${where}`,
    )
    .get(...(args as never[])) as Record<string, number>;
  return {
    total: r['total'] ?? 0,
    built: r['built'] ?? 0,
    policyPass: r['policyPass'] ?? 0,
    simulated: r['simulated'] ?? 0,
    providerFailures: r['providerFailures'] ?? 0,
    noRoute: r['noRoute'] ?? 0,
    assembled: r['assembled'] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// managed lifecycle
// ---------------------------------------------------------------------------

/**
 * States in which a position still holds value and must keep being worked.
 *
 * `EXIT_BLOCKED` is the one that matters. It used to be excluded from
 * `openPositions()`, so a position that could not be sold vanished from
 * marking, from exit management, from exposure and from every health surface —
 * while still nominally holding tokens. The state that most needs attention was
 * the one state nothing looked at.
 */
export const MANAGED_STATES = ['POSITION_OPEN', 'EXIT_INTENT', 'EXIT_BLOCKED', 'RECONCILING'] as const;
export type ManagedState = (typeof MANAGED_STATES)[number];

export interface ManagedPositionRow {
  position_id: string;
  mint: string;
  state: string;
  token_amount: string;
  cost_lamports: string;
  opened_utc_ms: number;
  peak_value_lamports: string | null;
  exit_blocked_since_utc_ms: number | null;
  exit_attempts: number;
  last_exit_attempt_utc_ms: number | null;
  last_exit_failure: string | null;
  entry_observation_id: string | null;
  route_family: string | null;
}

const MANAGED_SQL = MANAGED_STATES.map((s) => `'${s}'`).join(',');

export function managedPositions(db: Db): ManagedPositionRow[] {
  return db
    .prepare(`SELECT * FROM positions WHERE state IN (${MANAGED_SQL}) ORDER BY opened_utc_ms`)
    .all() as unknown as ManagedPositionRow[];
}

/**
 * The invariant, checked from first principles rather than through the helper.
 *
 * Any position holding tokens and not closed MUST appear in the managed set.
 * Returns the offenders, so a test and the health surface can both assert on
 * emptiness rather than trusting the query that has already been wrong once.
 */
export function unmanagedPositions(db: Db): { position_id: string; state: string; token_amount: string }[] {
  return db
    .prepare(
      `SELECT position_id, state, token_amount FROM positions
       WHERE closed_utc_ms IS NULL AND CAST(token_amount AS INTEGER) > 0
         AND state NOT IN (${MANAGED_SQL})`,
    )
    .all() as unknown as { position_id: string; state: string; token_amount: string }[];
}

export function markExitBlocked(
  db: Db,
  positionId: string,
  utcMs: number,
  failure: string,
): void {
  db.prepare(
    `UPDATE positions SET
       state = 'EXIT_BLOCKED',
       exit_blocked_since_utc_ms = COALESCE(exit_blocked_since_utc_ms, ?),
       exit_attempts = exit_attempts + 1,
       last_exit_attempt_utc_ms = ?,
       last_exit_failure = ?
     WHERE position_id = ?`,
  ).run(utcMs, utcMs, failure, positionId);
}

export function recordExitAttempt(db: Db, positionId: string, utcMs: number, failure: string | null): void {
  db.prepare(
    `UPDATE positions SET exit_attempts = exit_attempts + 1, last_exit_attempt_utc_ms = ?, last_exit_failure = ?
     WHERE position_id = ?`,
  ).run(utcMs, failure, positionId);
}

export function bindEntryObservation(db: Db, positionId: string, observationId: string, family: string): void {
  db.prepare('UPDATE positions SET entry_observation_id = ?, route_family = ? WHERE position_id = ?').run(
    observationId,
    family,
    positionId,
  );
}

export function bindExitObservation(db: Db, positionId: string, observationId: string): void {
  db.prepare('UPDATE positions SET exit_observation_id = ? WHERE position_id = ?').run(observationId, positionId);
}

// ---------------------------------------------------------------------------
// shadow books
// ---------------------------------------------------------------------------

export type ShadowBook = 'alpha_shadow' | 'canary_shadow';

export interface ShadowPosition {
  readonly shadowPositionId: string;
  readonly book: ShadowBook;
  readonly mint: string;
  readonly state: string;
  readonly notionalLamports: bigint;
  readonly tokenAmount: bigint;
  readonly costLamports: bigint;
  readonly entryObservationId: string | null;
  readonly openedUtcMs: number;
  readonly portfolioRefusal: string | null;
  readonly strategyVersion: string;
  readonly contextHash: string | null;
}

export function openShadowPosition(db: Db, p: Omit<ShadowPosition, 'shadowPositionId'>): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO shadow_positions
       (shadow_position_id,book,mint,state,notional_lamports,token_amount,cost_lamports,
        realized_lamports,peak_value_lamports,entry_observation_id,exit_observation_id,
        opened_utc_ms,closed_utc_ms,exit_reason,diagnostic,portfolio_refusal,strategy_version,context_hash)
     VALUES (?,?,?,?,?,?,?,NULL,?,?,NULL,?,NULL,NULL,NULL,?,?,?)`,
  ).run(
    id,
    p.book,
    p.mint,
    p.state,
    p.notionalLamports.toString(),
    p.tokenAmount.toString(),
    p.costLamports.toString(),
    p.costLamports.toString(),
    p.entryObservationId,
    p.openedUtcMs,
    p.portfolioRefusal,
    p.strategyVersion,
    p.contextHash,
  );
  return id;
}

export interface OpenShadowRow {
  shadow_position_id: string;
  book: string;
  mint: string;
  state: string;
  token_amount: string;
  cost_lamports: string;
  notional_lamports: string;
  peak_value_lamports: string | null;
  opened_utc_ms: number;
}

export function openShadowPositions(db: Db, book?: ShadowBook): OpenShadowRow[] {
  const sql =
    book === undefined
      ? `SELECT * FROM shadow_positions WHERE state IN (${MANAGED_SQL}) ORDER BY opened_utc_ms`
      : `SELECT * FROM shadow_positions WHERE book = ? AND state IN (${MANAGED_SQL}) ORDER BY opened_utc_ms`;
  const stmt = db.prepare(sql);
  return (book === undefined ? stmt.all() : stmt.all(book)) as unknown as OpenShadowRow[];
}

export function insertShadowMark(
  db: Db,
  m: {
    shadowPositionId: string;
    seq: number;
    observedUtcMs: number;
    observationId: string | null;
    executableValueLamports: bigint | null;
    routeAvailable: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO shadow_marks
       (shadow_mark_id,shadow_position_id,seq,observed_utc_ms,observation_id,executable_value_lamports,route_available)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(shadow_position_id,seq) DO NOTHING`,
  ).run(
    randomUUID(),
    m.shadowPositionId,
    m.seq,
    m.observedUtcMs,
    m.observationId,
    bn(m.executableValueLamports),
    m.routeAvailable ? 1 : 0,
  );
}

export function closeShadowPosition(
  db: Db,
  shadowPositionId: string,
  c: {
    realizedLamports: bigint;
    closedUtcMs: number;
    exitReason: string;
    diagnostic: string;
    exitObservationId: string | null;
  },
): void {
  db.prepare(
    `UPDATE shadow_positions SET state='POSITION_CLOSED', realized_lamports=?, closed_utc_ms=?,
       exit_reason=?, diagnostic=?, exit_observation_id=?, token_amount='0'
     WHERE shadow_position_id = ?`,
  ).run(
    c.realizedLamports.toString(),
    c.closedUtcMs,
    c.exitReason,
    c.diagnostic,
    c.exitObservationId,
    shadowPositionId,
  );
}

export function updateShadowPeak(db: Db, shadowPositionId: string, peak: bigint): void {
  db.prepare('UPDATE shadow_positions SET peak_value_lamports = ? WHERE shadow_position_id = ?').run(
    peak.toString(),
    shadowPositionId,
  );
}

export interface ShadowSummary {
  readonly book: string;
  readonly opened: number;
  readonly closed: number;
  readonly stillOpen: number;
  readonly realizedLamports: bigint;
  readonly openedAfterRefusal: number;
}

/**
 * Summarise a shadow book.
 *
 * `openedAfterRefusal` is the number the book exists for: positions the
 * realizable portfolio declined. If it is zero the shadow book is measuring
 * nothing the portfolio ledger does not already measure.
 *
 * Summed in bigint from TEXT, never through SQL SUM — a double is not exact
 * money.
 */
export function shadowSummary(db: Db, book: ShadowBook): ShadowSummary {
  const rows = db
    .prepare(
      'SELECT state, realized_lamports AS r, portfolio_refusal AS refusal FROM shadow_positions WHERE book = ?',
    )
    .all(book) as { state: string; r: string | null; refusal: string | null }[];
  let realized = 0n;
  let closed = 0;
  let stillOpen = 0;
  let afterRefusal = 0;
  for (const row of rows) {
    if (row.r !== null) realized += BigInt(row.r);
    if (row.state === 'POSITION_CLOSED') closed += 1;
    else stillOpen += 1;
    if (row.refusal !== null) afterRefusal += 1;
  }
  return { book, opened: rows.length, closed, stillOpen, realizedLamports: realized, openedAfterRefusal: afterRefusal };
}

// ---------------------------------------------------------------------------
// signal episodes
// ---------------------------------------------------------------------------

/**
 * Milliseconds after which the same mint counts as a NEW opportunity.
 *
 * Fifteen minutes. Long enough that a token rescreened every discovery cycle
 * stays one episode, short enough that a genuinely fresh setup hours later is
 * not silently merged into an old one. Frozen before collection; changing it
 * changes what "a trade" means and belongs in the multiple-testing ledger.
 */
export const EPISODE_COOLDOWN_MS = 900_000;

export interface EpisodeClaim {
  readonly signalEpisodeId: string;
  /** False when this mint is already an open episode for this book. */
  readonly isNew: boolean;
}

/**
 * Claim an episode for (mint, book).
 *
 * Returns `isNew: false` when the same mint in the same cooldown bucket has
 * already been claimed, which is the case a rescreen hits. The caller must not
 * open a second position on a `false`.
 *
 * The bucket is derived from wall time rather than stored state so the claim is
 * idempotent across restarts: the same rescreen after a crash lands in the same
 * bucket and is still refused.
 */
export function claimSignalEpisode(
  db: Db,
  mint: string,
  book: string,
  nowUtcMs: number,
  contextHash: string | null,
): EpisodeClaim {
  const bucket = Math.floor(nowUtcMs / EPISODE_COOLDOWN_MS);
  const id = `${book}:${mint}:${bucket}`;
  const existing = db
    .prepare('SELECT signal_episode_id FROM signal_episodes WHERE mint = ? AND book = ? AND cooldown_bucket = ?')
    .get(mint, book, bucket) as { signal_episode_id: string } | undefined;

  if (existing !== undefined) {
    db.prepare(
      'UPDATE signal_episodes SET screenings_seen = screenings_seen + 1, last_seen_utc_ms = ? WHERE signal_episode_id = ?',
    ).run(nowUtcMs, existing.signal_episode_id);
    return { signalEpisodeId: existing.signal_episode_id, isNew: false };
  }

  db.prepare(
    `INSERT INTO signal_episodes
       (signal_episode_id,mint,book,opened_utc_ms,cooldown_bucket,screenings_seen,last_seen_utc_ms,context_hash)
     VALUES (?,?,?,?,?,1,?,?)`,
  ).run(id, mint, book, nowUtcMs, bucket, nowUtcMs, contextHash);
  return { signalEpisodeId: id, isNew: true };
}

export function bindEpisode(
  db: Db,
  shadowPositionId: string,
  signalEpisodeId: string,
  sellObservationId: string | null,
  roundTripLossBps: number | null,
): void {
  db.prepare(
    `UPDATE shadow_positions
     SET signal_episode_id = ?, entry_sell_observation_id = ?, entry_round_trip_loss_bps = ?
     WHERE shadow_position_id = ?`,
  ).run(signalEpisodeId, sellObservationId, roundTripLossBps, shadowPositionId);
}

export interface EpisodeStats {
  readonly episodes: number;
  readonly rescreensAbsorbed: number;
  readonly maxScreeningsPerEpisode: number;
}

/**
 * How much duplication the episode key prevented.
 *
 * `rescreensAbsorbed` is the number of screenings that would each have become
 * their own shadow position under the old behaviour. It is the size of the
 * defect, measured rather than asserted.
 */
export function episodeStats(db: Db): EpisodeStats {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS episodes,
              COALESCE(SUM(screenings_seen - 1),0) AS absorbed,
              COALESCE(MAX(screenings_seen),0) AS maxSeen
       FROM signal_episodes`,
    )
    .get() as Record<string, number>;
  return {
    episodes: r['episodes'] ?? 0,
    rescreensAbsorbed: r['absorbed'] ?? 0,
    maxScreeningsPerEpisode: r['maxSeen'] ?? 0,
  };
}
