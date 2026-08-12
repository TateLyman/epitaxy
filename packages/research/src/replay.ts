import type { AppConfig } from '../../domain/src/config.js';
import type { Db } from '../../storage/src/db.js';
import type { ExecutableQuote, RoundTrip } from '../../domain/src/types.js';
import type { MintInformation } from '../../adapters/src/jupiter/schemas.js';
import { finalizeScreen, screenCheap } from '../../strategy/src/screen.js';
import type { ConcentrationInput } from '../../intelligence/src/gates.js';
import { parseImpact } from '../../domain/src/impact.js';

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
  /**
   * Present from the moment concentration capture was added. `null` means the
   * measurement was attempted and unavailable; ABSENT means the snapshot is
   * older than the capture and the decision cannot be reproduced at all.
   */
  concentration?: ConcentrationInput | null;
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
    feeMint: (q['fee_mint'] as string | null) ?? null,
    platformFeeAmount: q['platform_fee_amount'] == null ? null : BigInt(q['platform_fee_amount'] as string),
    priceImpactPct: q['price_impact_pct'] as number,
    // Re-derived from the stored raw fraction rather than reconstructed by
    // hand. Rows written before migration 7 carry no raw body, so the reading
    // says so instead of inventing a status.
    impact: parseImpact({ priceImpactPct: q['price_impact_pct'] as number }),
    contextSlot: null,
    rawBody: null,
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

  // Concentration comes from the snapshot. It used to be passed as null with a
  // comment claiming the caller excluded rows that had a measurement; the
  // caller filtered on `strategy_version` and nothing else, so those rows were
  // replayed against nothing and reported as divergences. 28 of them were,
  // once the v0.3.0 bump made replay actually run again (O035, O042).
  //
  // `replayable()` is what now enforces the exclusion the comment described,
  // and the CLI reports the excluded count so the gap stays visible.
  const result = finalizeScreen(
    info,
    config,
    row.taken_utc_ms,
    gates,
    roundTrip,
    null,
    raw.concentration ?? null,
  );

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

/**
 * Whether a stored decision can be re-derived from what was actually captured.
 *
 * A snapshot written before concentration capture existed cannot be: the gates
 * saw an on-chain holder distribution that is nowhere in the row. Replaying it
 * against `null` does not test determinism, it tests what happens when you
 * delete an input — so such a row is reported as unverifiable rather than
 * counted as either a pass or a divergence.
 *
 * The evidence that a measurement was taken is the presence of the
 * `holder_concentration` gate in the stored gate list. Its unavailable twin is
 * named `holder_concentration_unavailable`, so the check is on the exact name.
 */
export function replayable(row: SnapshotRow): boolean {
  try {
    const raw = JSON.parse(row.raw_inputs_json) as RawInputs;
    if ('concentration' in raw) return true;
    const gates = JSON.parse(row.gates_json) as { gate?: string }[];
    return !gates.some((g) => g.gate === 'holder_concentration');
  } catch {
    // A row that will not parse is a corrupt row, not an old one. Fail CLOSED
    // by returning it to the normal path, where replayOne throws inside the
    // caller's try and it is recorded as a divergence. Filtering it out here
    // would move corruption into a count labelled "unverifiable" — an
    // explanation it has not earned.
    return true;
  }
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
  /** Rows whose inputs were not fully captured; neither verified nor divergent. */
  readonly unverifiable: number;
  readonly threw: number;
  readonly divergentSnapshots: number;
  readonly mismatches: readonly Mismatch[];
}

export function replayAll(db: Db, config: AppConfig, rows: readonly SnapshotRow[]): ReplaySummary {
  const atVersion = rows.filter((r) => r.strategy_version === config.strategyVersion);
  const current = atVersion.filter(replayable);
  const unverifiable = atVersion.length - current.length;
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
    // Against `atVersion`, not `current`: an unverifiable row was not skipped
    // for being the wrong version, and folding the two together would let the
    // capture gap hide inside a number nobody reads closely.
    skippedOtherVersion: rows.length - atVersion.length,
    unverifiable,
    threw,
    divergentSnapshots: new Set(mismatches.map((m) => m.snapshotId)).size,
    mismatches,
  };
}
