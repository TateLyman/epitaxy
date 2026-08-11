import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type {
  Candidate,
  DecisionSnapshot,
  ExecutableQuote,
  ScreeningOutcome,
  Position,
  Fill,
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
