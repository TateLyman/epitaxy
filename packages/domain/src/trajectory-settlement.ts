import type { MeasuredLegSettlement } from './settlement.js';
import {
  entryCashOut,
  exitCashIn,
  executionCost,
  transferFeeOrUnknown,
  acquiredTokens,
  isPnlEligible,
} from './settlement.js';

/**
 * P5 — one settlement, one writer, one set of economics per trajectory.
 *
 * Findings C and D are the same defect on two legs: one row could hold two
 * entry costs, because the explicit field came from measured settlement while
 * `cost_lamports`, the ledger debit and the fill fees came from configured
 * assumptions. The exit could disagree with itself in seven documented ways —
 * router expected output used as actual, net cash written into a gross field, a
 * `/order` platform fee charged to a BUILD_CUSTOM fill, an unknown Token-2022
 * fee silently zeroed.
 *
 * The repair is not a reconciliation step. It is having one value.
 *
 * Everything downstream — position row, fill row, ledger row, trajectory row,
 * report, readiness — reads THIS object. There is deliberately no fallback
 * constructor: a settlement that cannot be measured is absent, and absent is a
 * state the caller must handle rather than a number this module invents.
 */


/**
 * P5 — cost applicability, stated rather than inferred from a null.
 *
 * `NOT_APPLICABLE` and `UNKNOWN` are opposite facts that both arrive as an
 * absent number. A legacy mint cannot carry a transfer fee, so zero is the
 * MEASURED answer; a Token-2022 mint whose extensions did not decode is
 * genuinely unknown and must block PnL. Collapsing them makes the safe case
 * and the dangerous case indistinguishable.
 */
export type Applicability = 'MEASURED' | 'NOT_APPLICABLE' | 'UNKNOWN';

export interface CostComponent {
  readonly applicability: Applicability;
  readonly lamports: bigint;
}

export const notApplicable: CostComponent = { applicability: 'NOT_APPLICABLE', lamports: 0n };
export const measured = (lamports: bigint): CostComponent => ({ applicability: 'MEASURED', lamports });
export const unknownCost: CostComponent = { applicability: 'UNKNOWN', lamports: 0n };

/** Only UNKNOWN blocks. NOT_APPLICABLE contributes a real, measured zero. */
export function blocksPnl(c: CostComponent): boolean {
  return c.applicability === 'UNKNOWN';
}

export interface TrajectorySettlement {
  readonly trajectoryId: string;

  readonly entry: MeasuredLegSettlement;
  readonly exit: MeasuredLegSettlement | null;

  readonly entryCashOutLamports: bigint;
  readonly exitCashInLamports: bigint | null;
  readonly grossExitCreditLamports: bigint | null;

  readonly baseFeesLamports: bigint;
  readonly priorityFeesLamports: bigint;
  readonly tipsLamports: bigint;
  readonly transferFeesLamports: bigint;
  readonly failedAttemptFeesLamports: bigint;

  readonly rentCreatedLamports: bigint;
  readonly rentRecoveredLamports: bigint;
  readonly rentStillLockedLamports: bigint;

  readonly cashbackAccruedLamports: bigint;
  readonly cashbackClaimableLamports: bigint;
  readonly cashbackClaimedLamports: bigint;
  readonly cashbackClaimCostLamports: bigint;

  /** Venue fees are taken out of the swap output; that does not make PnL unknown. */
  readonly venueFeesEmbeddedInOutput: boolean;
  readonly venueFeeDecompositionKnown: boolean;

  readonly residualTokenAtoms: bigint;
  readonly unexplainedLamports: bigint;

  readonly executionCostLamports: bigint;
  readonly netPnlLamports: bigint | null;

  /** Why PnL is null, when it is. Never silently absent. */
  readonly pnlBlockedReasons: readonly string[];
}

/**
 * The part of PnL eligibility that lives in the durable graph.
 *
 * P4.1 lists seven conditions. Four are properties of the measured leg and
 * `isPnlEligible` owns them. These three are properties of what was written to
 * disk, and nothing in memory can answer them.
 */
export interface LegEvidenceState {
  /** Every blob this leg references passed read-back verification. */
  readonly rawStateDurable: boolean;
  /** The observation, worker job and step ids all resolve to rows. */
  readonly linksResolve: boolean;
  /** Whether a residual token balance's meaning is established. */
  readonly residualSemanticsKnown: boolean;
}

