/**
 * P1 — one evidence taxonomy, so a claim carries its own strength.
 *
 * The failure this removes is a report that says "profitable" without saying
 * what kind of evidence the number rests on. A development counterfactual and a
 * landed mainnet fill are both "a trade" in a table, and pooling them produces a
 * number that means nothing while looking authoritative.
 *
 * The grades are ORDERED. Nothing may be promoted on evidence weaker than its
 * gate requires, and a mixed set takes the grade of its WEAKEST member — because
 * the weakest member is what an adversary would point at.
 *
 * NOT the same axis as `EvidenceClass` in ./evidence.js, and the two are kept in
 * separate files so they cannot be confused. `EvidenceClass` grades how well a
 * single LEG's simulation was verified (structural → effect-valid → offline
 * reproducible → confirmatory). `EvidenceGrade` here grades what an entire
 * TRAJECTORY's economics rest on. A trajectory can be built from confirmatory
 * legs and still be only `BOUNDED_COUNTERFACTUAL`, because its exit was
 * evaluated against a future state that never contained its entry.
 */

export type EvidenceGrade =
  /** A model evaluated against a model. Proves arithmetic, never economics. */
  | 'SYNTHETIC'
  /**
   * A quote or a pool-derived price at a real state. Nobody executed at it.
   * This is a mark, and a mark is a hypothesis about a fill.
   */
  | 'OBSERVED_PRICE'
  /**
   * A leg the runtime executed against real captured state, sequentially, with
   * the post-state measured. The entry is exact; the future is not.
   */
  | 'SIMULATED_EXECUTION'
  /**
   * A trajectory whose exit was evaluated against a LATER real pool state, with
   * the entry's own price impact bounded and haircut. Development evidence.
   */
  | 'BOUNDED_COUNTERFACTUAL'
  /**
   * As above, but the intervening pool events were replayed onto the local
   * post-entry state before the exit was evaluated. The stronger counterfactual.
   */
  | 'FULL_EVENT_REPLAY'
  /** A transaction that landed on mainnet and was reconciled from the chain. */
  | 'LANDED_MAINNET';

const ORDER: readonly EvidenceGrade[] = [
  'SYNTHETIC',
  'OBSERVED_PRICE',
  'SIMULATED_EXECUTION',
  'BOUNDED_COUNTERFACTUAL',
  'FULL_EVENT_REPLAY',
  'LANDED_MAINNET',
];

export function evidenceRank(g: EvidenceGrade): number {
  const i = ORDER.indexOf(g);
  if (i < 0) throw new Error(`unknown evidence grade ${g}`);
  return i;
}

export function atLeast(actual: EvidenceGrade, required: EvidenceGrade): boolean {
  return evidenceRank(actual) >= evidenceRank(required);
}

/**
 * The grade of a set is the grade of its weakest member.
 *
 * Taking the strongest, or the mean, is how one landed fill launders a hundred
 * synthetic ones into "mainnet evidence".
 */
export function weakestGrade(gs: readonly EvidenceGrade[]): EvidenceGrade | null {
  if (gs.length === 0) return null;
  let worst = gs[0] as EvidenceGrade;
  for (const g of gs) if (evidenceRank(g) < evidenceRank(worst)) worst = g;
  return worst;
}

/**
 * What each terminal claim is allowed to rest on.
 *
 * `LIVE_READY` is deliberately absent: no combination of evidence in this
 * repository can produce it, and the directive forbids it.
 */
export const CLAIM_REQUIREMENTS = {
  MEASUREMENT_REPAIR_REQUIRED: 'SYNTHETIC',
  VALID_TRAJECTORY_KERNEL_RUNNING: 'SIMULATED_EXECUTION',
  DEVELOPMENT_EDGE_CANDIDATE: 'BOUNDED_COUNTERFACTUAL',
  PUMP_CONFIRMATORY_COLLECTION_STARTED: 'BOUNDED_COUNTERFACTUAL',
  CANARY_READY: 'FULL_EVENT_REPLAY',
  STRATEGY_KILLED_BY_CORRECTED_ECONOMICS: 'SIMULATED_EXECUTION',
} as const satisfies Record<string, EvidenceGrade>;

export type TerminalClaim = keyof typeof CLAIM_REQUIREMENTS;

export function claimIsSupported(claim: TerminalClaim, evidence: readonly EvidenceGrade[]): {
  supported: boolean;
  weakest: EvidenceGrade | null;
  required: EvidenceGrade;
  reason: string;
} {
  const required = CLAIM_REQUIREMENTS[claim];
  const weakest = weakestGrade(evidence);
  if (weakest === null) {
    return { supported: false, weakest: null, required, reason: 'there is no evidence at all' };
  }
  const supported = atLeast(weakest, required);
  return {
    supported,
    weakest,
    required,
    reason: supported
      ? `weakest evidence ${weakest} meets ${required}`
      : `weakest evidence ${weakest} is below the required ${required}`,
  };
}

