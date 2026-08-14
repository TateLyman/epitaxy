/**
 * P19 — the development tournament, preregistered.
 *
 * Everything in this file is frozen BEFORE the first trajectory. That is the
 * only property that makes the result mean anything: an arm set chosen after
 * seeing which one is winning is not a comparison, and a checkpoint moved after
 * an arm underperforms is not a rule.
 *
 * The tournament does not run yet. Zero valid trajectories exist, and the
 * checkpoints below begin at ten per arm. What is wired now is the ALLOCATION —
 * every trajectory is assigned an arm as it opens, balanced and deterministic —
 * so that when trajectories start arriving they are already allocated rather
 * than retrospectively labelled. Retrospective labelling of an existing corpus
 * is how an arm gets assigned the trajectories that suit it.
 */

/** Entry policies. No parameter grid: three distinct hypotheses, not one tuned. */
export const ENTRY_ARMS = [
  /** The floor. Everything the hard gates admit, chosen at random among them. */
  'HARD_GATES_RANDOM',
  /** The current score, on the corrected v0.6.0 semantics. */
  'CORRECTED_CURRENT_QUALITY_SCORE',
  /** Continuation of survivor flow rather than a quality judgement. */
  'SURVIVOR_FLOW_CONTINUATION_V1',
] as const;
export type EntryArm = (typeof ENTRY_ARMS)[number];

/** Exit policies: one control, one challenger. */
export const EXIT_ARMS = [
  /** Fixed time. A control that cannot be tuned and cannot look ahead. */
  'FIXED_TIME_CONTROL',
  /** Exit on deteriorating flow or liquidity. */
  'FLOW_DETERIORATION_V1',
] as const;
export type ExitArm = (typeof EXIT_ARMS)[number];

export interface TournamentArm {
  readonly entry: EntryArm;
  readonly exit: ExitArm;
}

/** Every cell. Allocation is balanced across these, not across entries alone. */
export const ARMS: readonly TournamentArm[] = ENTRY_ARMS.flatMap((entry) =>
  EXIT_ARMS.map((exit) => ({ entry, exit })),
);

export const armId = (a: TournamentArm): string => `${a.entry}|${a.exit}`;

/**
 * Checkpoints, in completed valid trajectories PER ARM.
 *
 * Frozen. A checkpoint that moves after an arm underperforms is not a rule, and
 * the temptation to move it is strongest exactly when it matters.
 */
export const CHECKPOINTS = {
  /** Does the instrument work at all on this arm? Not a performance question. */
  INSTRUMENT_SANITY: 10,
  /** Are the sizes, costs and fillability what the size surface predicted? */
  SIZE_COST_SANITY: 25,
  /** The first point at which an arm may be eliminated. */
  EARLY_ELIMINATION: 50,
  /** The first point at which at most one arm may be selected. */
  SELECTION_PERMITTED: 100,
} as const;

export type EliminationReason =
  | 'NET_NEGATIVE_AFTER_ALL_COSTS'
  | 'NEGATIVE_WITHOUT_TOP_THREE'
  | 'CATASTROPHIC_INCIDENCE_UNACCEPTABLE'
  | 'BLOCKED_EXIT_INCIDENCE_UNACCEPTABLE'
  | 'MECHANICS_DRAG_CONSUMES_EDGE'
  | 'VALID_LABEL_THROUGHPUT_TOO_LOW'
  | 'ONE_MINT_OR_DAY_CARRIES_RESULT';

export interface ArmObservation {
  readonly completedTrajectories: number;
  readonly netLamports: bigint;
  /** Net with the three largest winners removed. Fragility, not performance. */
  readonly netWithoutTopThreeLamports: bigint;
  readonly catastrophicCount: number;
  readonly blockedExitCount: number;
  /** The mechanics floor at the development notional, in bps. */
  readonly mechanicsDragBps: number;
  /** Whatever plausible edge this arm shows, in bps, before mechanics. */
  readonly grossEdgeBps: number;
  readonly validTrajectoriesPerDay: number;
  readonly distinctMints: number;
  readonly distinctUtcDays: number;
  /** Share of net PnL from the single best mint, and the single best day. */
  readonly topMintShare: number;
  readonly topDayShare: number;
}

/** Frozen thresholds. Each one is a decision that belongs in the ledger. */
export const ELIMINATION = {
  maxCatastrophicShare: 0.05,
  maxBlockedExitShare: 0.2,
  minValidTrajectoriesPerDay: 3,
  maxSingleMintShare: 0.5,
  maxSingleDayShare: 0.5,
} as const;

