/**
 * P12 — risk facts must exist BEFORE the decision they are meant to affect.
 *
 * A gate that reads a fact collected after quote selection is not a gate. It is
 * a post-hoc annotation, and the position was taken either way. The ordering is
 * the whole control, so it is enforced by construction here rather than left to
 * whoever writes the next caller.
 */

export type RiskFactKind = 'MINT' | 'MAYHEM' | 'CASHBACK' | 'ENTITY';

export interface FactTiming {
  readonly kind: RiskFactKind;
  readonly collectedAtMs: number | null;
  readonly available: boolean;
}

export class FactCollectedTooLate extends Error {
  constructor(readonly kinds: readonly RiskFactKind[]) {
    super(
      `these risk facts were not available before quote selection: ${kinds.join(', ')}. ` +
        'A gate reading a fact collected after the decision is an annotation, not a gate.',
    );
    this.name = 'FactCollectedTooLate';
  }
}

export function assertFactsPrecedeSelection(
  facts: readonly FactTiming[],
  quoteSelectedAtMs: number,
): void {
  const late = facts
    .filter((f) => !f.available || f.collectedAtMs === null || f.collectedAtMs > quoteSelectedAtMs)
    .map((f) => f.kind);
  if (late.length > 0) throw new FactCollectedTooLate(late);
}

/**
 * Mayhem breadth.
 *
 * The officially identified agent wallet and known protocol-controlled flow are
 * excluded from independent breadth. If agent flow cannot be fully isolated the
 * answer is CONTAMINATED — **not zero and not organic**, because both of those
 * are claims about the market and this is a fact about our instrument.
 */
export type MayhemBreadth =
  | { kind: 'INDEPENDENT'; uniqueBuyers: number; excludedAgentFlow: number }
  | { kind: 'CONTAMINATED_UNUSABLE'; reason: string };

export function mayhemBreadth(p: {
  uniqueBuyers: number;
  agentWalletsKnown: boolean;
  agentFlowFullyIsolatable: boolean;
  excludedAgentFlow: number;
}): MayhemBreadth {
  if (!p.agentWalletsKnown) {
    return {
      kind: 'CONTAMINATED_UNUSABLE',
      reason: 'the official Mayhem agent wallets are not known, so protocol flow cannot be separated from organic flow',
    };
  }
  if (!p.agentFlowFullyIsolatable) {
    return {
      kind: 'CONTAMINATED_UNUSABLE',
      reason: 'agent flow could not be fully isolated; reporting the remainder as organic would overstate independent interest',
    };
  }
  return { kind: 'INDEPENDENT', uniqueBuyers: p.uniqueBuyers, excludedAgentFlow: p.excludedAgentFlow };
}

/** High-confidence entity links only. A weak link pools unrelated wallets. */
export const HIGH_CONFIDENCE_LINKS = [
  'COMMON_INITIAL_FUNDER',
  'SAME_FEE_PAYER',
  'SAME_TRANSACTION_CO_PURCHASE',
  'DIRECT_TRANSFER',
  'CREATOR_CLUSTER',
  'MAYHEM_CLUSTER',
] as const;
export type EntityLinkKind = (typeof HIGH_CONFIDENCE_LINKS)[number];

export interface EntityHistory {
  /**
   * True only when the walk reached the EARLIEST available signature.
   *
   * "The oldest of the newest 200 signatures" is not the first transaction, and
   * treating it as one makes a busy wallet look newly created. Measured on a
   * live pool: reaching the true earliest signature took 25 pages of 1,000.
   */
  readonly reachedEarliestSignature: boolean;
  readonly pagesWalked: number;
  readonly links: readonly EntityLinkKind[];
}

export type ConcentrationVerdict =
  | { kind: 'MEASURED'; entityAdjustedShare: number }
  | { kind: 'HISTORY_INCOMPLETE'; reason: string };

/**
 * Entity-adjusted concentration, passed into the GATE.
 *
 * Not merely a table. A number computed and displayed but never compared to a
 * limit is a number nobody acted on, which is indistinguishable from not having
 * computed it.
 */
export function entityAdjustedConcentration(p: {
  histories: readonly EntityHistory[];
  clusteredShare: number;
}): ConcentrationVerdict {
  /**
   * NO histories is not zero clustering.
   *
   * This function used to return `MEASURED` with whatever `clusteredShare` the
   * caller passed when `histories` was empty — because the filter below finds
   * nothing incomplete in an empty list. A caller that had examined no wallets
   * at all therefore got `MEASURED share 0`, which passes the gate.
   *
   * That is the exact substitution this whole module exists to prevent: an
   * unmeasured quantity reading identically to a measured safe one. Vacuous
   * truth over an empty collection is how it gets in.
   */
  if (p.histories.length === 0) {
    return {
      kind: 'HISTORY_INCOMPLETE',
      reason: 'no holder history was examined at all, so clustering is unmeasured rather than absent',
    };
  }
  const incomplete = p.histories.filter((h) => !h.reachedEarliestSignature).length;
  if (incomplete > 0) {
    return {
      kind: 'HISTORY_INCOMPLETE',
      reason: `${incomplete} of ${p.histories.length} wallet histories did not reach the earliest signature, so links may be missing and the share is a lower bound`,
    };
  }
  return { kind: 'MEASURED', entityAdjustedShare: p.clusteredShare };
}

export function concentrationGate(
  v: ConcentrationVerdict,
  maxShare: number,
): { pass: boolean; reason: string } {
  if (v.kind === 'HISTORY_INCOMPLETE') {
    // Unknown is not safe. An incomplete history can only UNDERSTATE clustering,
    // so passing on it would pass exactly the tokens we know least about.
    return { pass: false, reason: `concentration unknown: ${v.reason}` };
  }
  return {
    pass: v.entityAdjustedShare <= maxShare,
    reason: `entity-adjusted share ${(v.entityAdjustedShare * 100).toFixed(1)}% vs limit ${(maxShare * 100).toFixed(1)}%`,
  };
}

/**
 * A Token-2022 mint WITHOUT a transfer-fee extension has a measured
 * "not applicable" fee, which is different from an unmeasured one.
 *
 * Rejecting every Token-2022 mint because a fee was not observed in a leg
 * discards a whole class of tokens for a fact about the leg rather than about
 * the mint.
 */
export type TransferFeeState =
  | { kind: 'NOT_APPLICABLE'; why: 'no transfer fee extension is present on the mint' }
  | { kind: 'MEASURED'; currentBps: number; futureBps: number | null; withheldAtoms: bigint }
  | { kind: 'UNMEASURED'; why: string };

export function transferFeeState(p: {
  isToken2022: boolean;
  extensionsDecoded: boolean;
  hasTransferFeeExtension: boolean;
  currentBps: number | null;
  futureBps: number | null;
  withheldAtoms: bigint | null;
}): TransferFeeState {
  if (!p.isToken2022) return { kind: 'NOT_APPLICABLE', why: 'no transfer fee extension is present on the mint' };
  if (!p.extensionsDecoded) return { kind: 'UNMEASURED', why: 'the mint extensions did not decode' };
  if (!p.hasTransferFeeExtension) {
    return { kind: 'NOT_APPLICABLE', why: 'no transfer fee extension is present on the mint' };
  }
  if (p.currentBps === null || p.withheldAtoms === null) {
    return { kind: 'UNMEASURED', why: 'the transfer fee extension is present but its fields did not decode' };
  }
  return { kind: 'MEASURED', currentBps: p.currentBps, futureBps: p.futureBps, withheldAtoms: p.withheldAtoms };
}
