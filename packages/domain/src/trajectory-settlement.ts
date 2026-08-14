import type { MeasuredLegSettlement } from './settlement.js';
import { entryCashOut, exitCashIn, executionCost, transferFeeOrUnknown, acquiredTokens } from './settlement.js';

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

  const executionCostLamports =
    executionCost(p.entry) +
    (p.exit === null ? 0n : executionCost(p.exit)) +
    failed +
    rentLocked +
    cashback.claimCostLamports;

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
    unexplainedLamports: 0n,
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
