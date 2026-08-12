/**
 * One observation, one route family, one trade.
 *
 * The defect this module exists to make impossible: the engine priced paper
 * entries from `/swap/v2/order` and proved buildability from `/swap/v2/build`,
 * then booked a fill as though those were the same trade. They are not, and the
 * difference is measurable rather than theoretical. Probed live 2026-08-12,
 * 0.02 SOL → USDC, same instant:
 *
 *     /order  outAmount 1509732   feeBps 2   router metis   priceImpact -0.0188%
 *     /build  outAmount 1510066   no fee fields at all      priceImpactPct "0"
 *
 * `/build` returned 334 more units — about 22 bps — and reported no platform
 * fee, because it is a Metis-only route with a different fee model. A fill
 * claiming `/order`'s price and `/build`'s buildability describes a trade that
 * was never available on either.
 *
 * So an `ExecutionObservation` is the unit. One family, one exact amount, one
 * response, one route plan, one fee model, one instruction set, one expiry, one
 * context, one simulation result. A leg that is PnL-eligible references exactly
 * one of these, and `assertCoherent()` throws rather than letting two be blended.
 */

import { createHash } from 'node:crypto';

export const ROUTE_FAMILIES = ['ORDER_EXECUTE', 'BUILD_CUSTOM', 'DIRECT_VENUE', 'QUOTE_ONLY_BENCHMARK'] as const;
export type RouteFamily = (typeof ROUTE_FAMILIES)[number];

/**
 * What each family is, and what it is permitted to claim.
 *
 * `ORDER_EXECUTE` is deliberately NOT the primary paper route. Its sell leg
 * cannot be validated from an unfunded wallet that does not own the
 * hypothetical tokens, and its transaction must be submitted unmodified through
 * `/execute`. Until a real canary exercises that path it is an economic
 * benchmark, not evidence.
 */
export interface FamilyContract {
  readonly family: RouteFamily;
  /** May a fill in this family ever count toward executable PnL? */
  readonly pnlEligible: boolean;
  /** Is the platform fee already reflected in the returned amounts? */
  readonly feeIncludedInAmounts: boolean;
  /** Must the assembled transaction be submitted unmodified via /execute? */
  readonly submitViaExecute: boolean;
  readonly detail: string;
}

export const FAMILY_CONTRACTS: Record<RouteFamily, FamilyContract> = {
  ORDER_EXECUTE: {
    family: 'ORDER_EXECUTE',
    pnlEligible: false,
    feeIncludedInAmounts: true,
    submitViaExecute: true,
    detail:
      'all routers compete; Jupiter platform fee is included in the returned amounts and deducted ' +
      'automatically; the assembled transaction must be used unmodified and submitted through /execute. ' +
      'An economic BENCHMARK until a canary validates the path — a paper sell cannot be validated from ' +
      'an unfunded wallet that does not own the hypothetical tokens.',
  },
  BUILD_CUSTOM: {
    family: 'BUILD_CUSTOM',
    pnlEligible: true,
    feeIncludedInAmounts: false,
    submitViaExecute: false,
    detail:
      'Metis-only; quote and raw instructions come from one response; no default Jupiter swap fee; ' +
      'the exact-size transaction is assembled locally and broadcast by an explicitly measured ' +
      'broadcaster. The primary candidate for structurally valid paper simulation, because a local ' +
      'SVM fork can supply the hypothetical balance.',
  },
  DIRECT_VENUE: {
    family: 'DIRECT_VENUE',
    pnlEligible: false,
    feeIncludedInAmounts: false,
    submitViaExecute: false,
    detail: 'audited venue-specific transaction. DISABLED until a measured route family justifies the cost.',
  },
  QUOTE_ONLY_BENCHMARK: {
    family: 'QUOTE_ONLY_BENCHMARK',
    pnlEligible: false,
    feeIncludedInAmounts: true,
    submitViaExecute: false,
    detail: 'a price or route observation. Never PnL-eligible and never called executable.',
  },
};

/** Why a route observation could not be obtained. Never collapsed to null. */
export const OBSERVATION_FAILURES = [
  'NO_ROUTE',
  'HTTP_429',
  'HTTP_4XX',
  'HTTP_5XX',
  'TIMEOUT',
  'SCHEMA_DRIFT',
  'PARSER_ERROR',
  'POLICY_REFUSAL',
  'SIMULATION_FAILURE',
  'EXPIRED',
  'UNKNOWN',
] as const;
export type ObservationFailure = (typeof OBSERVATION_FAILURES)[number];

/** A provider failing is not a token being untradeable. */
export function isProviderFailure(f: ObservationFailure): boolean {
  return f === 'HTTP_429' || f === 'HTTP_4XX' || f === 'HTTP_5XX' || f === 'TIMEOUT' || f === 'SCHEMA_DRIFT';
}

