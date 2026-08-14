/**
 * P22 — the confirmatory window, and the contract it freezes.
 *
 * A development tournament selects an arm by looking at results. That is what
 * it is for, and it is also why its result cannot be trusted as an estimate:
 * the arm that won was chosen because it won. The confirmatory window exists to
 * ask the same question once, of an untouched sample, with every parameter
 * fixed BEFORE the first outcome.
 *
 * Two halves, and both matter:
 *
 *   the FREEZE     everything that must be pinned before collection starts
 *   the GATE       the conditions the completed window must satisfy
 *
 * The freeze is the harder discipline. A window whose notional or exit policy
 * moved partway through is not one experiment; it is two experiments sharing a
 * name, and the second one saw the first one's results.
 *
 * Nothing here weakens on failure. The directive's instruction is explicit —
 * "do not weaken a failed gate" — and the way that instruction is honoured in
 * code is that the thresholds are constants in this file, fixed by a test, with
 * no configuration path and no override argument.
 */

export interface FrozenConfirmatoryContract {
  /** The exact route families and capability fingerprints admitted. */
  readonly routeFamilies: readonly string[];
  readonly capabilityFingerprints: readonly string[];
  /** Which builder is primary, and what the fallback contract is. */
  readonly directBuilder: string;
  readonly fallbackBuilder: string | null;
  readonly notionalLamports: bigint;
  readonly cohort: string;
  readonly migrationAgeBand: string;
  /** Mayhem venues in or out. Not "whatever the gate happened to do". */
  readonly mayhemPolicy: 'EXCLUDE' | 'INCLUDE' | 'SEPARATE_COHORT';
  readonly entryPolicy: string;
  readonly exitPolicy: string;
  readonly fillLatencyMs: number;
  readonly costModel: string;
  readonly rentTreatment: string;
  readonly riskFacts: readonly string[];
  /** Stamped so a later reader can tell which code produced the window. */
  readonly strategyVersion: string;
  readonly sourceCommit: string;
  readonly frozenUtcMs: number;
}

/** Every field that must be present. Absence is a refusal, not a default. */
const REQUIRED_FIELDS: readonly (keyof FrozenConfirmatoryContract)[] = [
  'routeFamilies',
  'capabilityFingerprints',
  'directBuilder',
  'notionalLamports',
  'cohort',
  'migrationAgeBand',
  'mayhemPolicy',
  'entryPolicy',
  'exitPolicy',
  'fillLatencyMs',
  'costModel',
  'rentTreatment',
  'riskFacts',
  'strategyVersion',
  'sourceCommit',
  'frozenUtcMs',
];

