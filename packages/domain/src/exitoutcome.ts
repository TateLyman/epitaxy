/**
 * What actually happened to a position, as distinct from which rule noticed.
 *
 * This module exists because of a specific, measured defect. Until 2026-08-12
 * every exit in this system was labelled by the rule that fired, and one rule —
 * `exit_cost_exploded` — fired on `Math.abs(priceImpactPct) > maxExitImpactBps`.
 * Eight of the first ten paper positions closed under that label. Reading the
 * stored quotes afterwards showed the label covered two unrelated events:
 *
 *   - `3XiaH5DA` executable sell output went 42,553,483 -> 13 lamports, with
 *     `priceImpactPct` about -1.0. The token was gone. Exiting was right.
 *   - `DE6svnZL` had `priceImpactPct` of +0.0911 and was worth MORE than cost.
 *     `Math.abs` turned a favourable number into "911 bps of exit cost" and
 *     ejected a position that was up 2.07% after twenty-one seconds.
 *
 * A single label spanning "the asset evaporated" and "the price moved in our
 * favour" cannot support any decision, and averaging over it produces a number
 * that describes nothing.
 *
 * The fix is not to correct the sign. It is to stop deriving economic meaning
 * from a provider's diagnostic field at all. Sign conventions are the
 * provider's business and can change without notice; the amount of SOL a full
 * position converts to is ours, is directly observed, and has no convention.
 * `priceImpactPct` is still recorded — raw, signed, unmodified — because it is
 * useful evidence. It is simply not permitted to define an outcome.
 *
 * Two orthogonal questions, two fields:
 *   - `ExitOutcome`  — what economically happened. Derived from executable value.
 *   - `TriggerRule`  — which rule caused us to act. Derived from the exit logic.
 * Conflating them is the defect this module is named after.
 */

/**
 * Version of the exit-accounting semantics, stored on every exit row.
 *
 * Separate from `strategyVersion` on purpose. Strategy version answers "would
 * this system have made the same decision?"; accounting version answers "does
 * this row mean the same thing as that row?". Reclassifying history changes the
 * second without touching the first, and a single version field would force us
 * to choose which lie to tell.
 *
 * v1 — first version in which an outcome is derived from executable value
 * rather than from `Math.abs(priceImpactPct)`.
 */
export const ACCOUNTING_VERSION = 'exit-accounting-v1';

/** The rule that fired. Answers "why did we act now?" */
export type TriggerRule =
  | 'stop_loss'
  | 'trailing_stop'
  | 'take_profit'
  | 'max_hold'
  | 'exit_route_lost'
  | 'exit_cost_exploded'
  | 'liquidity_collapse'
  | 'manual_or_kill'
  | 'unknown';

/** What happened to the money. Answers "what did this position do to us?" */
export type ExitOutcome =
  | 'route_unavailable'
  | 'liquidity_collapse'
  | 'severe_exit_degradation'
  | 'ordinary_stop_loss'
  | 'take_profit'
  | 'time_exit'
  | 'cost_drift'
  | 'execution_failure'
  | 'reconciliation_failure'
  | 'unknown';

/**
 * Boundaries for the value-based categories, as fractions of entry cost.
 *
 * `COLLAPSE_RATIO` is 0.10 because that is where the question stops being "how
 * much did we lose" and becomes "is there a market at all". It is a definition,
 * not a tuned parameter: it is not fitted to outcomes and does not appear in
 * any entry or exit decision, so it does not belong in the multiple-testing
 * ledger. Changing it re-labels history and must be done deliberately.
 */
export const COLLAPSE_RATIO = 0.1;
export const SEVERE_RATIO = 0.5;

export interface OutcomeInputs {
  /** Executable SOL a full-position sell was quoted to return, at exit time. */
  readonly quotedExitOutputLamports: bigint | null;
  /** All-in lamports the position cost to open. */
  readonly positionEntryCostLamports: bigint;
  /** False when no route existed at all. */
  readonly routeAvailable: boolean;
  /** The rule that fired, if any. */
  readonly triggerRule: TriggerRule;
  /**
   * Set only by execution paths. Paper cannot produce these, and a paper run
   * that does is itself a defect.
   */
  readonly executionFailed?: boolean;
  readonly reconciliationFailed?: boolean;
}

export interface OutcomeVerdict {
  readonly outcome: ExitOutcome;
  /** exitValue / entryCost. Null when no executable quote existed. */
  readonly exitValueRatio: number | null;
  /** Why this label and not another. Stored, so a row can be argued with. */
  readonly rationale: string;
}

