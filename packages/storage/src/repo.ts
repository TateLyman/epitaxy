import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
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

export function insertQuote(db: Db, mint: string, side: 'buy' | 'sell', q: ExecutableQuote): void {
  db.prepare(
    `INSERT INTO quotes
      (quote_id,mint,input_mint,output_mint,in_amount,out_amount,other_amount_threshold,slippage_bps,
       platform_fee_bps,price_impact_pct,router,route_labels,signature_fee_lamports,
       prioritization_fee_lamports,rent_fee_lamports,transaction_buildable,error_code,error_message,
       requested_utc_ms,received_utc_ms,latency_ms,side)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
  );
}

export function recordRejectObservation(
  db: Db,
  mint: string,
  rejectedUtcMs: number,
  primaryReason: string,
  obs: { priceUsd: number | null; liquidityUsd: number | null; routeExists: boolean | null },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO reject_tracking
      (id,mint,rejected_utc_ms,primary_reason,observed_utc_ms,price_usd,liquidity_usd,route_exists,horizon_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
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
       strategy_version,simulated,exit_reason,peak_value_lamports)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
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
  },
): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
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
