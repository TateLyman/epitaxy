import { describe, it, expect } from 'vitest';
import {
  quoteLeg,
  quoteRoundTrip,
  expectedFailureCost,
  costBps,
  type LegCosts,
} from '../../packages/domain/src/accounting.js';
import {
  appliedComputeLimit,
  chargedPriorityFee,
  isNativeBuiltin,
  MAX_COMPUTE_UNIT_LIMIT,
} from '../../packages/solana/src/computebudget.js';
import { compileMessage, encodeUnsignedTransaction } from '../../packages/solana/src/encode.js';
import { decodeTransaction, readComputeBudget, COMPUTE_BUDGET_PROGRAM } from '../../packages/solana/src/transaction.js';
import { SYSTEM_PROGRAM } from '../../packages/solana/src/txpolicy.js';
import { base58Encode } from '../../packages/solana/src/base58.js';

/**
 * §10 — the cost model, and the two errors it exists to stop.
 *
 * The compute-limit numbers here are measured against a live SVM, not read from
 * documentation. See scripts and docs/STATUS.md.
 */

const key = (n: number): string => base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : i + 1)));
const BPF = key(77);

describe('§10.2 the applied compute limit', () => {
  it('gives a builtin 3,000 units and everything else 200,000', () => {
    // Measured: two builtins were charged 6,000, three were charged 9,000.
    expect(appliedComputeLimit([SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM], null).units).toBe(6_000);
    expect(appliedComputeLimit([SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM], null).units).toBe(9_000);
    expect(appliedComputeLimit([BPF], null).units).toBe(200_000);
    expect(appliedComputeLimit([COMPUTE_BUDGET_PROGRAM, BPF], null).units).toBe(203_000);
  });

  it('clamps the derived total at 1,400,000', () => {
    const many = Array.from({ length: 20 }, () => BPF);
    const r = appliedComputeLimit(many, null);
    expect(r.units).toBe(MAX_COMPUTE_UNIT_LIMIT);
    expect(r.clamped).toBe(true);
  });

  it('clamps an explicit limit above the maximum', () => {
    // Measured: an explicit 2,000,000 was charged as 1,400,000.
    const r = appliedComputeLimit([SYSTEM_PROGRAM], 2_000_000);
    expect(r.units).toBe(MAX_COMPUTE_UNIT_LIMIT);
    expect(r.source).toBe('explicit');
  });

  it('lets an explicit limit win over the derived one', () => {
    // Measured: an explicit 50,000 was charged as 50,000 despite two builtins.
    expect(appliedComputeLimit([SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM], 50_000).units).toBe(50_000);
  });

  it('treats an unresolvable program id as non-builtin, which is the dearer answer', () => {
    // A program loaded from a lookup table cannot be identified from static
    // keys. Guessing "builtin" would understate the fee by 197,000 units.
    expect(appliedComputeLimit([null], null).units).toBe(200_000);
  });

  it('does not consider a migrated builtin native', () => {
    // Address Lookup Table and Config were migrated to BPF and get the full
    // allocation. Listing them as native would understate every fee.
    expect(isNativeBuiltin('AddressLookupTab1e1111111111111111111111111')).toBe(false);
    expect(isNativeBuiltin(SYSTEM_PROGRAM)).toBe(true);
  });
});

describe('§10.1 the priority fee a route is actually charged', () => {
  const price = (micro: bigint): { programId: string; accounts: never[]; data: string } => {
    const b = Buffer.alloc(9);
    b.writeUInt8(3, 0);
    b.writeBigUInt64LE(micro, 1);
    return { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: b.toString('base64') };
  };
  const payer = key(3);
  const build = (ixs: { programId: string; accounts: unknown[]; data: string }[]): ReturnType<typeof decodeTransaction> =>
    decodeTransaction(encodeUnsignedTransaction(compileMessage(ixs as never, payer, key(7))));

  it('is NOT zero when the router omits SetComputeUnitLimit', () => {
    // This is the defect. Jupiter never sends a limit, so the old path
    // multiplied a real price by null and reported that every leg this system
    // builds pays no priority fee at all.
    const tx = build([
      price(2054n),
      { programId: BPF, accounts: [], data: 'AA==' },
      { programId: BPF, accounts: [], data: 'AA==' },
    ]);
    const cb = readComputeBudget(tx);
    expect(cb.unitLimit).toBeNull();
    expect(cb.unitPriceMicroLamports).toBe(2054n);

    const charged = chargedPriorityFee(tx, cb);
    // 3,000 for the compute-budget instruction + 200,000 each for two BPF ones.
    expect(charged.limit.units).toBe(403_000);
    expect(charged.limit.source).toBe('derived-from-instructions');
    // ceil(2054 * 403000 / 1e6) = ceil(827.762) = 828
    expect(charged.lamports).toBe(828n);
  });

  it('rounds the fee UP, never down', () => {
    const tx = build([price(1n), { programId: SYSTEM_PROGRAM, accounts: [], data: 'AA==' }]);
    // 1 microlamport across 6,000 units is 0.006 lamports, which is 1, not 0.
    expect(chargedPriorityFee(tx, readComputeBudget(tx)).lamports).toBe(1n);
  });

  it('is zero only when no price was set at all', () => {
    const tx = build([{ programId: SYSTEM_PROGRAM, accounts: [], data: 'AA==' }]);
    expect(chargedPriorityFee(tx, readComputeBudget(tx)).lamports).toBe(0n);
  });
});

