import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { classifyRejectOutcome } from '../../domain/src/rejectoutcome.js';
import type {
  Candidate,
  DecisionSnapshot,
  ExecutableQuote,
  ScreeningOutcome,
  Position,
  Fill,
  TradeIntent,
  PositionState,
} from '../../domain/src/types.js';

/**
 * Persistence helpers.
 *
 * Rule enforced here: bigints are written as TEXT and read back as bigint.
 * Nothing in this file may return a number where an amount is expected.
 */

export function newId(): string {
  return randomUUID();
}

export function insertCandidate(db: Db, c: Candidate): void {
  db.prepare(
    `INSERT INTO candidates
      (mint,name,symbol,decimals,token_program,creator,launchpad,first_seen_utc_ms,created_at_utc_ms,
       source,source_type,payload_hash,schema_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(mint) DO NOTHING`,
  ).run(
    c.mint,
    c.name,
    c.symbol,
    c.decimals,
    c.tokenProgram,
    c.creator,
    c.launchpad,
    c.firstSeenUtcMs,
    c.createdAtUtcMs,
    c.provenance.source,
    c.provenance.sourceType,
    c.provenance.payloadHash,
    c.provenance.schemaVersion,
  );
}

export function candidateExists(db: Db, mint: string): boolean {
  return db.prepare('SELECT 1 FROM candidates WHERE mint = ?').get(mint) !== undefined;
}

/**
 * Mints that have aged INTO the eligible window since discovery.
 *
 * This exists because the discovery feed and the strategy disagree by design:
 * `/tokens/v2/recent` only contains tokens whose first pool was just created,
 * while the strategy deliberately refuses to touch anything that young. Without
 * this queue the two never intersect and no candidate can ever be evaluated.
 */
/**
 * P16 — the maturing queue, per COHORT.
 *
 * `maturingMints` takes one window from `config.gates`, so only the configured
 * 2m–60m band was ever fed. `AGE_1H_5H`, `AGE_5H_24H` and `AGE_24H_7D` were
 * defined, given bounds, assigned to rows, and never had a single candidate
 * mature into them. Four arms on paper, one arm running — and comparing them
 * would have compared one populated cohort against three empty ones.
 *
 * Each cohort gets its OWN quota rather than sharing one limit. A shared limit
 * ordered by last-screened would be consumed by whichever band has the most
 * candidates, which is always the youngest, and the older arms would starve
 * exactly as they did before.
 */
export function maturingByCohort(
  db: Db,
  nowUtcMs: number,
  bounds: Readonly<Record<string, { fromMs: number; toMs: number }>>,
  perCohortLimit: number,
): { cohort: string; mint: string }[] {
  const out: { cohort: string; mint: string }[] = [];
  const seen = new Set<string>();
  for (const [cohort, b] of Object.entries(bounds)) {
    let rows: { mint: string }[];
    try {
      rows = db
        .prepare(
          `SELECT c.mint AS mint FROM candidates c
            LEFT JOIN (SELECT mint, MAX(evaluated_utc_ms) AS last_eval FROM screenings GROUP BY mint) s
              ON s.mint = c.mint
            WHERE COALESCE(c.created_at_utc_ms, c.first_seen_utc_ms) BETWEEN ? AND ?
            ORDER BY COALESCE(s.last_eval, 0) ASC
            LIMIT ?`,
        )
        .all(nowUtcMs - b.toMs, nowUtcMs - b.fromMs, perCohortLimit) as { mint: string }[];
    } catch {
      rows = [];
    }
    for (const r of rows) {
      // The bands are half-open and disjoint, so a mint cannot legitimately
      // appear twice; if it does, the first (younger) cohort keeps it rather
      // than the same token being screened once per band.
      if (seen.has(r.mint)) continue;
      seen.add(r.mint);
      out.push({ cohort, mint: r.mint });
    }
  }
  return out;
}

export function maturingMints(
  db: Db,
  nowUtcMs: number,
  minAgeMs: number,
  maxAgeMs: number,
  limit: number,
): string[] {
  // Least-recently-screened first. Ordering by age instead would pin the queue
  // to the youngest end of the window and the older half would never be looked
  // at again — which is precisely the half the strategy is waiting for.
  const rows = db
    .prepare(
      `SELECT c.mint AS mint FROM candidates c
        LEFT JOIN (SELECT mint, MAX(evaluated_utc_ms) AS last_eval FROM screenings GROUP BY mint) s
          ON s.mint = c.mint
        WHERE COALESCE(c.created_at_utc_ms, c.first_seen_utc_ms) BETWEEN ? AND ?
        ORDER BY COALESCE(s.last_eval, 0) ASC
        LIMIT ?`,
    )
    .all(nowUtcMs - maxAgeMs, nowUtcMs - minAgeMs, limit) as { mint: string }[];
  return rows.map((r) => r.mint);
}

