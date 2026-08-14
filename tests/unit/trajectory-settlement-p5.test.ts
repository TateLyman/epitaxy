import { describe, it, expect } from 'vitest';
import {
  buildTrajectorySettlement,
  checkIdentities,
  NO_CASHBACK,
} from '../../packages/domain/src/trajectory-settlement.js';
import type { MeasuredLegSettlement } from '../../packages/domain/src/settlement.js';

/**
 * P19 items 9–13 — one settlement, one set of economics.
 *
 * Findings C and D are the same defect on two legs. One row could hold two entry
 * costs, because the explicit field came from measured settlement while
 * `cost_lamports`, the ledger debit and the fill fees came from configured
 * assumptions. The exit could disagree with itself in seven documented ways.
 *
 * The repair is not a reconciliation step; it is having one value.
 */

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function leg(over: Partial<MeasuredLegSettlement> = {}): MeasuredLegSettlement {
  return {
    observationId: 'obs-1',
    simulationJobId: 'job-1',
    side: 'buy',
    family: 'BUILD_CUSTOM',
    capabilityFingerprint: 'fp',
    input: {
      kind: 'native_sol',
      requestedLamports: 20_000_000n,
      actualTradeDebitLamports: 20_000_000n,
      totalPayerDebitLamports: 22_079_080n,
    },
    output: { kind: 'token', mint: 'MintAAA', tokenProgram: TOKEN_PROGRAM_ID, minimumAtoms: 0n, expectedAtoms: null, actualCreditAtoms: 1_000n, transferFeeAtoms: 0n },
    costs: {
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 34_800n,
      tipLamports: 0n,
      protocolFeeLamports: null,
      creatorFeeLamports: null,
      lpFeeLamports: null,
      platformFeeLamports: 0n,
      transferFeeAtoms: 0n,
      transferFeeLamportsEquivalent: 0n,
      rentCreatedLamports: 2_039_280n,
      rentRecoveredLamports: 0n,
      failedAttemptCostLamports: 0n,
      unexplainedLamports: 0n,
      valueToUnnamedAccountsLamports: 0n,
    },
    createdAccounts: [],
    closedAccounts: [],
    residualTokenAtoms: 0n,
    payerNativeDeltaLamports: -22_079_080n,
    ...over,
  } as MeasuredLegSettlement;
}

function exitLeg(over: Partial<MeasuredLegSettlement> = {}): MeasuredLegSettlement {
  return leg({
    observationId: 'obs-2',
    simulationJobId: 'job-2',
    side: 'sell',
    input: { kind: 'token', mint: 'MintAAA', tokenProgram: TOKEN_PROGRAM_ID, requestedAtoms: 1_000n, actualTradeDebitAtoms: 1_000n },
    output: { kind: 'native_sol', minimumLamports: 18_000_000n, expectedLamports: 19_500_000n, actualCreditLamports: 19_500_000n },
    costs: {
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
      rentRecoveredLamports: 2_039_280n,
      failedAttemptCostLamports: 0n,
      unexplainedLamports: 0n,
      valueToUnnamedAccountsLamports: 0n,
    },
    residualTokenAtoms: 0n,
    payerNativeDeltaLamports: 21_534_280n,
    ...over,
  } as Partial<MeasuredLegSettlement>);
}

