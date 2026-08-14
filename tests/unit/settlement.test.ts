import { describe, it, expect } from 'vitest';
import {
  acquiredTokens,
  entryCashOut,
  exitCashIn,
  immediateRoundTrip,
  isPnlEligible,
  realizedLamports,
  type MeasuredLegSettlement,
} from '../../packages/domain/src/settlement.js';

/**
 * These numbers are not invented. They are the first effect-verified round trip
 * production ever produced, mint 6e5KR79A5L, BUILD_CUSTOM, 0.02 SOL, 300 bps
 * slippage allowance. Every assertion below is against what the simulator
 * actually measured.
 */
const BUY: MeasuredLegSettlement = {
  observationId: 'obs-buy',
  simulationJobId: 'job-buy',
  side: 'buy',
  family: 'BUILD_CUSTOM',
  capabilityFingerprint: 'test',
  input: {
    kind: 'native_sol',
    requestedLamports: 20_000_000n,
    actualTradeDebitLamports: 20_000_000n,
    totalPayerDebitLamports: 24_087_331n,
  },
  output: {
    kind: 'token',
    mint: 'MintB',
    tokenProgram: 'Tok',
    tokenAccount: 'Ata',
    minimumAtoms: 15_741_505_674n,
    expectedAtoms: 16_227_715_590n,
    actualCreditAtoms: 16_227_715_590n,
  },
  costs: {
    baseFeeLamports: 5_000n,
    priorityFeeLamports: 3_771n,
    tipLamports: 0n,
    protocolFeeLamports: null,
    creatorFeeLamports: null,
    lpFeeLamports: null,
    platformFeeLamports: 0n,
    transferFeeAtoms: null,
    transferFeeLamportsEquivalent: null,
    rentCreatedLamports: 4_078_560n,
    rentRecoveredLamports: 0n,
    failedAttemptCostLamports: 0n,
    unexplainedLamports: 0n,
    valueToUnnamedAccountsLamports: 24_078_560n,
  },
  createdAccounts: ['a', 'b'],
  closedAccounts: [],
  residualTokenAtoms: null,
  payerNativeDeltaLamports: -24_087_331n,
  fullAccountCoverage: true,
  effectValid: true,
  effectRefusals: [],
  snapshotManifestHash: null,
  replayable: false,
  complete: true,
  incompleteness: [],
};

const SELL: MeasuredLegSettlement = {
  ...BUY,
  observationId: 'obs-sell',
  simulationJobId: 'job-sell',
  side: 'sell',
  input: {
    kind: 'token',
    mint: 'MintB',
    tokenProgram: 'Tok',
    tokenAccount: 'Ata',
    requestedAtoms: 15_741_505_674n,
    actualDebitAtoms: 15_741_505_674n,
  },
  output: {
    kind: 'native_sol',
    minimumLamports: 18_690_028n,
    expectedLamports: 19_288_556n,
    actualCreditLamports: 19_288_556n,
  },
  costs: { ...BUY.costs, priorityFeeLamports: 2_268n, valueToUnnamedAccountsLamports: 4_078_560n },
  payerNativeDeltaLamports: 15_202_728n,
};

describe('P2 — the one measured settlement', () => {
  it('books the measured credit, not the router floor', () => {
    // The whole defect in one number. Production booked `netMinimumOutput`,
    // which is the floor the router promised not to go below, and the two
    // differ by the slippage allowance on every single trade.
    expect(acquiredTokens(BUY)).toBe(16_227_715_590n);
    expect(acquiredTokens(BUY) - BUY.output.minimumAtoms!).toBe(486_209_916n);
  });

  it('refuses to answer for the wrong side', () => {
    expect(() => acquiredTokens(SELL)).toThrow(/sell/);
    expect(() => realizedLamports(BUY)).toThrow(/buy/);
    expect(() => entryCashOut(SELL)).toThrow(/sell/);
    expect(() => exitCashIn(BUY)).toThrow(/buy/);
  });

  it('does not gate eligibility on value reaching unnamed accounts', () => {
    // 24,078,560 lamports reached pool vaults and the new token account. That
    // is what a working swap looks like. Gating on it condemns every leg that
    // succeeded, which is precisely what it did.
    expect(BUY.costs.valueToUnnamedAccountsLamports).toBeGreaterThan(0n);
    expect(isPnlEligible(BUY).ok).toBe(true);
  });

  it('refuses a leg with an actual residual', () => {
    const leaky = { ...BUY, costs: { ...BUY.costs, unexplainedLamports: 1n } };
    const v = isPnlEligible(leaky);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/no named cost/);
  });

  it('refuses a leg the effect did not verify, and one with partial coverage', () => {
    expect(isPnlEligible({ ...BUY, effectValid: false }).ok).toBe(false);
    expect(isPnlEligible({ ...BUY, fullAccountCoverage: false }).ok).toBe(false);
    expect(isPnlEligible({ ...BUY, complete: false, incompleteness: ['no fee'] }).ok).toBe(false);
  });
});

describe('P3 — the round trip the gate refuses on', () => {
  it("counts the exit's own fees and rent", () => {
    // This was `realized + rentRecovered` = 19,288,556: the gross credit, with
    // the cost of taking the exit dropped. The payer received 15,202,728.
    expect(exitCashIn(SELL)).toBe(15_202_728n);
    expect(exitCashIn(SELL)).toBeLessThan(SELL.output.actualCreditLamports!);
  });

  it('separates the trading loss from locked rent', () => {
    const rt = immediateRoundTrip(BUY, SELL);
    expect(rt.complete).toBe(true);
    expect(rt.cashOutLamports).toBe(24_087_331n);
    expect(rt.cashInLamports).toBe(15_202_728n);
    // All-in, rent charged as a cost: 3688 bps, and it would refuse everything.
    expect(rt.lossBps).toBe(3688);
    // What the market actually charged, against a 300 bps slippage allowance.
    expect(rt.tradingLossBps).toBe(363);
    expect(rt.recoverableRentLamports).toBe(8_157_120n);
  });

  it('is refused by a 400 bps cap on the all-in figure but not the trading one', () => {
    // The mutation this kills: gate on `lossBps` and no position ever opens,
    // for a charge the market never made.
    const rt = immediateRoundTrip(BUY, SELL);
    expect(rt.lossBps).toBeGreaterThan(400);
    expect(rt.tradingLossBps).toBeLessThan(400);
  });

  it('refuses to call two families a round trip', () => {
    const rt = immediateRoundTrip(BUY, { ...SELL, family: 'PUMP_DIRECT' });
    expect(rt.complete).toBe(false);
    expect(rt.reasons.join(' ')).toMatch(/family/);
  });

  it('carries the reason forward when either leg is ineligible', () => {
    const rt = immediateRoundTrip({ ...BUY, effectValid: false }, SELL);
    expect(rt.complete).toBe(false);
    expect(rt.reasons.join(' ')).toMatch(/^buy:/);
  });
});
