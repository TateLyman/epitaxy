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
  // §6 — a build that came back missing a load-bearing field.
  //
  // These used to collapse into a zero or an empty list somewhere downstream: a
  // missing otherAmountThreshold became a minimum output of 0, which is a
  // transaction that accepts any fill including none, and it looked exactly
  // like a route with generous slippage. Each one is now its own refusal so the
  // corpus can say which field the provider omitted and how often.
  'MISSING_MINIMUM_OUTPUT',
  'MISSING_BLOCKHASH',
  'MISSING_EXPIRY',
  'MISSING_ROUTE_PLAN',
  'MISSING_SWAP_INSTRUCTION',
  'MISSING_LOOKUP_TABLE',
  'MISSING_CONTEXT_SLOT',
  // The response describes a different trade than the one requested.
  'AMOUNT_MISMATCH',
  'MINT_MISMATCH',
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

/**
 * A response that arrived and was unusable.
 *
 * Neither an outage nor a fact about the token: the provider answered, and the
 * answer was incomplete. Kept separate because averaging these into either
 * bucket would hide a provider quietly dropping a field.
 */
export function isIncompleteBuild(f: ObservationFailure): boolean {
  return f.startsWith('MISSING_') || f === 'AMOUNT_MISMATCH' || f === 'MINT_MISMATCH';
}

/**
 * §6 — everything a BUILD_CUSTOM response must carry, checked before it is
 * allowed to become an observation.
 *
 * Returns the FIRST missing field as a typed failure, or null when the response
 * is complete. First rather than all, because the caller needs one reason to
 * store and the fields are checked in the order that makes the earliest one the
 * most informative.
 *
 * The amounts and mints are compared against what was actually requested. A
 * router returning a route for a different mint or a different size is not a
 * route for this trade, and inheriting its economics would price a position
 * that was never proposed.
 */
export interface BuildFields {
  readonly inputMint: string | null;
  readonly outputMint: string | null;
  readonly inAmount: bigint | null;
  readonly outAmount: bigint | null;
  readonly otherAmountThreshold: bigint | null;
  readonly routePlanEntries: number;
  readonly instructionCount: number;
  readonly hasSwapInstruction: boolean;
  readonly lookupTablesResolved: boolean;
  readonly blockhash: string | null;
  readonly lastValidBlockHeight: number | null;
  readonly contextSlot: number | null;
}

export interface BuildExpectation {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly requestedAmount: bigint;
}

export function missingBuildField(f: BuildFields, want: BuildExpectation): ObservationFailure | null {
  if (f.inputMint === null || f.outputMint === null) return 'MINT_MISMATCH';
  if (f.inputMint !== want.inputMint || f.outputMint !== want.outputMint) return 'MINT_MISMATCH';
  if (f.inAmount === null) return 'AMOUNT_MISMATCH';
  // Exact. A router that fills a different size is describing a different
  // trade, and this system prices the exact size it asked for.
  if (f.inAmount !== want.requestedAmount) return 'AMOUNT_MISMATCH';
  if (f.outAmount === null || f.outAmount <= 0n) return 'MISSING_MINIMUM_OUTPUT';
  // The minimum acceptable output IS the slippage protection. Absent, the
  // transaction accepts any fill at all, which is not a safer trade -- it is an
  // unbounded one that looks identical to a generous one.
  if (f.otherAmountThreshold === null || f.otherAmountThreshold <= 0n) return 'MISSING_MINIMUM_OUTPUT';
  if (f.routePlanEntries <= 0) return 'MISSING_ROUTE_PLAN';
  if (!f.hasSwapInstruction || f.instructionCount <= 0) return 'MISSING_SWAP_INSTRUCTION';
  if (!f.lookupTablesResolved) return 'MISSING_LOOKUP_TABLE';
  if (f.blockhash === null || f.blockhash.length === 0) return 'MISSING_BLOCKHASH';
  if (f.lastValidBlockHeight === null || f.lastValidBlockHeight <= 0) return 'MISSING_EXPIRY';
  // contextSlot is NOT vetoed here. Measured: it is null on all 22,177
  // observations in the corpus, because Jupiter's /build does not return it.
  //
  // A hard veto on a field the provider never populates refuses 100% of builds
  // and halts collection entirely, which is the defect this project already
  // recorded twice as MT001 and MT002. The invariant is explicit: absence of a
  // provider field is a fact about the PROVIDER, not about the token, and never
  // hard-vetoes.
  //
  // It is still load-bearing -- an offline replay needs the slot to stand at, or
  // lookup tables will not resolve -- so its absence blocks CONFIRMATORY
  // grading instead. See legIsConfirmatory.
  return null;
}

