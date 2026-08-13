/**
 * The one place a leg's economics are calculated.
 *
 * §10.6 — "no cost may appear in one path and disappear in another".
 *
 * Before this, the same trade was priced in `paper.ts` for the portfolio, again
 * in the shadow books, again in viability, and again in the reports, each
 * assembling its own sum out of the same config fields. Four assemblies of one
 * calculation is four chances to forget a term, and the way you discover you
 * forgot one is that a strategy looks profitable in one report and not another.
 *
 * Everything is `bigint` lamports. Nothing here rounds, and nothing here
 * silently defaults: a cost that is not known is `null` and makes the whole
 * quote `complete: false`, because a total assembled from an unknown is not a
 * total.
 */

export interface LegCosts {
  /** 5,000 per required signature. Charged whether or not the route lands. */
  readonly signatureFeeLamports: bigint;
  /**
   * ceil(unit_price × applied_limit / 1e6), where the applied limit is the
   * router's explicit one or the runtime's derived default. Never zero merely
   * because the router omitted a limit.
   */
  readonly priorityFeeLamports: bigint;
  /**
   * Rent for an associated token account this leg creates, or 0n when the
   * account already exists. LOCKED capital, not a loss, until it is not
   * recovered.
   */
  readonly ataRentLamports: bigint;
  /** Tip paid to a broadcaster. 0n while nothing is submitted. */
  readonly broadcasterTipLamports: bigint;
  /**
   * Router fee taken out of the output, when the route reports one. Null means
   * the provider did not say, which is not the same as none.
   */
  readonly platformFeeLamports: bigint | null;
}

export interface ExpectedFailureCost {
  /** Probability this leg has to be attempted more than once. */
  readonly probability: number;
  /** What one landed failure costs: signature plus priority fee, no output. */
  readonly conditionalLamports: bigint;
  /** probability × conditional, rounded UP to the lamport. */
  readonly expectedLamports: bigint;
  /** How the probability was arrived at, so an assumption is never silent. */
  readonly basis: 'observed' | 'upper-confidence-bound' | 'assumed-zero' | 'unknown';
}

export interface LegQuote {
  /** Everything paid regardless of outcome. */
  readonly fixedCostLamports: bigint;
  /** Rent, which is locked rather than spent. Included in capital, not in loss. */
  readonly lockedCapitalLamports: bigint;
  /** Expected cost of attempts that land and fail. */
  readonly expectedFailureLamports: bigint;
  /**
   * Everything the leg costs before any price movement: fixed + expected
   * failure. Rent is excluded because it is recoverable; see `lockedCapital`.
   */
  readonly totalCostLamports: bigint;
  /** False when any input was unknown. A false here must block a fill. */
  readonly complete: boolean;
  readonly missing: readonly string[];
}

/**
 * Price one leg.
 *
 * Rent is deliberately NOT part of `totalCostLamports`. It is capital that
 * leaves the free balance and comes back when the account is closed; counting
 * it as a cost double-charges a round trip that recovers it, and counting it as
 * free understates the capital a position ties up. It is its own number.
 */
export function quoteLeg(costs: LegCosts, failure: ExpectedFailureCost): LegQuote {
  const missing: string[] = [];
  if (costs.platformFeeLamports === null) missing.push('platform fee not reported by the provider');
  if (failure.basis === 'unknown') missing.push('failure probability unknown');

  const fixed =
    costs.signatureFeeLamports +
    costs.priorityFeeLamports +
    costs.broadcasterTipLamports +
    (costs.platformFeeLamports ?? 0n);

  return {
    fixedCostLamports: fixed,
    lockedCapitalLamports: costs.ataRentLamports,
    expectedFailureLamports: failure.expectedLamports,
    totalCostLamports: fixed + failure.expectedLamports,
    complete: missing.length === 0,
    missing,
  };
}

/**
 * The expected cost of landed failures.
 *
 * §10.3 — replaces one flat `assumedFailedAttemptLamports` charged on every
 * leg. A flat charge is wrong in both directions at once: it charges a cost
 * that usually does not happen, and it charges the same amount whether the
 * conditional cost is a 5,000-lamport signature or a 1.4-million-unit priority
 * fee.
 *
 * `probability` is a rate, not a count. It is rounded UP to the lamport, so a
 * small expected cost never disappears into truncation.
 */
export function expectedFailureCost(
  attempts: { landedFailures: number; total: number },
  conditionalLamports: bigint,
  basis: ExpectedFailureCost['basis'],
): ExpectedFailureCost {
  if (attempts.total === 0) {
    // No attempts observed. Zero is a claim, so it is labelled as one.
    return {
      probability: 0,
      conditionalLamports,
      expectedLamports: 0n,
      basis: basis === 'observed' ? 'assumed-zero' : basis,
    };
  }
  const probability = attempts.landedFailures / attempts.total;
  // Scaled arithmetic: the rate is a float, the money is not. Multiply in
  // basis-point-of-a-basis-point space and round up.
  const scaled = BigInt(Math.ceil(probability * 1_000_000));
  const expected = (conditionalLamports * scaled + 999_999n) / 1_000_000n;
  return { probability, conditionalLamports, expectedLamports: expected, basis };
}

/**
 * A full round trip: buy, hold, sell.
 *
 * §10.4 — closing an ATA in the SAME transaction as the exit swap does not pay
 * another signature. Charging one is a fabricated cost, and at the sizes this
 * system trades a 5,000-lamport phantom is 2.5 basis points of a 0.02 SOL leg.
 */
export interface RoundTrip {
  readonly entry: LegQuote;
  readonly exit: LegQuote;
  readonly closesAtaInExitTransaction: boolean;
  readonly ataRentRecovered: boolean;
}

export interface RoundTripCost {
  readonly totalCostLamports: bigint;
  /** Rent that is not coming back. A real loss, unlike locked rent. */
  readonly unrecoveredRentLamports: bigint;
  readonly complete: boolean;
  readonly missing: readonly string[];
}

export function quoteRoundTrip(rt: RoundTrip): RoundTripCost {
  const missing = [...rt.entry.missing.map((m) => `entry: ${m}`), ...rt.exit.missing.map((m) => `exit: ${m}`)];
  // The exit already carries its own signature fee. A same-transaction close
  // adds instructions, not signatures, so nothing extra is added here -- the
  // comment exists because adding one is the intuitive mistake.
  const unrecovered = rt.ataRentRecovered ? 0n : rt.entry.lockedCapitalLamports;
  return {
    totalCostLamports: rt.entry.totalCostLamports + rt.exit.totalCostLamports + unrecovered,
    unrecoveredRentLamports: unrecovered,
    complete: rt.entry.complete && rt.exit.complete,
    missing,
  };
}

/** Cost as a fraction of notional, in basis points. Rounded UP. */
export function costBps(costLamports: bigint, notionalLamports: bigint): number | null {
  if (notionalLamports <= 0n) return null;
  return Number((costLamports * 10_000n + notionalLamports - 1n) / notionalLamports);
}
