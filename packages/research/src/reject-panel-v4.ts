/**
 * P16 — PROSPECTIVE REJECT PANEL V4.
 *
 * This exists because a risk filter can look excellent for a reason that has
 * nothing to do with skill: it can simply trade less. Refuse enough candidates
 * and the entered set will contain fewer catastrophes, the catastrophic
 * incidence will fall, and every summary statistic will improve — while the
 * strategy makes less money, because memecoin returns are carried by a small
 * number of enormous winners and a filter that removes them removes the edge.
 *
 * Epitaxy has already seen the shape: one ~+14m lamport path carried an entire
 * positive window. A filter that had rejected that one token would have
 * "avoided losses" on twelve others and destroyed the window.
 *
 * So the entered PnL is not the statistic. These are:
 *
 *     catastrophic-loss rate among REJECTED
 *     right-tail winner rate among REJECTED
 *     opportunity cost
 *
 * A filter whose rejects contain the same winner rate as its entries is not
 * selecting; it is sampling. A filter that avoids losses AND removes every tail
 * winner is worse than no filter.
 */

export interface RejectedCandidate {
  readonly mint: string;
  readonly policy: string;
  readonly rejectionReason: string;
  /** The probability this reject was sampled into the panel. Inverse-weights it. */
  readonly selectionProbability: number;
  /** The shared later mark path, when it was collected. */
  readonly logReturn: number | null;
  readonly catastrophic: boolean | null;
  readonly blockedExit: boolean | null;
}

export interface EnteredCandidate {
  readonly mint: string;
  readonly logReturn: number;
  readonly catastrophic: boolean;
}

/** Frozen. A "right-tail winner" is a path that at least doubled in log terms. */
export const RIGHT_TAIL_LOG_RETURN = Math.log(2);

export interface RejectPanelReport {
  readonly policy: string;
  readonly rejectedSampled: number;
  readonly rejectedWithMarks: number;
  readonly catastrophicRateAmongRejected: number | null;
  readonly rightTailRateAmongRejected: number | null;
  readonly rightTailRateAmongEntered: number | null;
  /**
   * Inverse-probability-weighted mean log return of what was refused.
   *
   * Weighted because the panel SAMPLES rejects rather than marking all of them
   * — an unweighted mean would describe the sample, not the rejected
   * population, and the sampling rate is deliberately not uniform.
   */
  readonly opportunityCostMeanLogReturn: number | null;
  /** Winners the filter discarded. The number that decides whether it is useful. */
  readonly tailWinnersDiscarded: number;
  readonly verdict: string;
}

export function rejectPanelReport(
  policy: string,
  rejected: readonly RejectedCandidate[],
  entered: readonly EnteredCandidate[],
): RejectPanelReport {
  const mine = rejected.filter((r) => r.policy === policy);
  const marked = mine.filter((r) => r.logReturn !== null);

  const catastrophic = marked.filter((r) => r.catastrophic === true).length;
  const tailWinners = marked.filter((r) => (r.logReturn as number) >= RIGHT_TAIL_LOG_RETURN);

  /**
   * Inverse-probability weighting.
   *
   * A candidate sampled with probability 0.1 stands for ten of its kind. A
   * probability of zero would be a division by zero and is refused upstream:
   * a candidate that could not have been sampled cannot be in the panel.
   */
  let weightSum = 0;
  let weighted = 0;
  for (const r of marked) {
    if (r.selectionProbability <= 0) continue;
    const w = 1 / r.selectionProbability;
    weightSum += w;
    weighted += w * (r.logReturn as number);
  }

  const enteredTail = entered.filter((e) => e.logReturn >= RIGHT_TAIL_LOG_RETURN).length;
  const rejTailRate = marked.length === 0 ? null : tailWinners.length / marked.length;
  const entTailRate = entered.length === 0 ? null : enteredTail / entered.length;

  let verdict: string;
  if (marked.length === 0) {
    verdict = 'NOT_EVALUABLE: no rejected candidate carries a mark path, so nothing is known about what was refused';
  } else if (rejTailRate !== null && entTailRate !== null && rejTailRate > entTailRate) {
    verdict =
      `HARMFUL: the right-tail winner rate among rejects (${(rejTailRate * 100).toFixed(1)}%) EXCEEDS ` +
      `the rate among entries (${(entTailRate * 100).toFixed(1)}%); this filter is removing the paths that carry the strategy`;
  } else if (tailWinners.length > 0 && entTailRate !== null && entTailRate === 0) {
    verdict = `HARMFUL: ${tailWinners.length} tail winner(s) refused and none entered`;
  } else {
    verdict = `${tailWinners.length} tail winner(s) refused against ${enteredTail} entered`;
  }

  return {
    policy,
    rejectedSampled: mine.length,
    rejectedWithMarks: marked.length,
    catastrophicRateAmongRejected: marked.length === 0 ? null : catastrophic / marked.length,
    rightTailRateAmongRejected: rejTailRate,
    rightTailRateAmongEntered: entTailRate,
    opportunityCostMeanLogReturn: weightSum === 0 ? null : weighted / weightSum,
    tailWinnersDiscarded: tailWinners.length,
    verdict,
  };
}
