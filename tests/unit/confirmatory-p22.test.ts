import { describe, it, expect } from 'vitest';
import {
  checkFreeze,
  contractHeld,
  judgeConfirmatory,
  CONFIRMATORY_THRESHOLDS,
  type FrozenConfirmatoryContract,
  type ConfirmatoryEvidence,
} from '../../packages/domain/src/confirmatory.js';
import { bondingCurveAddresses } from '../../packages/solana/src/mayhem.js';

/**
 * P22 — the confirmatory window.
 *
 * A development tournament picks an arm by looking at results; that is what it
 * is for, and it is why its number cannot be an estimate. The confirmatory
 * window asks once, of an untouched sample, with everything fixed first.
 *
 * These tests exist to make weakening a failed gate a visible act. The
 * thresholds are constants with no configuration path, so the only way to pass
 * a window that failed is to edit a line a reviewer will see.
 */

const FROZEN: FrozenConfirmatoryContract = {
  routeFamilies: ['BUILD_CUSTOM'],
  capabilityFingerprints: ['pumpswap-t22-wsol'],
  directBuilder: 'pumpswap-official-sdk',
  fallbackBuilder: null,
  notionalLamports: 10_000_000n,
  cohort: 'AGE_2M_60M',
  migrationAgeBand: 'POST_MIGRATION',
  mayhemPolicy: 'EXCLUDE',
  entryPolicy: 'CORRECTED_CURRENT_QUALITY_SCORE',
  exitPolicy: 'FIXED_TIME_CONTROL',
  fillLatencyMs: 1_200,
  costModel: 'measured-settlement-v1',
  rentTreatment: 'exemption-only, excess reported separately',
  riskFacts: ['direct_mint_facts', 'entity_concentration'],
  strategyVersion: 'delayed-momentum-v0.6.0',
  sourceCommit: 'abc1234',
  frozenUtcMs: 1_760_000_000_000,
};

const PASSING: ConfirmatoryEvidence = {
  completedPositions: 210,
  distinctUtcDays: 24,
  netPnlLamports: 50_000_000n,
  expectedLogGrowth: 0.02,
  robustLowerBound: 0.004,
  profitFactor: 1.4,
  maxDrawdownBps: 800,
  cvarBps: 900,
  catastrophicIncidence: 0.01,
  blockedExitIncidence: 0.05,
  recentFiftyNetLamports: 8_000_000n,
  netWithoutTopThreeLamports: 20_000_000n,
  maxSingleDayShare: 0.2,
  maxSingleMintShare: 0.25,
  netUnderDoubleCostsLamports: 12_000_000n,
  netUnderLatencyStressLamports: 9_000_000n,
  exactCanarySizeShadowNetLamports: 3_000_000n,
  replayDivergences: 0,
  unresolvedReconciliations: 0,
  fingerprintsStable: true,
  maxDrawdownBpsAllowed: 1_500,
  maxCvarBpsAllowed: 1_500,
  maxCatastrophicIncidence: 0.05,
  maxBlockedExitIncidence: 0.2,
};

describe('P22 — the freeze is complete or it is not a freeze', () => {
  it('accepts a fully specified contract', () => {
    expect(checkFreeze(FROZEN).frozen).toBe(true);
  });

  it('refuses a contract missing any required field', () => {
    for (const key of Object.keys(FROZEN) as (keyof FrozenConfirmatoryContract)[]) {
      if (key === 'fallbackBuilder') continue; // the one field allowed to be null
      const partial = { ...FROZEN };
      delete (partial as Record<string, unknown>)[key];
      const r = checkFreeze(partial);
      expect(r.frozen, `${key} should be required`).toBe(false);
      expect(r.missing).toContain(key);
    }
  });

  it('allows a null fallback builder, because "none" is a decision', () => {
    expect(checkFreeze({ ...FROZEN, fallbackBuilder: null }).frozen).toBe(true);
  });

  it('refuses an EMPTY route family list, which admits everything', () => {
    const r = checkFreeze({ ...FROZEN, routeFamilies: [] });
    expect(r.frozen).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/admits everything/);
  });

  it('refuses a notional nobody could deploy', () => {
    expect(checkFreeze({ ...FROZEN, notionalLamports: 0n }).frozen).toBe(false);
  });

  it('refuses a contract that cannot name its commit', () => {
    // Without it the window cannot be re-derived, and a window that cannot be
    // re-derived is an anecdote.
    expect(checkFreeze({ ...FROZEN, sourceCommit: 'not-a-commit' }).frozen).toBe(false);
  });
});