/**
 * A leg whose durability HAS been established.
 *
 * Deliberately a named constant rather than a default parameter. A default
 * would mean every caller that forgot to establish durability got it for free,
 * which is precisely how 275 trajectories settled with no raw state at all. A
 * caller using this is claiming, in the diff, that it checked.
 */
export const DURABLE_EVIDENCE: LegEvidenceState = {
  rawStateDurable: true,
  linksResolve: true,
  residualSemanticsKnown: true,
};

export interface CashbackFacts {
  readonly accruedLamports: bigint;
  readonly claimableLamports: bigint;
  readonly claimedLamports: bigint;
  readonly claimCostLamports: bigint;
}

export const NO_CASHBACK: CashbackFacts = {
  accruedLamports: 0n,
  claimableLamports: 0n,
  claimedLamports: 0n,
  claimCostLamports: 0n,
};

/**
 * Build the one settlement.
 *
 * `netPnl` is null — with reasons — whenever a component of it is unknown. An
 * unknown transfer fee, tip, rent figure or residual makes the number unknown;
 * an unknown venue fee DECOMPOSITION does not, because the input and output were
 * both measured and the split between LP, protocol and creator does not change
 * what the wallet did.
 */
export function buildTrajectorySettlement(p: {
  trajectoryId: string;
  entry: MeasuredLegSettlement;
  exit: MeasuredLegSettlement | null;
  cashback?: CashbackFacts;
  /** Fees actually paid on attempts that did not land. Never an estimate. */
  failedAttemptFeesLamports?: bigint;
  /** Rent the trajectory opened and has not recovered. */
  rentStillLockedLamports?: bigint;
  venueFeeDecompositionKnown?: boolean;
  /**
   * P4.1 — the three eligibility conditions that are facts about the PERSISTED
   * evidence rather than about the in-memory leg.
   *
   * A leg object cannot know whether its blobs survived read-back or whether
   * its observation id resolves to a row; only the writer that persisted them
   * can. Passing them in keeps `isPnlEligible` honest without giving the domain
   * a database.
   *
   * Absent means UNKNOWN, and unknown blocks. That is deliberate: the audit
   * found 275 settled trajectories with no raw state at all, and a default of
   * "probably fine" is how they settled.
   */
  legEvidence?: {
    readonly entry?: LegEvidenceState;
    readonly exit?: LegEvidenceState;
  };
}): TrajectorySettlement {
  const reasons: string[] = [];
  const cashback = p.cashback ?? NO_CASHBACK;

  const entryCash = entryCashOut(p.entry);
  const entryFee = transferFeeOrUnknown(p.entry);
  if (entryFee === null) reasons.push('the entry transfer fee was not measured');

  const exitCash = p.exit === null ? null : exitCashIn(p.exit);
  const exitFee = p.exit === null ? 0n : transferFeeOrUnknown(p.exit);
  if (p.exit !== null && exitFee === null) reasons.push('the exit transfer fee was not measured');
  if (p.exit === null) reasons.push('the trajectory has not exited');

  /**
   * Both legs must be runtime-successful, effect-valid and completely covered
   * before net PnL exists. A leg whose writables were not all observed cannot
   * be replayed, and a number derived from it is not re-derivable — which is
   * this repository's definition of not being evidence.
   */
  for (const [name, leg] of [
    ['entry', p.entry],
    ['exit', p.exit],
  ] as const) {
    if (leg === null) continue;
    /**
     * P4.1 — `isPnlEligible` IS the rule, and this is the writer that has to
     * obey it.
     *
     * The 8f73cef audit's second-most-expensive finding (K-1): this function
     * checked three of the four conditions `isPnlEligible` states in its own
     * header and NEVER READ THE FOURTH — `costs.unexplainedLamports`. So a leg
     * the domain itself calls PnL-ineligible produced a published net PnL.
     * `isPnlEligible` was called by the paper engine and by `settlement-check`;
     * it was not called by the canonical writer for the trajectory corpus.
     *
     * Calling it rather than restating three of its clauses means a condition
     * added there can never again be missing here.
     */
    const eligible = isPnlEligible(leg);
    if (!eligible.ok) reasons.push(...eligible.reasons.map((r) => `the ${name} leg is not PnL-eligible: ${r}`));

    // Raw evidence durability and link resolution are properties of the
    // PERSISTED graph, not of the in-memory leg, so they are supplied by the
    // caller. Absent, they are UNKNOWN and unknown blocks.
    const durability = p.legEvidence?.[name];
    if (durability === undefined) {
      reasons.push(`the ${name} leg's raw-state durability was not established`);
    } else {
      if (!durability.rawStateDurable) reasons.push(`the ${name} leg's raw pre/post state is not durable`);
      if (!durability.linksResolve) reasons.push(`the ${name} leg's worker/observation links do not resolve`);
      if (durability.residualSemanticsKnown === false) {
        reasons.push(`the ${name} leg's residual semantics are unknown`);
      }
    }
  }

  const residual = p.exit === null ? acquiredTokens(p.entry) : p.exit.residualTokenAtoms ?? 0n;
  if (residual !== 0n && p.exit !== null) {
    // Tokens still held are value that did not become cash. At these sizes one
    // atom prices at zero lamports, so a residual is not recoverable either.
    reasons.push(`${residual} token atoms remain after the exit`);
  }

  const baseFees = p.entry.costs.baseFeeLamports + (p.exit?.costs.baseFeeLamports ?? 0n);
  const priority = p.entry.costs.priorityFeeLamports + (p.exit?.costs.priorityFeeLamports ?? 0n);
  const tips = p.entry.costs.tipLamports + (p.exit?.costs.tipLamports ?? 0n);
  const transferFees = (entryFee ?? 0n) + (exitFee ?? 0n);
  const failed = p.failedAttemptFeesLamports ?? 0n;

  const rentCreated = p.entry.costs.rentCreatedLamports + (p.exit?.costs.rentCreatedLamports ?? 0n);
  const rentRecovered = p.entry.costs.rentRecoveredLamports + (p.exit?.costs.rentRecoveredLamports ?? 0n);
  const rentLocked = p.rentStillLockedLamports ?? (rentCreated > rentRecovered ? rentCreated - rentRecovered : 0n);

  /**
   * Cashback is not cash until it is claimed.
   *
   * `accrued` is what the pool credited, `claimable` is what the accumulator
   * actually holds and would release, `claimed` is what reached the wallet. Only
   * the third is in PnL. Collapsing them would book a receivable as revenue.
   */
  if (cashback.accruedLamports > 0n && cashback.claimedLamports === 0n) {
    // Not a blocker: an unclaimed receivable is a known quantity of nothing yet.
    // It is simply not added to PnL.
  }

  /**
   * F16 — every component appears EXACTLY ONCE.
   *
   * `executionCost(leg)` already contains base fee, priority fee, tip, NET rent
   * (created minus recovered) and the PER-LEG failed-attempt cost. This
   * function once added `failed` and `rentLocked` on top, counting rent twice,
   * while omitting transfer fees entirely — so the total was simultaneously too
   * high on rent and too low on Token-2022. `rentLocked` is therefore NOT added
   * here; it is already inside each leg's net rent.
   *
   * Three things legs do not carry, and they are the only additions:
   *
   *   transferFees              measured, and per-trajectory
   *   failed                    the TRAJECTORY-LEVEL failed-attempt fee
   *   cashback.claimCostLamports
   *
   * P4.3 — `failed` is the one the audit caught entering ZERO times (K-1).
   * `executionCost(leg)` sums only the per-leg `failedAttemptCostLamports`;
   * this function accepted `failedAttemptFeesLamports`, stored it in
   * `trajectory_settlements`, and added it to no total. The audit's mutation
   * set it to 5,000 lamports and measured no effect at all. It was latent while
   * `openTrajectory` passed nothing — and an API that accepts a cost and loses
   * it is a defect whether or not a caller has reached it yet.
   */
  const executionCostLamports =
    executionCost(p.entry) +
    (p.exit === null ? 0n : executionCost(p.exit)) +
    transferFees +
    failed +
    cashback.claimCostLamports;

  /**
   * payer delta = named trade flows + named fees + named rent + named cashback
   *             + unexplained
   */
  /**
   * The named components, listed individually.
   *
   * A first attempt compared the payer delta against `exitCashIn - entryCashOut`
   * — but `exitCashIn` IS the payer delta, so the difference was algebraically
   * forced to zero. A "derived" value that cannot come out nonzero is exactly
   * as informative as the hardcoded zero it replaced, and looks better while
   * being no better.
   *
   * The reconciliation has to name each flow separately, so that anything the
   * cost model does not know about shows up as a remainder.
   */
  const tradeOut = p.entry.input.kind === 'native_sol' ? p.entry.input.actualTradeDebitLamports : 0n;
  const tradeIn = p.exit?.output.kind === 'native_sol' ? p.exit.output.actualCreditLamports : 0n;
  const namedFees =
    p.entry.costs.baseFeeLamports +
    p.entry.costs.priorityFeeLamports +
    p.entry.costs.tipLamports +
    (p.exit?.costs.baseFeeLamports ?? 0n) +
    (p.exit?.costs.priorityFeeLamports ?? 0n) +
    (p.exit?.costs.tipLamports ?? 0n) +
    /**
     * The VENUE SKIM, which left the payer and was not named here.
     *
     * The protocol, buyback and creator cuts land in accounts the frozen plan
     * names, so they are measured rather than inferred. Omitting them made the
     * payer reconciliation short by exactly their total and reported a known
     * cost as an unexplained remainder — the failure this whole derivation
     * exists to prevent, in the derivation itself.
     *
     * `null` still means unmeasured and still contributes nothing, so an
     * unobserved skim keeps showing up in the remainder.
     */
    (p.entry.costs.protocolFeeLamports ?? 0n) +
    (p.exit?.costs.protocolFeeLamports ?? 0n);
  const namedRent = rentCreated - rentRecovered;

  /**
   * THE CASHBACK CLAIM IS NOT IN THESE TWO LEGS.
   *
   * `actualPayerDelta` below sums the ENTRY and EXIT legs' own payer deltas.
   * `claim_cashback` is a THIRD transaction against the accumulator; its
   * lamports never pass through the buy or the sell, so adding the claim to the
   * expected side asserts a flow these two legs did not carry and manufactures
   * a residue of exactly the claimed amount.
   *
   * Found by enforcing the residue rather than by reading the code: a fixture
   * with 60,000 claimed and 5,000 of claim cost produced a spurious −55,000
   * unexplained, which under the old build was computed and ignored. The
   * expression has been wrong since it was written; nothing read it, so nothing
   * disagreed.
   *
   * The claim still enters PnL — through the cash identity, where it belongs —
   * and its cost still enters execution cost. If a claim LEG is ever settled as
   * part of a trajectory, it must arrive as a third `MeasuredLegSettlement` and
   * be added to BOTH sides of this reconciliation, not to one.
   */
  const namedPayerDelta = tradeIn - tradeOut - namedFees - namedRent;
  const actualPayerDelta =
    p.entry.payerNativeDeltaLamports + (p.exit?.payerNativeDeltaLamports ?? 0n);
  const unexplained = p.exit === null ? 0n : actualPayerDelta - namedPayerDelta;

  /**
   * P4.2 — NON-ZERO UNEXPLAINED VALUE BLOCKS PnL. NO EXCEPTION.
   *
   * This is the audit's single most expensive finding (K-2). The residue was
   * computed, stored, and READ BY NOTHING: it was neither a `pnlBlockedReason`
   * nor a `checkIdentities` violation. In the live corpus that produced
   *
   *     52 settlements
   *     51 with a non-zero unexplained remainder
   *     30 of those publishing a net PnL anyway
   *      0 carrying an identity violation
   *
   * with a worst case of net −6,426,787 lamports published against −4,564,488
   * unexplained — the residue being 71% of the loss the row reported, on a
   * 20,000,000 lamport notional.
   *
   * A payer identity that does not close means some lamports left the wallet
   * and the model cannot say where. Publishing a number derived from the
   * lamports it CAN name, while that is true, is not a conservative
   * approximation — it is a different quantity wearing PnL's name.
   */
  if (unexplained !== 0n) {
    reasons.push(
      `the payer identity does not close: ${unexplained} lamports left the payer with no named flow. ` +
        'Net PnL is withheld rather than published over an unreconciled residue.',
    );
  }

  const netPnlLamports =
    reasons.length === 0 && exitCash !== null
      ? exitCash + cashback.claimedLamports - entryCash.cashOut - cashback.claimCostLamports
      : null;

  return {
    trajectoryId: p.trajectoryId,
    entry: p.entry,
    exit: p.exit,
    entryCashOutLamports: entryCash.cashOut,
    exitCashInLamports: exitCash,
    // The GROSS credit is what the venue paid out, before this leg's own fees
    // and rent. Writing net cash into a gross field was one of finding D's
    // seven ways for an exit to disagree with itself.
    grossExitCreditLamports:
      p.exit === null || p.exit.output.kind !== 'native_sol' ? null : p.exit.output.actualCreditLamports,
    baseFeesLamports: baseFees,
    priorityFeesLamports: priority,
    tipsLamports: tips,
    transferFeesLamports: transferFees,
    failedAttemptFeesLamports: failed,
    rentCreatedLamports: rentCreated,
    rentRecoveredLamports: rentRecovered,
    rentStillLockedLamports: rentLocked,
    cashbackAccruedLamports: cashback.accruedLamports,
    cashbackClaimableLamports: cashback.claimableLamports,
    cashbackClaimedLamports: cashback.claimedLamports,
    cashbackClaimCostLamports: cashback.claimCostLamports,
    venueFeesEmbeddedInOutput: true,
    venueFeeDecompositionKnown: p.venueFeeDecompositionKnown ?? false,
    residualTokenAtoms: residual,
    /**
     * Derived, never hardcoded.
     *
     * The payer's actual native delta must equal the flows we can name. What is
     * left over is the part of the trade nobody accounted for, and writing zero
     * there asserted that no such part exists — which is a claim, not a
     * measurement. A nonzero value is the signal that a cost model is
     * incomplete, and it can only appear if it is computed.
     */
    unexplainedLamports: unexplained,
    executionCostLamports,
    netPnlLamports,
    pnlBlockedReasons: reasons,
  };
}