export interface FreezeCheck {
  readonly frozen: boolean;
  readonly missing: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * Whether a contract is complete enough to start collecting against.
 *
 * `fallbackBuilder` is the only field allowed to be null, because "there is no
 * fallback" is a decision. Everything else absent means it was never decided,
 * and an undecided parameter is one that will be decided by whatever happens.
 */
export function checkFreeze(c: Partial<FrozenConfirmatoryContract>): FreezeCheck {
  const missing: string[] = [];
  const reasons: string[] = [];

  for (const f of REQUIRED_FIELDS) {
    const v = c[f];
    if (v === undefined || v === null) {
      missing.push(f);
      continue;
    }
    if (Array.isArray(v) && v.length === 0) {
      missing.push(f);
      reasons.push(`${f} is empty, which admits everything rather than a stated set`);
    }
  }
  if (c.notionalLamports !== undefined && c.notionalLamports <= 0n) {
    missing.push('notionalLamports');
    reasons.push('a non-positive notional is not a size anyone could deploy');
  }
  if (c.sourceCommit !== undefined && !/^[0-9a-f]{7,40}$/.test(c.sourceCommit)) {
    missing.push('sourceCommit');
    reasons.push('the commit must name a real revision, so the window can be re-derived');
  }

  return { frozen: missing.length === 0, missing: [...new Set(missing)], reasons };
}

/** Whether an observed window was collected under the frozen contract. */
export function contractHeld(
  frozen: FrozenConfirmatoryContract,
  observed: {
    routeFamilies: readonly string[];
    notionalLamports: bigint;
    cohorts: readonly string[];
    entryPolicies: readonly string[];
    exitPolicies: readonly string[];
    strategyVersions: readonly string[];
    fillLatencyMs: number;
  },
): { held: boolean; drift: readonly string[] } {
  const drift: string[] = [];
  const extra = observed.routeFamilies.filter((f) => !frozen.routeFamilies.includes(f));
  if (extra.length > 0) drift.push(`route families outside the freeze: ${extra.join(', ')}`);
  if (observed.notionalLamports !== frozen.notionalLamports) {
    drift.push(`notional ${observed.notionalLamports} against a frozen ${frozen.notionalLamports}`);
  }
  if (observed.cohorts.some((c) => c !== frozen.cohort)) {
    drift.push(`cohorts outside the freeze: ${observed.cohorts.filter((c) => c !== frozen.cohort).join(', ')}`);
  }
  if (observed.entryPolicies.some((p) => p !== frozen.entryPolicy)) drift.push('more than one entry policy');
  if (observed.exitPolicies.some((p) => p !== frozen.exitPolicy)) drift.push('more than one exit policy');
  if (observed.strategyVersions.some((v) => v !== frozen.strategyVersion)) {
    drift.push(`strategy versions outside the freeze: ${observed.strategyVersions.join(', ')}`);
  }
  if (observed.fillLatencyMs !== frozen.fillLatencyMs) {
    drift.push(`fill latency ${observed.fillLatencyMs} against a frozen ${frozen.fillLatencyMs}`);
  }
  return { held: drift.length === 0, drift };
}

/**
 * The pass conditions. Constants, with no configuration path.
 *
 * Every one of these is from the directive. They are here rather than in a
 * config file precisely so that failing one cannot be answered by editing a
 * number: an edit here is a diff a reviewer sees, and belongs in
 * `docs/MULTIPLE_TESTING_LEDGER.csv`.
 */
export const CONFIRMATORY_THRESHOLDS = {
  minCompletedPositions: 200,
  minDistinctUtcDays: 21,
  minProfitFactor: 1.25,
  /** The most recent N must be positive on their own. */
  recentWindow: 50,
} as const;

export interface ConfirmatoryEvidence {
  readonly completedPositions: number;
  readonly distinctUtcDays: number;
  readonly netPnlLamports: bigint;
  readonly expectedLogGrowth: number;
  readonly robustLowerBound: number;
  readonly profitFactor: number;
  readonly maxDrawdownBps: number;
  readonly cvarBps: number;
  readonly catastrophicIncidence: number;
  readonly blockedExitIncidence: number;
  readonly recentFiftyNetLamports: bigint;
  readonly netWithoutTopThreeLamports: bigint;
  readonly maxSingleDayShare: number;
  readonly maxSingleMintShare: number;
  readonly netUnderDoubleCostsLamports: bigint;
  readonly netUnderLatencyStressLamports: bigint;
  readonly exactCanarySizeShadowNetLamports: bigint;
  readonly replayDivergences: number;
  readonly unresolvedReconciliations: number;
  readonly fingerprintsStable: boolean;
  readonly maxDrawdownBpsAllowed: number;
  readonly maxCvarBpsAllowed: number;
  readonly maxCatastrophicIncidence: number;
  readonly maxBlockedExitIncidence: number;
}

export interface ConfirmatoryVerdict {
  readonly passed: boolean;
  readonly failures: readonly string[];
  /** True once there is enough sample to judge at all. */
  readonly sufficientSample: boolean;
}

/**
 * Judge a completed confirmatory window.
 *
 * Every condition is AND. There is no scoring, no weighting and no "mostly
 * passed": a window that fails one condition failed, and the correct response
 * is another window, not a softer threshold.
 */
export function judgeConfirmatory(e: ConfirmatoryEvidence): ConfirmatoryVerdict {
  const failures: string[] = [];
  const T = CONFIRMATORY_THRESHOLDS;

  const sufficientSample =
    e.completedPositions >= T.minCompletedPositions && e.distinctUtcDays >= T.minDistinctUtcDays;
  if (e.completedPositions < T.minCompletedPositions) {
    failures.push(`${e.completedPositions} completed positions, ${T.minCompletedPositions} required`);
  }
  if (e.distinctUtcDays < T.minDistinctUtcDays) {
    failures.push(`${e.distinctUtcDays} distinct UTC days, ${T.minDistinctUtcDays} required`);
  }

  if (e.netPnlLamports <= 0n) failures.push('net PnL is not positive');
  if (e.expectedLogGrowth <= 0) failures.push('expected log growth is not positive');
  if (e.robustLowerBound <= 0) failures.push('the robust lower bound is not positive');
  if (e.profitFactor < T.minProfitFactor) {
    failures.push(`profit factor ${e.profitFactor} below ${T.minProfitFactor}`);
  }
  if (e.maxDrawdownBps > e.maxDrawdownBpsAllowed) failures.push('drawdown exceeds its bound');
  if (e.cvarBps > e.maxCvarBpsAllowed) failures.push('CVaR exceeds its bound');
  if (e.catastrophicIncidence > e.maxCatastrophicIncidence) failures.push('catastrophic incidence unacceptable');
  if (e.blockedExitIncidence > e.maxBlockedExitIncidence) failures.push('blocked-exit incidence unacceptable');
  if (e.recentFiftyNetLamports <= 0n) failures.push(`the most recent ${T.recentWindow} are not positive`);
  if (e.netWithoutTopThreeLamports <= 0n) failures.push('not positive without the top three');
  if (e.maxSingleDayShare > 0.5) failures.push('one day carries more than half the net');
  if (e.maxSingleMintShare > 0.5) failures.push('one mint carries more than half the net');
  if (e.netUnderDoubleCostsLamports <= 0n) failures.push('not positive under 2x actual costs');
  if (e.netUnderLatencyStressLamports <= 0n) failures.push('not positive under latency and failure stress');
  if (e.exactCanarySizeShadowNetLamports <= 0n) failures.push('the exact canary-size shadow is not positive');
  if (e.replayDivergences !== 0) failures.push(`${e.replayDivergences} replay divergences`);
  if (e.unresolvedReconciliations !== 0) failures.push(`${e.unresolvedReconciliations} unresolved reconciliations`);
  if (!e.fingerprintsStable) failures.push('capability fingerprints are not stable');

  return { passed: failures.length === 0, failures, sufficientSample };
}