describe('P22 — drift from the frozen contract invalidates the window', () => {
  const observed = {
    routeFamilies: ['BUILD_CUSTOM'],
    notionalLamports: 10_000_000n,
    cohorts: ['AGE_2M_60M'],
    entryPolicies: ['CORRECTED_CURRENT_QUALITY_SCORE'],
    exitPolicies: ['FIXED_TIME_CONTROL'],
    strategyVersions: ['delayed-momentum-v0.6.0'],
    fillLatencyMs: 1_200,
  };

  it('holds when nothing moved', () => {
    expect(contractHeld(FROZEN, observed).held).toBe(true);
  });

  it('catches a notional that changed partway through', () => {
    // Two experiments sharing a name, and the second saw the first's results.
    const r = contractHeld(FROZEN, { ...observed, notionalLamports: 20_000_000n });
    expect(r.held).toBe(false);
    expect(r.drift.join(' ')).toMatch(/notional/);
  });

  it('catches a route family that was never frozen', () => {
    const r = contractHeld(FROZEN, { ...observed, routeFamilies: ['BUILD_CUSTOM', 'ORDER'] });
    expect(r.held).toBe(false);
  });

  it('catches more than one exit policy', () => {
    const r = contractHeld(FROZEN, { ...observed, exitPolicies: ['FIXED_TIME_CONTROL', 'FLOW_DETERIORATION_V1'] });
    expect(r.held).toBe(false);
  });

  it('catches a strategy version change mid-window', () => {
    const r = contractHeld(FROZEN, { ...observed, strategyVersions: ['delayed-momentum-v0.6.0', 'v0.7.0'] });
    expect(r.held).toBe(false);
  });

  it('catches a fill latency that was retuned', () => {
    const r = contractHeld(FROZEN, { ...observed, fillLatencyMs: 400 });
    expect(r.held).toBe(false);
  });
});

describe('P22 — the gate, one condition at a time', () => {
  it('passes a window that clears everything', () => {
    const v = judgeConfirmatory(PASSING);
    expect(v.passed).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('refuses 199 positions', () => {
    const v = judgeConfirmatory({ ...PASSING, completedPositions: 199 });
    expect(v.passed).toBe(false);
    expect(v.sufficientSample).toBe(false);
  });

  it('refuses 20 distinct days however many positions', () => {
    // 200 positions in a fortnight is a fortnight, not a sample of regimes.
    expect(judgeConfirmatory({ ...PASSING, distinctUtcDays: 20, completedPositions: 900 }).passed).toBe(false);
  });

  const cases: [string, Partial<ConfirmatoryEvidence>][] = [
    ['net PnL not positive', { netPnlLamports: 0n }],
    ['expected log growth not positive', { expectedLogGrowth: 0 }],
    ['robust lower bound not positive', { robustLowerBound: -0.001 }],
    ['profit factor below 1.25', { profitFactor: 1.24 }],
    ['drawdown over bound', { maxDrawdownBps: 1_501 }],
    ['CVaR over bound', { cvarBps: 1_501 }],
    ['catastrophic incidence', { catastrophicIncidence: 0.06 }],
    ['blocked exits', { blockedExitIncidence: 0.21 }],
    ['recent fifty not positive', { recentFiftyNetLamports: -1n }],
    ['not positive without the top three', { netWithoutTopThreeLamports: 0n }],
    ['one day carries it', { maxSingleDayShare: 0.51 }],
    ['one mint carries it', { maxSingleMintShare: 0.51 }],
    ['not positive at 2x costs', { netUnderDoubleCostsLamports: 0n }],
    ['not positive under latency stress', { netUnderLatencyStressLamports: 0n }],
    ['canary-size shadow not positive', { exactCanarySizeShadowNetLamports: 0n }],
    ['a replay divergence', { replayDivergences: 1 }],
    ['an unresolved reconciliation', { unresolvedReconciliations: 1 }],
    ['unstable fingerprints', { fingerprintsStable: false }],
  ];

  for (const [name, patch] of cases) {
    it(`refuses on: ${name}`, () => {
      expect(judgeConfirmatory({ ...PASSING, ...patch }).passed).toBe(false);
    });
  }

  it('every condition is AND — one failure is a failure', () => {
    // No scoring, no weighting, no "mostly passed". A window that fails one
    // condition failed, and the answer is another window.
    const v = judgeConfirmatory({ ...PASSING, profitFactor: 1.0, netPnlLamports: 1n });
    expect(v.passed).toBe(false);
    expect(v.failures.length).toBeGreaterThan(0);
  });

  it('the thresholds have no configuration path', () => {
    // The only way to pass a window that failed is to edit a constant, which is
    // a diff a reviewer sees.
    expect(CONFIRMATORY_THRESHOLDS.minCompletedPositions).toBe(200);
    expect(CONFIRMATORY_THRESHOLDS.minDistinctUtcDays).toBe(21);
    expect(CONFIRMATORY_THRESHOLDS.minProfitFactor).toBe(1.25);
    expect(judgeConfirmatory.length).toBe(1);
  });
});

describe('the bonding curve has two derivations', () => {
  it('derives both, and they differ', () => {
    // Deriving only v1 returns "no account" for every newer mint, which reads
    // exactly like "this is not a pump token" and is a different statement.
    const a = bondingCurveAddresses('6gkNeHKvyXWLBqFZdctiHs4sqgxdjG548XsuLdMBpump');
    expect(a.v1).not.toBe(a.v2);
    expect(a.v1.length).toBeGreaterThan(30);
    expect(a.v2.length).toBeGreaterThan(30);
  });

  it('is deterministic', () => {
    const m = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
    expect(bondingCurveAddresses(m)).toEqual(bondingCurveAddresses(m));
  });
});