/**
 * The identity every writer must satisfy.
 *
 * Exported so the writers can assert it rather than each recomputing PnL its own
 * way — which is how one row came to hold two entry costs.
 */
export function checkIdentities(s: TrajectorySettlement): { ok: boolean; violations: readonly string[] } {
  const v: string[] = [];

  /**
   * THE PAYER IDENTITY. Checked first, because it is the one that was silently
   * absent.
   *
   * The audit ran a forced fixture that moved 2,500,000 lamports off the named
   * flows and got:
   *
   *     unexplained        = -2,500,000
   *     netPnl             = -2,700,000       ← published anyway
   *     pnlBlockedReasons  = 0
   *     identityViolations = 0
   *
   * and, in the live corpus, 51 of 52 settlements with a residue and ZERO
   * violations recorded. `unexplainedLamports` was computed, stored and read by
   * nothing. An identity check that cannot fail on the one quantity designed to
   * detect an incomplete cost model is decorative.
   *
   * The exact residue goes into the message, not a boolean: the number is what
   * tells a reader whether this is a rounding artefact or 71% of the reported
   * loss.
   */
  if (s.unexplainedLamports !== 0n) {
    v.push(
      `the payer identity does not close: ${s.unexplainedLamports} lamports unexplained ` +
        `against an entry of ${s.entryCashOutLamports} lamports`,
    );
  }

  // A published net PnL over a residue is a second, separate violation: the
  // first says the model is incomplete, this one says something published
  // anyway.
  if (s.unexplainedLamports !== 0n && s.netPnlLamports !== null) {
    v.push(
      `net PnL ${s.netPnlLamports} is published while ${s.unexplainedLamports} lamports remain unexplained`,
    );
  }

  if (s.netPnlLamports !== null && s.exitCashInLamports !== null) {
    const expected =
      s.exitCashInLamports + s.cashbackClaimedLamports - s.entryCashOutLamports - s.cashbackClaimCostLamports;
    if (expected !== s.netPnlLamports) v.push(`netPnl ${s.netPnlLamports} != identity ${expected}`);
  }

  // Principal is never execution cost. The entry cash out contains it; the
  // execution cost must not.
  if (s.executionCostLamports >= s.entryCashOutLamports && s.entryCashOutLamports > 0n) {
    v.push('execution cost is at least the entry cash out, which means principal leaked into it');
  }

  if (s.rentStillLockedLamports < 0n) v.push('negative locked rent');
  if (s.cashbackClaimedLamports > s.cashbackAccruedLamports + s.cashbackClaimableLamports) {
    v.push('more cashback claimed than ever accrued or claimable');
  }

  return { ok: v.length === 0, violations: v };
}