describe('§10.3 expected failure cost', () => {
  it('labels an unobserved rate as assumed rather than measured', () => {
    const f = expectedFailureCost({ landedFailures: 0, total: 0 }, 205_000n, 'observed');
    expect(f.expectedLamports).toBe(0n);
    // Zero is a claim. It says so.
    expect(f.basis).toBe('assumed-zero');
  });

  it('scales with the conditional cost rather than charging a flat amount', () => {
    const cheap = expectedFailureCost({ landedFailures: 1, total: 10 }, 5_000n, 'observed');
    const dear = expectedFailureCost({ landedFailures: 1, total: 10 }, 500_000n, 'observed');
    expect(cheap.expectedLamports).toBe(500n);
    expect(dear.expectedLamports).toBe(50_000n);
  });

  it('rounds up so a small expectation does not vanish', () => {
    const f = expectedFailureCost({ landedFailures: 1, total: 1_000_000 }, 5_000n, 'observed');
    expect(f.expectedLamports).toBeGreaterThan(0n);
  });
});

describe('§10.6 one accounting module', () => {
  const costs = (over: Partial<LegCosts> = {}): LegCosts => ({
    signatureFeeLamports: 5_000n,
    priorityFeeLamports: 828n,
    ataRentLamports: 0n,
    broadcasterTipLamports: 0n,
    platformFeeLamports: 0n,
    ...over,
  });
  const noFailure = expectedFailureCost({ landedFailures: 0, total: 0 }, 5_828n, 'assumed-zero');

  it('keeps rent OUT of cost and IN capital', () => {
    // Rent is recoverable. Counting it as a cost double-charges a round trip
    // that gets it back; counting it as free understates the capital tied up.
    const q = quoteLeg(costs({ ataRentLamports: 2_039_280n }), noFailure);
    expect(q.totalCostLamports).toBe(5_828n);
    expect(q.lockedCapitalLamports).toBe(2_039_280n);
  });

  it('refuses to be complete when the platform fee is unreported', () => {
    const q = quoteLeg(costs({ platformFeeLamports: null }), noFailure);
    expect(q.complete).toBe(false);
    expect(q.missing.join(' ')).toContain('platform fee');
  });

  it('charges no extra signature for closing the ATA in the exit transaction', () => {
    const entry = quoteLeg(costs({ ataRentLamports: 2_039_280n }), noFailure);
    const exit = quoteLeg(costs(), noFailure);
    const recovered = quoteRoundTrip({ entry, exit, closesAtaInExitTransaction: true, ataRentRecovered: true });
    // Two legs, two signatures. The close is an instruction, not a signature.
    expect(recovered.totalCostLamports).toBe(5_828n * 2n);
    expect(recovered.unrecoveredRentLamports).toBe(0n);
  });

  it('books rent as a real loss when it is not recovered', () => {
    const entry = quoteLeg(costs({ ataRentLamports: 2_039_280n }), noFailure);
    const exit = quoteLeg(costs(), noFailure);
    const stranded = quoteRoundTrip({ entry, exit, closesAtaInExitTransaction: false, ataRentRecovered: false });
    expect(stranded.unrecoveredRentLamports).toBe(2_039_280n);
    expect(stranded.totalCostLamports).toBe(5_828n * 2n + 2_039_280n);
  });

  it('propagates incompleteness through the round trip', () => {
    const bad = quoteLeg(costs({ platformFeeLamports: null }), noFailure);
    const ok = quoteLeg(costs(), noFailure);
    expect(quoteRoundTrip({ entry: bad, exit: ok, closesAtaInExitTransaction: true, ataRentRecovered: true }).complete).toBe(false);
  });

  it('reports cost in basis points, rounded up', () => {
    // 11,656 lamports on a 0.02 SOL leg is 5.8 bps, reported as 6.
    expect(costBps(11_656n, 20_000_000n)).toBe(6);
    expect(costBps(1n, 0n)).toBeNull();
  });
});
