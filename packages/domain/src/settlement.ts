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
   * DERIVED from an identity, never read from a stored column:
   *
   *   residual = payer's native delta - (credit - tradeDebit - fees - tip
   *                                      - rentCreated + rentRecovered)
   *
   * Must be zero for a PnL-eligible leg. A residue is not rounding: it is a
   * cost the model does not know about, and a cost the model does not know
   * about is exactly what turns a positive backtest into a negative account.
   */
  readonly unexplainedLamports: bigint;
  /**
   * Value that reached accounts the request did not name.
   *
   * NOT a residual, and this distinction cost a full measurement cycle. Every
   * AMM swap moves lamports into pool vaults and into the token account it
   * creates, so this is large and non-zero on every SUCCESSFUL trade. Read as
   * "unexplained cost" it condemns exactly the legs that worked.
   *
   * It is kept because it is the number a skim is found in — against a route
   * plan, not against zero.
   */
  readonly valueToUnnamedAccountsLamports: bigint;
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

  /**
   * The payer's own native balance change. Negative when it spent.
   *
   * THE primitive every cash figure is derived from, because it is the one
   * quantity that cannot disagree with itself. Building the round trip out of
   * a credit here and a debit there is how the exit's fees and rent went
   * missing from it entirely.
   */
  readonly payerNativeDeltaLamports: bigint;

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
  if (!s.fullAccountCoverage) reasons.push('did not observe every writable it touched');
  if (s.costs.unexplainedLamports !== 0n) {
    reasons.push(`${s.costs.unexplainedLamports} lamports left the payer with no named cost`);
  }
  // Deliberately NOT gated on `valueToUnnamedAccountsLamports`. See its doc.

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
 * From the payer's balance, not from the input side of the trade: fees, tip
 * and rent all left too, and a cash figure that omits them is not cash.
 */
export function entryCashOut(s: MeasuredLegSettlement): { cashOut: bigint; lockedRent: bigint } {
  if (s.side !== 'buy') throw new Error(`entryCashOut on a ${s.side} leg`);
  return {
    cashOut: -s.payerNativeDeltaLamports,
    lockedRent: s.costs.rentCreatedLamports - s.costs.rentRecoveredLamports,
  };
}

/**
 * What the payer actually netted by closing.
 *
 * This was `realized + rentRecovered`: the gross credit, with the exit's own
 * signature fee, priority fee and rent silently dropped. On a measured leg
 * that was 19,288,556 reported against 15,202,728 actually received — the
 * round trip was flattering the exit by the entire cost of taking it.
 */
export function exitCashIn(s: MeasuredLegSettlement): bigint {
  if (s.side !== 'sell') throw new Error(`exitCashIn on a ${s.side} leg`);
  return s.payerNativeDeltaLamports;
}

/**
 * What EXECUTING cost, with the principal excluded.
 *
 * P4's field contract:
 *
 *   execution_cost_lamports   fees/tips/rent loss/failure cost only
 *                             NEVER principal
 *
 * Production was writing `entryCashOut().cashOut` here, which is principal
 * plus costs. On a 0.02 SOL entry that reports ~24,000,000 lamports of
 * "execution cost" against ~4,087,000 of actual cost — and a 2x-cost stress
 * test then doubles the principal, which is not a cost and does not double.
 *
 * Rent enters as the part NOT recovered: rent that comes back was never spent.
 */
export function executionCost(s: MeasuredLegSettlement): bigint {
  return (
    s.costs.baseFeeLamports +
    s.costs.priorityFeeLamports +
    s.costs.tipLamports +
    (s.costs.rentCreatedLamports - s.costs.rentRecoveredLamports) +
    s.costs.failedAttemptCostLamports
  );
}

/**
 * The transfer fee, or a refusal.
 *
 * A null transfer fee must never become zero — but zero is CORRECT when the
 * asset cannot have one. Legacy SPL Token has no transfer-fee extension, so
 * "not applicable" and "not measured" are different answers and only the
 * second blocks a PnL-eligible leg.
 *
 * Returns null when it is genuinely unknown, and the caller must refuse.
 */
export function transferFeeOrUnknown(s: MeasuredLegSettlement): bigint | null {
  const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const touches2022 =
    (s.input.kind === 'token' && s.input.tokenProgram === TOKEN_2022) ||
    (s.output.kind === 'token' && s.output.tokenProgram === TOKEN_2022);

  if (s.costs.transferFeeLamportsEquivalent !== null) return s.costs.transferFeeLamportsEquivalent;
  // Not applicable: legacy Token has no such extension.
  if (!touches2022) return 0n;
  // Token-2022 and unmeasured. Unknown, and unknown is not zero.
  return null;
}

/**
 * The immediate round trip, from two measured settlements.
 *
 * Not from router quotes on either side. This is the number the tradability
 * gate must refuse on, and computing it from anything else means refusing on a
 * different trade than the one that would be booked.
 */
export interface RoundTripEconomics {
  /** Everything that left the payer to open. */
  readonly cashOutLamports: bigint;
  /** Everything the payer actually netted by closing, exit costs included. */
  readonly cashInLamports: bigint;
  readonly netLamports: bigint;
  /** All-in, counting rent as a cost. Reported, not gated. */
  readonly lossBps: number;

  /**
   * The trading loss: slippage, fees and price, with rent excluded.
   *
   * THIS is what the tradability cap gates on, and the difference is not
   * cosmetic. Measured live: 3688 bps all-in against 363 bps of trading cost,
   * on a 0.02 SOL round trip with a 300 bps slippage allowance. The gap is
   * account rent, which does not scale with the edge and is returned when the
   * account is closed.
   *
   * Rent is locked capital, which is this system's existing treatment of it.
   * Counting it as a trading cost refuses trades for a charge the market never
   * made; assuming it back without closing the account would be the opposite
   * error, so it is reported separately rather than netted away silently.
   */
  readonly tradingLossBps: number;
  /** Rent this round trip locked. Recoverable only by closing the account. */
  readonly recoverableRentLamports: bigint;
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

  const { cashOut, lockedRent: buyRent } = entryCashOut(buy);
  const cashIn = exitCashIn(sell);
  const net = cashIn - cashOut;
  const lossBps = cashOut <= 0n ? 0 : Number(((cashOut - cashIn) * 10_000n) / cashOut);

  // Rent both legs locked and neither returned. Each leg is simulated from a
  // fresh state, so a sell provisions accounts a real round trip already holds;
  // its rent is an artifact of measuring the legs separately.
  const sellRent = sell.costs.rentCreatedLamports - sell.costs.rentRecoveredLamports;
  const rentLocked = buyRent + sellRent;

  // The trading question: what did the MARKET charge? Rent is capital the
  // account holds, returned when it is closed, and it does not scale with the
  // edge. Excluded from both sides of the ratio, never from one.
  const tradingNet = net + rentLocked;
  const tradingBasis = cashOut - buyRent;
  const tradingLossBps = tradingBasis <= 0n ? 0 : Number((-tradingNet * 10_000n) / tradingBasis);

  return {
    cashOutLamports: cashOut,
    cashInLamports: cashIn,
    netLamports: net,
    lossBps,
    tradingLossBps,
    recoverableRentLamports: rentLocked,
    complete: reasons.length === 0,
    reasons,
  };
}