/**
 * The counterfactual problem, stated where it cannot be forgotten.
 *
 * A future mainnet pool state does not contain the hypothetical entry. Calling a
 * later mainnet quote an exact counterfactual exit is false unless the entry's
 * persistent effect on the pool is handled.
 */
export interface EntryImpactBound {
  /** entry quote in / effective quote reserve at entry. */
  readonly quoteImpactRatio: number;
  /** tokens acquired / base reserve at entry. */
  readonly baseImpactRatio: number;
  /** The larger of the two, which is what the price actually moves with. */
  readonly maxImpactRatio: number;
  /** A conservative haircut applied to the counterfactual exit value. */
  readonly haircutBps: number;
  readonly withinSmallImpactBound: boolean;
  readonly boundUsed: number;
}

/**
 * Frozen. A larger bound admits an entry whose own effect on the pool is a
 * material part of the return being measured.
 */
export const SMALL_IMPACT_BOUND = 0.005; // 50 bps of either reserve

export function boundEntryImpact(p: {
  entryQuoteInLamports: bigint;
  effectiveQuoteReserveLamports: bigint;
  tokensAcquiredAtoms: bigint;
  baseReserveAtoms: bigint;
  bound?: number;
}): EntryImpactBound {
  const bound = p.bound ?? SMALL_IMPACT_BOUND;
  const ratio = (a: bigint, b: bigint): number => {
    if (b <= 0n) return Number.POSITIVE_INFINITY;
    // Scaled integer division first, so a large u64 never crosses a double
    // before it has been reduced to a small ratio.
    return Number((a * 1_000_000n) / b) / 1_000_000;
  };
  const q = ratio(p.entryQuoteInLamports, p.effectiveQuoteReserveLamports);
  const b = ratio(p.tokensAcquiredAtoms, p.baseReserveAtoms);
  const max = Math.max(q, b);

  // The haircut is the impact itself, doubled: the entry moved the price in,
  // and the exit pays to move back through its own footprint. Rounded up.
  const haircutBps = Number.isFinite(max) ? Math.ceil(max * 2 * 10_000) : 10_000;

  return {
    quoteImpactRatio: q,
    baseImpactRatio: b,
    maxImpactRatio: max,
    haircutBps,
    withinSmallImpactBound: Number.isFinite(max) && max <= bound,
    boundUsed: bound,
  };
}

/** Apply the haircut to a counterfactual exit value. Never upward. */
export function haircutExitValue(exitLamports: bigint, haircutBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.ceil(haircutBps))));
  return (exitLamports * (10_000n - bps)) / 10_000n;
}

export interface SoleVenueAttribution {
  readonly attributed: boolean;
  readonly baseOutAtoms: bigint;
  readonly quoteInLamports: bigint;
  readonly takerCreditAtoms: bigint;
  /** Why not, when not. Null when attributed. */
  readonly refusal: string | null;
}

/**
 * Did the CANONICAL POOL supply the entire entry?
 *
 * F4. Showing that the canonical base vault changed is not enough: a split or
 * routed entry moves it too, and reporting "the vault moved" as direct evidence
 * is how a routed fill becomes a claim about one venue's mechanics.
 *
 * The identity that has to hold is that the pool's base vault fell by EXACTLY
 * what the taker gained, and that quote went in. If some other venue supplied
 * part of the flow, the taker's credit exceeds what this pool gave up.
 *
 * Extracted from `openTrajectory` where it sat inline. It is the rule that makes
 * every direct-mechanics number in this repository mean anything, and it had no
 * test of its own — the audit in tests/unit/directive-29c7cc7-coverage.test.ts
 * found that by refusing to accept a citation whose text was not in the file.
 */
export function attributeSoleVenue(p: {
  baseOutAtoms: bigint;
  quoteInLamports: bigint;
  takerCreditAtoms: bigint;
}): SoleVenueAttribution {
  const base = { baseOutAtoms: p.baseOutAtoms, quoteInLamports: p.quoteInLamports, takerCreditAtoms: p.takerCreditAtoms };
  if (p.baseOutAtoms <= 0n) {
    return { ...base, attributed: false, refusal: 'the pool base vault did not fall, so this pool supplied nothing' };
  }
  if (p.quoteInLamports <= 0n) {
    return { ...base, attributed: false, refusal: 'the pool quote vault did not rise, so nothing was paid to this pool' };
  }
  if (p.baseOutAtoms !== p.takerCreditAtoms) {
    return {
      ...base,
      attributed: false,
      refusal:
        `pool base out ${p.baseOutAtoms} != taker credit ${p.takerCreditAtoms}; ` +
        'part of the flow came from somewhere else, so this is not direct evidence about this venue',
    };
  }
  return { ...base, attributed: true, refusal: null };
}
