import { describe, it, expect } from 'vitest';
import {
  createTrajectoryKernel,
  assertSameIdentity,
  IdentitySubstituted,
  type TrajectoryIdentity,
} from '../../packages/pipeline/src/trajectory-kernel.js';
import {
  boundEntryImpact,
  haircutExitValue,
  claimIsSupported,
  weakestGrade,
  atLeast,
  SMALL_IMPACT_BOUND,
} from '../../packages/domain/src/trajectory-evidence.js';
import type { MeasuredLegSettlement } from '../../packages/domain/src/settlement.js';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function costs(over: Record<string, unknown> = {}) {
  return {
    baseFeeLamports: 5_000n,
    priorityFeeLamports: 0n,
    tipLamports: 0n,
    protocolFeeLamports: null,
    creatorFeeLamports: null,
    lpFeeLamports: null,
    platformFeeLamports: 0n,
    transferFeeAtoms: 0n,
    transferFeeLamportsEquivalent: 0n,
    rentCreatedLamports: 0n,
    rentRecoveredLamports: 0n,
    failedAttemptCostLamports: 0n,
    unexplainedLamports: 0n,
    valueToUnnamedAccountsLamports: 0n,
    ...over,
  };
}

/**
 * Built to satisfy the real type, with no forced cast.
 *
 * A cast that has to be pushed past the checker is a cast that has stopped
 * describing the type, and a fixture shaped unlike anything the production code
 * produces generates failures that look like production defects.
 */
function entryLeg(acquired = 1_000_000n): MeasuredLegSettlement {
  const leg: MeasuredLegSettlement = {
    observationId: 'obs-entry',
    simulationJobId: 'job-entry',
    side: 'buy',
    family: 'BUILD_CUSTOM',
    capabilityFingerprint: 'fp',
    input: {
      kind: 'native_sol',
      requestedLamports: 20_000_000n,
      actualTradeDebitLamports: 20_000_000n,
      totalPayerDebitLamports: 20_005_000n,
    },
    output: {
      kind: 'token',
      mint: 'MintAAA',
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenAccount: 'AtaAAA',
      minimumAtoms: 0n,
      expectedAtoms: null,
      actualCreditAtoms: acquired,
    },
    costs: costs({ rentCreatedLamports: 2_039_280n }),
    createdAccounts: [],
    closedAccounts: [],
    residualTokenAtoms: 0n,
    payerNativeDeltaLamports: -20_005_000n,
    fullAccountCoverage: true,
    effectValid: true,
    effectRefusals: [],
    snapshotManifestHash: 'snap-1',
    replayable: true,
    complete: true,
    incompleteness: [],
  };
  return leg;
}

function exitLeg(observationId: string, credit = 21_000_000n): MeasuredLegSettlement {
  const leg: MeasuredLegSettlement = {
    ...entryLeg(),
    observationId,
    simulationJobId: 'job-' + observationId,
    side: 'sell',
    input: {
      kind: 'token',
      mint: 'MintAAA',
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenAccount: 'AtaAAA',
      requestedAtoms: 1_000_000n,
      actualDebitAtoms: 1_000_000n,
    },
    output: { kind: 'native_sol', minimumLamports: 0n, expectedLamports: credit, actualCreditLamports: credit },
    costs: costs({ rentRecoveredLamports: 2_039_280n }),
    residualTokenAtoms: 0n,
    payerNativeDeltaLamports: credit,
  };
  return leg;
}

const IDENTITY: TrajectoryIdentity = {
  trajectoryId: 't-1',
  entryObservationId: 'obs-entry',
  entrySimulationJobId: 'job-entry',
  entrySettlementId: 'set-entry',
  venue: 'PUMPSWAP',
  pool: 'PoolAAA',
  capabilityFingerprint: 'fp',
  snapshotHash: 'snap-1',
  mint: 'MintAAA',
  cohort: 'c1',
  migrationAgeMs: 60_000,
  notionalLamports: 20_000_000n,
  entryPolicyInputs: {},
  stratum: 'CANONICAL_NONCASHBACK',
};

const SMALL_RESERVES = { effectiveQuoteLamports: 100_000_000_000n, baseAtoms: 10_000_000_000_000n };

describe('P4 — one immutable economic identity travels the whole lifecycle', () => {
  it('refuses a substituted entry observation', () => {
    // Substituting an observation into an existing identity is exactly what made
    // a fill mean nothing: a different observation is a different economic
    // event and needs a different identity.
    expect(() => assertSameIdentity(IDENTITY, { ...IDENTITY, entryObservationId: 'obs-other' })).toThrow(
      IdentitySubstituted,
    );
  });

  it('refuses a substituted snapshot, pool or mint', () => {
    for (const patch of [{ snapshotHash: 'x' }, { pool: 'y' }, { mint: 'z' }]) {
      expect(() => assertSameIdentity(IDENTITY, { ...IDENTITY, ...patch })).toThrow(IdentitySubstituted);
    }
  });

  it('accepts the same identity', () => {
    expect(() => assertSameIdentity(IDENTITY, { ...IDENTITY })).not.toThrow();
  });
});

