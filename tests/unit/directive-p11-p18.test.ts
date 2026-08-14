import { describe, it, expect } from 'vitest';
import {
  assignCohort,
  cohortRelativeRank,
  coverageVerdict,
  eligibilitySuppressed,
  allocationPriority,
  assertNoCrossCohortRawComparison,
  CrossCohortComparison,
  MIGRATION_AGE_BANDS,
} from '../../packages/strategy/src/cohort-comparability.js';
import {
  assertFactsPrecedeSelection,
  FactCollectedTooLate,
  mayhemBreadth,
  entityAdjustedConcentration,
  concentrationGate,
  transferFeeState,
} from '../../packages/intelligence/src/risk-facts-order.js';
import {
  capabilityFingerprint,
  approveFingerprint,
  assertConfigUsableForHistorical,
  ConfigBytesAnachronism,
  landedParityCoverage,
} from '../../packages/research/src/capability-fingerprint.js';
import {
  contractHeld,
  evaluateReadiness,
  READINESS_THRESHOLDS,
  type ConfirmatoryContract,
  type ConfirmatoryTrajectoryRow,
} from '../../packages/research/src/confirmatory-trajectories.js';
import { buildBottleneckReport, infrastructurePurchaseAllowed } from '../../packages/research/src/bottleneck.js';
import {
  shouldSampleRejection,
  classifyRejection,
  falseNegativeRate,
  tallyOutcomes,
  assertPanelNotReused,
  PanelVersionReused,
} from '../../packages/research/src/reject-panel.js';

const DIMS = {
  venueProgramId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  programDataHash: 'aaa',
  poolLayoutVersion: 'v1',
  instructionDiscriminator: 'e992d18ecf6840bc',
  feeConfigHash: 'fee1',
  cashbackFlag: false,
  cashbackAccountsPresent: false,
  mayhemFlag: false,
  baseTokenProgram: 'Tokenkeg',
  quoteTokenProgram: 'Tokenkeg',
  tokenExtensions: [] as string[],
  quoteMint: 'So111',
  builderVersion: 'sdk-1.1',
  runtimeVersion: 'litesvm-0.6.1',
};

