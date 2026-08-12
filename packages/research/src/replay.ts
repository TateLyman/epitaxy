import type { AppConfig } from '../../domain/src/config.js';
import type { Db } from '../../storage/src/db.js';
import type { ExecutableQuote, RoundTrip } from '../../domain/src/types.js';
import type { MintInformation } from '../../adapters/src/jupiter/schemas.js';
import { finalizeScreen, screenCheap } from '../../strategy/src/screen.js';

/**
 * Replay: re-decides stored snapshots and compares the result to what was
 * recorded at the time.
 *
 * The claim this exists to test is that a decision is a pure function of its
 * captured inputs. If replay disagrees with the original, then either the
 * snapshot does not capture everything the decision depended on, or the
 * strategy changed — and both are things we need to know before trusting any
 * backtest built on this data.
 *
 * A mismatch is therefore reported as a defect, never smoothed over. Rows whose
 * `strategy_version` differs from the current one are *expected* to diverge and
 * are counted separately, because comparing v0.1.0 decisions against v0.2.0
 * code measures the version bump, not determinism.
 *
 * This module holds no I/O beyond reading the database it is handed, so the
 * determinism claim can be tested against a constructed corpus rather than only
 * against whatever the live database happens to contain.
 */

export interface SnapshotRow {
  snapshot_id: string;
  mint: string;
  taken_utc_ms: number;
  token_age_ms: number | null;
  features_json: string;
  raw_inputs_json: string;
  freshness_json: string;
  eligible: number;
  hard_vetoes_json: string;
  soft_risk_score: number;
  opportunity_score: number;
  gates_json: string;
  strategy_version: string;
}

interface Features {
  liquidityUsd: number | null;
  holderCount: number | null;
  organicScore: number | null;
  mcap: number | null;
  fdv: number | null;
  usdPrice: number | null;
}

interface RawInputs {
  symbol: string;
  name: string;
  launchpad: string;
  dev: string | null;
  decimals: number;
  tokenProgram: string | null;
  audit: Record<string, unknown> | null;
  stats5m: Record<string, unknown> | null;
  buyQuoteId: string | null;
  sellQuoteId: string | null;
}

/**
 * Rebuilds the exact provider object the gates saw. `createdAt` is derived from
 * the recorded age rather than re-fetched, so replay never depends on a source
 * still being reachable — or still returning the same thing.
 */
export function reconstruct(row: SnapshotRow): MintInformation {
  const f = JSON.parse(row.features_json) as Features;
  const raw = JSON.parse(row.raw_inputs_json) as RawInputs;
  const createdAtMs = row.token_age_ms === null ? null : row.taken_utc_ms - row.token_age_ms;

  return {
    id: row.mint,
    name: raw.name,
    symbol: raw.symbol,
    decimals: raw.decimals,
    dev: raw.dev,
    launchpad: raw.launchpad,
    tokenProgram: raw.tokenProgram,
    liquidity: f.liquidityUsd,
    holderCount: f.holderCount,
    organicScore: f.organicScore,
    mcap: f.mcap,
    fdv: f.fdv,
    usdPrice: f.usdPrice,
    audit: raw.audit,
    stats5m: raw.stats5m,
    createdAt: createdAtMs === null ? null : new Date(createdAtMs).toISOString(),
    firstPool: null,
    updatedAt: null,
  } as unknown as MintInformation;
}

export function loadQuote(db: Db, quoteId: string | null): ExecutableQuote | null {
  if (quoteId === null) return null;
  const q = db.prepare('SELECT * FROM quotes WHERE quote_id = ?').get(quoteId) as Record<string, string | number> | undefined;
  if (!q) return null;
  return {
    quoteId: q['quote_id'] as string,
    inputMint: q['input_mint'] as string,
    outputMint: q['output_mint'] as string,
    inAmount: BigInt(q['in_amount'] as string),
    outAmount: BigInt(q['out_amount'] as string),
    otherAmountThreshold: BigInt(q['other_amount_threshold'] as string),
    slippageBps: q['slippage_bps'] as number,
    platformFeeBps: q['platform_fee_bps'] as number,
    priceImpactPct: q['price_impact_pct'] as number,
    router: q['router'] as string,
    // Stored by insertQuote as a '>'-joined path, not JSON. Split rather than
    // parsed so replay reads back exactly what was written.
    routeLabels: ((q['route_labels'] as string | null) ?? '').split('>').filter((s) => s.length > 0),
    signatureFeeLamports: BigInt(q['signature_fee_lamports'] as string),
    prioritizationFeeLamports: BigInt(q['prioritization_fee_lamports'] as string),
    rentFeeLamports: BigInt(q['rent_fee_lamports'] as string),
    transactionBuildable: q['transaction_buildable'] === 1,
    errorCode: (q['error_code'] as number | null) ?? null,
    errorMessage: (q['error_message'] as string | null) ?? null,
    requestedUtcMs: q['requested_utc_ms'] as number,
    receivedUtcMs: q['received_utc_ms'] as number,
    latencyMs: q['latency_ms'] as number,
    // Labelled as replayed rather than reconstructed to look like a live
    // fetch. No gate reads provenance, so this cannot influence the decision;
    // it exists so a quote can never be mistaken for one just off the wire.
    provenance: {
      source: 'replay.storage',
      sourceType: 'direct_chain',
      receivedMonotonicMs: 0,
      receivedUtcMs: q['received_utc_ms'] as number,
      slot: null,
      sourceUtcMs: null,
      schemaVersion: 'replay',
      parserVersion: 'replay',
      payloadHash: '',
    },
  };
}

