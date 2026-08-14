/**
 * Core immutable domain types.
 *
 * INVARIANT: every raw token/lamport amount is a bigint. Floating point is
 * permitted only for derived, display-only, or scoring values that can never
 * feed back into an amount, a fee, or a balance reconciliation.
 */

import type { ImpactReading } from './impact.js';

export type Mode = 'observe' | 'paper' | 'replay' | 'backtest' | 'canary' | 'live';

export const MODES: readonly Mode[] = ['observe', 'paper', 'replay', 'backtest', 'canary', 'live'] as const;

/** Modes that are allowed to construct a signer. */
export const SIGNING_MODES: readonly Mode[] = ['canary', 'live'] as const;

export type Base58 = string;

export const WSOL_MINT: Base58 = 'So11111111111111111111111111111111111111112';
export const USDC_MINT: Base58 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Where an observation came from. Chain-derived facts outrank indexer views;
 * a decision must be able to state which it relied on.
 */
export type SourceType =
  | 'direct_chain' // decoded from an account or program log we read ourselves
  | 'rpc_derived' // computed from RPC responses
  | 'official_indexer' // first-party indexer for the venue (e.g. Jupiter for its own routes)
  | 'third_party_indexer' // e.g. DEX Screener
  | 'model'; // produced by our own model/scoring code

export interface Provenance {
  readonly source: string;
  readonly sourceType: SourceType;
  /** Monotonic ms since process start; immune to wall-clock adjustment. */
  readonly receivedMonotonicMs: number;
  readonly receivedUtcMs: number;
  /** Slot the data describes, when the source exposes one. */
  readonly slot: number | null;
  /** Timestamp asserted by the source itself, if any. */
  readonly sourceUtcMs: number | null;
  readonly schemaVersion: string;
  readonly parserVersion: string;
  /** sha256 of the raw payload, for drift forensics. */
  readonly payloadHash: string;
}

export type LaunchpadName =
  | 'pump.fun'
  | 'pumpswap'
  | 'raydium_launchlab'
  | 'meteora_dbc'
  | 'bags'
  | 'boop'
  | 'believe'
  | 'jup_studio'
  | 'unknown';

export interface TokenStatsWindow {
  readonly buyVolume: number | null;
  readonly sellVolume: number | null;
  readonly numBuys: number | null;
  readonly numSells: number | null;
  readonly numTraders: number | null;
  readonly numNetBuyers: number | null;
  readonly priceChange: number | null;
  readonly liquidityChange: number | null;
  readonly holderChange: number | null;
}

/** A discovered token before any enrichment or gating. */
export interface Candidate {
  readonly mint: Base58;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly tokenProgram: Base58;
  readonly creator: Base58 | null;
  readonly launchpad: LaunchpadName;
  readonly firstSeenUtcMs: number;
  readonly createdAtUtcMs: number | null;
  readonly provenance: Provenance;
}

/**
 * A frozen snapshot of every value a decision was allowed to see, at the
 * instant the decision was made. Replay reconstructs decisions from these and
 * must never reach past them.
 */
export interface DecisionSnapshot {
  readonly snapshotId: string;
  readonly mint: Base58;
  readonly takenUtcMs: number;
  readonly takenMonotonicMs: number;
  readonly slot: number | null;
  readonly tokenAgeMs: number | null;
  readonly features: Readonly<Record<string, number | null>>;
  readonly rawInputs: Readonly<Record<string, unknown>>;
  /** Per-source age in ms at decision time; stale inputs must veto. */
  /**
   * Age of each source at decision time. NULL means the provider gave no
   * timestamp -- never 0, which is the most favourable value obtainable from
   * the absence of information, and never -1, which a consumer could compare
   * against a threshold and pass.
   */
  readonly freshnessMs: Readonly<Record<string, number | null>>;
}

export type GateSeverity = 'hard_veto' | 'soft_risk';

export interface GateResult {
  readonly gate: string;
  readonly severity: GateSeverity;
  readonly passed: boolean;
  /** Machine-readable reason code. Never a free-text external string. */
  readonly reason: string;
  /** Bounded, sanitized detail for humans. */
  readonly detail: string;
  /** For soft gates: 0 = no concern, 1 = maximum concern. */
  readonly riskContribution: number;
}

export interface ScreeningOutcome {
  readonly mint: Base58;
  readonly snapshotId: string;
  readonly evaluatedUtcMs: number;
  readonly gates: readonly GateResult[];
  readonly hardVetoes: readonly string[];
  readonly softRiskScore: number;
  readonly opportunityScore: number | null;
  readonly scoreComponents: Readonly<Record<string, number>>;
  readonly eligible: boolean;
  readonly strategyVersion: string;
}

/** A quote we actually requested from a router, with its freshness. */
export interface ExecutableQuote {
  readonly quoteId: string;
  readonly inputMint: Base58;
  readonly outputMint: Base58;
  readonly inAmount: bigint;
  readonly outAmount: bigint;
  /** Router's worst-case output at the requested slippage. */
  readonly otherAmountThreshold: bigint;
  readonly slippageBps: number;
  readonly platformFeeBps: number;
  /** The mint the platform fee is denominated in. Null when not reported. */
  readonly feeMint: string | null;
  /** Platform fee in raw units of `feeMint`. Null when not reported. */
  readonly platformFeeAmount: bigint | null;
  /**
   * Raw signed impact fraction, exactly as delivered.
   *
   * Kept for backward compatibility with stored rows and reports. New consumers
   * read `impact` instead: this field cannot express "the provider did not say",
   * and a 0 here is indistinguishable from a perfect fill.
   */
  readonly priceImpactPct: number;
  /** The audited reading: status, adverse magnitude, and the raw string. */
  readonly impact: ImpactReading;
  /** Slot the router priced against, when reported. */
  readonly contextSlot: number | null;
  /**
   * The exact response body, for `raw_payloads`. Null when the caller did not
   * ask for it — never fabricated.
   */
  readonly rawBody: string | null;
  readonly router: string;
  readonly routeLabels: readonly string[];
  readonly signatureFeeLamports: bigint;
  readonly prioritizationFeeLamports: bigint;
  readonly rentFeeLamports: bigint;
  /** True only when the router actually returned a signable transaction. */
  readonly transactionBuildable: boolean;
  readonly errorCode: number | null;
  readonly errorMessage: string | null;
  readonly requestedUtcMs: number;
  readonly receivedUtcMs: number;
  readonly latencyMs: number;
  readonly provenance: Provenance;
}

