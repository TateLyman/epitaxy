/**
 * P1/P24 — what makes a round trip sequential, decided by rule rather than by
 * the word in the filename.
 *
 * The previous directive shipped a proof called stateful whose sell carried the
 * wallet inventory the buy left and nothing else. Pool reserves, virtual quote
 * reserves, the creator and protocol accounts, the volume accumulator and the
 * fee config were all re-fetched from mainnet, so the sell was priced — and its
 * ROUTE chosen — against a pool with its pre-buy depth. The error flatters, and
 * a document was the only thing standing between it and a strategy estimate.
 *
 * So the classification is code, it is stamped into the artifact, and a run
 * that carries only inventory is named for what it is.
 *
 * Two provenances have to be distinguished, because either one alone is enough
 * to break the claim:
 *
 *   PRICED_FROM  where the exit's expected output came from
 *   EXECUTED_ON  what state the exit actually ran against
 *
 * A sell priced on mainnet and executed on committed state is still not
 * sequential: the size, the route and the minimum-output were all chosen
 * against depth that no longer exists.
 */

export type StateProvenance =
  /** Re-read from the chain, with no memory of any prior leg in this trip. */
  | 'FRESH_MAINNET'
  /** The committed post-state of an earlier step in the same runtime. */
  | 'COMMITTED_PRIOR_STEP'
  /** Carried by hand — a balance copied forward, the rest re-read. */
  | 'CARRIED_INVENTORY_ONLY'
  | 'UNKNOWN';

export type RoundTripEvidenceClass =
  /** Entry and exit share one committed state, and the exit was built from it. */
  | 'TRUE_SEQUENTIAL_ROUND_TRIP'
  /** Two independent market states sharing a wallet. Never strategy evidence. */
  | 'LINKED_FRESH_STATE_LEGS'
  /** The entry moved a venue the exit does not use; sequencing is vacuous. */
  | 'SEQUENTIAL_BUT_DISJOINT_VENUE'
  /** Not enough of the trip executed to classify it. */
  | 'INCOMPLETE';

export interface RoundTripProvenance {
  /** Did the entry leg commit in the runtime? */
  readonly entryCommitted: boolean;
  /** Did the exit leg commit? */
  readonly exitCommitted: boolean;
  readonly exitPricedFrom: StateProvenance;
  readonly exitExecutedOn: StateProvenance;
  /**
   * Whether the entry actually changed the accounts the exit priced against.
   *
   * Null when it was not measured, and null is NOT true: an unverified claim
   * that the buy moved the sell's pool is exactly the claim under review.
   */
  readonly entryMutatedExitVenue: boolean | null;
}

export interface RoundTripClassification {
  readonly evidenceClass: RoundTripEvidenceClass;
  readonly reasons: readonly string[];
  /** Whether a PnL figure from this trip may be used as strategy evidence. */
  readonly usableAsStrategyEvidence: boolean;
}

export function classifyRoundTrip(p: RoundTripProvenance): RoundTripClassification {
  const reasons: string[] = [];

  if (!p.entryCommitted || !p.exitCommitted) {
    reasons.push(
      !p.entryCommitted ? 'the entry leg did not commit' : 'the exit leg did not commit',
    );
    return { evidenceClass: 'INCOMPLETE', reasons, usableAsStrategyEvidence: false };
  }

  const linked: string[] = [];
  if (p.exitPricedFrom !== 'COMMITTED_PRIOR_STEP') {
    linked.push(`the exit was priced from ${p.exitPricedFrom}, not the committed entry state`);
  }
  if (p.exitExecutedOn !== 'COMMITTED_PRIOR_STEP') {
    linked.push(`the exit executed on ${p.exitExecutedOn}, not the committed entry state`);
  }
  if (linked.length > 0) {
    return {
      evidenceClass: 'LINKED_FRESH_STATE_LEGS',
      reasons: linked,
      usableAsStrategyEvidence: false,
    };
  }

  if (p.entryMutatedExitVenue !== true) {
    reasons.push(
      p.entryMutatedExitVenue === null
        ? 'whether the entry moved the venue the exit used was never measured'
        : 'the entry did not move the venue the exit used',
    );
    return {
      evidenceClass: 'SEQUENTIAL_BUT_DISJOINT_VENUE',
      reasons,
      usableAsStrategyEvidence: false,
    };
  }

  return {
    evidenceClass: 'TRUE_SEQUENTIAL_ROUND_TRIP',
    reasons: ['the exit was priced from, and executed on, the state the entry committed'],
    usableAsStrategyEvidence: true,
  };
}

/**
 * The gap between what a fresh-state exit would have quoted and what the
 * committed state quotes, in bps of the fresh-state figure.
 *
 * Positive means the fresh-state quote was HIGHER — the linked-leg proof would
 * have over-reported proceeds by that much. Sign is preserved rather than taken
 * as a magnitude, because an immediate round trip against a constant-product
 * pool moves the price in the holder's favour and the naive expectation is
 * backwards.
 */
export function selfImpactBps(freshStateQuote: bigint, committedStateQuote: bigint): number | null {
  if (freshStateQuote <= 0n) return null;
  return Number(((freshStateQuote - committedStateQuote) * 10_000n) / freshStateQuote);
}