function roundTripFrom(db: Db, raw: RawInputs, features: Record<string, unknown>): RoundTrip | null {
  const buy = loadQuote(db, raw.buyQuoteId);
  if (buy === null) return null;
  const sell = loadQuote(db, raw.sellQuoteId);
  return {
    buy,
    sell,
    roundTripLossBps: (features['roundTripLossBps'] as number | null) ?? null,
    exitExists: sell !== null && sell.outAmount > 0n,
  } as RoundTrip;
}

export interface Mismatch {
  readonly snapshotId: string;
  readonly mint: string;
  readonly field: string;
  readonly stored: string;
  readonly replayed: string;
}

export function replayOne(db: Db, config: AppConfig, row: SnapshotRow): Mismatch[] {
  const info = reconstruct(row);
  const features = JSON.parse(row.features_json) as Record<string, unknown>;
  const raw = JSON.parse(row.raw_inputs_json) as RawInputs;
  const freshness = JSON.parse(row.freshness_json) as { jupiter_tokens: number };

  const { gates } = screenCheap(info, config, row.taken_utc_ms, freshness.jupiter_tokens);
  const roundTrip = roundTripFrom(db, raw, features);

  // Concentration is passed as null: it was not captured in the snapshot, so
  // replay must not invent it. Rows decided WITH a concentration measurement
  // are excluded by the caller rather than silently compared against nothing.
  const result = finalizeScreen(info, config, row.taken_utc_ms, gates, roundTrip, null, null);

  const out: Mismatch[] = [];
  const push = (field: string, stored: unknown, replayed: unknown): void => {
    if (String(stored) !== String(replayed)) {
      out.push({ snapshotId: row.snapshot_id, mint: row.mint, field, stored: String(stored), replayed: String(replayed) });
    }
  };

  push('eligible', row.eligible === 1, result.outcome.eligible);
  push('opportunityScore', row.opportunity_score, result.outcome.opportunityScore);
  push('softRiskScore', row.soft_risk_score, result.outcome.softRiskScore);
  push(
    'hardVetoes',
    [...(JSON.parse(row.hard_vetoes_json) as string[])].sort().join(','),
    [...result.outcome.hardVetoes].sort().join(','),
  );
  return out;
}

export function snapshotRows(db: Db, limit: number): SnapshotRow[] {
  return db
    .prepare(
      `SELECT s.snapshot_id, s.mint, s.taken_utc_ms, s.token_age_ms, s.features_json, s.raw_inputs_json, s.freshness_json,
              c.eligible, c.hard_vetoes_json, c.soft_risk_score, c.opportunity_score, c.gates_json, c.strategy_version
       FROM decision_snapshots s
       JOIN screenings c ON c.snapshot_id = s.snapshot_id
       ORDER BY s.taken_utc_ms DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as SnapshotRow[];
}

export interface ReplaySummary {
  readonly examined: number;
  readonly replayed: number;
  readonly skippedOtherVersion: number;
  readonly threw: number;
  readonly divergentSnapshots: number;
  readonly mismatches: readonly Mismatch[];
}

export function replayAll(db: Db, config: AppConfig, rows: readonly SnapshotRow[]): ReplaySummary {
  const current = rows.filter((r) => r.strategy_version === config.strategyVersion);
  const mismatches: Mismatch[] = [];
  let threw = 0;

  for (const row of current) {
    try {
      mismatches.push(...replayOne(db, config, row));
    } catch (e) {
      threw += 1;
      // A snapshot that cannot be re-decided at all is a divergence of the
      // worst kind, so it is recorded as one rather than skipped.
      mismatches.push({
        snapshotId: row.snapshot_id,
        mint: row.mint,
        field: 'exception',
        stored: 'n/a',
        replayed: (e as Error).message,
      });
    }
  }

  return {
    examined: rows.length,
    replayed: current.length,
    skippedOtherVersion: rows.length - current.length,
    threw,
    divergentSnapshots: new Set(mismatches.map((m) => m.snapshotId)).size,
    mismatches,
  };
}