describe('P5 — one settlement, and PnL that refuses when a part is unknown', () => {
  it('produces a net PnL when everything is measured', () => {
    const s = buildTrajectorySettlement({ trajectoryId: 't1', entry: leg(), exit: exitLeg() });
    expect(s.netPnlLamports).not.toBeNull();
    expect(s.pnlBlockedReasons).toEqual([]);
    expect(checkIdentities(s).ok).toBe(true);
  });

  it('an open trajectory has no PnL, and says so', () => {
    const s = buildTrajectorySettlement({ trajectoryId: 't2', entry: leg(), exit: null });
    expect(s.netPnlLamports).toBeNull();
    expect(s.pnlBlockedReasons.join(' ')).toMatch(/has not exited/);
  });

  it('an UNMEASURED transfer fee blocks PnL rather than becoming zero', () => {
    // The exact defect: `?? 0n` turned "not measured" into "there is none", and
    // on a Token-2022 mint that is the fee which makes the position a bad one.
    const s = buildTrajectorySettlement({
      trajectoryId: 't3',
      entry: leg({
        output: { kind: 'token', mint: 'M', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', minimumAtoms: 0n, expectedAtoms: null, actualCreditAtoms: 1n, transferFeeAtoms: null },
        costs: { ...leg().costs, transferFeeLamportsEquivalent: null },
      } as Partial<MeasuredLegSettlement>),
      exit: exitLeg(),
    });
    expect(s.netPnlLamports).toBeNull();
    expect(s.pnlBlockedReasons.join(' ')).toMatch(/transfer fee was not measured/);
  });

  it('residual tokens block PnL, because unsold tokens are not cash', () => {
    const s = buildTrajectorySettlement({
      trajectoryId: 't4',
      entry: leg(),
      exit: exitLeg({ residualTokenAtoms: 250n }),
    });
    expect(s.netPnlLamports).toBeNull();
    expect(s.pnlBlockedReasons.join(' ')).toMatch(/250 token atoms remain/);
  });

  it('an unknown venue fee DECOMPOSITION does not block PnL', () => {
    // Input and output were both measured. How the venue split its cut between
    // LP, protocol and creator does not change what the wallet did.
    const s = buildTrajectorySettlement({
      trajectoryId: 't5',
      entry: leg(),
      exit: exitLeg(),
      venueFeeDecompositionKnown: false,
    });
    expect(s.venueFeesEmbeddedInOutput).toBe(true);
    expect(s.venueFeeDecompositionKnown).toBe(false);
    expect(s.netPnlLamports).not.toBeNull();
  });
});

describe('P5 — principal is never execution cost', () => {
  it('execution cost excludes the principal and includes the transfer fee', () => {
    const s = buildTrajectorySettlement({ trajectoryId: 't6', entry: leg(), exit: exitLeg() });
    // 20,000,000 of principal must not appear in the cost.
    expect(s.executionCostLamports).toBeLessThan(20_000_000n);
    expect(checkIdentities(s).ok).toBe(true);
  });

  it('the identity check catches principal leaking in', () => {
    const s = buildTrajectorySettlement({ trajectoryId: 't7', entry: leg(), exit: exitLeg() });
    const leaked = { ...s, executionCostLamports: s.entryCashOutLamports + 1n };
    expect(checkIdentities(leaked).ok).toBe(false);
    expect(checkIdentities(leaked).violations.join(' ')).toMatch(/principal/);
  });

  it('unrecovered rent is a cost; recovered rent is not', () => {
    const recovered = buildTrajectorySettlement({ trajectoryId: 't8', entry: leg(), exit: exitLeg() });
    const stranded = buildTrajectorySettlement({
      trajectoryId: 't9',
      entry: leg(),
      exit: exitLeg({ costs: { ...exitLeg().costs, rentRecoveredLamports: 0n } } as Partial<MeasuredLegSettlement>),
    });
    expect(stranded.rentStillLockedLamports).toBeGreaterThan(recovered.rentStillLockedLamports);
    expect(stranded.executionCostLamports).toBeGreaterThan(recovered.executionCostLamports);
  });
});

describe('P5 — cashback is a receivable until it is claimed', () => {
  it('accrued cashback does not enter PnL', () => {
    const withAccrual = buildTrajectorySettlement({
      trajectoryId: 'c1',
      entry: leg(),
      exit: exitLeg(),
      cashback: { accruedLamports: 60_000n, claimableLamports: 60_000n, claimedLamports: 0n, claimCostLamports: 0n },
    });
    const without = buildTrajectorySettlement({ trajectoryId: 'c2', entry: leg(), exit: exitLeg() });
    // Booking a receivable as revenue is exactly what keeping the three fields
    // separate prevents.
    expect(withAccrual.netPnlLamports).toBe(without.netPnlLamports);
    expect(withAccrual.cashbackAccruedLamports).toBe(60_000n);
    expect(withAccrual.cashbackClaimedLamports).toBe(0n);
  });

  it('claimed cashback enters PnL, and its claim cost enters execution cost', () => {
    const s = buildTrajectorySettlement({
      trajectoryId: 'c3',
      entry: leg(),
      exit: exitLeg(),
      cashback: { accruedLamports: 60_000n, claimableLamports: 0n, claimedLamports: 60_000n, claimCostLamports: 5_000n },
    });
    const base = buildTrajectorySettlement({ trajectoryId: 'c4', entry: leg(), exit: exitLeg() });
    expect(s.netPnlLamports).toBe((base.netPnlLamports ?? 0n) + 60_000n - 5_000n);
    expect(s.executionCostLamports).toBe(base.executionCostLamports + 5_000n);
    expect(checkIdentities(s).ok).toBe(true);
  });

  it('cannot claim more than ever accrued or was claimable', () => {
    const s = buildTrajectorySettlement({
      trajectoryId: 'c5',
      entry: leg(),
      exit: exitLeg(),
      cashback: { ...NO_CASHBACK, claimedLamports: 1_000n },
    });
    expect(checkIdentities(s).ok).toBe(false);
    expect(checkIdentities(s).violations.join(' ')).toMatch(/more cashback claimed/);
  });
});

describe('P5 — the gross exit credit is gross', () => {
  it('reports the venue payout, not the net wallet cash', () => {
    // Writing net cash into a gross field was one of finding D's seven ways for
    // an exit to disagree with itself.
    const s = buildTrajectorySettlement({ trajectoryId: 'g1', entry: leg(), exit: exitLeg() });
    expect(s.grossExitCreditLamports).toBe(19_500_000n);
    expect(s.exitCashInLamports).not.toBe(s.grossExitCreditLamports);
  });

  it('is null when the trajectory has not exited', () => {
    const s = buildTrajectorySettlement({ trajectoryId: 'g2', entry: leg(), exit: null });
    expect(s.grossExitCreditLamports).toBeNull();
    expect(s.exitCashInLamports).toBeNull();
  });
});