/**
 * Classify. Deterministic, total, and dependent on no provider convention.
 *
 * Order is deliberate: infrastructure reality first, then economic magnitude,
 * then the rule. A position whose exit quote returned 5% of cost is a
 * `liquidity_collapse` whether the stop-loss or the impact cap happened to
 * notice first — otherwise the label records our polling order rather than the
 * market.
 */
export function classifyExit(input: OutcomeInputs): OutcomeVerdict {
  // Money-critical failures outrank everything: they mean we do not actually
  // know the position's state, and a confident label would be a lie.
  if (input.reconciliationFailed === true) {
    return {
      outcome: 'reconciliation_failure',
      exitValueRatio: null,
      rationale: 'ledger and chain disagree; position state is not known',
    };
  }
  if (input.executionFailed === true) {
    return {
      outcome: 'execution_failure',
      exitValueRatio: null,
      rationale: 'exit transaction did not land',
    };
  }

  if (!input.routeAvailable || input.quotedExitOutputLamports === null) {
    return {
      outcome: 'route_unavailable',
      exitValueRatio: null,
      rationale: 'no sell route existed at exit time; position could not be converted at any price',
    };
  }

  // Guard rather than assume. A zero cost would make every ratio infinite and
  // silently reclassify the whole corpus, so it is refused as unknown.
  if (input.positionEntryCostLamports <= 0n) {
    return {
      outcome: 'unknown',
      exitValueRatio: null,
      rationale: 'entry cost was not positive; no ratio is definable',
    };
  }

  const ratio = Number(input.quotedExitOutputLamports) / Number(input.positionEntryCostLamports);
  const pct = (ratio * 100).toFixed(2);

  if (ratio <= COLLAPSE_RATIO) {
    return {
      outcome: 'liquidity_collapse',
      exitValueRatio: ratio,
      rationale: `full-position sell quote returned ${pct}% of entry cost, at or below the ${COLLAPSE_RATIO * 100}% collapse threshold`,
    };
  }

  if (ratio <= SEVERE_RATIO) {
    return {
      outcome: 'severe_exit_degradation',
      exitValueRatio: ratio,
      rationale: `full-position sell quote returned ${pct}% of entry cost; market still functioning but value largely gone`,
    };
  }

  switch (input.triggerRule) {
    case 'take_profit':
      return { outcome: 'take_profit', exitValueRatio: ratio, rationale: `take-profit rule fired at ${pct}% of cost` };
    case 'max_hold':
      return { outcome: 'time_exit', exitValueRatio: ratio, rationale: `holding period elapsed at ${pct}% of cost` };
    case 'stop_loss':
    case 'trailing_stop':
      return {
        outcome: 'ordinary_stop_loss',
        exitValueRatio: ratio,
        rationale: `${input.triggerRule} fired at ${pct}% of cost, above the ${SEVERE_RATIO * 100}% severe threshold`,
      };
    case 'exit_cost_exploded':
      // The honest residual: the token still holds most of its value, but the
      // cost of getting out moved against us. This is the only case the old
      // label was ever entitled to describe.
      return {
        outcome: 'cost_drift',
        exitValueRatio: ratio,
        rationale: `exit cost exceeded its cap while the position still held ${pct}% of cost`,
      };
    case 'exit_route_lost':
      // Reaching here means the rule saw no route but a quote existed anyway.
      // Contradictory input is reported, not smoothed over.
      return {
        outcome: 'unknown',
        exitValueRatio: ratio,
        rationale: `contradictory: rule reported a lost route but an executable quote of ${pct}% of cost was present`,
      };
    case 'liquidity_collapse':
      return {
        outcome: 'unknown',
        exitValueRatio: ratio,
        rationale: `contradictory: rule reported collapse but the quote returned ${pct}% of cost`,
      };
    case 'manual_or_kill':
      return { outcome: 'time_exit', exitValueRatio: ratio, rationale: `closed by operator or kill switch at ${pct}% of cost` };
    case 'unknown':
      return { outcome: 'unknown', exitValueRatio: ratio, rationale: `no trigger rule recorded; quote was ${pct}% of cost` };
  }
}

/** True for outcomes that indicate broken infrastructure rather than a bad trade. */
export function isInfrastructureOutcome(o: ExitOutcome): boolean {
  return o === 'route_unavailable' || o === 'execution_failure' || o === 'reconciliation_failure';
}

/**
 * True for outcomes that are a market event rather than our strategy working.
 * Kept separate from the above because a collapse is real economic loss — it
 * counts against PnL — while an infrastructure outcome means the number is not
 * yet known.
 */
export function isMarketFailureOutcome(o: ExitOutcome): boolean {
  return o === 'liquidity_collapse' || o === 'severe_exit_degradation';
}
