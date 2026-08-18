import { decideEntry, type EntryDecision, type EntryPolicy, type PreEntryFeatures } from './treatments.js';

/**
 * P2 — a policy with no measured inputs is NOT EVALUABLE, not losing.
 *
 * At the audited head `SURVIVOR_FLOW_CONTINUATION_V1` rejected every candidate
 * because all six of its inputs were the literal `null`, and
 * `CORRECTED_CURRENT_QUALITY_SCORE` rejected every candidate because its score
 * was never computed in the trajectory collector. Both wrote REJECT rows. So
 * did a policy that had looked at real numbers and declined.
 *
 * Those are completely different facts and the corpus could not tell them
 * apart. Read naively, the two challengers had "rejected 100% of candidates",
 * which sounds like an extremely conservative strategy and was actually an
 * instrument reading zero because it was unplugged.
 *
 * The repair is a third verdict:
 *
 *     ENTER                the policy had what it needed and bought
 *     REJECTED_ON_SIGNAL   the policy had what it needed and declined
 *     NOT_EVALUABLE        the policy did not have what it needed
 *
 * Only the first two are evidence about a strategy. The third is evidence about
 * the apparatus, and pooling it with the second is how a broken sensor gets
 * reported as a cautious one.
 */

export type Evaluability = 'ENTER' | 'REJECTED_ON_SIGNAL' | 'NOT_EVALUABLE';

/**
 * The fields each policy actually READS.
 *
 * Declared rather than inferred, because inferring them from a run would make
 * the required set depend on the data — a policy that short-circuits on the
 * first unknown would appear to require only that one field.
 *
 * `HARD_GATES_RANDOM` requires nothing beyond the gates by design: it is the
 * causal control, and a control that needed signal coverage would be absent
 * from exactly the rows where the challengers are absent, which is the one
 * place a control has to be present.
 */
export const POLICY_REQUIRED_FIELDS: Readonly<Record<EntryPolicy, readonly string[]>> = {
  HARD_GATES_RANDOM: [],
  CORRECTED_CURRENT_QUALITY_SCORE: ['correctedQualityScore'],
  SURVIVOR_FLOW_CONTINUATION_V1: [
    'independentBuyerPersistence',
    'nonMayhemNetQuoteInflowLamports',
    'effectiveQuoteReserveTrend',
    'executableExitCapacityTrend',
    'continuationSlope',
    'creatorNetSellingLamports',
    'entityConcentration',
    'mintBehaviourSafe',
  ],
  MIGRATION_MICROSTRUCTURE_RISK_V1: [
    'mechanicsViable',
    'creatorNetSellingLamports',
    'mintBehaviourSafe',
    'entityConcentration',
    'largestFirstBuyerEntityShare',
    'buyerRetention',
    'lateSellPressure',
    'migrationPathEntityDominance',
  ],
};

export interface CoverageVerdict {
  readonly policy: EntryPolicy;
  readonly decision: EntryDecision;
  readonly evaluability: Evaluability;
  readonly requiredFields: readonly string[];
  readonly knownFields: readonly string[];
  readonly unknownFields: readonly string[];
  readonly fullCoverage: boolean;
}

/**
 * Decide, and say whether the decision means anything.
 *
 * The decision itself is UNCHANGED — `decideEntry` is called exactly as before
 * and an unknown still never reads as a pass. What changes is that the row now
 * records whether the policy was in a position to have an opinion.
 *
 * The hard gates are checked first and deliberately: a candidate a safety gate
 * refused is REJECTED_ON_SIGNAL for every policy, because the gate is a
 * measured fact and every policy is bound by it. Calling that NOT_EVALUABLE
 * would quietly remove the safest rejections from the denominator.
 */
export function evaluateWithCoverage(
  policy: EntryPolicy,
  features: PreEntryFeatures,
  extra: Readonly<Record<string, unknown>> = {},
  opts: { seed: string } = { seed: 'epitaxy-control-v1' },
): CoverageVerdict {
  const decision = decideEntry(policy, features, opts);
  const required = POLICY_REQUIRED_FIELDS[policy] ?? [];

  const bag: Record<string, unknown> = { ...(features as unknown as Record<string, unknown>), ...extra };
  const known: string[] = [];
  const unknown: string[] = [];
  for (const f of required) {
    const v = bag[f];
    if (v === null || v === undefined) unknown.push(f);
    else known.push(f);
  }
  const fullCoverage = unknown.length === 0;

  let evaluability: Evaluability;
  if (decision.enter) {
    evaluability = 'ENTER';
  } else if (!features.hardGatesPass || !features.mechanicsViable) {
    // A gate or the mechanics refused. That is a measurement, not a gap.
    evaluability = 'REJECTED_ON_SIGNAL';
  } else if (!fullCoverage) {
    evaluability = 'NOT_EVALUABLE';
  } else {
    evaluability = 'REJECTED_ON_SIGNAL';
  }

  return { policy, decision, evaluability, requiredFields: required, knownFields: known, unknownFields: unknown, fullCoverage };
}

export interface PolicyCoverageSummary {
  readonly policy: EntryPolicy;
  readonly eligible: number;
  readonly enter: number;
  readonly rejectedOnSignal: number;
  readonly notEvaluable: number;
  /** Share of eligible trajectories on which the policy could form an opinion. */
  readonly decisionCoverage: number;
  readonly unknownFieldHistogram: Readonly<Record<string, number>>;
}

export function summarisePolicyCoverage(verdicts: readonly CoverageVerdict[]): PolicyCoverageSummary[] {
  const byPolicy = new Map<EntryPolicy, CoverageVerdict[]>();
  for (const v of verdicts) {
    const list = byPolicy.get(v.policy);
    if (list === undefined) byPolicy.set(v.policy, [v]);
    else list.push(v);
  }
  return [...byPolicy.entries()].map(([policy, vs]) => {
    const hist: Record<string, number> = {};
    for (const v of vs) for (const f of v.unknownFields) hist[f] = (hist[f] ?? 0) + 1;
    const enter = vs.filter((v) => v.evaluability === 'ENTER').length;
    const rejected = vs.filter((v) => v.evaluability === 'REJECTED_ON_SIGNAL').length;
    const notEval = vs.filter((v) => v.evaluability === 'NOT_EVALUABLE').length;
    return {
      policy,
      eligible: vs.length,
      enter,
      rejectedOnSignal: rejected,
      notEvaluable: notEval,
      decisionCoverage: vs.length === 0 ? 0 : (enter + rejected) / vs.length,
      unknownFieldHistogram: hist,
    };
  });
}

/**
 * Whether a policy's performance may be QUOTED at all.
 *
 * "Do not call policy performance with zero entries" is the directive's rule
 * and this is where it is enforced rather than remembered. A policy that never
 * entered has no return distribution; printing its mean as 0.00 invents a
 * result, and printing it as a loss invents a worse one.
 */
export function performanceIsQuotable(s: PolicyCoverageSummary): { ok: boolean; reason: string } {
  if (s.enter === 0) {
    return {
      ok: false,
      reason:
        `${s.policy} entered 0 of ${s.eligible} eligible trajectories ` +
        `(${s.notEvaluable} NOT_EVALUABLE); it has no outcome distribution to report`,
    };
  }
  return { ok: true, reason: `${s.enter} entered position(s)` };
}
