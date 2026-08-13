/**
 * What actually happened to a token we refused.
 *
 * §17 — "provider disappearance is not -100%".
 *
 * The reject corpus is the only thing that can say whether the gates are
 * throwing away money, and it is the easiest corpus in the system to corrupt.
 * A token the provider stops listing has a NULL price, and a NULL price read as
 * a number is zero, and zero means the token went to nothing. Every gate then
 * looks brilliant: the things it rejected all "went to zero", when what actually
 * happened is that a provider stopped answering about them.
 *
 * That error has a direction. It always flatters the gates, and it is largest
 * exactly where the data is thinnest, so it survives every sanity check that
 * asks whether the numbers look plausible.
 *
 * So each horizon observation is classified explicitly, and only one of these
 * classes is a return.
 */

export const REJECT_OUTCOMES = [
  /** A route existed at the horizon and we know what it was worth. */
  'EXECUTABLE_VALUE',
  /** The router answered and said there is no route. A fact about the token. */
  'NO_ROUTE_CONFIRMED',
  /** Reserves observed to have collapsed on-chain. A fact about the pool. */
  'POOL_DRAIN_CONFIRMED',
  /** The provider stopped listing it. A fact about the PROVIDER. */
  'PROVIDER_MISSING',
  /** We were not observing at the time. A fact about US. */
  'SOURCE_GAP',
  /** A route was quoted but no transaction could be built for it. */
  'UNBUILDABLE',
  /** None of the above could be established. */
  'UNKNOWN',
] as const;
export type RejectOutcome = (typeof REJECT_OUTCOMES)[number];

/** Only this class carries a number that may be averaged into a return. */
export function isReturnBearing(o: RejectOutcome): boolean {
  return o === 'EXECUTABLE_VALUE';
}

/**
 * A confirmed total loss, as distinct from an absence of information.
 *
 * Both of these mean the position would have been worth nothing, and both are
 * legitimately -100%. Neither is inferred from a missing field.
 */
export function isConfirmedWorthless(o: RejectOutcome): boolean {
  return o === 'NO_ROUTE_CONFIRMED' || o === 'POOL_DRAIN_CONFIRMED';
}

export interface HorizonEvidence {
  /** Did a router answer at all at this horizon? */
  readonly providerAnswered: boolean;
  /** Did the router say a route exists? Null when it did not answer. */
  readonly routeExists: boolean | null;
  /** Executable value in lamports, when one was obtained. */
  readonly executableValueLamports: bigint | null;
  /** Could a transaction be built for the route? Null when not attempted. */
  readonly buildable: boolean | null;
  /** On-chain reserves, when observed. Null is unknown, not zero. */
  readonly poolReservesLamports: bigint | null;
  /** True when this engine was not collecting across the horizon. */
  readonly sourceGap: boolean;
}

/**
 * Classify one horizon observation.
 *
 * Ordered so the most specific fact wins, and so our own failures are never
 * attributed to the token. A source gap is checked FIRST: if we were not
 * watching, nothing else we think we know about that window is evidence.
 */
export function classifyRejectOutcome(e: HorizonEvidence): RejectOutcome {
  // We were not looking. Anything else here is inference about a period we did
  // not observe, and inference is not evidence.
  if (e.sourceGap) return 'SOURCE_GAP';

  // The provider went away. This says nothing whatsoever about the token, and
  // treating it as a total loss is the defect this whole module exists for.
  if (!e.providerAnswered) return 'PROVIDER_MISSING';

  // The provider answered and said there is no route. That IS a fact about the
  // token, and it is a confirmed total loss.
  if (e.routeExists === false) return 'NO_ROUTE_CONFIRMED';

  // Reserves observed at zero on-chain: confirmed independently of any router.
  if (e.poolReservesLamports !== null && e.poolReservesLamports === 0n) return 'POOL_DRAIN_CONFIRMED';

  // A route that cannot be turned into a transaction is not a route we could
  // have taken, and its quoted value is not a value we could have realised.
  if (e.buildable === false) return 'UNBUILDABLE';

  if (e.executableValueLamports !== null && e.executableValueLamports >= 0n) return 'EXECUTABLE_VALUE';

  return 'UNKNOWN';
}

/**
 * The return to attribute to a classified horizon, or null.
 *
 * Null means "do not put this in the average". It is deliberately NOT zero and
 * deliberately not -100%: a horizon we cannot price must be excluded and
 * counted, not folded in at a convenient number.
 */
export function rejectReturnBps(
  outcome: RejectOutcome,
  entryNotionalLamports: bigint,
  valueLamports: bigint | null,
): number | null {
  if (isConfirmedWorthless(outcome)) return -10_000;
  if (!isReturnBearing(outcome)) return null;
  if (valueLamports === null || entryNotionalLamports <= 0n) return null;
  return Number(((valueLamports - entryNotionalLamports) * 10_000n) / entryNotionalLamports);
}

export interface OutcomeMix {
  readonly counts: Readonly<Record<RejectOutcome, number>>;
  readonly priceable: number;
  readonly total: number;
  /** Share of horizons that could not be priced. High means low trust. */
  readonly unpriceableFraction: number;
}

/**
 * Summarise a set of classified horizons.
 *
 * `unpriceableFraction` is the number to read first. A reject study where half
 * the horizons are PROVIDER_MISSING is not a study of rejected tokens; it is a
 * study of provider coverage wearing that name.
 */
export function summariseOutcomes(outcomes: readonly RejectOutcome[]): OutcomeMix {
  const counts = Object.fromEntries(REJECT_OUTCOMES.map((o) => [o, 0])) as Record<RejectOutcome, number>;
  for (const o of outcomes) counts[o] += 1;
  const priceable = outcomes.filter((o) => isReturnBearing(o) || isConfirmedWorthless(o)).length;
  return {
    counts,
    priceable,
    total: outcomes.length,
    unpriceableFraction: outcomes.length === 0 ? 1 : (outcomes.length - priceable) / outcomes.length,
  };
}
