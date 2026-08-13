/**
 * P2 — the one canonical measured settlement of a leg.
 *
 * The defect this exists to make impossible:
 *
 *   the simulation verifies one set of amounts
 *   and the paper position books a different set
 *
 * That is not a rounding disagreement. It means the thing admitted by the gate
 * and the thing recorded as evidence are different trades, and every downstream
 * number — PnL, round-trip loss, cost surface, readiness — describes the
 * second while the first is what was checked.
 *
 * A settlement is derived from exactly four inputs and nothing else:
 *
 *   one exact observation
 *   one completed simulation job
 *   the persisted structured pre/post state
 *   the exact economic request
 *
 * Never from router amounts after effect verification. The router's expected
 * and minimum outputs remain BOUNDS and BENCHMARKS: they say what was asked
 * for, never what happened.
 */

export type SettlementAsset =
  | {
      readonly kind: 'native_sol';
      /** What the leg asked to spend, before fees. */
      readonly requestedLamports: bigint;
      /** The swap's own lamports, separated from fees, tip and rent. */
      readonly actualTradeDebitLamports: bigint;
      /** Everything that left the payer, including fees and rent. */
      readonly totalPayerDebitLamports: bigint;
    }
  | {
      readonly kind: 'token';
      readonly mint: string;
      readonly tokenProgram: string;
      readonly tokenAccount: string;
      readonly requestedAtoms: bigint;
      readonly actualDebitAtoms: bigint;
    };

export type SettlementCredit =
  | {
      readonly kind: 'native_sol';
      readonly minimumLamports: bigint;
      readonly expectedLamports: bigint | null;
      readonly actualCreditLamports: bigint;
    }
  | {
      readonly kind: 'token';
      readonly mint: string;
      readonly tokenProgram: string;
      readonly tokenAccount: string;
      readonly minimumAtoms: bigint;
      readonly expectedAtoms: bigint | null;
      readonly actualCreditAtoms: bigint;
    };

/**
 * Every cost, each either measured or explicitly unknown.
 *
 * `null` means unobserved. It never becomes zero. A family fact MAY be zero —
 * BUILD_CUSTOM through Jupiter charges no platform fee, and that is a fact
 * about the family rather than a missing measurement — but an unobserved value
 * may not.
 */
export interface SettlementCosts {
  readonly baseFeeLamports: bigint;
  readonly priorityFeeLamports: bigint;
  readonly tipLamports: bigint;
  readonly protocolFeeLamports: bigint | null;
  readonly creatorFeeLamports: bigint | null;
  readonly lpFeeLamports: bigint | null;
  /** Zero is a FAMILY FACT for BUILD_CUSTOM, not an assumption. */
  readonly platformFeeLamports: bigint;
  readonly transferFeeAtoms: bigint | null;
  readonly transferFeeLamportsEquivalent: bigint | null;
  readonly rentCreatedLamports: bigint;
  readonly rentRecoveredLamports: bigint;
  readonly failedAttemptCostLamports: bigint;
  /**
   * Lamports that left the payer and no named cost explains.
   *
   * Must be zero for a PnL-eligible leg. A residue is not rounding: it is a
   * cost the model does not know about, and a cost the model does not know
   * about is exactly what turns a positive backtest into a negative account.
   */
  readonly unexplainedLamports: bigint;
}

export interface MeasuredLegSettlement {
  readonly observationId: string;
  readonly simulationJobId: string;
  readonly side: 'buy' | 'sell';
  readonly family: string;
  readonly capabilityFingerprint: string;

  readonly input: SettlementAsset;
  readonly output: SettlementCredit;
  readonly costs: SettlementCosts;

  readonly createdAccounts: readonly string[];
  readonly closedAccounts: readonly string[];
  /** What the leg still holds of the input asset. Null when unobserved. */
  readonly residualTokenAtoms: bigint | null;

  readonly fullAccountCoverage: boolean;
  readonly effectValid: boolean;
  readonly effectRefusals: readonly string[];
  readonly snapshotManifestHash: string | null;
  readonly replayable: boolean;

  /** False when any money-critical quantity is unknown. See `incompleteness`. */
  readonly complete: boolean;
  readonly incompleteness: readonly string[];
}

/**
 * Whether a settlement may back a PnL-eligible leg.
 *
 * All four, and the reasons are not interchangeable:
 *
 *   complete              every money-critical quantity is known
 *   effectValid           the trade demonstrably happened
 *   fullAccountCoverage   every writable was observed on both sides
 *   unexplained == 0      no lamport left the payer unaccounted for
 */