describe('P4 — open decides the evidence ceiling, not the report', () => {
  const kernel = createTrajectoryKernel();

  it('a small entry can reach BOUNDED_COUNTERFACTUAL', () => {
    const r = kernel.open({ identity: IDENTITY, entry: entryLeg(), entryReserves: SMALL_RESERVES });
    expect(r.impact.withinSmallImpactBound).toBe(true);
    expect(r.maximumAttainableGrade).toBe('BOUNDED_COUNTERFACTUAL');
    expect(r.refusals).toEqual([]);
  });

  it('an entry that moves the pool is capped at SIMULATED_EXECUTION forever', () => {
    // A future mainnet state never contained this entry. Deciding the ceiling
    // later is how a weak trajectory gets counted as a strong one once the
    // number looks good.
    const r = kernel.open({
      identity: IDENTITY,
      entry: entryLeg(),
      entryReserves: { effectiveQuoteLamports: 100_000_000n, baseAtoms: 2_000_000n },
    });
    expect(r.impact.withinSmallImpactBound).toBe(false);
    expect(r.maximumAttainableGrade).toBe('SIMULATED_EXECUTION');
    expect(r.refusals.join(' ')).toMatch(/cannot stand in for its counterfactual exit/);
  });

  it('an entry that acquired nothing is abandoned', () => {
    const r = kernel.open({ identity: IDENTITY, entry: entryLeg(0n), entryReserves: SMALL_RESERVES });
    expect(r.state).toBe('ABANDONED');
    expect(r.refusals.join(' ')).toMatch(/acquired no tokens/);
  });
});

describe('P4 — a mark is not a fill', () => {
  const kernel = createTrajectoryKernel();
  const mark = (over = {}) => ({
    observationId: 'obs-2',
    atMs: 1_000,
    executableLamports: 21_000_000n,
    source: 'DIRECT_POOL' as const,
    routeAvailable: true,
    refusalReason: null,
    ...over,
  });

  it('accepts a priced mark', () => {
    expect(kernel.observeMark({ identity: IDENTITY, mark: mark() }).accepted).toBe(true);
  });

  it('rejects an unpriced mark and keeps the reason', () => {
    const r = kernel.observeMark({
      identity: IDENTITY,
      mark: mark({ routeAvailable: false, refusalReason: 'pool drained: base 0, quote 0' }),
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/pool drained/);
  });

  it('refuses a mark that reuses the entry observation', () => {
    const r = kernel.observeMark({ identity: IDENTITY, mark: mark({ observationId: 'obs-entry' }) });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/may not reuse the entry observation/);
  });

  it('refuses a mark that prices the position at zero', () => {
    expect(kernel.observeMark({ identity: IDENTITY, mark: mark({ executableLamports: 0n }) }).accepted).toBe(false);
  });
});

describe('P4 — never select A, simulate B, book A', () => {
  const kernel = createTrajectoryKernel();

  it('books the settlement OF THE OBSERVATION IT SELECTED', () => {
    // The directive's own scenario: A fails, B is valid, C is better. B is the
    // first valid candidate past the latency floor, so B is what is booked —
    // and the exit must be B's OWN settlement, not C's price.
    const r = kernel.advance({
      identity: IDENTITY,
      state: 'AWAITING_FILL_OBSERVATION',
      triggeredAtMs: 0,
      minimumFillLatencyMs: 400,
      settledCandidates: [
        { observationId: 'A', atMs: 500, settlement: exitLeg('A', 1n), executable: false },
        { observationId: 'B', atMs: 600, settlement: exitLeg('B', 21_000_000n), executable: true },
        { observationId: 'C', atMs: 900, settlement: exitLeg('C', 99_000_000n), executable: true },
      ],
    });
    expect(r.selectedObservationId).toBe('B');
    expect(r.exit?.observationId).toBe('B');
    expect(r.state).toBe('SETTLED');
  });

  it('ignores candidates inside the latency floor', () => {
    const r = kernel.advance({
      identity: IDENTITY,
      state: 'AWAITING_FILL_OBSERVATION',
      triggeredAtMs: 0,
      minimumFillLatencyMs: 400,
      settledCandidates: [{ observationId: 'TOO_SOON', atMs: 100, settlement: exitLeg('TOO_SOON'), executable: true }],
    });
    expect(r.selectedObservationId).toBeNull();
    expect(r.reason).toMatch(/latency floor/);
  });

  it('waits rather than inventing a fill when nothing has settled', () => {
    const r = kernel.advance({
      identity: IDENTITY,
      state: 'AWAITING_FILL_OBSERVATION',
      triggeredAtMs: 0,
      minimumFillLatencyMs: 400,
      settledCandidates: [],
    });
    expect(r.state).toBe('AWAITING_FILL_OBSERVATION');
    expect(r.exit).toBeNull();
    expect(r.reason).toMatch(/no later observation has been settled/);
  });
});

