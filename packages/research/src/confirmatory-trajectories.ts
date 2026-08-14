/**
 * P18 — one exact confirmatory contract, frozen before the first outcome.
 *
 * The failure this removes is a readiness number computed by summing every
 * historical shadow. That answers "has anything ever looked good", which is a
 * question with a yes in any large enough corpus. The question that matters is
 * "did the thing I committed to in advance do what I said it would", and only a
 * contract frozen BEFORE the first outcome can answer it.
 *
 * Two properties make it a contract rather than a description:
 *
 * 1. **Every threshold is a constant here.** None may be supplied by observed
 *    evidence. A threshold read from the data it judges is not a threshold.
 * 2. **One trajectory produces one row.** No unrelated qualifying job may
 *    satisfy another trajectory's requirement — that is how a corpus of near
 *    misses becomes a confirmed result.
 */

export interface ConfirmatoryContract {
  readonly contractId: string;
  /** Frozen at creation. A contract stamped after an outcome is not frozen. */
  readonly frozenAtUtcMs: number;
  readonly sourceCommit: string;
  readonly strategyVersion: string;
  readonly kernelVersion: string;
  readonly notionalLamports: string;
  readonly cohort: string;
  readonly migrationAgeBand: string;
  readonly cashbackPolicy: string;
  readonly mayhemPolicy: string;
  readonly entryPolicy: string;
  readonly exitPolicy: string;
  readonly approvedFingerprints: readonly string[];
  readonly costModel: string;
  readonly rentTreatment: string;
  readonly counterfactualEvidenceClass: string;
}

/**
 * One trajectory, one row. Every identity field is exact.
 */
export interface ConfirmatoryTrajectoryRow {
  readonly trajectoryId: string;
  readonly entryObservationId: string;
  readonly entrySimulationJobId: string;
  readonly entrySettlementId: string;
  readonly exitObservationId: string | null;
  readonly exitSimulationJobId: string | null;
  readonly exitSettlementId: string | null;

  readonly contractId: string;
  readonly sourceCommit: string;
  readonly strategyVersion: string;
  readonly kernelVersion: string;
  readonly notionalLamports: string;
  readonly cohort: string;
  readonly migrationAgeBand: string;
  readonly cashbackPolicy: string;
  readonly mayhemPolicy: string;
  readonly entryPolicy: string;
  readonly exitPolicy: string;
  readonly capabilityFingerprint: string;
  readonly costModel: string;
  readonly rentTreatment: string;
  readonly counterfactualEvidenceClass: string;

  readonly netPnlLamports: string | null;
  readonly utcDay: string;
  readonly mint: string;
  readonly entityCluster: string | null;
  /** True when an execution cost had to be invented. Disqualifying. */
  readonly usedFallbackExecutionCost: boolean;
}

