import { describe, it, expect } from 'vitest';
import {
  executionCost,
  transferFeeOrUnknown,
  entryCashOut,
  type MeasuredLegSettlement,
} from '../../packages/domain/src/settlement.js';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** The first effect-verified production buy: 0.02 SOL in, 24,087,331 out. */
const BUY: MeasuredLegSettlement = {
  observationId: 'o',
  simulationJobId: 'j',
  side: 'buy',
  family: 'BUILD_CUSTOM',
  capabilityFingerprint: 'fp',
  input: {
    kind: 'native_sol',
    requestedLamports: 20_000_000n,
    actualTradeDebitLamports: 20_000_000n,
    totalPayerDebitLamports: 24_087_331n,
  },
  output: {
    kind: 'token',
    mint: 'M',
    tokenProgram: TOKEN,
    tokenAccount: 'A',
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
  createdAccounts: [],
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

describe('P4 — execution cost never includes principal', () => {
  it('counts fees, tip and unrecovered rent only', () => {
    // 5,000 + 3,771 + 0 + (4,078,560 - 0) + 0
    expect(executionCost(BUY)).toBe(4_087_331n);
  });

  it('is an order of magnitude below cash out, which is what was being written', () => {
    // Production wrote entryCashOut().cashOut into execution_cost_lamports.
    // On this leg that reports 24,087,331 lamports of "execution cost" against
    // 4,087,331 of actual cost — and a 2x-cost stress then doubles the
    // principal, which is not a cost and does not double.
    const cashOut = entryCashOut(BUY).cashOut;
    expect(cashOut).toBe(24_087_331n);
    expect(executionCost(BUY)).toBeLessThan(cashOut / 5n);
    expect(cashOut - executionCost(BUY)).toBe(20_000_000n); // exactly the principal
  });

  it('does not charge rent that came back', () => {
    const recovered = {
      ...BUY,
      costs: { ...BUY.costs, rentRecoveredLamports: 4_078_560n },
    };
    // Rent that returns was never spent.
    expect(executionCost(recovered)).toBe(8_771n);
  });

  it('charges an actual failed attempt, and only an actual one', () => {
    expect(executionCost(BUY)).toBe(4_087_331n);
    const withFailure = { ...BUY, costs: { ...BUY.costs, failedAttemptCostLamports: 5_000n } };
    expect(executionCost(withFailure)).toBe(4_092_331n);
  });
});

describe('P4 — a null transfer fee never becomes zero', () => {
  it('returns 0 for legacy Token, where the extension cannot exist', () => {
    // "Not applicable" and "not measured" are different answers, and only the
    // second should block a leg.
    expect(transferFeeOrUnknown(BUY)).toBe(0n);
  });

  it('returns NULL for an unmeasured Token-2022 fee', () => {
    const t22: MeasuredLegSettlement = {
      ...BUY,
      output: { ...(BUY.output as never), tokenProgram: TOKEN_2022 } as never,
    };
    expect(transferFeeOrUnknown(t22)).toBeNull();
  });

  it('returns the measured fee when there is one', () => {
    const measured: MeasuredLegSettlement = {
      ...BUY,
      output: { ...(BUY.output as never), tokenProgram: TOKEN_2022 } as never,
      costs: { ...BUY.costs, transferFeeLamportsEquivalent: 1_234n },
    };
    expect(transferFeeOrUnknown(measured)).toBe(1_234n);
  });

  it('sees a Token-2022 INPUT too, not only the output', () => {
    const sell: MeasuredLegSettlement = {
      ...BUY,
      side: 'sell',
      input: {
        kind: 'token',
        mint: 'M',
        tokenProgram: TOKEN_2022,
        tokenAccount: 'A',
        requestedAtoms: 1n,
        actualDebitAtoms: 1n,
      },
      output: { kind: 'native_sol', minimumLamports: 0n, expectedLamports: null, actualCreditLamports: 1n },
    };
    expect(transferFeeOrUnknown(sell)).toBeNull();
  });
});