describe('P4 — settle applies the counterfactual haircut only where it belongs', () => {
  const kernel = createTrajectoryKernel();
  const open = kernel.open({ identity: IDENTITY, entry: entryLeg(), entryReserves: SMALL_RESERVES });

  it('haircuts a bounded counterfactual exit', () => {
    const s = kernel.settle({
      identity: IDENTITY,
      entry: entryLeg(),
      exit: exitLeg('B'),
      impact: open.impact,
      evidenceGrade: 'BOUNDED_COUNTERFACTUAL',
    });
    expect(s.haircutExitCashInLamports).not.toBeNull();
    expect(s.haircutExitCashInLamports as bigint).toBeLessThan(s.settlement.exitCashInLamports as bigint);
  });

  it('does NOT haircut a landed fill, whose price already contains the entry', () => {
    const s = kernel.settle({
      identity: IDENTITY,
      entry: entryLeg(),
      exit: exitLeg('B'),
      impact: open.impact,
      evidenceGrade: 'LANDED_MAINNET',
    });
    expect(s.haircutExitCashInLamports).toBeNull();
  });

  it('satisfies the settlement identities', () => {
    const s = kernel.settle({
      identity: IDENTITY,
      entry: entryLeg(),
      exit: exitLeg('B'),
      impact: open.impact,
      evidenceGrade: 'BOUNDED_COUNTERFACTUAL',
    });
    expect(s.identityViolations).toEqual([]);
  });
});

describe('P1 — evidence grades are ordered and take their weakest member', () => {
  it('a set is graded by its weakest member', () => {
    // Taking the strongest is how one landed fill launders a hundred synthetic
    // ones into "mainnet evidence".
    expect(weakestGrade(['LANDED_MAINNET', 'SYNTHETIC', 'FULL_EVENT_REPLAY'])).toBe('SYNTHETIC');
  });

  it('orders the grades', () => {
    expect(atLeast('LANDED_MAINNET', 'BOUNDED_COUNTERFACTUAL')).toBe(true);
    expect(atLeast('OBSERVED_PRICE', 'SIMULATED_EXECUTION')).toBe(false);
  });

  it('refuses CANARY_READY on development evidence', () => {
    const r = claimIsSupported('CANARY_READY', ['BOUNDED_COUNTERFACTUAL', 'BOUNDED_COUNTERFACTUAL']);
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/below the required FULL_EVENT_REPLAY/);
  });

  it('refuses any claim with no evidence at all', () => {
    expect(claimIsSupported('DEVELOPMENT_EDGE_CANDIDATE', []).supported).toBe(false);
  });

  it('supports MEASUREMENT_REPAIR_REQUIRED on anything, since it claims nothing', () => {
    expect(claimIsSupported('MEASUREMENT_REPAIR_REQUIRED', ['SYNTHETIC']).supported).toBe(true);
  });
});

describe('P8 — the entry impact bound', () => {
  it('measures impact against both reserves and takes the larger', () => {
    const b = boundEntryImpact({
      entryQuoteInLamports: 1_000n,
      effectiveQuoteReserveLamports: 1_000_000n,
      tokensAcquiredAtoms: 50_000n,
      baseReserveAtoms: 1_000_000n,
    });
    expect(b.quoteImpactRatio).toBeCloseTo(0.001, 6);
    expect(b.baseImpactRatio).toBeCloseTo(0.05, 6);
    expect(b.maxImpactRatio).toBeCloseTo(0.05, 6);
    expect(b.withinSmallImpactBound).toBe(false);
  });

  it('treats a zero reserve as infinite impact rather than as a divide by zero', () => {
    const b = boundEntryImpact({
      entryQuoteInLamports: 1n,
      effectiveQuoteReserveLamports: 0n,
      tokensAcquiredAtoms: 1n,
      baseReserveAtoms: 1_000n,
    });
    expect(b.withinSmallImpactBound).toBe(false);
    expect(b.haircutBps).toBe(10_000);
  });

  it('never crosses Number with a u64 before reducing it to a ratio', () => {
    const b = boundEntryImpact({
      entryQuoteInLamports: 9_007_199_254_740_993n,
      effectiveQuoteReserveLamports: 9_007_199_254_740_993_000n,
      tokensAcquiredAtoms: 1n,
      baseReserveAtoms: 1_000_000_000n,
    });
    expect(b.quoteImpactRatio).toBeCloseTo(0.001, 6);
  });

  it('the haircut only ever reduces value', () => {
    expect(haircutExitValue(1_000_000n, 200)).toBe(980_000n);
    expect(haircutExitValue(1_000_000n, 0)).toBe(1_000_000n);
    // A nonsensical haircut cannot increase the value.
    expect(haircutExitValue(1_000_000n, -50)).toBe(1_000_000n);
    expect(haircutExitValue(1_000_000n, 99_999)).toBe(0n);
  });

  it('the small-impact bound is frozen at 50 bps', () => {
    expect(SMALL_IMPACT_BOUND).toBe(0.005);
  });
});
