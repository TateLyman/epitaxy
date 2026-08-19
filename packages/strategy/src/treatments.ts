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
  'MIGRATION_MICROSTRUCTURE_RISK_V1',
] as const;
export type EntryPolicy = (typeof ENTRY_POLICIES)[number];

/**
 * The policies whose results may be quoted as PRIMARY inference.
 *
 * `CORRECTED_CURRENT_QUALITY_SCORE` is retired from primary inference here, as
 * P9 requires: it has no trajectory-source coverage — its score was never
 * computed in this collector — so every row it produced was NOT_EVALUABLE
 * rather than a decision. It stays in `ENTRY_POLICIES` and keeps deciding,
 * because a descriptive arm costs nothing and removing it would make the corpus
 * discontinuous. It simply may not be reported as a result.
 */
export const PRIMARY_ENTRY_POLICIES: readonly EntryPolicy[] = [
  'HARD_GATES_RANDOM',
  'MIGRATION_MICROSTRUCTURE_RISK_V1',
  'SURVIVOR_FLOW_CONTINUATION_V1',
];

export const DESCRIPTIVE_ONLY_POLICIES: readonly EntryPolicy[] = ['CORRECTED_CURRENT_QUALITY_SCORE'];

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

  /**
   * P3/P9 — pre-migration structure, from the CLOSED bonding-curve history.
   *
   * Optional so that every existing construction of this interface stays valid;
   * absent reads exactly like null, which is to say never like a pass. All four
   * are computed strictly before the migration signature, so none of them can
   * carry post-migration information into an entry decision.
   */
  readonly largestFirstBuyerEntityShare?: number | null;
  readonly buyerRetention?: number | null;
  readonly lateSellPressure?: number | null;
  readonly migrationPathEntityDominance?: number | null;
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

    case 'MIGRATION_MICROSTRUCTURE_RISK_V1':
      return migrationMicrostructureRisk(f);
  }
}

/**
 * P9 — `MIGRATION_MICROSTRUCTURE_RISK_V1`.
 *
 * The one new mechanism-distinct policy this phase is permitted, and its job is
 * NOT to predict the winner.
 *
 *     remove launch structures associated with catastrophic post-migration loss
 *     while preserving exposure to the rare right-tail winner
 *
 * Those two clauses pull in opposite directions and the second one is the one
 * that gets quietly abandoned. Epitaxy's own windows show a single ~+14m
 * lamport path carrying an entire positive window — remove it and both policies
 * are negative — so a filter that trims the tail to improve the win rate makes
 * the strategy worse while every summary statistic it is judged on improves.
 *
 * Three consequences, all deliberate:
 *
 *  1. EVERY THRESHOLD IS EXTREME, not central. `maxEntityDominance` is 0.70,
 *     not the 0.35 the survivor policy uses for a different purpose. This
 *     policy is meant to refuse the launch that is one wallet in a trench coat,
 *     not to prefer the tidiest-looking token. A tidy launch and a winner are
 *     not the same population.
 *
 *  2. IT IS SPARSE. Eight conditions, all mechanical, none fitted. Twenty
 *     threshold clauses tuned on 13 settled paths would be a curve fit with a
 *     policy's name on it.
 *
 *  3. NOTHING HERE IS FITTED TO THE CURRENT OUTCOMES. The values come from
 *     protocol mechanics and from published launch-structure research
 *     (MemeTrans, SolRugDetector, Pump.fun graduation work), which chose the
 *     FAMILIES. They are registered in docs/MULTIPLE_TESTING_LEDGER.csv before
 *     the window opens, and they are availability-driven rather than
 *     outcome-driven, so they spend no alpha.
 *
 * An unknown is still a refusal, and that will make this policy NOT_EVALUABLE
 * on any candidate whose pre-migration history could not be fetched. That is
 * the honest state and it is measured by `pnpm policy:coverage` rather than
 * hidden behind a default.
 */
export interface MicrostructureRiskThresholds {
  readonly maxCreatorNetSellingLamports: bigint;
  readonly maxEntityConcentration: number;
  readonly maxFirstBuyerEntityShare: number;
  readonly minBuyerRetention: number;
  readonly maxLateSellPressure: number;
  readonly maxEntityDominance: number;
}

/**
 * Frozen before the window. See docs/MULTIPLE_TESTING_LEDGER.csv.
 *
 * Read them as "this launch is structurally broken", not as "this launch is
 * good". Every one of them is a wide bound.
 */