describe('P11 — cohorts and scores are comparable, or not compared', () => {
  it('assigns on a named clock and refuses when that clock is unknown', () => {
    expect(assignCohort({ tokenAgeMs: 1, timeSinceMigrationMs: 60_000, timeSinceCurrentPoolCreationMs: null, mayhemElapsedMs: null }).cohort).toBe('FIRST_HOUR');
    const none = assignCohort({ tokenAgeMs: 999, timeSinceMigrationMs: null, timeSinceCurrentPoolCreationMs: null, mayhemElapsedMs: null });
    // Not defaulted to OLDER: a token assigned by absence would be scored
    // against a population it may not belong to.
    expect(none.cohort).toBeNull();
    expect(none.reason).toMatch(/unknown/);
  });

  it('keeps token age, migration age, pool age and Mayhem elapsed as separate clocks', () => {
    expect(MIGRATION_AGE_BANDS.every((b) => b.clock === 'timeSinceMigrationMs')).toBe(true);
    // A week-old token that migrated a minute ago is FIRST_HOUR on the clock
    // that matters, and collapsing the clocks would call it OLDER.
    const a = assignCohort({ tokenAgeMs: 604_800_000, timeSinceMigrationMs: 60_000, timeSinceCurrentPoolCreationMs: 60_000, mayhemElapsedMs: null });
    expect(a.cohort).toBe('FIRST_HOUR');
  });

  it('REFUSES a raw cross-cohort comparison', () => {
    expect(() =>
      assertNoCrossCohortRawComparison('firstHourFreshness', [{ cohort: 'FIRST_HOUR' }, { cohort: 'OLDER' }]),
    ).toThrow(CrossCohortComparison);
  });

  it('a cohort-relative rank makes a constant feature say "I do not discriminate"', () => {
    // Every value equal → 0.5 for all, rather than an invented order.
    expect(cohortRelativeRank([5, 5, 5, 5])).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('ranks within cohort and carries nulls through as nulls', () => {
    const r = cohortRelativeRank([1, null, 3, 2]);
    expect(r[1]).toBeNull();
    expect(r[0] as number).toBeLessThan(r[3] as number);
    expect(r[3] as number).toBeLessThan(r[2] as number);
  });

  it('a low-coverage score is never silently an ordinary score', () => {
    expect(coverageVerdict({ featuresPresent: 2, featuresRequired: 9, lowCoverageStratumEnabled: false }).verdict).toBe('NOT_ELIGIBLE');
    expect(coverageVerdict({ featuresPresent: 2, featuresRequired: 9, lowCoverageStratumEnabled: true }).verdict).toBe('LOW_COVERAGE_STRATUM');
    expect(coverageVerdict({ featuresPresent: 9, featuresRequired: 9, lowCoverageStratumEnabled: false }).verdict).toBe('ELIGIBLE');
  });

  it('a rejection in one cohort does not suppress eligibility in another', () => {
    const other = eligibilitySuppressed({ priorRejections: [{ cohort: 'FIRST_HOUR', utcMs: 1 }], currentCohort: 'FIRST_DAY' });
    expect(other.suppressed).toBe(false);
    const same = eligibilitySuppressed({ priorRejections: [{ cohort: 'FIRST_DAY', utcMs: 1 }], currentCohort: 'FIRST_DAY' });
    expect(same.suppressed).toBe(true);
  });

  it('allocates to the LEAST complete cell first', () => {
    const cells = [
      { cohort: 'FIRST_HOUR' as const, cashback: false, mayhem: false, feeTierBps: 250, completed: 40 },
      { cohort: 'FIRST_DAY' as const, cashback: true, mayhem: false, feeTierBps: 60, completed: 0 },
    ];
    expect(allocationPriority(cells)[0]?.completed).toBe(0);
  });
});

describe('P12 — risk facts precede the decision they affect', () => {
  it('refuses when a fact was collected after quote selection', () => {
    expect(() =>
      assertFactsPrecedeSelection(
        [
          { kind: 'MINT', collectedAtMs: 100, available: true },
          { kind: 'ENTITY', collectedAtMs: 300, available: true },
        ],
        200,
      ),
    ).toThrow(FactCollectedTooLate);
  });

  it('an unavailable fact is late, not absent', () => {
    expect(() =>
      assertFactsPrecedeSelection([{ kind: 'MAYHEM', collectedAtMs: null, available: false }], 200),
    ).toThrow(/MAYHEM/);
  });

  it('Mayhem breadth is CONTAMINATED, never zero and never organic', () => {
    const r = mayhemBreadth({ uniqueBuyers: 40, agentWalletsKnown: true, agentFlowFullyIsolatable: false, excludedAgentFlow: 0 });
    expect(r.kind).toBe('CONTAMINATED_UNUSABLE');
  });

  it('incomplete entity history fails the concentration gate rather than passing it', () => {
    // An incomplete history can only UNDERSTATE clustering, so passing on it
    // would pass exactly the tokens we know least about.
    const v = entityAdjustedConcentration({
      histories: [{ reachedEarliestSignature: false, pagesWalked: 1, links: [] }],
      clusteredShare: 0.1,
    });
    expect(v.kind).toBe('HISTORY_INCOMPLETE');
    expect(concentrationGate(v, 0.35).pass).toBe(false);
  });

  it('a complete history passes or fails on the number', () => {
    const v = entityAdjustedConcentration({
      histories: [{ reachedEarliestSignature: true, pagesWalked: 25, links: ['COMMON_INITIAL_FUNDER'] }],
      clusteredShare: 0.2,
    });
    expect(concentrationGate(v, 0.35).pass).toBe(true);
    expect(concentrationGate(v, 0.1).pass).toBe(false);
  });

  it('a Token-2022 mint with no fee extension is NOT_APPLICABLE, not unmeasured', () => {
    const s = transferFeeState({
      isToken2022: true,
      extensionsDecoded: true,
      hasTransferFeeExtension: false,
      currentBps: null,
      futureBps: null,
      withheldAtoms: null,
    });
    // Rejecting every Token-2022 mint for a fee not observed in a leg discards
    // a class of tokens for a fact about the leg.
    expect(s.kind).toBe('NOT_APPLICABLE');
  });

  it('undecoded extensions are UNMEASURED, which is not the same as none', () => {
    const s = transferFeeState({
      isToken2022: true,
      extensionsDecoded: false,
      hasTransferFeeExtension: false,
      currentBps: null,
      futureBps: null,
      withheldAtoms: null,
    });
    expect(s.kind).toBe('UNMEASURED');
  });
});

describe('P16 — the fingerprint binds what it claims to bind', () => {
  it('changes when ANY bound dimension changes', () => {
    const base = capabilityFingerprint(DIMS);
    for (const patch of [
      { feeConfigHash: 'fee2' },
      { cashbackFlag: true },
      { mayhemFlag: true },
      { baseTokenProgram: 'Token2022' },
      { tokenExtensions: ['transferHook'] },
      { builderVersion: 'sdk-1.2' },
      { runtimeVersion: 'litesvm-0.7.0' },
      { programDataHash: 'bbb' },
    ]) {
      expect(capabilityFingerprint({ ...DIMS, ...patch })).not.toBe(base);
    }
  });

  it('an absent dimension hashes differently from a present one', () => {
    expect(capabilityFingerprint({ ...DIMS, feeConfigHash: null })).not.toBe(capabilityFingerprint(DIMS));
  });

  it('is stable under token extension ordering', () => {
    const a = capabilityFingerprint({ ...DIMS, tokenExtensions: ['a', 'b'] });
    const b = capabilityFingerprint({ ...DIMS, tokenExtensions: ['b', 'a'] });
    expect(a).toBe(b);
  });

  it('refuses approval when a parity check never ran', () => {
    const d = approveFingerprint('fp', [{ check: 'OFFICIAL_SDK_QUOTE', agreed: true, note: null }], {
      landedAttributionIsolatable: false,
    });
    expect(d.approved).toBe(false);
    expect(d.missing.length).toBeGreaterThan(0);
  });

  it('approves a narrow fingerprint when every applicable check agrees', () => {
    const d = approveFingerprint(
      'fp',
      [
        { check: 'OFFICIAL_SDK_QUOTE', agreed: true, note: null },
        { check: 'EPITAXY_LOCAL_QUOTE', agreed: true, note: null },
        { check: 'DIRECT_INSTRUCTION_SIMULATION', agreed: true, note: null },
        { check: 'SEQUENTIAL_RUNTIME_EFFECT', agreed: true, note: null },
      ],
      // Landed attribution is not isolatable through an aggregator, and
      // pretending it is would be worse than not having the check.
      { landedAttributionIsolatable: false },
    );
    expect(d.approved).toBe(true);
  });

  it('refuses current config bytes for a historical transaction', () => {
    expect(() =>
      assertConfigUsableForHistorical({
        what: 'fee config',
        currentConfigHash: 'now',
        configHashAtTransaction: 'then',
        configIncludedInEvidence: false,
      }),
    ).toThrow(ConfigBytesAnachronism);
  });

  it('allows them when the hash is proven unchanged', () => {
    expect(() =>
      assertConfigUsableForHistorical({
        what: 'fee config',
        currentConfigHash: 'same',
        configHashAtTransaction: 'same',
        configIncludedInEvidence: false,
      }),
    ).not.toThrow();
  });

  it('names every uncovered landed-parity dimension', () => {
    const c = landedParityCoverage(['buy', 'sell']);
    expect(c.complete).toBe(false);
    expect(c.missing).toContain('token_2022');
    expect(c.missing).toContain('cashback');
  });
});

describe('P18 — the frozen contract, and readiness that reads only it', () => {
  const contract: ConfirmatoryContract = {
    contractId: 'c1',
    frozenAtUtcMs: 1,
    sourceCommit: 'abc',
    strategyVersion: 's1',
    kernelVersion: 'k1',
    notionalLamports: '20000000',
    cohort: 'FIRST_HOUR',
    migrationAgeBand: 'FIRST_HOUR',
    cashbackPolicy: 'NONE',
    mayhemPolicy: 'EXCLUDE',
    entryPolicy: 'HARD_GATES_RANDOM',
    exitPolicy: 'FIXED_15M_CONTROL',
    approvedFingerprints: ['fp1'],
    costModel: 'measured',
    rentTreatment: 'unrecovered_is_cost',
    counterfactualEvidenceClass: 'SIMULATED_EXECUTION',
  };
  const row = (over: Partial<ConfirmatoryTrajectoryRow> = {}): ConfirmatoryTrajectoryRow => ({
    trajectoryId: 't1',
    entryObservationId: 'o1',
    entrySimulationJobId: 'j1',
    entrySettlementId: 's1',
    exitObservationId: 'o2',
    exitSimulationJobId: 'j2',
    exitSettlementId: 's2',
    contractId: 'c1',
    sourceCommit: 'abc',
    strategyVersion: 's1',
    kernelVersion: 'k1',
    notionalLamports: '20000000',
    cohort: 'FIRST_HOUR',
    migrationAgeBand: 'FIRST_HOUR',
    cashbackPolicy: 'NONE',
    mayhemPolicy: 'EXCLUDE',
    entryPolicy: 'HARD_GATES_RANDOM',
    exitPolicy: 'FIXED_15M_CONTROL',
    capabilityFingerprint: 'fp1',
    costModel: 'measured',
    rentTreatment: 'unrecovered_is_cost',
    counterfactualEvidenceClass: 'SIMULATED_EXECUTION',
    netPnlLamports: '100',
    utcDay: '2026-08-14',
    mint: 'M',
    entityCluster: null,
    usedFallbackExecutionCost: false,
    ...over,
  });

  it('holds when every bound field matches', () => {
    expect(contractHeld(contract, [row()]).held).toBe(true);
  });

  it('fails on ANY bound field, not a sampled subset', () => {
    for (const patch of [
      { sourceCommit: 'other' },
      { strategyVersion: 'other' },
      { kernelVersion: 'other' },
      { notionalLamports: '1' },
      { entryPolicy: 'other' },
      { exitPolicy: 'other' },
      { costModel: 'other' },
      { rentTreatment: 'other' },
      { counterfactualEvidenceClass: 'other' },
      { capabilityFingerprint: 'unapproved' },
    ]) {
      expect(contractHeld(contract, [row(patch)]).held).toBe(false);
    }
  });

  it('refuses a duplicated trajectory: one trajectory, one row', () => {
    const r = contractHeld(contract, [row(), row()]);
    expect(r.held).toBe(false);
    expect(r.violations.some((v) => v.actual === 'duplicated')).toBe(true);
  });

  it('refuses an invented execution cost', () => {
    expect(contractHeld(contract, [row({ usedFallbackExecutionCost: true })]).held).toBe(false);
  });

  it('readiness treats every UNKNOWN as a FAIL', () => {
    const r = evaluateReadiness({
      contractHeld: true,
      completedTrajectories: 1_000,
      distinctUtcDays: 40,
      netPnlLamports: 1n,
      expectedLogGrowth: null,
      robustLowerBound: null,
      profitFactor: null,
      drawdownBounded: null,
      cvarAcceptable: null,
      catastrophicIncidenceAcceptable: null,
      blockedIncidenceAcceptable: null,
      recentFiftyPositive: null,
      positiveWithoutTopN: {},
      positiveWithoutBestDay: null,
      positiveWithoutBestFiveMintsOrEntities: null,
      positiveUnderDoubleCosts: null,
      positiveUnderLatencyFailureRentCashbackStress: null,
      positiveExactCanarySizeShadow: null,
      replayDivergences: 0,
      unresolvedReconciliations: 0,
      fingerprintsStable: null,
    });
    // A gate that treated null as satisfied would report ready fastest when
    // least is known.
    expect(r.ready).toBe(false);
    expect(r.failing.length).toBeGreaterThan(5);
  });

  it('the thresholds are constants here, not supplied by evidence', () => {
    expect(READINESS_THRESHOLDS.minCompletedTrajectories).toBe(200);
    expect(READINESS_THRESHOLDS.minDistinctUtcDays).toBe(21);
    expect(READINESS_THRESHOLDS.minProfitFactor).toBe(1.25);
  });
});

describe('P17 — the bottleneck is measured on ACTIVE time', () => {
  const base = {
    time: { activeSeconds: 1_200, wallSeconds: 86_400 },
    resources: [{ kind: 'jupiter_build' as const, detail: null, count: 600, errors429: 0, quotaErrors: 0 }],
    throughput: {
      completedTrajectories: 20,
      candidatesConsidered: 1_200,
      candidatesWithCanonicalPool: 20,
      candidatesWithCashbackPool: 6,
      apparatusFailures: 3,
      duplicateObservations: 0,
      workerBusySeconds: 300,
    },
    latency: { queueLagMs: [10, 20, 400], markLagMs: [5, 9], triggerToFillMs: [900, 1_100] },
  };

  it('divides by active seconds, not wall seconds', () => {
    const r = buildBottleneckReport(base);
    // 600 builds over 1,200 ACTIVE seconds is 0.5/s. Over the 86,400 wall
    // seconds it would read 0.007/s and look like nothing.
    expect(r.perResourcePerActiveSecond['jupiter_build']).toBeCloseTo(0.5, 6);
  });

  it('names a low duty cycle rather than letting it masquerade as low load', () => {
    const r = buildBottleneckReport(base);
    expect(r.dutyCycle).toBeCloseTo(1_200 / 86_400, 6);
    expect(r.notes.join(' ')).toMatch(/duty cycle/);
  });

  it('counts a label as one completed TRAJECTORY', () => {
    const r = buildBottleneckReport(base);
    expect(r.validTrajectoriesPerCandidate).toBeCloseTo(20 / 1_200, 6);
    expect(r.canonicalPoolYield).toBeCloseTo(20 / 1_200, 6);
  });

  it('says rate capacity is not the constraint when it clearly is not', () => {
    // 0.5/s against a 5/s limit is 10% utilisation. A limit of 1/s would put
    // this at exactly the 50% boundary, where the report correctly declines to
    // call it either way.
    const r = buildBottleneckReport({ ...base, limitsPerActiveSecond: { jupiter_build: 5 } });
    expect(r.bindingConstraint).toMatch(/jupiter_build/);
    expect(r.notes.join(' ')).toMatch(/NOT the constraint/);
  });

  it('does NOT claim spare capacity at the boundary', () => {
    const r = buildBottleneckReport({ ...base, limitsPerActiveSecond: { jupiter_build: 1 } });
    expect(r.bindingConstraint).toMatch(/50.0%/);
    expect(r.notes.join(' ')).not.toMatch(/NOT the constraint/);
  });

  it('reports null rather than zero when there is no active time', () => {
    const r = buildBottleneckReport({ ...base, time: { activeSeconds: 0, wallSeconds: 100 } });
    expect(r.validTrajectoriesPerDay).toBeNull();
    expect(r.workerUtilization).toBeNull();
  });

  it('forbids buying infrastructure before a positive untouched edge exists', () => {
    const d = infrastructurePurchaseAllowed({
      item: 'shreds',
      positiveUntouchedEdgeExists: false,
      bindingConstraintIsThisResource: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/loses faster/);
  });

  it('forbids buying what is not the binding constraint', () => {
    expect(
      infrastructurePurchaseAllowed({
        item: 'jupiter_developer',
        positiveUntouchedEdgeExists: true,
        bindingConstraintIsThisResource: false,
      }).allowed,
    ).toBe(false);
  });
});

describe('P15 — the reject panel is prospective', () => {
  it('samples deterministically and independently per rejection time', () => {
    const a = shouldSampleRejection('seed', 'MintA', 1_000, 0.5);
    expect(shouldSampleRejection('seed', 'MintA', 1_000, 0.5)).toBe(a);
    // Two rejections of the same mint get independent draws, so repeats do not
    // systematically appear or vanish together.
    const draws = Array.from({ length: 40 }, (_, i) => shouldSampleRejection('seed', 'MintA', i, 0.5));
    expect(new Set(draws).size).toBe(2);
  });

  it('classifies apparatus failure BEFORE any market outcome', () => {
    const r = classifyRejection({
      sampleId: 's',
      marks: [],
      laterFillable: null,
      fixedHorizonExecutableLamports: 99_000_000n,
      entryCostLamports: 1n,
      apparatusFailed: true,
      providerGap: false,
      supportedVenueExists: true,
      exitBlocked: false,
    });
    // Even with a spectacular apparent profit, our own failure is not a market
    // outcome.
    expect(r.outcome).toBe('APPARATUS_FAILURE');
  });

  it('says NO_SUPPORTED_VENUE rather than "no route"', () => {
    const r = classifyRejection({
      sampleId: 's',
      marks: [],
      laterFillable: null,
      fixedHorizonExecutableLamports: null,
      entryCostLamports: null,
      apparatusFailed: false,
      providerGap: false,
      supportedVenueExists: false,
      exitBlocked: false,
    });
    expect(r.outcome).toBe('NO_SUPPORTED_VENUE');
    expect(r.reason).toMatch(/venues WE support/);
  });

  it('separates catastrophic from ordinary losses', () => {
    const cat = classifyRejection({
      sampleId: 's',
      marks: [],
      laterFillable: true,
      fixedHorizonExecutableLamports: 100n,
      entryCostLamports: 20_000n,
      apparatusFailed: false,
      providerGap: false,
      supportedVenueExists: true,
      exitBlocked: false,
    });
    expect(cat.outcome).toBe('CATASTROPHIC');
  });

  it('excludes unanswerable rows from the false-negative denominator', () => {
    // Counting them as correct rejections makes a gate look better the more
    // often the instrument breaks.
    const t = tallyOutcomes([
      'PROFITABLE_EXECUTABLE',
      'UNPROFITABLE_EXECUTABLE',
      'APPARATUS_FAILURE',
      'NO_SUPPORTED_VENUE',
      'PROVIDER_GAP',
    ]);
    const r = falseNegativeRate(t);
    expect(r.answerable).toBe(2);
    expect(r.excluded).toBe(3);
    expect(r.rate).toBeCloseTo(0.5, 6);
  });

  it('refuses to report a gate on the panel version it was tuned on', () => {
    expect(() => assertPanelNotReused('v3', 'v3')).toThrow(PanelVersionReused);
    expect(() => assertPanelNotReused('v3', 'v4')).not.toThrow();
  });
});
