import { createHash } from 'node:crypto';

/**
 * P10 / finding F — the tournament was labels, not treatments.
 *
 * The previous build allocated ONE arm label to ONE trajectory. That measures
 * nothing: each arm sees a different set of tokens, so any difference between
 * arms is confounded with which tokens each arm happened to draw, and with a
 * sample this size that difference is almost entirely noise.
 *
 * The repair is that every structurally sampled trajectory provides ONE common
 * market path, and every applicable policy is evaluated over that same path.
 * The comparison then becomes paired: same token, same pool, same marks, same
 * costs, different decision. That removes the token-selection variance entirely,
 * which is the dominant term.
 */

export const ENTRY_POLICIES = [
  'HARD_GATES_RANDOM',
  'CORRECTED_CURRENT_QUALITY_SCORE',
  'SURVIVOR_FLOW_CONTINUATION_V1',
] as const;
export type EntryPolicy = (typeof ENTRY_POLICIES)[number];

export const EXIT_POLICIES = ['FIXED_15M_CONTROL', 'FLOW_LIQUIDITY_DETERIORATION_V1'] as const;
export type ExitPolicy = (typeof EXIT_POLICIES)[number];

/**
 * Pre-entry features ONLY.
 *
 * Every field here must be knowable strictly before the entry is placed. A
 * feature computed from a post-entry observation is leakage, and leakage is
 * indistinguishable from edge in a backtest — it is the single most common way a
 * strategy looks profitable and is not.
 */
export interface PreEntryFeatures {
  readonly mint: string;
  /** Hard safety gates. A false here is disqualifying for EVERY policy. */
  readonly hardGatesPass: boolean;

  readonly independentBuyerPersistence: number | null;
  readonly nonMayhemNetQuoteInflowLamports: bigint | null;
  readonly effectiveQuoteReserveTrend: number | null;
  readonly executableExitCapacityTrend: number | null;
  readonly continuationSlope: number | null;
  readonly creatorNetSellingLamports: bigint | null;
  readonly entityConcentration: number | null;
  readonly mintBehaviourSafe: boolean | null;
  readonly mechanicsViable: boolean;

  /** The corrected quality score, or null when coverage was insufficient. */
  readonly correctedQualityScore: number | null;
  readonly scoreCoverageOk: boolean;
}

export interface EntryDecision {
  readonly policy: EntryPolicy;
  readonly enter: boolean;
  readonly reason: string;
  /** Features that were unknown. An unknown is never read as a pass. */
  readonly unknowns: readonly string[];
}

/**
 * A persisted, seeded inclusion.
 *
 * Deterministic in (seed, mint) so the control arm is reproducible across runs
 * and across machines. `Math.random()` would make the control arm unreplayable,
 * which defeats the purpose of having a control.
 */
export function seededInclusion(seed: string, mint: string, rate: number): boolean {
  const h = createHash('sha256').update(seed).update(':').update(mint).digest();
  // 32 bits of the digest as a uniform in [0,1).
  const x = h.readUInt32BE(0) / 0x1_0000_0000;
  return x < rate;
}

export const CONTROL_INCLUSION_RATE = 0.5;

export function decideEntry(
  policy: EntryPolicy,
  f: PreEntryFeatures,
  opts: { seed: string; thresholds?: Partial<SurvivorThresholds> } = { seed: 'epitaxy-control-v1' },
): EntryDecision {
  const unknowns: string[] = [];

  // Hard safety gates bind every policy. An arm that could trade through them
  // would not be a different strategy, it would be a different risk appetite.
  if (!f.hardGatesPass) {
    return { policy, enter: false, reason: 'a hard safety gate rejected this candidate', unknowns };
  }
  if (!f.mechanicsViable) {
    return { policy, enter: false, reason: 'the mechanics are not viable, so no policy can trade it', unknowns };
  }

  switch (policy) {
    case 'HARD_GATES_RANDOM': {
      // The causal control. It deliberately uses NO signal beyond the gates, so
      // any challenger that cannot beat it is not using information.
      const enter = seededInclusion(opts.seed, f.mint, CONTROL_INCLUSION_RATE);
      return {
        policy,
        enter,
        reason: enter ? 'seeded random inclusion' : 'seeded random exclusion',
        unknowns,
      };
    }

    case 'CORRECTED_CURRENT_QUALITY_SCORE': {
      if (!f.scoreCoverageOk) {
        unknowns.push('scoreCoverage');
        return { policy, enter: false, reason: 'score coverage was insufficient, and an unscored token is not a pass', unknowns };
      }
      if (f.correctedQualityScore === null) {
        unknowns.push('correctedQualityScore');
        return { policy, enter: false, reason: 'the corrected score is unavailable', unknowns };
      }
      const enter = f.correctedQualityScore >= QUALITY_SCORE_THRESHOLD;
      return {
        policy,
        enter,
        reason: `corrected score ${f.correctedQualityScore.toFixed(3)} vs threshold ${QUALITY_SCORE_THRESHOLD}`,
        unknowns,
      };
    }

    case 'SURVIVOR_FLOW_CONTINUATION_V1':
      return survivorFlowContinuation(f, { ...SURVIVOR_DEFAULTS, ...(opts.thresholds ?? {}) });
  }
}