export function insertSnapshot(db: Db, s: DecisionSnapshot): void {
  db.prepare(
    `INSERT INTO decision_snapshots
      (snapshot_id,mint,taken_utc_ms,taken_mono_ms,slot,token_age_ms,features_json,raw_inputs_json,freshness_json)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    s.snapshotId,
    s.mint,
    s.takenUtcMs,
    s.takenMonotonicMs,
    s.slot,
    s.tokenAgeMs,
    JSON.stringify(s.features),
    JSON.stringify(s.rawInputs),
    JSON.stringify(s.freshnessMs),
  );
}

export function insertScreening(db: Db, o: ScreeningOutcome): string {
  const id = newId();
  db.prepare(
    `INSERT INTO screenings
      (screening_id,mint,snapshot_id,evaluated_utc_ms,eligible,hard_vetoes_json,soft_risk_score,
       opportunity_score,components_json,gates_json,strategy_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    o.mint,
    o.snapshotId,
    o.evaluatedUtcMs,
    o.eligible ? 1 : 0,
    JSON.stringify(o.hardVetoes),
    o.softRiskScore,
    o.opportunityScore,
    JSON.stringify(o.scoreComponents),
    JSON.stringify(o.gates),
    o.strategyVersion,
  );
  return id;
}

export function insertQuote(
  db: Db,
  mint: string,
  side: 'buy' | 'sell',
  q: ExecutableQuote,
  /** Hash of the stored raw body, when the caller persisted one. */
  rawPayloadHash: string | null = null,
  contextHash: string | null = null,
): void {
  db.prepare(
    `INSERT INTO quotes
      (quote_id,mint,input_mint,output_mint,in_amount,out_amount,other_amount_threshold,slippage_bps,
       platform_fee_bps,price_impact_pct,router,route_labels,signature_fee_lamports,
       prioritization_fee_lamports,rent_fee_lamports,transaction_buildable,error_code,error_message,
       requested_utc_ms,received_utc_ms,latency_ms,side,
       fee_mint,platform_fee_amount,raw_payload_hash,impact_schema_status,adverse_impact_bps,context_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(quote_id) DO NOTHING`,
  ).run(
    q.quoteId,
    mint,
    q.inputMint,
    q.outputMint,
    q.inAmount.toString(),
    q.outAmount.toString(),
    q.otherAmountThreshold.toString(),
    q.slippageBps,
    q.platformFeeBps,
    q.priceImpactPct,
    q.router,
    q.routeLabels.join('>'),
    q.signatureFeeLamports.toString(),
    q.prioritizationFeeLamports.toString(),
    q.rentFeeLamports.toString(),
    q.transactionBuildable ? 1 : 0,
    q.errorCode,
    q.errorMessage,
    q.requestedUtcMs,
    q.receivedUtcMs,
    q.latencyMs,
    side,
    q.feeMint,
    q.platformFeeAmount === null ? null : q.platformFeeAmount.toString(),
    rawPayloadHash,
    // Recorded even when OK, so "the parser was satisfied" is a stored fact
    // rather than an inference drawn from the absence of a complaint.
    q.impact.status,
    q.impact.adverseBps,
    contextHash,
  );
}

export function recordRejectObservation(
  db: Db,
  mint: string,
  rejectedUtcMs: number,
  primaryReason: string,
  obs: {
    priceUsd: number | null;
    liquidityUsd: number | null;
    routeExists: boolean | null;
    /**
     * §17 — the evidence needed to classify what actually happened.
     *
     * Optional so existing callers keep working, and absent evidence produces
     * UNKNOWN rather than a guess. What it must never produce is a return: a
     * NULL price read as a number is zero, zero means the token went to
     * nothing, and every gate then looks brilliant for rejecting things that
     * "went to zero" when a provider simply stopped answering.
     */
    providerAnswered?: boolean;
    executableValueLamports?: bigint | null;
    buildable?: boolean | null;
    poolReservesLamports?: bigint | null;
    sourceGap?: boolean;
  },
): void {
  const now = Date.now();
  const outcome = classifyRejectOutcome({
    // A price came back at all, so somebody answered -- unless the caller says
    // otherwise. Callers that know better pass it explicitly.
    providerAnswered: obs.providerAnswered ?? obs.priceUsd !== null,
    routeExists: obs.routeExists,
    executableValueLamports: obs.executableValueLamports ?? null,
    buildable: obs.buildable ?? null,
    poolReservesLamports: obs.poolReservesLamports ?? null,
    sourceGap: obs.sourceGap ?? false,
  });
  db.prepare(
    `INSERT INTO reject_tracking
      (id,mint,rejected_utc_ms,primary_reason,observed_utc_ms,price_usd,liquidity_usd,route_exists,horizon_ms,
       outcome,executable_value_lamports,provider_answered,buildable,pool_reserves_lamports)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId(),
    mint,
    rejectedUtcMs,
    primaryReason,
    now,
    obs.priceUsd,
    obs.liquidityUsd,
    obs.routeExists === null ? null : obs.routeExists ? 1 : 0,
    now - rejectedUtcMs,
    outcome,
    obs.executableValueLamports === undefined || obs.executableValueLamports === null
      ? null
      : obs.executableValueLamports.toString(),
    obs.providerAnswered === undefined ? null : obs.providerAnswered ? 1 : 0,
    obs.buildable === undefined || obs.buildable === null ? null : obs.buildable ? 1 : 0,
    obs.poolReservesLamports === undefined || obs.poolReservesLamports === null
      ? null
      : obs.poolReservesLamports.toString(),
  );
}

export interface FollowUpTarget {
  readonly mint: string;
  /** First time this mint was ever rejected; the anchor every horizon is measured from. */
  readonly anchorUtcMs: number;
  readonly primaryReason: string;
  readonly observations: number;
}

/**
 * Mints that were rejected and are now due for a forward re-observation.
 *
 * Without this, `reject_tracking` only ever records the instant of rejection,
 * and the question the table exists to answer — what did the tokens we refused
 * actually do next — is unanswerable. A filter that looks strict is worthless
 * unless we can show the things it removed were worth removing.
 *
 * Anchored on each mint's FIRST rejection so a horizon means the same thing for
 * every row, even though an actively-screened mint is re-rejected every cycle.
 */
export function rejectsNeedingFollowUp(
  db: Db,
  nowUtcMs: number,
  opts: { lookbackMs: number; minGapMs: number; maxObservations: number; limit: number },
): FollowUpTarget[] {
  // `n` counts FORWARD observations only. Counting every row would permanently
  // exclude the mints we most want to follow: one that is re-screened each cycle
  // accumulates dozens of zero-horizon rejection rows within minutes, and would
  // hit any all-rows cap long before a single forward observation was taken.
  const rows = db
    .prepare(
      `SELECT mint,
              MIN(rejected_utc_ms) AS anchor,
              MAX(CASE WHEN horizon_ms > ? THEN observed_utc_ms ELSE 0 END) AS last_forward,
              SUM(CASE WHEN horizon_ms > ? THEN 1 ELSE 0 END) AS n
       FROM reject_tracking
       WHERE rejected_utc_ms >= ?
       GROUP BY mint
       HAVING last_forward <= ? AND n < ?
       ORDER BY n ASC, anchor ASC
       LIMIT ?`,
    )
    .all(
      opts.minGapMs,
      opts.minGapMs,
      nowUtcMs - opts.lookbackMs,
      nowUtcMs - opts.minGapMs,
      opts.maxObservations,
      opts.limit,
    ) as unknown as { mint: string; anchor: number; last_forward: number; n: number }[];

  if (rows.length === 0) return [];

  // The reason attached to the anchor, not to whichever rejection happened last:
  // grouping outcomes by a later reason would attribute a token's fate to a gate
  // that fired only after the token had already changed.
  const reasons = new Map<string, string>();
  const placeholders = rows.map(() => '?').join(',');
  const reasonRows = db
    .prepare(
      `SELECT r.mint AS mint, r.primary_reason AS reason
       FROM reject_tracking r
       JOIN (SELECT mint, MIN(rejected_utc_ms) AS a FROM reject_tracking
             WHERE mint IN (${placeholders}) GROUP BY mint) f
         ON f.mint = r.mint AND f.a = r.rejected_utc_ms`,
    )
    .all(...rows.map((r) => r.mint)) as unknown as { mint: string; reason: string }[];
  for (const r of reasonRows) if (!reasons.has(r.mint)) reasons.set(r.mint, r.reason);

  return rows.map((r) => ({
    mint: r.mint,
    anchorUtcMs: r.anchor,
    primaryReason: reasons.get(r.mint) ?? 'unknown',
    observations: r.n,
  }));
}

/**
 * Appends a forward observation against an existing rejection anchor. Kept
 * separate from `recordRejectObservation` because the horizon here is real
 * elapsed time rather than the few milliseconds it takes to write the initial
 * row, and conflating the two would make every horizon statistic meaningless.
 */
export function recordForwardObservation(
  db: Db,
  target: FollowUpTarget,
  observedUtcMs: number,
  obs: { priceUsd: number | null; liquidityUsd: number | null; routeExists: boolean | null },
): void {
  db.prepare(
    `INSERT INTO reject_tracking
      (id,mint,rejected_utc_ms,primary_reason,observed_utc_ms,price_usd,liquidity_usd,route_exists,horizon_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId(),
    target.mint,
    target.anchorUtcMs,
    target.primaryReason,
    observedUtcMs,
    obs.priceUsd,
    obs.liquidityUsd,
    obs.routeExists === null ? null : obs.routeExists ? 1 : 0,
    observedUtcMs - target.anchorUtcMs,
  );
}

/**
 * Records an intent, or returns the one already recorded under the same
 * idempotency key.
 *
 * Idempotency lives in the UNIQUE constraint rather than in a read-then-write,
 * because a read-then-write is not atomic across a crash and this is exactly
 * the operation a crash is most likely to interrupt. The caller learns whether
 * it created the intent or found it, and a "found" result means some earlier
 * attempt may already be in flight.
 */
export function claimIntent(db: Db, intent: TradeIntent, simulated: boolean): { created: boolean; intentId: string } {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO intents
        (intent_id,idempotency_key,mint,side,input_mint,output_mint,max_input_amount,min_output_amount,
         max_total_fee_lamports,max_priority_fee_lamports,deadline_utc_ms,strategy_version,risk_snapshot_hash,
         created_utc_ms,state,simulated)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      intent.intentId,
      intent.idempotencyKey,
      intent.mint,
      intent.side,
      intent.inputMint,
      intent.outputMint,
      intent.maxInputAmount.toString(),
      intent.minOutputAmount.toString(),
      intent.maxTotalFeeLamports.toString(),
      intent.maxPriorityFeeLamports.toString(),
      intent.deadlineUtcMs,
      intent.strategyVersion,
      intent.riskSnapshotHash,
      intent.createdUtcMs,
      'INTENT_CREATED' satisfies PositionState,
      simulated ? 1 : 0,
    );
  if (result.changes === 1) return { created: true, intentId: intent.intentId };
  const existing = db
    .prepare('SELECT intent_id FROM intents WHERE idempotency_key = ?')
    .get(intent.idempotencyKey) as { intent_id: string } | undefined;
  if (existing === undefined) {
    throw new Error(`intent ${intent.idempotencyKey} was neither inserted nor found`);
  }
  return { created: false, intentId: existing.intent_id };
}

export function setIntentState(db: Db, intentId: string, state: PositionState): void {
  db.prepare('UPDATE intents SET state = ? WHERE intent_id = ?').run(state, intentId);
}

export interface IntentRow {
  intent_id: string;
  idempotency_key: string;
  mint: string;
  side: string;
  input_mint: string;
  output_mint: string;
  max_input_amount: string;
  min_output_amount: string;
  max_total_fee_lamports: string;
  max_priority_fee_lamports: string;
  deadline_utc_ms: number;
  strategy_version: string;
  risk_snapshot_hash: string;
  created_utc_ms: number;
  state: string;
  simulated: number;
}

export function intentById(db: Db, intentId: string): IntentRow | null {
  return (db.prepare('SELECT * FROM intents WHERE intent_id = ?').get(intentId) as IntentRow | undefined) ?? null;
}

export type AttemptOutcome = 'SIGNED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'UNKNOWN';

export interface AttemptRow {
  attempt_id: string;
  intent_id: string;
  attempt_no: number;
  signature: string;
  blockhash: string;
  last_valid_height: number;
  signed_utc_ms: number;
  sent_utc_ms: number | null;
  send_error: string | null;
  outcome: string;
  landed_slot: number | null;
  chain_error: string | null;
  resolved_utc_ms: number | null;
}

/**
 * Written after signing and BEFORE sending. The signature is deterministic
 * given the message, so it identifies the transaction whether or not the send
 * call returns — which is the whole reason this row exists.
 */
export function recordAttempt(
  db: Db,
  a: {
    attemptId: string;
    intentId: string;
    attemptNo: number;
    signature: string;
    blockhash: string;
    lastValidHeight: number;
    signedUtcMs: number;
    simulatedOut: bigint | null;
    simulatedIn: bigint | null;
  },
): void {
  db.prepare(
    `INSERT INTO execution_attempts
      (attempt_id,intent_id,attempt_no,signature,blockhash,last_valid_height,signed_utc_ms,outcome,
       simulated_out,simulated_in)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    a.attemptId,
    a.intentId,
    a.attemptNo,
    a.signature,
    a.blockhash,
    a.lastValidHeight,
    a.signedUtcMs,
    'SIGNED' satisfies AttemptOutcome,
    a.simulatedOut === null ? null : a.simulatedOut.toString(),
    a.simulatedIn === null ? null : a.simulatedIn.toString(),
  );
}

export function updateAttempt(
  db: Db,
  attemptId: string,
  fields: {
    outcome?: AttemptOutcome;
    sentUtcMs?: number;
    sendError?: string | null;
    landedSlot?: number | null;
    chainError?: string | null;
    resolvedUtcMs?: number | null;
  },
): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const push = (col: string, v: string | number | null): void => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (fields.outcome !== undefined) push('outcome', fields.outcome);
  if (fields.sentUtcMs !== undefined) push('sent_utc_ms', fields.sentUtcMs);
  if (fields.sendError !== undefined) push('send_error', fields.sendError);
  if (fields.landedSlot !== undefined) push('landed_slot', fields.landedSlot);
  if (fields.chainError !== undefined) push('chain_error', fields.chainError);
  if (fields.resolvedUtcMs !== undefined) push('resolved_utc_ms', fields.resolvedUtcMs);
  if (sets.length === 0) return;
  vals.push(attemptId);
  db.prepare(`UPDATE execution_attempts SET ${sets.join(', ')} WHERE attempt_id = ?`).run(...vals);
}

/** Attempts whose fate is not yet known. These block any further action on their intent. */
export function unresolvedAttempts(db: Db): AttemptRow[] {
  return db
    .prepare(
      `SELECT * FROM execution_attempts WHERE outcome IN ('SIGNED','SUBMITTED','UNKNOWN') ORDER BY signed_utc_ms`,
    )
    .all() as unknown as AttemptRow[];
}

export function attemptCount(db: Db, intentId: string): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM execution_attempts WHERE intent_id = ?').get(intentId) as
    | { n: number }
    | undefined;
  return r?.n ?? 0;
}

export function recordSignRefusal(db: Db, intentId: string, kind: string, detail: string): void {
  db.prepare('INSERT INTO sign_refusals (intent_id,utc_ms,kind,detail) VALUES (?,?,?,?)').run(
    intentId,
    Date.now(),
    kind,
    detail.slice(0, 2000),
  );
}

export function insertPosition(db: Db, p: Position): void {
  db.prepare(
    `INSERT INTO positions
      (position_id,mint,state,token_amount,cost_lamports,realized_lamports,opened_utc_ms,closed_utc_ms,
       strategy_version,simulated,exit_reason,peak_value_lamports,
       execution_cost_lamports,gross_proceeds_lamports,net_pnl_lamports,
       entry_cash_out_lamports,exit_cash_in_lamports,locked_rent_lamports,residual_token_atoms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    p.positionId,
    p.mint,
    p.state,
    p.tokenAmount.toString(),
    p.costLamports.toString(),
    p.realizedLamports.toString(),
    p.openedUtcMs,
    p.closedUtcMs,
    p.strategyVersion,
    p.simulated ? 1 : 0,
    null,
    p.costLamports.toString(),
    // P4 — written at open, from the measured settlement. NULL on the two that
    // an open position genuinely does not have yet, which is not zero.
    p.executionCostLamports === undefined || p.executionCostLamports === null
      ? null
      : p.executionCostLamports.toString(),
    p.grossProceedsLamports === undefined || p.grossProceedsLamports === null
      ? null
      : p.grossProceedsLamports.toString(),
    p.netPnlLamports === undefined || p.netPnlLamports === null ? null : p.netPnlLamports.toString(),
    // P9 — NULL is undetermined, never zero. An open position has no exit cash
    // in, and an unobserved residual is not a residual of zero.
    p.entryCashOutLamports === undefined || p.entryCashOutLamports === null
      ? null
      : p.entryCashOutLamports.toString(),
    p.exitCashInLamports === undefined || p.exitCashInLamports === null ? null : p.exitCashInLamports.toString(),
    p.lockedRentLamports === undefined || p.lockedRentLamports === null ? null : p.lockedRentLamports.toString(),
    p.residualTokenAtoms === undefined || p.residualTokenAtoms === null ? null : p.residualTokenAtoms.toString(),
  );
}

export function updatePosition(
  db: Db,
  positionId: string,
  fields: {
    state?: string;
    realizedLamports?: bigint;
    closedUtcMs?: number | null;
    exitReason?: string | null;
    peakValueLamports?: bigint;
    tokenAmount?: bigint;
    /** P4 — settled at close, from the measured exit settlement. */
    executionCostLamports?: bigint;
    grossProceedsLamports?: bigint;
    netPnlLamports?: bigint;
    entryCashOutLamports?: bigint;
    exitCashInLamports?: bigint;
    lockedRentLamports?: bigint;
    residualTokenAtoms?: bigint;
    /** P10 — the trigger, and the latency the fill actually took. */
    exitTriggeredUtcMs?: number;
    exitTriggerObservationId?: string;
    exitTriggerReason?: string;
    exitFillLatencyMs?: number;
  },
): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [field, column] of [
    ['executionCostLamports', 'execution_cost_lamports'],
    ['grossProceedsLamports', 'gross_proceeds_lamports'],
    ['netPnlLamports', 'net_pnl_lamports'],
    ['entryCashOutLamports', 'entry_cash_out_lamports'],
    ['exitCashInLamports', 'exit_cash_in_lamports'],
    ['lockedRentLamports', 'locked_rent_lamports'],
    ['residualTokenAtoms', 'residual_token_atoms'],
  ] as const) {
    const v = fields[field];
    if (v !== undefined) {
      sets.push(`${column} = ?`);
      vals.push(v.toString());
    }
  }
  for (const [field, column] of [
    ['exitTriggeredUtcMs', 'exit_triggered_utc_ms'],
    ['exitTriggerObservationId', 'exit_trigger_observation_id'],
    ['exitTriggerReason', 'exit_trigger_reason'],
    ['exitFillLatencyMs', 'exit_fill_latency_ms'],
  ] as const) {
    const v = fields[field];
    if (v !== undefined) {
      sets.push(`${column} = ?`);
      vals.push(typeof v === 'number' ? v : String(v));
    }
  }
  if (fields.state !== undefined) {
    sets.push('state = ?');
    vals.push(fields.state);
  }
  if (fields.realizedLamports !== undefined) {
    sets.push('realized_lamports = ?');
    vals.push(fields.realizedLamports.toString());
  }
  if (fields.closedUtcMs !== undefined) {
    sets.push('closed_utc_ms = ?');
    vals.push(fields.closedUtcMs);
  }
  if (fields.exitReason !== undefined) {
    sets.push('exit_reason = ?');
    vals.push(fields.exitReason);
  }
  if (fields.peakValueLamports !== undefined) {
    sets.push('peak_value_lamports = ?');
    vals.push(fields.peakValueLamports.toString());
  }
  if (fields.tokenAmount !== undefined) {
    sets.push('token_amount = ?');
    vals.push(fields.tokenAmount.toString());
  }
  if (sets.length === 0) return;
  vals.push(positionId);
  db.prepare(`UPDATE positions SET ${sets.join(', ')} WHERE position_id = ?`).run(...vals);
}