/** A no-route response is not an outage. */
export function isTokenFact(f: ObservationFailure): boolean {
  return f === 'NO_ROUTE';
}

export type PolicyOutcome = 'PASS' | 'FAIL' | 'NOT_RUN';
export type SimulationOutcome = 'SIMULATED_OK' | 'SIMULATION_FAILED' | 'NOT_SIMULATED';

export interface ExecutionObservation {
  readonly observationId: string;
  readonly family: RouteFamily;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly inputMint: string;
  readonly outputMint: string;

  /** The EXACT amount requested. Never a probe scaled to something else. */
  readonly requestedAmount: bigint;
  /** The response's own expected output. */
  readonly expectedOutput: bigint;
  /** The response's own worst permitted output at the requested slippage. */
  readonly minimumOutput: bigint;
  readonly slippageBps: number;

  /**
   * Fee as the response reported it. `feeIncludedInAmounts` on the family
   * contract says whether it has already been taken out of the amounts above —
   * deducting it again is the §3.2 defect and `netExpectedOutput()` is the only
   * sanctioned way to ask.
   */
  readonly platformFeeBps: number | null;
  readonly platformFeeAmount: bigint | null;
  readonly platformFeeMint: string | null;

  readonly signatureFeeLamports: bigint | null;
  readonly prioritizationFeeLamports: bigint | null;
  readonly rentFeeLamports: bigint | null;
  readonly broadcasterTipLamports: bigint | null;

  readonly routePlanHash: string;
  readonly routeLabels: readonly string[];
  readonly instructionSetHash: string | null;
  readonly instructionCount: number | null;
  readonly computeUnitLimit: number | null;
  readonly transactionBytes: number | null;

  readonly lastValidBlockHeight: number | null;
  readonly expireAt: number | null;
  readonly contextSlot: number | null;

  readonly rawPayloadHash: string | null;
  readonly endpoint: string;
  readonly requestId: string | null;

  readonly instructionPolicy: PolicyOutcome;
  readonly transactionPolicy: PolicyOutcome;
  readonly simulation: SimulationOutcome;
  readonly policyDetail: string | null;
  readonly simulationDetail: string | null;

  readonly requestedUtcMs: number;
  readonly receivedUtcMs: number;
  readonly latencyMs: number;
  readonly contextHash: string | null;
}

export class RouteHybrid extends Error {
  constructor(reason: string) {
    super(
      `refusing to combine route observations: ${reason}. A price from one route and a build from ` +
        'another do not form an executable trade. Measured 2026-08-12: /order and /build returned ' +
        'different amounts and different fee models for the same token, amount and instant.',
    );
    this.name = 'RouteHybrid';
  }
}

/**
 * Two observations may only describe one leg when every identity field agrees.
 *
 * Throws. Not a warning — the whole point is that a hybrid must fail closed, and
 * the previous implementation produced one silently on every fill.
 */
export function assertCoherent(a: ExecutionObservation, b: ExecutionObservation): void {
  if (a.observationId !== b.observationId) {
    throw new RouteHybrid(`different observation ids ${a.observationId} and ${b.observationId}`);
  }
  if (a.family !== b.family) throw new RouteHybrid(`family ${a.family} vs ${b.family}`);
  if (a.requestedAmount !== b.requestedAmount) {
    throw new RouteHybrid(`amount ${a.requestedAmount} vs ${b.requestedAmount}`);
  }
  if (a.routePlanHash !== b.routePlanHash) throw new RouteHybrid('different route plans');
  if (a.contextSlot !== b.contextSlot) throw new RouteHybrid(`context slot ${a.contextSlot} vs ${b.contextSlot}`);
}

/**
 * Whether a single observation may back a PnL-eligible leg.
 *
 * Every clause is a requirement and an unknown fails. `NOT_RUN` and
 * `NOT_SIMULATED` are unknowns, not passes.
 */
export function legIsExecutable(o: ExecutionObservation): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const contract = FAMILY_CONTRACTS[o.family];
  if (!contract.pnlEligible) reasons.push(`family ${o.family} is never PnL-eligible`);
  if (o.instructionPolicy !== 'PASS') reasons.push(`instruction policy ${o.instructionPolicy}`);
  if (o.transactionPolicy !== 'PASS') reasons.push(`transaction policy ${o.transactionPolicy}`);
  if (o.simulation !== 'SIMULATED_OK') reasons.push(`simulation ${o.simulation}`);
  if (o.instructionSetHash === null) reasons.push('no instruction set');
  if (o.rawPayloadHash === null) reasons.push('no retained raw payload');
  if (o.expectedOutput <= 0n) reasons.push('no expected output');
  return { ok: reasons.length === 0, reasons };
}

