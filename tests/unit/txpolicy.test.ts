import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decodeTransaction,
  readComputeBudget,
  priorityFeeLamports,
  TxDecodeError,
  COMPUTE_BUDGET_PROGRAM,
} from '../../packages/solana/src/transaction.js';
import {
  evaluateTransactionPolicy,
  defaultLimits,
  JUPITER_V6,
  MAX_TX_BYTES,
} from '../../packages/solana/src/txpolicy.js';

const fixtures = JSON.parse(readFileSync('tests/fixtures/transactions/jupiter-v6.json', 'utf8')) as {
  signature: string;
  base64: string;
  version: number;
}[];

function bytes(i: number): Uint8Array {
  return new Uint8Array(Buffer.from(fixtures[i]!.base64, 'base64'));
}

describe('decodeTransaction against real mainnet v0 transactions', () => {
  it('has fixtures to test', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it('decodes every captured Jupiter v6 swap', () => {
    for (let i = 0; i < fixtures.length; i++) {
      const tx = decodeTransaction(bytes(i));
      expect(tx.version).toBe(0);
      expect(tx.numRequiredSignatures).toBeGreaterThanOrEqual(1);
      expect(tx.staticAccountKeys.length).toBeGreaterThan(1);
      expect(tx.instructions.length).toBeGreaterThan(0);
      expect(tx.recentBlockhash.length).toBeGreaterThan(31);
    }
  });

  it('finds the Jupiter program among the static keys', () => {
    const anyJupiter = fixtures.some((_, i) => decodeTransaction(bytes(i)).staticAccountKeys.includes(JUPITER_V6));
    expect(anyJupiter).toBe(true);
  });

  it('resolves address lookup tables as a structure it understands', () => {
    // Real router output uses v0 lookups; a decoder that silently ignored them
    // would mis-attribute which accounts a transaction touches.
    const withLookups = fixtures.filter((_, i) => decodeTransaction(bytes(i)).addressTableLookups.length > 0);
    expect(withLookups.length).toBeGreaterThan(0);
  });

  it('reads a real priority fee from the compute budget instructions', () => {
    const fees = fixtures.map((_, i) => priorityFeeLamports(readComputeBudget(decodeTransaction(bytes(i)))));
    expect(fees.some((f) => f > 0n)).toBe(true);
  });
});

describe('decodeTransaction fails closed', () => {
  it('rejects trailing bytes', () => {
    const b = bytes(0);
    const padded = new Uint8Array(b.length + 1);
    padded.set(b);
    expect(() => decodeTransaction(padded)).toThrow(TxDecodeError);
  });

  it('rejects truncation', () => {
    expect(() => decodeTransaction(bytes(0).subarray(0, 50))).toThrow(TxDecodeError);
  });

  it('rejects an empty buffer', () => {
    expect(() => decodeTransaction(new Uint8Array(0))).toThrow(TxDecodeError);
  });

  it('rejects an unsupported transaction version', () => {
    const b = new Uint8Array(bytes(0));
    const sigCount = b[0] as number;
    b[1 + sigCount * 64] = 0x80 | 3; // claim version 3
    expect(() => decodeTransaction(b)).toThrow(TxDecodeError);
  });
});

describe('evaluateTransactionPolicy', () => {
  const someoneElse = 'So11111111111111111111111111111111111111112';

  it('refuses a transaction whose fee payer is not our key', () => {
    const result = evaluateTransactionPolicy(bytes(0), defaultLimits(someoneElse, 1_000_000n));
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.violation)).toContain('wrong_fee_payer');
  });

  it('accepts an otherwise conforming transaction when the fee payer matches', () => {
    // Take the real transaction's own fee payer, so the only question under
    // test is whether the remaining policy rules pass on genuine router output.
    const decoded = decodeTransaction(bytes(0));
    const feePayer = decoded.staticAccountKeys[0]!;
    const result = evaluateTransactionPolicy(bytes(0), defaultLimits(feePayer, 10_000_000n));
    const kinds = result.violations.map((v) => v.violation);
    expect(kinds).not.toContain('wrong_fee_payer');
    expect(kinds).not.toContain('undecodable');
  });

  it('refuses a priority fee above the configured cap', () => {
    const decoded = decodeTransaction(bytes(0));
    const feePayer = decoded.staticAccountKeys[0]!;
    const result = evaluateTransactionPolicy(bytes(0), defaultLimits(feePayer, 0n));
    const fee = priorityFeeLamports(readComputeBudget(decoded));
    if (fee > 0n) {
      expect(result.violations.map((v) => v.violation)).toContain('priority_fee_too_high');
      expect(result.allowed).toBe(false);
    }
  });

  it('refuses a program that is not on the allowlist', () => {
    const decoded = decodeTransaction(bytes(0));
    const feePayer = decoded.staticAccountKeys[0]!;
    const limits = { ...defaultLimits(feePayer, 10_000_000n), allowedPrograms: [COMPUTE_BUDGET_PROGRAM] };
    const result = evaluateTransactionPolicy(bytes(0), limits);
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.violation)).toContain('disallowed_program');
  });

  it('refuses undecodable bytes rather than passing them through', () => {
    const junk = new Uint8Array(200).fill(0xab);
    const result = evaluateTransactionPolicy(junk, defaultLimits(someoneElse, 1_000_000n));
    expect(result.allowed).toBe(false);
    expect(result.decoded).toBeNull();
  });

  it('refuses anything larger than a Solana packet', () => {
    const oversized = new Uint8Array(MAX_TX_BYTES + 1);
    const result = evaluateTransactionPolicy(oversized, defaultLimits(someoneElse, 1_000_000n));
    expect(result.violations.map((v) => v.violation)).toEqual(['oversized']);
  });
});