/** Frozen. Changing it is a preregistration event, not a tuning step. */
export const QUALITY_SCORE_THRESHOLD = 0.55;

export interface SurvivorThresholds {
  readonly minBuyerPersistence: number;
  readonly minReserveTrend: number;
  readonly minExitCapacityTrend: number;
  readonly minContinuationSlope: number;
  readonly maxContinuationSlope: number;
  readonly maxEntityConcentration: number;
}

export const SURVIVOR_DEFAULTS: SurvivorThresholds = {
  minBuyerPersistence: 0.5,
  minReserveTrend: 0,
  minExitCapacityTrend: 0,
  minContinuationSlope: 0,
  // "Nonvertical": a slope this steep is a launch spike, and buying the top of
  // one is the single most reliable way to lose on a memecoin.
  maxContinuationSlope: 5,
  maxEntityConcentration: 0.35,
};

function survivorFlowContinuation(f: PreEntryFeatures, t: SurvivorThresholds): EntryDecision {
  const unknowns: string[] = [];
  const fail: string[] = [];

  /**
   * An unknown is never a pass.
   *
   * This is the repository's standing rule — absence of a provider field is a
   * fact about the provider, not about the token — applied to entry policy. A
   * policy that treated null as "fine" would enter most often on exactly the
   * tokens nothing is known about.
   */
  const need = <T>(name: string, v: T | null, ok: (x: T) => boolean, why: string): void => {
    if (v === null) {
      unknowns.push(name);
      fail.push(`${name} is unknown`);
      return;
    }
    if (!ok(v)) fail.push(why);
  };

  need('independentBuyerPersistence', f.independentBuyerPersistence, (x) => x >= t.minBuyerPersistence, 'buyer persistence is too low');
  need('nonMayhemNetQuoteInflow', f.nonMayhemNetQuoteInflowLamports, (x) => x > 0n, 'net quote inflow is not positive');
  need('effectiveQuoteReserveTrend', f.effectiveQuoteReserveTrend, (x) => x >= t.minReserveTrend, 'the effective quote reserve is shrinking');
  need('executableExitCapacityTrend', f.executableExitCapacityTrend, (x) => x >= t.minExitCapacityTrend, 'exit capacity is deteriorating');
  need(
    'continuationSlope',
    f.continuationSlope,
    (x) => x > t.minContinuationSlope && x <= t.maxContinuationSlope,
    'continuation is either negative or vertical',
  );
  need('creatorNetSelling', f.creatorNetSellingLamports, (x) => x <= 0n, 'the creator or a linked entity is net selling');
  need('entityConcentration', f.entityConcentration, (x) => x <= t.maxEntityConcentration, 'entity concentration is too high');
  need('mintBehaviourSafe', f.mintBehaviourSafe, (x) => x, 'the mint can be frozen, inflated or taxed');

  return {
    policy: 'SURVIVOR_FLOW_CONTINUATION_V1',
    enter: fail.length === 0,
    reason: fail.length === 0 ? 'every pre-entry condition held' : fail.join('; '),
    unknowns,
  };
}

/** The mark stream an exit policy sees. Shared across every policy. */
export interface MarkPoint {
  readonly atMs: number;
  readonly executableLamports: bigint;
  /** Exit capacity at this mark, when it was measured. */
  readonly exitCapacityLamports: bigint | null;
  readonly effectiveQuoteReserveLamports: bigint | null;
}

export interface ExitDecision {
  readonly policy: ExitPolicy;
  readonly triggeredAtMs: number | null;
  readonly reason: string;
}

export const FIXED_HORIZON_MS = 15 * 60 * 1_000;

/** Descriptive horizons. Not used for inference without a new preregistration. */
export const REPORTED_HORIZONS_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000] as const;