export interface ContractViolation {
  readonly trajectoryId: string;
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

/**
 * `contractHeld` — every field, not a sample of them.
 *
 * A row that differs from the contract in ANY bound dimension is a different
 * experiment. Checking a subset would let the interesting differences through,
 * because the interesting differences are exactly the ones nobody thought to
 * check.
 */
export function contractHeld(
  contract: ConfirmatoryContract,
  rows: readonly ConfirmatoryTrajectoryRow[],
): { held: boolean; violations: readonly ContractViolation[] } {
  const v: ContractViolation[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const check = (field: string, expected: string, actual: string): void => {
      if (expected !== actual) v.push({ trajectoryId: r.trajectoryId, field, expected, actual });
    };

    // One trajectory, one row.
    if (seen.has(r.trajectoryId)) {
      v.push({
        trajectoryId: r.trajectoryId,
        field: 'trajectoryId',
        expected: 'unique',
        actual: 'duplicated',
      });
    }
    seen.add(r.trajectoryId);

    check('contractId', contract.contractId, r.contractId);
    check('sourceCommit', contract.sourceCommit, r.sourceCommit);
    check('strategyVersion', contract.strategyVersion, r.strategyVersion);
    check('kernelVersion', contract.kernelVersion, r.kernelVersion);
    check('notionalLamports', contract.notionalLamports, r.notionalLamports);
    check('cohort', contract.cohort, r.cohort);
    check('migrationAgeBand', contract.migrationAgeBand, r.migrationAgeBand);
    check('cashbackPolicy', contract.cashbackPolicy, r.cashbackPolicy);
    check('mayhemPolicy', contract.mayhemPolicy, r.mayhemPolicy);
    check('entryPolicy', contract.entryPolicy, r.entryPolicy);
    check('exitPolicy', contract.exitPolicy, r.exitPolicy);
    check('costModel', contract.costModel, r.costModel);
    check('rentTreatment', contract.rentTreatment, r.rentTreatment);
    check('counterfactualEvidenceClass', contract.counterfactualEvidenceClass, r.counterfactualEvidenceClass);

    if (!contract.approvedFingerprints.includes(r.capabilityFingerprint)) {
      v.push({
        trajectoryId: r.trajectoryId,
        field: 'capabilityFingerprint',
        expected: contract.approvedFingerprints.join('|') || '<none approved>',
        actual: r.capabilityFingerprint,
      });
    }

    // No invented execution cost is allowed in confirmatory data.
    if (r.usedFallbackExecutionCost) {
      v.push({
        trajectoryId: r.trajectoryId,
        field: 'usedFallbackExecutionCost',
        expected: 'false',
        actual: 'true',
      });
    }
  }

  return { held: v.length === 0, violations: v };
}

/**
 * Every readiness threshold, frozen as a constant.
 *
 * Read from here and nowhere else. A gate whose threshold came from the data it
 * judges will always pass.
 */
export const READINESS_THRESHOLDS = {
  minCompletedTrajectories: 200,
  minDistinctUtcDays: 21,
  minProfitFactor: 1.25,
  recentWindow: 50,
  dropTopN: [1, 3, 5, 10] as const,
  dropBestMintsOrEntities: 5,
  costStressMultiple: 2,
} as const;

export interface ReadinessInputs {
  readonly contractHeld: boolean;
  readonly completedTrajectories: number;
  readonly distinctUtcDays: number;
  readonly netPnlLamports: bigint | null;
  readonly expectedLogGrowth: number | null;
  readonly robustLowerBound: number | null;
  readonly profitFactor: number | null;
  readonly drawdownBounded: boolean | null;
  readonly cvarAcceptable: boolean | null;
  readonly catastrophicIncidenceAcceptable: boolean | null;
  readonly blockedIncidenceAcceptable: boolean | null;
  readonly recentFiftyPositive: boolean | null;
  readonly positiveWithoutTopN: Readonly<Record<string, boolean | null>>;
  readonly positiveWithoutBestDay: boolean | null;
  readonly positiveWithoutBestFiveMintsOrEntities: boolean | null;
  readonly positiveUnderDoubleCosts: boolean | null;
  readonly positiveUnderLatencyFailureRentCashbackStress: boolean | null;
  readonly positiveExactCanarySizeShadow: boolean | null;
  readonly replayDivergences: number;
  readonly unresolvedReconciliations: number;
  readonly fingerprintsStable: boolean | null;
}

export interface ReadinessGate {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

/**
 * Readiness.
 *
 * An UNKNOWN is a FAIL, never a pass. Most of these inputs are null in a system
 * that has not run long enough, and a gate that treats null as satisfied would
 * report ready fastest when least is known.
 */
export function evaluateReadiness(i: ReadinessInputs): {
  ready: boolean;
  gates: readonly ReadinessGate[];
  failing: readonly string[];
} {
  const gates: ReadinessGate[] = [];
  const g = (name: string, pass: boolean | null, detail: string): void => {
    gates.push({ name, pass: pass === true, detail: pass === null ? `${detail} (UNKNOWN, which is a fail)` : detail });
  };

  g('contract held', i.contractHeld, i.contractHeld ? 'every bound field matches' : 'the frozen contract does not hold');
  g(
    'completed trajectories',
    i.completedTrajectories >= READINESS_THRESHOLDS.minCompletedTrajectories,
    `${i.completedTrajectories} of ${READINESS_THRESHOLDS.minCompletedTrajectories}`,
  );
  g(
    'distinct UTC days',
    i.distinctUtcDays >= READINESS_THRESHOLDS.minDistinctUtcDays,
    `${i.distinctUtcDays} of ${READINESS_THRESHOLDS.minDistinctUtcDays}`,
  );
  g('net PnL positive', i.netPnlLamports === null ? null : i.netPnlLamports > 0n, `${i.netPnlLamports ?? 'unknown'}`);
  g('expected log growth positive', i.expectedLogGrowth === null ? null : i.expectedLogGrowth > 0, `${i.expectedLogGrowth ?? 'unknown'}`);
  g('robust lower bound positive', i.robustLowerBound === null ? null : i.robustLowerBound > 0, `${i.robustLowerBound ?? 'unknown'}`);
  g(
    'profit factor',
    i.profitFactor === null ? null : i.profitFactor >= READINESS_THRESHOLDS.minProfitFactor,
    `${i.profitFactor ?? 'unknown'} vs ${READINESS_THRESHOLDS.minProfitFactor}`,
  );
  g('drawdown bounded', i.drawdownBounded, 'frozen drawdown bound');
  g('CVaR acceptable', i.cvarAcceptable, 'frozen CVaR bound');
  g('catastrophic incidence', i.catastrophicIncidenceAcceptable, 'frozen incidence bound');
  g('blocked incidence', i.blockedIncidenceAcceptable, 'frozen incidence bound');
  g('recent 50 positive', i.recentFiftyPositive, `last ${READINESS_THRESHOLDS.recentWindow}`);
  for (const n of READINESS_THRESHOLDS.dropTopN) {
    g(`positive without top ${n}`, i.positiveWithoutTopN[String(n)] ?? null, `drop the ${n} best trajectories`);
  }
  g('positive without best day', i.positiveWithoutBestDay, 'drop the best UTC day');
  g(
    'positive without best five mints or entities',
    i.positiveWithoutBestFiveMintsOrEntities,
    `drop the best ${READINESS_THRESHOLDS.dropBestMintsOrEntities}`,
  );
  g('positive under 2x costs', i.positiveUnderDoubleCosts, `${READINESS_THRESHOLDS.costStressMultiple}x actual costs`);
  g('positive under stress', i.positiveUnderLatencyFailureRentCashbackStress, 'latency, failure, rent, cashback claim');
  g('positive exact canary-size shadow', i.positiveExactCanarySizeShadow, 'at the exact canary notional');
  g('zero replay divergence', i.replayDivergences === 0, `${i.replayDivergences} divergence(s)`);
  g('zero unresolved reconciliation', i.unresolvedReconciliations === 0, `${i.unresolvedReconciliations} unresolved`);
  g('fingerprints stable', i.fingerprintsStable, 'approved set unchanged over the window');

  const failing = gates.filter((x) => !x.pass).map((x) => x.name);
  return { ready: failing.length === 0, gates, failing };
}
