import { mintFacts, type MintFacts } from './mintfacts.js';
import { mayhemFactsOf, breadthUsability, type MayhemFacts, type BreadthUsability } from '../../solana/src/mayhem.js';
import {
  transferFeeState,
  entityAdjustedConcentration,
  concentrationGate,
  assertFactsPrecedeSelection,
  type TransferFeeState,
  type ConcentrationVerdict,
  type EntityHistory,
} from './risk-facts-order.js';
import type { DecodedMint } from '../../solana/src/mint.js';

/**
 * P10 — the risk facts, assembled BEFORE the decision they are meant to affect.
 *
 * Every module underneath this one existed and was tested. None of them reached
 * the trajectory collector, so a candidate was admitted on mechanics alone: it
 * had a canonical pool, the buy simulated, the sell simulated. Whether the mint
 * could freeze our exit, whether the venue was in Mayhem mode, whether four of
 * the top five holders were one wallet — none of that was consulted, and none
 * of it was stored against the trajectory that resulted.
 *
 * A gate that reads a fact collected AFTER selection is not a gate; it is a
 * post-hoc annotation and the position was taken either way. So the ordering is
 * enforced by construction: `collectedAtMs` is stamped here, and
 * `admitCandidate` refuses anything stamped later than the decision.
 *
 * ## The two rules that are easy to get backwards
 *
 * **Unknown is not safe.** A mint that could not be read has not been shown to
 * be harmless; it has not been looked at. Every verdict here defaults to
 * refusing, because this system has repeatedly found that absent-means-safe is
 * the direction errors travel.
 *
 * **Mayhem flow is not organic and not zero.** The agent's share cannot be
 * isolated without the program layout, and subtracting an unmeasured quantity
 * is a guess with a minus sign. A Mayhem venue's breadth is UNUSABLE, which is
 * a fact about our instrument rather than a claim about the market.
 */

export interface CandidateRiskFacts {
  readonly mint: string;
  readonly pool: string;
  /** When these were collected. Compared against the decision, not assumed. */
  readonly collectedAtMs: number;
  readonly mint2022: MintFacts;
  readonly transferFee: TransferFeeState;
  readonly mayhem: MayhemFacts;
  readonly breadth: BreadthUsability;
  readonly breadthCountsAsOrganic: boolean;
  /** Decoded from the pool. Null means this SDK build has no such field. */
  readonly isCashbackCoin: boolean | null;
  readonly accumulatorWsolAta: string | null;
  readonly concentration: ConcentrationVerdict;
  /**
   * The top holders' combined share, from balances alone.
   *
   * The CHEAP tier. One `getTokenLargestAccounts` call, always available, and a
   * real measurement of a real thing — it just cannot tell one wallet holding
   * five accounts from five independent holders. Entity-adjusted concentration
   * is the strong tier and needs a signature history per holder.
   *
   * Null when even this could not be read, which refuses.
   */
  readonly rawTopHolderShare: number | null;
  readonly holdersExamined: number;
  readonly canonicalPool: boolean;
  /**
   * Why the pool could not be read, when it could not be.
   *
   * "The pool does not exist" and "the endpoint returned 429" are different
   * facts. Both refuse; naming them identically reports an apparatus failure as
   * a property of the token, and a run that exhausted its quota then reads as a
   * chain with no canonical pools.
   */
  readonly poolReadFailure: string | null;
  /**
   * Whether the entry would have to open accounts another trader would have.
   *
   * P6's stratum boundary, carried here so admission and stratification read
   * the same fact. Null before the buy has been simulated — this is collected
   * BEFORE the decision, and the decision is what schedules the simulation.
   */
  readonly requiresSharedSetup: boolean | null;
}

export interface AdmissionLimits {
  /** Entity-adjusted, not raw. A cluster of five wallets is one holder. */
  readonly maxEntityAdjustedShare: number;
  /** The cheap tier's limit. Looser, because it CANNOT see clustering. */
  readonly maxRawTopHolderShare: number;
  /**
   * Admit on the raw share alone when entity histories were not walked.
   *
   * The honest position on an unaffordable measurement, and it is a limit
   * rather than a silent waiver so that it appears in the preregistration.
   *
   * Refusing outright would be defensible and is not free: a study that admits
   * nothing measures nothing, and paginating every top holder's full signature
   * history is a Helius-tier operation this system does not have. Admitting
   * SILENTLY would be the defect — an unmeasured quantity reading as a safe
   * one. So the candidate is admitted, the raw gate still bites, and the
   * stratum says CONCENTRATION_RAW_ONLY so no analysis can pool it with a
   * candidate whose clustering was actually measured.
   */
  readonly allowRawOnlyConcentration: boolean;
  /** Admit a token whose venue runs in Mayhem mode, in its own stratum. */
  readonly allowMayhem: boolean;
  /** Admit a mint whose transfer fee could not be measured. */
  readonly allowUnmeasuredTransferFee: boolean;
}

