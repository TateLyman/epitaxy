/**
 * P13 — external data is a PRIOR and a feature lab, never a decision.
 *
 * MemeTrans, SolRugDetector and the Pump.fun graduation work are useful for
 * three things: verifying a feature formula, identifying which families are
 * worth computing, and testing that our code scales to a real dataset. They are
 * useful for exactly one thing they will be reached for anyway, and must not
 * be: deciding.
 *
 * The forbidden move is specific and seductive —
 *
 *     train on 2024/2025 data, then declare the 2026 PumpSwap strategy validated
 *
 * — and it is wrong for reasons that have nothing to do with statistics. The
 * protocol changed, the fee schedule changed (the 420-SOL tier and cashback did
 * not exist), the migration venue changed, and the participant population
 * changed. A model fitted to that world is not a weaker estimate of this one; it
 * is an estimate of a different thing.
 *
 * So an external score enters the system as EXTERNAL_PRIOR_SCORE and the type
 * makes it structurally impossible to feed to a policy. `decideEntry` takes
 * `PreEntryFeatures`, this is not one, and there is no conversion.
 */

export interface ExternalPriorScore {
  readonly kind: 'EXTERNAL_PRIOR_SCORE';
  readonly mint: string;
  readonly modelId: string;
  /** The corpus it was fitted on. Recorded so its era can never be forgotten. */
  readonly trainedOnCorpus: string;
  readonly trainedThroughUtc: string;
  readonly score: number;
  /**
   * Always false in this phase. It becomes true only after PROSPECTIVE current
   * data calibrates it, which is a preregistration event and not a code change.
   */
  readonly decisionBearing: false;
  readonly note: string;
}

export class ExternalPriorMisuse extends Error {}

export function externalPriorScore(p: {
  mint: string;
  modelId: string;
  trainedOnCorpus: string;
  trainedThroughUtc: string;
  score: number;
}): ExternalPriorScore {
  return {
    kind: 'EXTERNAL_PRIOR_SCORE',
    ...p,
    decisionBearing: false,
    note:
      'fitted on a corpus predating the current fee schedule, migration venue and participant population; ' +
      'descriptive only until prospective Epitaxy data calibrates it',
  };
}

/**
 * The guard for any caller that thinks it can use one.
 *
 * Throws. Not a warning and not a null — a prior that silently declines to
 * influence a decision is indistinguishable from one that did, and this is the
 * boundary where a 2024 model becomes a 2026 trade.
 */
export function assertNotDecisionBearing(s: ExternalPriorScore, context: string): void {
  if (s.decisionBearing !== false) {
    throw new ExternalPriorMisuse(`${context}: an external prior may not bear a decision`);
  }
}

export function refuseExternalPriorInPolicy(s: ExternalPriorScore): never {
  throw new ExternalPriorMisuse(
    `EXTERNAL_PRIOR_SCORE for ${s.mint} (model ${s.modelId}, trained through ${s.trainedThroughUtc}) ` +
      'may not enter an entry policy: the protocol, fee schedule, venue and population all changed after its corpus',
  );
}