export interface OpenPositionRow {
  position_id: string;
  mint: string;
  state: string;
  token_amount: string;
  cost_lamports: string;
  realized_lamports: string;
  opened_utc_ms: number;
  strategy_version: string;
  peak_value_lamports: string | null;
}

export function openPositions(db: Db): OpenPositionRow[] {
  return db
    .prepare(`SELECT * FROM positions WHERE state IN ('POSITION_OPEN','EXIT_INTENT') ORDER BY opened_utc_ms`)
    .all() as unknown as OpenPositionRow[];
}

export function insertFill(db: Db, f: Fill): void {
  db.prepare(
    `INSERT INTO fills
      (fill_id,intent_id,mint,side,actual_in_amount,actual_out_amount,fee_lamports,priority_fee_lamports,
       rent_lamports,signature,slot,simulated,utc_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    f.fillId,
    f.intentId,
    f.mint,
    f.side,
    f.actualInAmount.toString(),
    f.actualOutAmount.toString(),
    f.feeLamports.toString(),
    f.priorityFeeLamports.toString(),
    f.rentLamports.toString(),
    f.signature,
    f.slot,
    f.simulated ? 1 : 0,
    f.utcMs,
  );
}

export function recordHealth(db: Db, kind: string, severity: 'info' | 'warn' | 'critical', detail: string): void {
  db.prepare('INSERT INTO health_events (utc_ms,kind,severity,detail) VALUES (?,?,?,?)').run(
    Date.now(),
    kind,
    severity,
    detail.slice(0, 500),
  );
}

export function recordSourceHealth(
  db: Db,
  source: string,
  ok: boolean,
  latencyMs: number | null,
  errorKind: string | null,
): void {
  db.prepare(
    'INSERT INTO source_health (source,utc_ms,ok,latency_ms,error_kind) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',
  ).run(source, Date.now(), ok ? 1 : 0, latencyMs, errorKind);
}

export function recordTrial(
  db: Db,
  description: string,
  params: unknown,
  metric: string,
  value: number | null,
  sampleSize: number | null,
): void {
  db.prepare('INSERT INTO trials (trial_id,utc_ms,description,params_json,metric,value,sample_size) VALUES (?,?,?,?,?,?,?)').run(
    newId(),
    Date.now(),
    description,
    JSON.stringify(params),
    metric,
    value,
    sampleSize,
  );
}

export interface ObserveCounters {
  candidates: number;
  screenings: number;
  eligible: number;
  quotes: number;
}

export function counters(db: Db): ObserveCounters {
  const one = (sql: string): number => {
    const r = db.prepare(sql).get() as { c: number } | undefined;
    return r?.c ?? 0;
  };
  return {
    candidates: one('SELECT COUNT(*) AS c FROM candidates'),
    screenings: one('SELECT COUNT(*) AS c FROM screenings'),
    eligible: one('SELECT COUNT(*) AS c FROM screenings WHERE eligible = 1'),
    quotes: one('SELECT COUNT(*) AS c FROM quotes'),
  };
}

/** Aggregate rejection reasons, the primary observe-mode output. */
export function rejectionBreakdown(db: Db, sinceUtcMs = 0): { reason: string; count: number }[] {
  const rows = db
    .prepare('SELECT hard_vetoes_json AS v FROM screenings WHERE evaluated_utc_ms >= ? AND eligible = 0')
    .all(sinceUtcMs) as { v: string }[];
  const tally = new Map<string, number>();
  for (const r of rows) {
    let reasons: string[] = [];
    try {
      reasons = JSON.parse(r.v) as string[];
    } catch {
      continue;
    }
    for (const reason of reasons) tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  return [...tally.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

/**
 * Position marks and terminal exit records (migration 5).
 *
 * The rule enforced in this section: NULL means unknown and is written as
 * NULL. Nothing here is defaulted to zero to make a row look complete, because
 * the defect these tables exist to fix (O032) was precisely a number that
 * looked meaningful and was not.
 */

export interface PositionMark {
  readonly markId: string;
  readonly positionId: string;
  readonly mint: string;
  readonly seq: number;
  readonly observedUtcMs: number;

  /** Provider diagnostic, raw and signed. Never used to classify. */
  readonly rawPriceImpactPct: number | null;
  readonly rawPriceImpactBpsSigned: number | null;

  readonly quotedExitInputTokenAmount: bigint | null;
  readonly quotedExitOutputLamports: bigint | null;
  readonly quotedExitThresholdLamports: bigint | null;
  readonly positionEntryCostLamports: bigint;
  readonly positionMarkedValueLamports: bigint | null;
  readonly exitValueRatio: number | null;
  readonly outputChangeFromPreviousMarkBps: number | null;

  readonly routeAvailable: boolean;
  readonly routeLabels: string | null;

  readonly platformFeeBps: number | null;
  readonly platformFeeAmount: bigint | null;
  readonly transferFeeAmount: bigint | null;
  readonly estimatedNetworkFeeLamports: bigint | null;
  readonly estimatedPriorityFeeLamports: bigint | null;

  readonly poolQuoteReserve: bigint | null;
  readonly poolTokenReserve: bigint | null;
  readonly quoteReserveChangeFromEntryBps: number | null;
  readonly quoteReserveChangeFromPrevBps: number | null;
  readonly liquidityUsd: number | null;
  readonly liquidityChangeFromEntryBps: number | null;

  readonly developerNetTokenFlow: bigint | null;
  readonly clusteredInsiderNetTokenFlow: bigint | null;

  readonly quoteRequestedUtcMs: number | null;
  readonly quoteReceivedUtcMs: number | null;
  readonly quoteLatencyMs: number | null;
  readonly sourceUtcMs: number | null;
  readonly slot: number | null;
  readonly source: string;
  readonly backfilled: boolean;

  /**
   * P9 -- what priced this mark, and whether it may drive a decision.
   *
   * `ORDER_QUOTE_BENCHMARK` is a router's opinion about a swap nobody built.
   * It is cheap, useful, and must never move a stop. Absent means the row
   * predates the distinction, which is the same thing as not decision-bearing.
   */
  readonly markSource?: 'BUILD_CUSTOM_SELL' | 'PUMP_DIRECT' | 'ORDER_QUOTE_BENCHMARK' | null;
  readonly markObservationId?: string | null;
  readonly benchmarkOrderLamports?: bigint | null;
  /** How far the cheap number sits from the executable one. Signed. */
  readonly benchmarkMinusExecutableBps?: number | null;
  readonly decisionBearing?: boolean;
}

/** bigint-or-null to TEXT-or-NULL. Keeps every amount out of float space. */
const bnOrNull = (v: bigint | null): string | null => (v === null ? null : v.toString());

export function insertPositionMark(db: Db, m: PositionMark): void {
  db.prepare(
    `INSERT INTO position_marks
      (mark_id,position_id,mint,seq,observed_utc_ms,
       raw_price_impact_pct,raw_price_impact_bps_signed,
       quoted_exit_input_token_amount,quoted_exit_output_lamports,quoted_exit_threshold_lamports,
       position_entry_cost_lamports,position_marked_value_lamports,exit_value_ratio,
       output_change_from_previous_mark_bps,route_available,route_labels,
       platform_fee_bps,platform_fee_amount,transfer_fee_amount,
       estimated_network_fee_lamports,estimated_priority_fee_lamports,
       pool_quote_reserve,pool_token_reserve,quote_reserve_change_from_entry_bps,
       quote_reserve_change_from_prev_bps,liquidity_usd,liquidity_change_from_entry_bps,
       developer_net_token_flow,clustered_insider_net_token_flow,
       quote_requested_utc_ms,quote_received_utc_ms,quote_latency_ms,source_utc_ms,slot,source,backfilled,
       mark_source,mark_observation_id,benchmark_order_lamports,benchmark_minus_executable_bps,decision_bearing)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(position_id,seq) DO NOTHING`,
  ).run(
    m.markId,
    m.positionId,
    m.mint,
    m.seq,
    m.observedUtcMs,
    m.rawPriceImpactPct,
    m.rawPriceImpactBpsSigned,
    bnOrNull(m.quotedExitInputTokenAmount),
    bnOrNull(m.quotedExitOutputLamports),
    bnOrNull(m.quotedExitThresholdLamports),
    m.positionEntryCostLamports.toString(),
    bnOrNull(m.positionMarkedValueLamports),
    m.exitValueRatio,
    m.outputChangeFromPreviousMarkBps,
    m.routeAvailable ? 1 : 0,
    m.routeLabels,
    m.platformFeeBps,
    bnOrNull(m.platformFeeAmount),
    bnOrNull(m.transferFeeAmount),
    bnOrNull(m.estimatedNetworkFeeLamports),
    bnOrNull(m.estimatedPriorityFeeLamports),
    bnOrNull(m.poolQuoteReserve),
    bnOrNull(m.poolTokenReserve),
    m.quoteReserveChangeFromEntryBps,
    m.quoteReserveChangeFromPrevBps,
    m.liquidityUsd,
    m.liquidityChangeFromEntryBps,
    bnOrNull(m.developerNetTokenFlow),
    bnOrNull(m.clusteredInsiderNetTokenFlow),
    m.quoteRequestedUtcMs,
    m.quoteReceivedUtcMs,
    m.quoteLatencyMs,
    m.sourceUtcMs,
    m.slot,
    m.source,
    m.backfilled ? 1 : 0,
    m.markSource ?? null,
    m.markObservationId ?? null,
    bnOrNull(m.benchmarkOrderLamports ?? null),
    m.benchmarkMinusExecutableBps ?? null,
    m.decisionBearing === true ? 1 : 0,
  );
}

export interface PositionExit {
  readonly positionId: string;
  readonly mint: string;
  /** ExitOutcome — what happened economically. */
  readonly outcome: string;
  /** TriggerRule — which rule noticed. Deliberately a separate column. */
  readonly triggerRule: string;
  readonly outcomeRationale: string;
  readonly exitValueRatio: number | null;

  readonly positionEntryCostLamports: bigint;
  readonly quotedExitOutputLamports: bigint | null;
  /** Lamports the swap returned, before exit fees. Never negative. */
  readonly grossProceedsLamports: bigint | null;
  readonly exitFeesLamports: bigint | null;
  /** gross - fees. May be negative, which is a real economic statement. */
  readonly netProceedsLamports: bigint | null;
  readonly realizedLamports: bigint;

  readonly entryNotionalLamports: bigint | null;
  readonly entryFixedCostsLamports: bigint | null;
  readonly ataRentLamports: bigint | null;
  /** Null when unknown. Paper has never modelled the refund; see O033. */
  readonly ataRentRefunded: boolean | null;

  readonly finalMarkId: string | null;
  readonly marksObserved: number;
  readonly openedUtcMs: number;
  readonly closedUtcMs: number | null;
  readonly heldMs: number | null;
  readonly strategyVersion: string;
  readonly accountingVersion: string;
  readonly backfilled: boolean;
}

export function insertPositionExit(db: Db, e: PositionExit): void {
  db.prepare(
    `INSERT INTO position_exits
      (position_id,mint,outcome,trigger_rule,outcome_rationale,exit_value_ratio,
       position_entry_cost_lamports,quoted_exit_output_lamports,gross_proceeds_lamports,
       exit_fees_lamports,net_proceeds_lamports,realized_lamports,
       entry_notional_lamports,entry_fixed_costs_lamports,ata_rent_lamports,ata_rent_refunded,
       final_mark_id,marks_observed,opened_utc_ms,closed_utc_ms,held_ms,
       strategy_version,accounting_version,backfilled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(position_id) DO UPDATE SET
       outcome=excluded.outcome, trigger_rule=excluded.trigger_rule,
       outcome_rationale=excluded.outcome_rationale, exit_value_ratio=excluded.exit_value_ratio,
       quoted_exit_output_lamports=excluded.quoted_exit_output_lamports,
       gross_proceeds_lamports=excluded.gross_proceeds_lamports,
       exit_fees_lamports=excluded.exit_fees_lamports,
       net_proceeds_lamports=excluded.net_proceeds_lamports,
       final_mark_id=excluded.final_mark_id, marks_observed=excluded.marks_observed,
       accounting_version=excluded.accounting_version, backfilled=excluded.backfilled`,
  ).run(
    e.positionId,
    e.mint,
    e.outcome,
    e.triggerRule,
    e.outcomeRationale,
    e.exitValueRatio,
    e.positionEntryCostLamports.toString(),
    bnOrNull(e.quotedExitOutputLamports),
    bnOrNull(e.grossProceedsLamports),
    bnOrNull(e.exitFeesLamports),
    bnOrNull(e.netProceedsLamports),
    e.realizedLamports.toString(),
    bnOrNull(e.entryNotionalLamports),
    bnOrNull(e.entryFixedCostsLamports),
    bnOrNull(e.ataRentLamports),
    e.ataRentRefunded === null ? null : e.ataRentRefunded ? 1 : 0,
    e.finalMarkId,
    e.marksObserved,
    e.openedUtcMs,
    e.closedUtcMs,
    e.heldMs,
    e.strategyVersion,
    e.accountingVersion,
    e.backfilled ? 1 : 0,
  );
}

/** Next sequence number for a position. Marks are append-only. */
export function nextMarkSeq(db: Db, positionId: string): number {
  const r = db
    .prepare('SELECT COALESCE(MAX(seq), -1) AS s FROM position_marks WHERE position_id = ?')
    .get(positionId) as { s: number };
  return r.s + 1;
}

/** The most recent mark, or null when none has been taken yet. */
export function latestMark(
  db: Db,
  positionId: string,
): { seq: number; outLamports: bigint | null } | null {
  const r = db
    .prepare(
      `SELECT seq, quoted_exit_output_lamports AS o FROM position_marks
       WHERE position_id = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(positionId) as { seq: number; o: string | null } | undefined;
  if (r === undefined) return null;
  return { seq: r.seq, outLamports: r.o === null ? null : BigInt(r.o) };
}

export function exitOutcomeBreakdown(
  db: Db,
): { outcome: string; count: number; totalRealized: bigint }[] {
  const rows = db
    .prepare(
      `SELECT outcome, COUNT(*) AS n, COALESCE(SUM(CAST(realized_lamports AS INTEGER)),0) AS r
       FROM position_exits GROUP BY outcome ORDER BY n DESC`,
    )
    .all() as { outcome: string; n: number; r: number }[];
  return rows.map((x) => ({ outcome: x.outcome, count: x.n, totalRealized: BigInt(x.r) }));
}

/**
 * A structural build attempt, successful or not.
 *
 * Written for EVERY attempt. A refused entry is as much a fact about the route
 * as an accepted one, and the corpus needs both to answer "what fraction of
 * eligible candidates could actually be traded?" — a question no stored row
 * could answer before this table existed.
 */
export interface BuildAttempt {
  buildId: string;
  mint: string;
  side: 'buy' | 'sell';
  positionId: string | null;
  quoteId: string | null;
  requestedUtcMs: number;
  receivedUtcMs: number | null;
  latencyMs: number | null;
  inputMint: string;
  outputMint: string;
  amount: bigint;
  taker: string;
  slippageBps: number | null;
  buildEndpoint: string;
  buildRouter: string | null;
  buildRequestId: string | null;
  buildStatus: 'BUILD_SUCCEEDED' | 'BUILD_FAILED' | 'UNVERIFIABLE';
  buildErrorCode: number | null;
  buildErrorClass: string | null;
  instructionCount: number | null;
  programIds: readonly string[] | null;
  hasSetup: boolean | null;
  hasCleanup: boolean | null;
  transactionBytesHash: string | null;
  lastValidBlockHeight: number | null;
  expireAt: number | null;
  quoteContextSlot: number | null;
  buildContextSlot: number | null;
  /**
   * Result of the instruction-level policy decoder, or NULL when it did not
   * run. Never defaulted to a pass, and never widened to imply the full signer
   * check: the label carries its own coverage, see
   * packages/solana/src/instructionpolicy.ts.
   */
  policyStatus: string | null;
  /**
   * NULL until a local SVM fixture exists.
   *
   * Deliberately still NULL in this build. A mainnet simulation cannot be run
   * for a paper sell: the taker does not own the hypothetical tokens, so
   * simulateTransaction fails for a reason that says nothing about the route.
   * Claiming a pass here from the buy leg, or downgrading silently to the
   * quote, are the two failures the directive names by name.
   */
  simulationStatus: string | null;
  contextHash: string | null;
}

export function insertBuildAttempt(db: Db, b: BuildAttempt): void {
  db.prepare(
    `INSERT INTO build_attempts
      (build_id,mint,side,position_id,quote_id,requested_utc_ms,received_utc_ms,latency_ms,
       input_mint,output_mint,amount,taker,slippage_bps,
       build_endpoint,build_router,build_request_id,build_status,build_error_code,build_error_class,
       instruction_count,program_ids,has_setup,has_cleanup,
       transaction_bytes_hash,last_valid_block_height,expire_at,quote_context_slot,build_context_slot,
       policy_status,simulation_status,context_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    b.buildId,
    b.mint,
    b.side,
    b.positionId,
    b.quoteId,
    b.requestedUtcMs,
    b.receivedUtcMs,
    b.latencyMs,
    b.inputMint,
    b.outputMint,
    b.amount.toString(),
    b.taker,
    b.slippageBps,
    b.buildEndpoint,
    b.buildRouter,
    b.buildRequestId,
    b.buildStatus,
    b.buildErrorCode,
    b.buildErrorClass,
    b.instructionCount,
    b.programIds === null ? null : JSON.stringify(b.programIds),
    b.hasSetup === null ? null : b.hasSetup ? 1 : 0,
    b.hasCleanup === null ? null : b.hasCleanup ? 1 : 0,
    b.transactionBytesHash,
    b.lastValidBlockHeight,
    b.expireAt,
    b.quoteContextSlot,
    b.buildContextSlot,
    b.policyStatus,
    b.simulationStatus,
    b.contextHash,
  );
}

/** Build success rate over a window, for the readiness gate and health. */
export function buildStats(db: Db, sinceUtcMs: number | null): {
  attempts: number;
  succeeded: number;
  failed: number;
  unverifiable: number;
} {
  const row = (
    sinceUtcMs === null
      ? db.prepare(
          `SELECT COUNT(*) AS attempts,
                  SUM(CASE WHEN build_status='BUILD_SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
                  SUM(CASE WHEN build_status='BUILD_FAILED' THEN 1 ELSE 0 END) AS failed,
                  SUM(CASE WHEN build_status='UNVERIFIABLE' THEN 1 ELSE 0 END) AS unverifiable
           FROM build_attempts`,
        )
      : db.prepare(
          `SELECT COUNT(*) AS attempts,
                  SUM(CASE WHEN build_status='BUILD_SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
                  SUM(CASE WHEN build_status='BUILD_FAILED' THEN 1 ELSE 0 END) AS failed,
                  SUM(CASE WHEN build_status='UNVERIFIABLE' THEN 1 ELSE 0 END) AS unverifiable
           FROM build_attempts WHERE requested_utc_ms >= ?`,
        )
  ).get(...(sinceUtcMs === null ? [] : [sinceUtcMs])) as Record<string, number | null>;
  return {
    attempts: row['attempts'] ?? 0,
    succeeded: row['succeeded'] ?? 0,
    failed: row['failed'] ?? 0,
    unverifiable: row['unverifiable'] ?? 0,
  };
}