/** Frozen for the development window. Changing one is a preregistered act. */
export const DEVELOPMENT_LIMITS: AdmissionLimits = {
  maxEntityAdjustedShare: 0.5,
  // Looser than the entity-adjusted limit ON PURPOSE. The raw share cannot see
  // clustering, so it under-reports; a tight limit on an under-reporting
  // measurement would refuse honest tokens and still admit clustered ones.
  maxRawTopHolderShare: 0.8,
  allowRawOnlyConcentration: true,
  // Admitted, and stratified. Excluding Mayhem outright would discard a
  // regime rather than measure it; pooling it with the rest would describe
  // neither. The breadth reading is what carries the contamination.
  allowMayhem: true,
  allowUnmeasuredTransferFee: false,
};

export interface Admission {
  readonly admit: boolean;
  /** Every reason, not the first. A single word collapses six facts into one. */
  readonly refusals: readonly string[];
  /** The stratum this candidate belongs in if admitted. Never pooled. */
  readonly stratum: string;
}

/**
 * Assemble the facts. Reads nothing: every input is already decoded.
 *
 * Deliberately total and synchronous, so the ORDER is visible at the call site.
 * A version of this that fetched would make "collected before the decision"
 * depend on where the awaits happened to land.
 */
export function collectCandidateRiskFacts(p: {
  mint: string;
  pool: string;
  nowMs: number;
  decodedMint: DecodedMint | null;
  mintDecodeFailure?: string | null;
  isToken2022: boolean;
  hasTransferFeeExtension: boolean;
  transferFeeCurrentBps: number | null;
  transferFeeFutureBps: number | null;
  transferFeeWithheldAtoms: bigint | null;
  poolIsMayhemMode: boolean | null;
  bondingCurveIsMayhemMode?: boolean | null;
  isCashbackCoin: boolean | null;
  accumulatorWsolAta: string | null;
  holderHistories: readonly EntityHistory[];
  clusteredShare: number;
  /** Top holders' combined share from balances alone. Null when unread. */
  rawTopHolderShare: number | null;
  holdersExamined: number;
  canonicalPool: boolean;
  poolReadFailure?: string | null;
  requiresSharedSetup?: boolean | null;
}): CandidateRiskFacts {
  const facts = mintFacts(p.decodedMint, p.mintDecodeFailure ?? null);
  const mayhem = mayhemFactsOf({
    mint: p.mint,
    nowUtcMs: p.nowMs,
    poolIsMayhemMode: p.poolIsMayhemMode,
    bondingCurveIsMayhemMode: p.bondingCurveIsMayhemMode ?? null,
  });
  const usability = breadthUsability(mayhem);

  return {
    mint: p.mint,
    pool: p.pool,
    collectedAtMs: p.nowMs,
    mint2022: facts,
    transferFee: transferFeeState({
      isToken2022: p.isToken2022,
      // A mint that did not decode has no readable extensions, and that is a
      // different fact from one whose extensions decoded to nothing.
      extensionsDecoded: p.decodedMint !== null,
      hasTransferFeeExtension: p.hasTransferFeeExtension,
      currentBps: p.transferFeeCurrentBps,
      futureBps: p.transferFeeFutureBps,
      withheldAtoms: p.transferFeeWithheldAtoms,
    }),
    mayhem,
    breadth: usability.usability,
    breadthCountsAsOrganic: usability.countsAsOrganic,
    isCashbackCoin: p.isCashbackCoin,
    accumulatorWsolAta: p.accumulatorWsolAta,
    concentration: entityAdjustedConcentration({
      histories: p.holderHistories,
      clusteredShare: p.clusteredShare,
    }),
    rawTopHolderShare: p.rawTopHolderShare,
    holdersExamined: p.holdersExamined,
    canonicalPool: p.canonicalPool,
    poolReadFailure: p.poolReadFailure ?? null,
    requiresSharedSetup: p.requiresSharedSetup ?? null,
  };
}

/**
 * Should this candidate be opened, and in which stratum?
 *
 * Refusals are the product. Every failing fact is named, because collapsing six
 * of them into one word is how 93% of a previous corpus became uninformative.
 */