/**
 * A buy quote paired with the reverse sell quote for the amount that buy would
 * produce. A buy route without a sell route is not a trade.
 */
export interface RoundTrip {
  readonly buy: ExecutableQuote;
  readonly sell: ExecutableQuote | null;
  /** Total loss in bps of a full in-and-out at this instant, or null if no exit. */
  readonly roundTripLossBps: number | null;
  readonly exitExists: boolean;
}

export type PositionState =
  | 'DISCOVERED'
  | 'SCREENED'
  | 'ELIGIBLE'
  | 'INTENT_CREATED'
  | 'ORDER_REQUESTED'
  | 'ORDER_VALIDATED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'EXPIRED'
  | 'UNKNOWN'
  | 'RECONCILED'
  | 'POSITION_OPEN'
  | 'EXIT_INTENT'
  /**
   * P10 — a policy has fired and the fill has not landed yet.
   *
   * Distinct from EXIT_INTENT, which meant "we would like to leave", and from
   * EXIT_BLOCKED, which means "we tried and could not". This is the interval a
   * real exit spends between noticing and landing, and collapsing it is how
   * every exit in the corpus was priced at a moment no exit could reach.
   */
  | 'AWAITING_FILL_OBSERVATION'
  | 'POSITION_CLOSED'
  | 'EXIT_BLOCKED';

export const TERMINAL_STATES: readonly PositionState[] = [
  'POSITION_CLOSED',
  'FAILED',
  'EXPIRED',
] as const;

/** Bounded instruction handed to the executor. The signer trusts nothing else. */
export interface TradeIntent {
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly mint: Base58;
  readonly side: 'buy' | 'sell';
  readonly inputMint: Base58;
  readonly outputMint: Base58;
  readonly maxInputAmount: bigint;
  readonly minOutputAmount: bigint;
  readonly maxTotalFeeLamports: bigint;
  readonly maxPriorityFeeLamports: bigint;
  readonly deadlineUtcMs: number;
  readonly strategyVersion: string;
  readonly riskSnapshotHash: string;
  readonly createdUtcMs: number;
}

export interface Fill {
  readonly fillId: string;
  readonly intentId: string;
  readonly mint: Base58;
  readonly side: 'buy' | 'sell';
  /** Wallet-reflected amounts, not quoted amounts. */
  readonly actualInAmount: bigint;
  readonly actualOutAmount: bigint;
  readonly feeLamports: bigint;
  readonly priorityFeeLamports: bigint;
  readonly rentLamports: bigint;
  readonly signature: string | null;
  readonly slot: number | null;
  readonly simulated: boolean;
  readonly utcMs: number;
}

export interface Position {
  readonly positionId: string;
  readonly mint: Base58;
  readonly state: PositionState;
  readonly tokenAmount: bigint;
  readonly costLamports: bigint;
  readonly realizedLamports: bigint;
  readonly openedUtcMs: number;
  readonly closedUtcMs: number | null;
  readonly strategyVersion: string;
  readonly simulated: boolean;

  /**
   * P4 — the explicit economics, written by the runtime.
   *
   * Migration 22 added these columns and no writer populated them, so every
   * reader either recomputed PnL its own way or read NULL and reported zero.
   * A schema that has been migrated but not written to is worse than a missing
   * column: the column's existence reads as evidence that the number is kept.
   *
   * `null` means not yet determined — an open position has no net PnL. It never
   * means zero.
   */
  readonly executionCostLamports?: bigint | null;
  readonly grossProceedsLamports?: bigint | null;
  readonly netPnlLamports?: bigint | null;

  /**
   * P9 — the two ends of the cash flow, and the rent held between them.
   *
   * `netPnlLamports = exitCashInLamports - entryCashOutLamports` exactly.
   * Rent is identified separately rather than netted into either side: it is
   * capital the account holds, not a cost the market charged, and collapsing
   * the two is how a 363 bps round trip reads as 3,688.
   */
  readonly entryCashOutLamports?: bigint | null;
  readonly exitCashInLamports?: bigint | null;
  readonly lockedRentLamports?: bigint | null;
  readonly residualTokenAtoms?: bigint | null;
}

export type CircuitBreaker =
  | 'daily_loss'
  | 'weekly_loss'
  | 'drawdown'
  | 'stale_data'
  | 'schema_drift'
  | 'rpc_disagreement'
  | 'execution_failures'
  | 'reconciliation_mismatch'
  | 'balance_anomaly'
  | 'duplicate_executor'
  | 'storage_failure'
  | 'clock_skew'
  | 'resume_resync'
  | 'unexpected_instruction'
  | 'model_drift'
  | 'kill_switch';

export interface HealthState {
  readonly healthy: boolean;
  readonly breakers: readonly CircuitBreaker[];
  readonly newEntriesAllowed: boolean;
  readonly detail: string;
}