export const MICROSTRUCTURE_RISK_DEFAULTS: MicrostructureRiskThresholds = {
  // The creator taking anything out late is the single most repeated finding in
  // the rug literature. Zero tolerance is not a tuned number; it is the
  // mechanism — a creator who is selling into their own migration is the
  // counterparty, not the issuer.
  maxCreatorNetSellingLamports: 0n,
  // Wider than the survivor policy's 0.35: this is the catastrophe bound.
  maxEntityConcentration: 0.6,
  // One entity behind more than 70% of the first twenty buys is a bundle.
  maxFirstBuyerEntityShare: 0.7,
  // At least a fifth of early buyers still holding at migration. A launch where
  // essentially everyone had already left is one nobody is left to bid.
  minBuyerRetention: 0.2,
  // More than 80% of the final minute's volume being sells is a reversal in
  // progress, not a dip.
  maxLateSellPressure: 0.8,
  // One entity providing more than 70% of the whole path to migration.
  maxEntityDominance: 0.7,
};

function migrationMicrostructureRisk(
  f: PreEntryFeatures,
  t: MicrostructureRiskThresholds = MICROSTRUCTURE_RISK_DEFAULTS,
): EntryDecision {
  const unknowns: string[] = [];
  const fail: string[] = [];

  const need = <T>(name: string, v: T | null | undefined, ok: (x: T) => boolean, why: string): void => {
    if (v === null || v === undefined) {
      unknowns.push(name);
      fail.push(`${name} is unknown`);
      return;
    }
    if (!ok(v)) fail.push(why);
  };

  // 1. Mechanics. Already checked by the caller, restated so the condition
  //    count in this policy matches what the ledger registered.
  if (!f.mechanicsViable) fail.push('the mechanics are not viable');

  // 2. The creator is not net selling.
  need(
    'creatorNetSellingLamports',
    f.creatorNetSellingLamports,
    (x) => x <= t.maxCreatorNetSellingLamports,
    'the creator or a linked entity is net selling',
  );

  // 3. No hostile mint behaviour.
  need('mintBehaviourSafe', f.mintBehaviourSafe, (x) => x, 'the mint can be frozen, inflated or taxed');

  // 4. Entity concentration under the catastrophe bound.
  need(
    'entityConcentration',
    f.entityConcentration,
    (x) => x <= t.maxEntityConcentration,
    `entity concentration exceeds ${t.maxEntityConcentration}`,
  );

  // 5. No extreme first-buyer entity domination.
  need(
    'largestFirstBuyerEntityShare',
    f.largestFirstBuyerEntityShare,
    (x) => x <= t.maxFirstBuyerEntityShare,
    `one entity placed more than ${t.maxFirstBuyerEntityShare} of the first twenty buys`,
  );

  // 6. Buyer retention above the preregistered floor.
  need(
    'buyerRetention',
    f.buyerRetention,
    (x) => x >= t.minBuyerRetention,
    `early buyer retention is below ${t.minBuyerRetention}`,
  );

  // 7. No extreme late sell-pressure reversal.
  need(
    'lateSellPressure',
    f.lateSellPressure,
    (x) => x <= t.maxLateSellPressure,
    `late sell pressure exceeds ${t.maxLateSellPressure}`,
  );

  // 8. The path to migration was not one entity.
  need(
    'migrationPathEntityDominance',
    f.migrationPathEntityDominance,
    (x) => x <= t.maxEntityDominance,
    `a single entity provided more than ${t.maxEntityDominance} of the path to migration`,
  );

  return {
    policy: 'MIGRATION_MICROSTRUCTURE_RISK_V1',
    enter: fail.length === 0,
    reason: fail.length === 0 ? 'no catastrophic launch structure was present' : fail.join('; '),
    unknowns,
  };
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
  /** When the rule FIRED. Not necessarily when it could have traded. */
  readonly triggeredAtMs: number | null;
  /**
   * P9.2 — the FIRST LATER VALID FILL, which is a different instant.
   *
   * A deterioration is detected BY a mark. Filling at that same mark's price
   * books the exit at the observation that revealed the deterioration, which is
   * the one price the strategy demonstrably could not have traded at: it did
   * not know until the mark existed. The directive states the rule as
   *
   *     first deterioration trigger -> first later valid fill
   *
   * Null when the rule fired and no later mark carries a valid price. That is a
   * blocked exit, not a fill at the trigger.
   */
  readonly filledAtMs: number | null;
  readonly reason: string;
}

export const FIXED_HORIZON_MS = 15 * 60 * 1_000;

/** Descriptive horizons. Not used for inference without a new preregistration. */
export const REPORTED_HORIZONS_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000] as const;