export interface ArmVerdict {
  readonly eliminate: boolean;
  readonly reasons: readonly EliminationReason[];
  readonly detail: readonly string[];
  /** True once the arm has enough trajectories to be judged at all. */
  readonly eligibleForElimination: boolean;
}

/**
 * Whether an arm is killed at the 50-trajectory checkpoint.
 *
 * Deliberately a pure function of a preregistered observation, so the decision
 * can be re-derived later and cannot drift with how anyone feels about an arm.
 * "Do not protect the original 2m–60m thesis" is enforced by the absence of any
 * special case for it.
 */
export function judgeArm(o: ArmObservation): ArmVerdict {
  const reasons: EliminationReason[] = [];
  const detail: string[] = [];

  if (o.completedTrajectories < CHECKPOINTS.EARLY_ELIMINATION) {
    return {
      eliminate: false,
      reasons: [],
      detail: [`${o.completedTrajectories} of ${CHECKPOINTS.EARLY_ELIMINATION} trajectories; not yet judged`],
      eligibleForElimination: false,
    };
  }

  if (o.netLamports <= 0n) {
    reasons.push('NET_NEGATIVE_AFTER_ALL_COSTS');
    detail.push(`net ${o.netLamports} lamports after all costs`);
  }
  if (o.netWithoutTopThreeLamports <= 0n) {
    reasons.push('NEGATIVE_WITHOUT_TOP_THREE');
    detail.push(`net without the top three winners is ${o.netWithoutTopThreeLamports}`);
  }
  const catShare = o.completedTrajectories === 0 ? 0 : o.catastrophicCount / o.completedTrajectories;
  if (catShare > ELIMINATION.maxCatastrophicShare) {
    reasons.push('CATASTROPHIC_INCIDENCE_UNACCEPTABLE');
    detail.push(`${(catShare * 100).toFixed(1)}% catastrophic`);
  }
  const blockedShare = o.completedTrajectories === 0 ? 0 : o.blockedExitCount / o.completedTrajectories;
  if (blockedShare > ELIMINATION.maxBlockedExitShare) {
    reasons.push('BLOCKED_EXIT_INCIDENCE_UNACCEPTABLE');
    detail.push(`${(blockedShare * 100).toFixed(1)}% of exits blocked`);
  }
  if (o.grossEdgeBps <= o.mechanicsDragBps) {
    reasons.push('MECHANICS_DRAG_CONSUMES_EDGE');
    detail.push(`gross edge ${o.grossEdgeBps} bps against a ${o.mechanicsDragBps} bps mechanics floor`);
  }
  if (o.validTrajectoriesPerDay < ELIMINATION.minValidTrajectoriesPerDay) {
    reasons.push('VALID_LABEL_THROUGHPUT_TOO_LOW');
    detail.push(`${o.validTrajectoriesPerDay}/day valid trajectories`);
  }
  if (o.topMintShare > ELIMINATION.maxSingleMintShare || o.topDayShare > ELIMINATION.maxSingleDayShare) {
    reasons.push('ONE_MINT_OR_DAY_CARRIES_RESULT');
    detail.push(`top mint ${(o.topMintShare * 100).toFixed(0)}%, top day ${(o.topDayShare * 100).toFixed(0)}% of net`);
  }

  return { eliminate: reasons.length > 0, reasons, detail, eligibleForElimination: true };
}

/**
 * The arm a trajectory belongs to.
 *
 * Balanced by construction and deterministic given the counts, so two processes
 * reading the same corpus assign the same arm and a restart does not reshuffle
 * the allocation. The least-filled cell wins; ties break on the frozen order of
 * `ARMS`, never on anything about the candidate.
 *
 * Assigning by a property of the candidate — its score, its liquidity, its age
 * — would make the arms non-comparable, because each would then be measured on
 * a different population.
 */
export function allocateArm(counts: ReadonlyMap<string, number>): TournamentArm {
  let best = ARMS[0] as TournamentArm;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const arm of ARMS) {
    const n = counts.get(armId(arm)) ?? 0;
    if (n < bestCount) {
      best = arm;
      bestCount = n;
    }
  }
  return best;
}

/**
 * The primary objective, stated once.
 *
 * Robust expected log growth per capital-hour. Not win rate, and not total PnL:
 * win rate is maximised by never cutting a loser, and total PnL is maximised by
 * whichever arm happened to catch the biggest mint.
 */
export const PRIMARY_OBJECTIVE = 'robust_expected_log_growth_per_capital_hour' as const;
export const SECONDARY_OBJECTIVES = [
  'cvar',
  'catastrophic_incidence',
  'blocked_exit_incidence',
  'tail_day_mint_concentration',
] as const;