export function decideExit(policy: ExitPolicy, openedAtMs: number, marks: readonly MarkPoint[]): ExitDecision {
  const ordered = [...marks].sort((a, b) => a.atMs - b.atMs);

  if (policy === 'FIXED_15M_CONTROL') {
    const at = ordered.find((m) => m.atMs >= openedAtMs + FIXED_HORIZON_MS);
    return {
      policy,
      triggeredAtMs: at?.atMs ?? null,
      reason: at ? 'the frozen 15 minute horizon' : 'no mark exists at or after 15 minutes',
    };
  }

  /**
   * The challenger: leave when the ability to leave is deteriorating.
   *
   * Deliberately NOT a take-profit grid. Memecoin returns are heavy-tailed and a
   * small number of winners carry the result, so an arbitrary early take-profit
   * truncates exactly the right tail the strategy depends on. This exits on a
   * liquidity fact, not on a price target.
   */
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (prev === undefined || cur === undefined) continue;
    if (prev.exitCapacityLamports === null || cur.exitCapacityLamports === null) continue;
    if (prev.exitCapacityLamports === 0n) continue;

    const dropBps = Number(((prev.exitCapacityLamports - cur.exitCapacityLamports) * 10_000n) / prev.exitCapacityLamports);
    if (dropBps >= EXIT_CAPACITY_DROP_BPS) {
      return {
        policy,
        triggeredAtMs: cur.atMs,
        reason: `exit capacity fell ${dropBps} bps between marks, which is the liquidity deteriorating rather than the price moving`,
      };
    }
  }

  // Falls back to the frozen horizon so the challenger cannot hold forever and
  // win by survivorship.
  const at = ordered.find((m) => m.atMs >= openedAtMs + FIXED_HORIZON_MS);
  return {
    policy,
    triggeredAtMs: at?.atMs ?? null,
    reason: at ? 'no deterioration; fell back to the frozen horizon' : 'no deterioration and no 15 minute mark',
  };
}

/** Frozen. */
export const EXIT_CAPACITY_DROP_BPS = 2_000;

/**
 * Checkpoints, per policy and cohort.
 *
 * An arm may be eliminated at 50 only under the frozen rule below. Eliminating
 * on a look at the data is how a multiple-testing budget is spent without
 * anyone recording that it was spent.
 */
export const CHECKPOINTS = {
  APPARATUS_SANITY: 10,
  COSTS_AND_FILLABILITY: 25,
  EARLY_ELIMINATION: 50,
  DEVELOPMENT_SELECTION_PERMITTED: 100,
} as const;

export type CheckpointName = keyof typeof CHECKPOINTS;

export function checkpointReached(n: number): CheckpointName | null {
  if (n >= CHECKPOINTS.DEVELOPMENT_SELECTION_PERMITTED) return 'DEVELOPMENT_SELECTION_PERMITTED';
  if (n >= CHECKPOINTS.EARLY_ELIMINATION) return 'EARLY_ELIMINATION';
  if (n >= CHECKPOINTS.COSTS_AND_FILLABILITY) return 'COSTS_AND_FILLABILITY';
  if (n >= CHECKPOINTS.APPARATUS_SANITY) return 'APPARATUS_SANITY';
  return null;
}

/**
 * The frozen elimination rule.
 *
 * An arm is eliminated at the 50 checkpoint only when its PAIRED mean is worse
 * than the control's by more than the paired standard error times this
 * multiple. Paired, because every policy saw the same trajectories — an unpaired
 * comparison would be dominated by which tokens each arm drew, which is the
 * confound this whole section exists to remove.
 */
export const ELIMINATION_SE_MULTIPLE = 2;

export function shouldEliminate(p: {
  pairedDifferences: readonly number[];
}): { eliminate: boolean; reason: string; n: number; mean: number | null; se: number | null } {
  const n = p.pairedDifferences.length;
  if (n < CHECKPOINTS.EARLY_ELIMINATION) {
    return { eliminate: false, reason: `${n} paired observations; elimination is not permitted before ${CHECKPOINTS.EARLY_ELIMINATION}`, n, mean: null, se: null };
  }
  const mean = p.pairedDifferences.reduce((a, b) => a + b, 0) / n;
  const variance = p.pairedDifferences.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  if (se === 0) {
    return { eliminate: false, reason: 'the paired differences have no variance, which is an apparatus fault rather than a result', n, mean, se };
  }
  const eliminate = mean < -ELIMINATION_SE_MULTIPLE * se;
  return {
    eliminate,
    reason: eliminate
      ? `paired mean ${mean.toFixed(2)} is more than ${ELIMINATION_SE_MULTIPLE} standard errors (${se.toFixed(2)}) below the control`
      : `paired mean ${mean.toFixed(2)} is within ${ELIMINATION_SE_MULTIPLE} standard errors (${se.toFixed(2)}) of the control`,
    n,
    mean,
    se,
  };
}
