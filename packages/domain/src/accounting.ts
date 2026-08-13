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


/**
 * P12 — the entry and exit cash flows, as the ONE implementation.
 *
 * `packages/domain/src/execution.ts` had `totalEntryCost` and `netExitProceeds`
 * doing this arithmetic separately, and they were what the runtime actually
 * called; this module was used by one script. Two implementations of one
 * calculation is two chances to forget a term, and the way you find out you
 * forgot one is that a strategy is profitable in one report and not another.
 *
 * Those two functions now delegate here. Nothing else may re-derive these sums.
 */

export interface EntryCashFlow {
  /** The exact input the leg spends. Not a probe, not a round number. */
  readonly inputLamports: bigint;
  readonly baseFeeLamports: bigint;
  /** MEASURED, from the applied compute limit. Never assumed zero. */
  readonly priorityFeeLamports: bigint;
  /** Route-specific. A Jupiter /submit tip is not paid to another broadcaster. */
  readonly routeTipLamports: bigint;
  /** Rent for an ATA this leg creates. Locked capital, not a loss. */
  readonly rentCreatedLamports: bigint;
  /**
   * Transfer fee NOT already embedded in the quoted output.
   *
   * Null means unobserved. In confirmatory data that is fatal rather than zero:
   * a Token-2022 transfer fee read as zero understates every cost it touches,
   * and it is exactly the extension a memecoin is most likely to carry.
   */
  readonly transferFeeLamports: bigint | null;
  /** Explicit platform fee not already embedded. Null means the provider did not say. */
  readonly platformFeeLamports: bigint | null;
  readonly failure: ExpectedFailureCost;
}

export interface CashFlowResult {
  /** Capital that leaves the free balance. Includes locked rent. */
  readonly cashLamports: bigint;
  /** The part that is recoverable rather than spent. */
  readonly lockedCapitalLamports: bigint;
  /** cash minus locked: what is actually gone. */
  readonly spentLamports: bigint;
  readonly complete: boolean;
  readonly missing: readonly string[];
}

export function entryCashOut(f: EntryCashFlow): CashFlowResult {
  const missing: string[] = [];
  if (f.transferFeeLamports === null) missing.push('transfer fee not observed');
  if (f.platformFeeLamports === null) missing.push('platform fee not reported by the provider');
  if (f.failure.basis === 'unknown') missing.push('failure probability unknown');

  const cash =
    f.inputLamports +
    f.baseFeeLamports +
    f.priorityFeeLamports +
    f.routeTipLamports +
    f.rentCreatedLamports +
    (f.transferFeeLamports ?? 0n) +
    (f.platformFeeLamports ?? 0n) +
    f.failure.expectedLamports;

  return {
    cashLamports: cash,
    lockedCapitalLamports: f.rentCreatedLamports,
    spentLamports: cash - f.rentCreatedLamports,
    complete: missing.length === 0,
    missing,
  };
}

export interface ExitCashFlow {
  readonly outputLamports: bigint;
  readonly baseFeeLamports: bigint;
  readonly priorityFeeLamports: bigint;
  readonly routeTipLamports: bigint;
  readonly transferFeeLamports: bigint | null;
  /**
   * Charged ONLY when closing the account needs its own transaction.
   *
   * A close in the same exit transaction pays no second signature, and charging
   * one is a fabricated cost: 5,000 lamports against a 0.02 SOL leg is 2.5 bps
   * of an edge measured in hundreds.
   */
  readonly separateCloseTransaction: boolean;
  /** Credited only when a close was actually shown to be possible. */
  readonly rentRecoveredLamports: bigint;
  readonly failure: ExpectedFailureCost;
}

export function exitCashIn(f: ExitCashFlow): CashFlowResult {
  const missing: string[] = [];
  if (f.transferFeeLamports === null) missing.push('transfer fee not observed');
  if (f.failure.basis === 'unknown') missing.push('failure probability unknown');

  const closeFee = f.separateCloseTransaction ? f.baseFeeLamports : 0n;
  const cash =
    f.outputLamports -
    f.baseFeeLamports -
    f.priorityFeeLamports -
    f.routeTipLamports -
    (f.transferFeeLamports ?? 0n) -
    closeFee -
    f.failure.expectedLamports +
    f.rentRecoveredLamports;

  return {
    cashLamports: cash,
    lockedCapitalLamports: 0n,
    spentLamports: cash,
    complete: missing.length === 0,
    missing,
  };
}

/**
 * The failure model, from observed attempts rather than one flat charge.
 *
 * P12 replaces `assumedFailedAttemptLamports` charged identically on every leg.
 * A flat charge is wrong in both directions at once: it charges a cost that
 * usually does not happen, and it charges the same amount whether the
 * conditional cost is a 5,000-lamport signature or a 1.4-million-unit priority
 * fee.
 */
export interface AttemptRecord {
  readonly entryAttempts: number;
  readonly entryLandedFailures: number;
  readonly entryLandedFeeLamports: bigint;
  readonly exitAttempts: number;
  readonly exitLandedFailures: number;
  readonly exitLandedFeeLamports: bigint;
}

/**
 * An upper bound on the failure rate, not the point estimate.
 *
 * Three failures in ten attempts and three hundred in a thousand are the same
 * point estimate and very different evidence. The upper bound is what sizing
 * has to survive, so it is what sizing is given.
 *
 * Wilson-style, without pretending to more precision than a small sample has.
 */
export function failureUpperBound(landedFailures: number, attempts: number, z = 1.96): number {
  if (attempts <= 0) return 1;
  const p = landedFailures / attempts;
  const denom = 1 + (z * z) / attempts;
  const centre = p + (z * z) / (2 * attempts);
  const spread = z * Math.sqrt((p * (1 - p)) / attempts + (z * z) / (4 * attempts * attempts));
  return Math.min(1, (centre + spread) / denom);
}

/**
 * The failure cost sizing should assume, from the attempt record.
 *
 * Uses the UPPER BOUND. With no attempts the bound is 1, so a leg with no
 * history is charged a full failure -- which is the honest answer, and which
 * makes collecting the history worth something.
 */
export function sizingFailureCost(
  record: AttemptRecord,
  side: 'entry' | 'exit',
  conditionalLamports: bigint,
): ExpectedFailureCost {
  const attempts = side === 'entry' ? record.entryAttempts : record.exitAttempts;
  const failures = side === 'entry' ? record.entryLandedFailures : record.exitLandedFailures;
  const bound = failureUpperBound(failures, attempts);
  const scaled = BigInt(Math.ceil(bound * 1_000_000));
  return {
    probability: bound,
    conditionalLamports,
    expectedLamports: (conditionalLamports * scaled + 999_999n) / 1_000_000n,
    basis: attempts === 0 ? 'unknown' : 'upper-confidence-bound',
  };
}