export function decideExit(policy: ExitPolicy, openedAtMs: number, marks: readonly MarkPoint[]): ExitDecision {
  const ordered = [...marks].sort((a, b) => a.atMs - b.atMs);

  /**
   * The first mark strictly AFTER `afterMs` that carries a tradable price.
   *
   * P9.2: a rule that fires on a mark cannot also fill on it. The control's
   * horizon is a CLOCK rather than a signal — it is known in advance — so the
   * control fills at its horizon mark; the challenger's trigger is information
   * the mark itself supplied, so it fills later.
   */
  const firstValidFillAfter = (afterMs: number): MarkPoint | null =>
    ordered.find((m) => m.atMs > afterMs && m.executableLamports > 0n) ?? null;

  if (policy === 'FIXED_15M_CONTROL') {
    const at = ordered.find((m) => m.atMs >= openedAtMs + FIXED_HORIZON_MS);
    return {
      policy,
      triggeredAtMs: at?.atMs ?? null,
      // The horizon is a preregistered clock, so the control could stand ready
      // at it. Its trigger and its fill are the same instant, and that is the
      // asymmetry that makes the comparison fair rather than rigged.
      filledAtMs: at?.atMs ?? null,
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
  /**
   * F8 — compare against the LAST KNOWN capacity, not the adjacent mark.
   *
   * The loop used to `continue` when either side of an adjacent pair was null,
   * so a sequence 1,000,000 → null → 500,000 never compared anything and the
   * 50% collapse spanning the gap was invisible. The position was held through
   * a halving of exit capacity because one mark in the middle was unmeasured.
   *
   * Treating a gap as "no deterioration" is the null-is-safe reading this
   * repository forbids everywhere else.
   */
  let lastKnown: { atMs: number; capacity: bigint } | null = null;
  let improvedSinceOpen = false;

  for (const m of ordered) {
    if (m.exitCapacityLamports === null) continue;
    const cap = m.exitCapacityLamports;
    if (lastKnown !== null && lastKnown.capacity > 0n) {
      const dropBps = Number(((lastKnown.capacity - cap) * 10_000n) / lastKnown.capacity);
      if (dropBps >= EXIT_CAPACITY_DROP_BPS) {
        const spanned = m.atMs - lastKnown.atMs;
        const fill = firstValidFillAfter(m.atMs);
        return {
          policy,
          triggeredAtMs: m.atMs,
          filledAtMs: fill?.atMs ?? null,
          reason:
            `exit capacity fell ${dropBps} bps over ${spanned}ms since the last MEASURED mark, ` +
            'which is the liquidity deteriorating rather than the price moving' +
            (fill === null
              ? '; no later mark carries a tradable price, so the exit is BLOCKED rather than filled at the trigger'
              : `; filled at the first later valid mark, +${fill.atMs - m.atMs}ms`),
        };
      }
      if (cap > lastKnown.capacity) improvedSinceOpen = true;
    }
    lastKnown = { atMs: m.atMs, capacity: cap };
  }

  /**
   * F7 — the challenger can also hold LONGER, within a frozen bound.
   *
   * It used to fall back to the identical `FIXED_HORIZON_MS`, so on every path
   * where deterioration did not fire it returned exactly the control's answer.
   * The two policies were identical except when the challenger exited sooner,
   * which made the tournament structurally incapable of discovering that
   * exiting early is the error — and with heavy-tailed returns, that is the
   * error most worth discovering.
   *
   * So when liquidity has IMPROVED and none has deteriorated, the challenger
   * holds to a frozen extension. The extension is bounded and it is a
   * preregistered constant, not a search: an unbounded hold would win by
   * survivorship, which is what the original fallback correctly guarded against.
   */
  const horizon = openedAtMs + FIXED_HORIZON_MS;
  if (improvedSinceOpen) {
    const extended = ordered.find((m) => m.atMs >= horizon + EXIT_EXTENSION_MS);
    if (extended !== undefined) {
      return {
        policy,
        triggeredAtMs: extended.atMs,
        // A preregistered extension is a clock too, so trigger and fill coincide.
        filledAtMs: extended.atMs,
        reason: `exit capacity improved and never deteriorated, so the hold extended by ${EXIT_EXTENSION_MS}ms`,
      };
    }
  }

  const at = ordered.find((m) => m.atMs >= horizon);
  return {
    policy,
    triggeredAtMs: at?.atMs ?? null,
    filledAtMs: at?.atMs ?? null,
    reason: at ? 'no deterioration; fell back to the frozen horizon' : 'no deterioration and no 15 minute mark',
  };
}

/**
 * Frozen. The challenger may hold this much longer than the control when
 * liquidity improved, and no longer.
 */
export const EXIT_EXTENSION_MS = 15 * 60 * 1_000;

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