export type PolicyOutcome = 'PASS' | 'FAIL' | 'NOT_RUN';
export type SimulationOutcome = 'SIMULATED_OK' | 'SIMULATION_FAILED' | 'NOT_SIMULATED';

/**
 * P3 -- whether the ECONOMIC effect was verified, which `SimulationOutcome`
 * never claimed and was read as claiming anyway.
 *
 * `NOT_VERIFIED` is an unknown and fails every gate. It is deliberately not
 * spelled `EFFECT_REFUSED`: "nobody checked" and "somebody checked and it
 * failed" are different facts, and only one of them is evidence about a route.
 */
export type SimulationEffectOutcome = 'SIMULATED_EFFECT_OK' | 'EFFECT_REFUSED' | 'NOT_VERIFIED';

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
  /**
   * P3 -- the ECONOMIC verdict, separate from the runtime one.
   *
   * Optional in the type only so a row written before the check existed reads
   * back honestly as an unknown rather than as a pass. Every gate treats an
   * absent value as NOT_VERIFIED, which fails.
   */
  readonly simulationEffect?: SimulationEffectOutcome | null;
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

export interface LegRequirements {
  /**
   * Whether a successful LOCAL simulation is required.
   *
   * Read from `config.requireLocalSimulation`. It is a PARAMETER rather than a
   * constant because this repository's entire defect history is fields that
   * were declared, stored, listed in a schema, and read by no decision -- and a
   * config flag that nothing consults is that defect wearing a new name. If the
   * requirement were hardcoded here the flag would be ceremonial, and the
   * project has a test whose whole job is to fail on ceremonial config.
   */
  readonly requireLocalSimulation: boolean;
}

/**
 * Whether a single observation may back a PnL-eligible leg.
 *
 * Every clause is a requirement and an unknown fails. `NOT_RUN` and
 * `NOT_SIMULATED` are unknowns, not passes.
 */
export function legIsExecutable(
  o: ExecutionObservation,
  req: LegRequirements = { requireLocalSimulation: true },
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const contract = FAMILY_CONTRACTS[o.family];
  if (!contract.pnlEligible) reasons.push(`family ${o.family} is never PnL-eligible`);
  if (o.instructionPolicy !== 'PASS') reasons.push(`instruction policy ${o.instructionPolicy}`);
  if (o.transactionPolicy !== 'PASS') reasons.push(`transaction policy ${o.transactionPolicy}`);
  if (req.requireLocalSimulation && o.simulation !== 'SIMULATED_OK') {
    reasons.push(`simulation ${o.simulation}`);
  }
  // P3 -- the runtime not complaining is not the trade happening. A leg backs a
  // PnL-eligible fill only when the effect was verified: an output arrived, the
  // debit was the intended one, the fee is fully attributable, and every
  // writable the run touched was observed on both sides.
  if (req.requireLocalSimulation && (o.simulationEffect ?? 'NOT_VERIFIED') !== 'SIMULATED_EFFECT_OK') {
    reasons.push(`simulation effect ${o.simulationEffect ?? 'NOT_VERIFIED'}`);
  }
  if (o.instructionSetHash === null) reasons.push('no instruction set');
  if (o.rawPayloadHash === null) reasons.push('no retained raw payload');
  if (o.expectedOutput <= 0n) reasons.push('no expected output');

  // §6 — the load-bearing fields, required here and not only at build time.
  // A row that reached storage with one of these missing must not become a
  // fill just because the policies happened to pass over what was there.
  if (o.minimumOutput <= 0n) reasons.push('no minimum output: the fill would be unbounded');
  if (o.lastValidBlockHeight === null) reasons.push('no expiry');
  if (o.instructionCount === null || o.instructionCount <= 0) reasons.push('no instructions');
  if (o.transactionBytes === null) reasons.push('no packet size was measured');

  return { ok: reasons.length === 0, reasons };
}

/**
 * Whether an observation may back a leg counted as CONFIRMATORY evidence.
 *
 * Simulation is never optional here, whatever the operating config says.
 * `legIsExecutable` decides whether the engine may act; this decides whether
 * the resulting row is evidence, and those are different questions. An
 * operator may choose to collect development data without a simulator. Nobody
 * may choose to call it confirmatory.
 */
export function legIsConfirmatory(o: ExecutionObservation): { ok: boolean; reasons: string[] } {
  const base = legIsExecutable(o, { requireLocalSimulation: true });
  const reasons = [...base.reasons];
  // The slot the route was priced at. Absent it, an offline replay has no point
  // in time to stand at and a lookup table extended since will not resolve --
  // so the run cannot be reproduced, whatever else is right about it.
  //
  // This does NOT block collection. It blocks the row counting as evidence,
  // which is the correct place for a fact about provider coverage.
  if (o.contextSlot === null) reasons.push('no context slot: the run could not be replayed at the right point in time');
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