export function admitCandidate(f: CandidateRiskFacts, limits: AdmissionLimits = DEVELOPMENT_LIMITS): Admission {
  const refusals: string[] = [];

  if (!f.canonicalPool) {
    // Named apart. An apparatus failure is not a fact about the token, and a
    // refusal histogram that merges them makes a rate-limited run look like a
    // chain with no canonical pools.
    refusals.push(
      f.poolReadFailure === null
        ? 'the pool is not the canonical PumpSwap pool for this mint'
        : `APPARATUS: the pool could not be read (${f.poolReadFailure.slice(0, 70)})`,
    );
  }

  // HOSTILE is a measured fact and refuses. UNKNOWN is not a measured fact and
  // ALSO refuses, because a mint nobody could read has not been shown safe.
  const hard: [keyof MintFacts, string][] = [
    ['freezeAuthority', 'a freeze authority can disable our exit'],
    ['permanentDelegate', 'a permanent delegate can move tokens out of any account'],
    ['defaultAccountState', 'new accounts start frozen, so the exit may be impossible from the start'],
    ['transferHook', 'a hook program runs on every transfer and can refuse ours'],
    ['nonTransferable', 'the token cannot be transferred at all'],
    ['pausable', 'transfers can be paused by an authority'],
  ];
  for (const [k, why] of hard) {
    const v = f.mint2022[k];
    if (v === 'HOSTILE') refusals.push(`${String(k)}: ${why}`);
    else if (v === 'UNKNOWN') refusals.push(`${String(k)} is UNKNOWN, and unknown is not safe`);
  }
  if (f.mint2022.decodeFailure !== null) {
    refusals.push(`the mint did not decode: ${f.mint2022.decodeFailure.slice(0, 80)}`);
  }

  if (f.transferFee.kind === 'UNMEASURED' && !limits.allowUnmeasuredTransferFee) {
    refusals.push(`the transfer fee is unmeasured: ${f.transferFee.why}`);
  }

  /**
   * The concentration GATE, not a concentration display.
   *
   * A number computed and shown but never compared to a limit is a number
   * nobody acted on, which is indistinguishable from not having computed it.
   * An incomplete holder history refuses: it can only UNDERSTATE clustering, so
   * passing on it would pass exactly the tokens we know least about.
   */
  const gate = concentrationGate(f.concentration, limits.maxEntityAdjustedShare);
  if (!gate.pass) {
    // The strong tier could not decide. Fall back to the cheap one only when
    // the limits SAY SO, and never past the cheap one's own limit.
    const rawOnly = f.concentration.kind === 'HISTORY_INCOMPLETE' && limits.allowRawOnlyConcentration;
    if (!rawOnly) {
      refusals.push(gate.reason);
    } else if (f.rawTopHolderShare === null) {
      refusals.push('neither entity-adjusted nor raw concentration could be read');
    } else if (f.rawTopHolderShare > limits.maxRawTopHolderShare) {
      refusals.push(
        `raw top-holder share ${(f.rawTopHolderShare * 100).toFixed(1)}% exceeds ` +
          `${(limits.maxRawTopHolderShare * 100).toFixed(1)}%, and it can only UNDERSTATE clustering`,
      );
    }
  }

  if (f.mayhem.enabled === true && !limits.allowMayhem) {
    refusals.push('the venue runs in Mayhem mode');
  }

  return {
    admit: refusals.length === 0,
    refusals,
    stratum: stratumOf(f),
  };
}

/**
 * The cell this candidate belongs in.
 *
 * Never pooled: a cashback coin in Mayhem mode is a materially different regime
 * from a plain non-cashback coin, and averaging them describes neither.
 * `requiresSharedSetup` is part of the identity because P6's whole hypothesis is
 * that a cold candidate's cost is a one-time payment on somebody else's behalf.
 */
export function stratumOf(f: CandidateRiskFacts): string {
  const parts = [
    f.canonicalPool ? 'CANONICAL' : 'NONCANONICAL',
    f.isCashbackCoin === true ? 'CASHBACK' : f.isCashbackCoin === false ? 'NONCASHBACK' : 'CASHBACK_UNKNOWN',
    f.mayhem.enabled === true ? 'MAYHEM' : f.mayhem.enabled === false ? 'NONMAYHEM' : 'MAYHEM_UNKNOWN',
    f.transferFee.kind === 'NOT_APPLICABLE' ? 'LEGACY_FEE' : f.transferFee.kind === 'MEASURED' ? 'T22_FEE' : 'FEE_UNKNOWN',
    f.requiresSharedSetup === true ? 'COLD_SETUP' : f.requiresSharedSetup === false ? 'WARM' : 'SETUP_UNKNOWN',
    // Which tier of concentration was actually measured. Part of the identity
    // so that no analysis can pool a candidate whose clustering was measured
    // with one where only balances were read.
    f.concentration.kind === 'MEASURED' ? 'CONCENTRATION_ENTITY' : 'CONCENTRATION_RAW_ONLY',
  ];
  return parts.join('/');
}

/**
 * The facts were available before the decision. Throws if not.
 *
 * Re-exported through this module so a caller wiring admission has the ordering
 * check in front of it rather than one import away.
 */
export function assertCollectedBeforeDecision(f: CandidateRiskFacts, decidedAtMs: number): void {
  assertFactsPrecedeSelection(
    [
      { kind: 'MINT', collectedAtMs: f.collectedAtMs, available: f.mint2022.decodeFailure === null },
      { kind: 'MAYHEM', collectedAtMs: f.collectedAtMs, available: f.mayhem.source !== 'none' },
      { kind: 'CASHBACK', collectedAtMs: f.collectedAtMs, available: f.isCashbackCoin !== null },
      { kind: 'ENTITY', collectedAtMs: f.collectedAtMs, available: f.concentration.kind === 'MEASURED' },
    ],
    decidedAtMs,
  );
}