/**
 * Expected output NET of the platform fee, charged exactly once.
 *
 * §3.2. `/order` includes its fee in the returned amounts, so multiplying by
 * `(1 - feeBps)` again understates the fill — that is what the engine did on
 * every entry. `/build` returns no fee fields at all, so there is nothing to
 * deduct unless a platform fee was deliberately requested.
 *
 * This is the only sanctioned way to ask, so a caller cannot reintroduce the
 * double charge by reaching for the raw field.
 */
export function netExpectedOutput(o: ExecutionObservation): bigint {
  const contract = FAMILY_CONTRACTS[o.family];
  if (contract.feeIncludedInAmounts) return o.expectedOutput;
  if (o.platformFeeAmount !== null) return o.expectedOutput - o.platformFeeAmount;
  if (o.platformFeeBps !== null && o.platformFeeBps > 0) {
    return (o.expectedOutput * BigInt(10_000 - o.platformFeeBps)) / 10_000n;
  }
  return o.expectedOutput;
}

/** Same, for the worst permitted output. */
export function netMinimumOutput(o: ExecutionObservation): bigint {
  const contract = FAMILY_CONTRACTS[o.family];
  if (contract.feeIncludedInAmounts) return o.minimumOutput;
  if (o.platformFeeBps !== null && o.platformFeeBps > 0) {
    return (o.minimumOutput * BigInt(10_000 - o.platformFeeBps)) / 10_000n;
  }
  return o.minimumOutput;
}

/**
 * The three valuations, persisted together so none can be chosen after the fact.
 *
 * The primary rule is frozen before collection. `minimumOutput` is a slippage
 * FLOOR derived from our own slippage setting, not a claim that every fill
 * equals the worst permitted output, so it is the stress case and not the base
 * case unless evidence says otherwise.
 */
export interface Valuations {
  readonly expectedOutput: bigint;
  readonly minimumOutputStress: bigint;
  readonly latencyStressedOutput: bigint;
}

export function valuations(o: ExecutionObservation, latencyStressBps: number): Valuations {
  const expected = netExpectedOutput(o);
  return {
    expectedOutput: expected,
    minimumOutputStress: netMinimumOutput(o),
    latencyStressedOutput: (expected * BigInt(10_000 - latencyStressBps)) / 10_000n,
  };
}

/**
 * Every non-recoverable cost of taking a position, charged once each.
 *
 * §3.4 — nothing is omitted for being small. A thin edge cannot be tested by an
 * accounting model that skips the costs it considers negligible; the signature
 * fee is 5000 lamports, which against a 0.02 SOL canary notional is 2.5 bps, and
 * the whole question is whether the strategy clears a few hundred bps.
 *
 * `assumed*` fields are named so that a reader can see at a glance which numbers
 * came from a response and which came from us.
 */
export interface EntryCosts {
  readonly inputLamports: bigint;
  readonly signatureFeeLamports: bigint;
  readonly priorityFeeLamports: bigint;
  readonly broadcasterTipLamports: bigint;
  readonly ataRentLamports: bigint;
  readonly transferFeeLamports: bigint;
  readonly platformFeeLamports: bigint;
  readonly assumedFailedAttemptLamports: bigint;
}

export function totalEntryCost(c: EntryCosts): bigint {
  return (
    c.inputLamports +
    c.signatureFeeLamports +
    c.priorityFeeLamports +
    c.broadcasterTipLamports +
    c.ataRentLamports +
    c.transferFeeLamports +
    c.platformFeeLamports +
    c.assumedFailedAttemptLamports
  );
}

export interface ExitCosts {
  readonly grossProceedsLamports: bigint;
  readonly signatureFeeLamports: bigint;
  readonly priorityFeeLamports: bigint;
  readonly broadcasterTipLamports: bigint;
  readonly transferFeeLamports: bigint;
  readonly closeAccountFeeLamports: bigint;
  readonly assumedFailedAttemptLamports: bigint;
  /** Credited only when a close was shown to be possible. See ata.ts. */
  readonly ataRentRecoveredLamports: bigint;
}

export function netExitProceeds(c: ExitCosts): bigint {
  return (
    c.grossProceedsLamports -
    c.signatureFeeLamports -
    c.priorityFeeLamports -
    c.broadcasterTipLamports -
    c.transferFeeLamports -
    c.closeAccountFeeLamports -
    c.assumedFailedAttemptLamports +
    c.ataRentRecoveredLamports
  );
}

/**
 * Hash of a route plan, so two observations can be compared without storing the
 * whole plan twice. Order matters — a different split is a different route.
 */
export function routePlanHash(steps: readonly { ammKey: string; label?: string | undefined; percent?: number | undefined }[]): string {
  return createHash('sha256')
    .update(JSON.stringify(steps.map((s) => [s.ammKey, s.label ?? null, s.percent ?? null])))
    .digest('hex');
}