export function isPnlEligible(s: MeasuredLegSettlement): { ok: boolean; reasons: readonly string[] } {
  const reasons: string[] = [];
  if (!s.complete) reasons.push(`settlement incomplete: ${s.incompleteness.join('; ')}`);
  if (!s.effectValid) reasons.push(`effect not verified: ${s.effectRefusals.slice(0, 2).join('; ')}`);
  if (!s.fullAccountCoverage) reasons.push('account coverage incomplete');
  if (s.costs.unexplainedLamports !== 0n) {
    reasons.push(`${s.costs.unexplainedLamports} lamports left the payer with no named cost`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * The tokens a BUY actually acquired.
 *
 * THE number the production entry must use. `netMinimumOutput()` is the
 * router's floor — what it promised not to go below — and booking it as the
 * acquired amount records a position the simulator never verified. The two
 * differ by the slippage allowance on every single trade.
 *
 * Throws rather than returning a fallback: a caller that cannot get the
 * measured credit must refuse the entry, not proceed on an estimate.
 */
export function acquiredTokens(s: MeasuredLegSettlement): bigint {
  if (s.side !== 'buy') throw new Error(`acquiredTokens on a ${s.side} leg`);
  if (s.output.kind !== 'token') {
    throw new Error('a buy whose output is not a token has no acquired token amount');
  }
  return s.output.actualCreditAtoms;
}

/** The lamports a SELL actually returned. Same contract as above. */
export function realizedLamports(s: MeasuredLegSettlement): bigint {
  if (s.side !== 'sell') throw new Error(`realizedLamports on a ${s.side} leg`);
  if (s.output.kind !== 'native_sol') {
    throw new Error('a sell whose output is not native SOL has no realized lamports');
  }
  return s.output.actualCreditLamports;
}

/**
 * Everything that left the payer to open this position.
 *
 * Includes locked rent, because it did leave. `lockedRentLamports` reports the
 * recoverable part separately so the caller can decide, once, whether to treat
 * it as capital or cost — rather than each caller deciding differently.
 */
export function entryCashOut(s: MeasuredLegSettlement): { cashOut: bigint; lockedRent: bigint } {
  if (s.input.kind !== 'native_sol') {
    throw new Error('entry cash out is a native-SOL concept; a token-input leg is not an entry');
  }
  return { cashOut: s.input.totalPayerDebitLamports, lockedRent: s.costs.rentCreatedLamports };
}

/** What the payer actually received, net, for closing. */
export function exitCashIn(s: MeasuredLegSettlement): bigint {
  return realizedLamports(s) + s.costs.rentRecoveredLamports;
}

/**
 * The immediate round trip, from two measured settlements.
 *
 * Not from router quotes on either side. This is the number the tradability
 * gate must refuse on, and computing it from anything else means refusing on a
 * different trade than the one that would be booked.
 */
export interface RoundTripEconomics {
  readonly cashOutLamports: bigint;
  readonly cashInLamports: bigint;
  readonly netLamports: bigint;
  readonly lossBps: number;
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

export function immediateRoundTrip(buy: MeasuredLegSettlement, sell: MeasuredLegSettlement): RoundTripEconomics {
  const reasons: string[] = [];
  const b = isPnlEligible(buy);
  const s = isPnlEligible(sell);
  if (!b.ok) reasons.push(...b.reasons.map((r) => `buy: ${r}`));
  if (!s.ok) reasons.push(...s.reasons.map((r) => `sell: ${r}`));
  if (buy.family !== sell.family) {
    // Two families are two markets, and their difference is not a round trip.
    reasons.push(`family ${buy.family} != ${sell.family}`);
  }

  const { cashOut, lockedRent } = entryCashOut(buy);
  const cashIn = exitCashIn(sell);
  // Rent is counted ONCE: it left on the buy and came back on the sell, and
  // the recovered part is already inside cashIn.
  void lockedRent;
  const net = cashIn - cashOut;
  const lossBps = cashOut <= 0n ? 0 : Number(((cashOut - cashIn) * 10_000n) / cashOut);

  return {
    cashOutLamports: cashOut,
    cashInLamports: cashIn,
    netLamports: net,
    lossBps,
    complete: reasons.length === 0,
    reasons,
  };
}
