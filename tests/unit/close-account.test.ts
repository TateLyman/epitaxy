import { describe, expect, it } from 'vitest';
import {
  encodeCloseAccountTransaction,
  closeAccountIntent,
  CloseBuildError,
} from '../../packages/execution/src/close-account.js';
import { decodeTransaction, COMPUTE_BUDGET_PROGRAM } from '../../packages/solana/src/transaction.js';
import { evaluateTransactionPolicy, defaultLimits } from '../../packages/solana/src/txpolicy.js';
import { evaluateBinding } from '../../packages/execution/src/binding.js';

const OWNER = '2TNUsCxbW8a8mG2UHU5KL3k36fecR9qxoF6F2JEY1bqR';
const ATA = 'FqjUmQjG5WNqvVBz2Y2ZWNaKQKZQhRJqcVYqPqYqTqXq';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// A real-shaped blockhash. All-zero bytes are refused by the policy as `blockhash_missing`,
// which the first version of this test tripped over — the policy was right and the test was wrong.
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

/**
 * The close path recovers 2,039,280 lamports of rent — 1,020 bps of a 0.02 SOL position, and
 * fourteen times the measured AMM fee. It is also the only transaction this repository builds
 * itself rather than receiving from an aggregator, so the bytes are asserted rather than trusted.
 */
describe('close-account — the only transaction we build ourselves', () => {
  it('encodes a transaction the repo decoder reads back exactly', () => {
    const raw = encodeCloseAccountTransaction({
      owner: OWNER, tokenAccount: ATA, tokenProgram: TOKEN_PROGRAM, recentBlockhash: BLOCKHASH,
    });
    const d = decodeTransaction(raw);

    expect(d.version).toBe('legacy');
    expect(d.numRequiredSignatures).toBe(1);
    // Index 0 is the fee payer by definition, and binding relies on that to decide whose
    // lamports are leaving. If the owner ever stops being index 0 the bound silently changes.
    expect(d.staticAccountKeys[0]).toBe(OWNER);
    expect(d.staticAccountKeys[1]).toBe(ATA);
    expect(d.staticAccountKeys).toHaveLength(4);
    expect(d.recentBlockhash).toBe(BLOCKHASH);
    expect(d.instructions).toHaveLength(2);
  });

  it('emits exactly a compute-unit limit and one CloseAccount, and nothing else', () => {
    const raw = encodeCloseAccountTransaction({
      owner: OWNER, tokenAccount: ATA, tokenProgram: TOKEN_PROGRAM, recentBlockhash: BLOCKHASH,
    });
    const d = decodeTransaction(raw);

    const [cu, close] = d.instructions;
    expect(d.staticAccountKeys[cu?.programIdIndex ?? -1]).toBe(COMPUTE_BUDGET_PROGRAM);
    expect(cu?.data[0]).toBe(2); // SetComputeUnitLimit

    expect(d.staticAccountKeys[close?.programIdIndex ?? -1]).toBe(TOKEN_PROGRAM);
    // A one-byte body. There is no amount field to get wrong.
    expect(close?.data).toHaveLength(1);
    expect(close?.data[0]).toBe(9); // CloseAccount
    // [account to close, rent destination, owner authority]. The destination MUST be index 0 —
    // if it were anything else the rent would leave to a third party and this test is the only
    // thing standing between that mistake and a signature.
    expect([...(close?.accountIndexes ?? [])]).toEqual([1, 0, 0]);
  });

  it('passes the transaction policy the signer will run on it', () => {
    const raw = encodeCloseAccountTransaction({
      owner: OWNER, tokenAccount: ATA, tokenProgram: TOKEN_PROGRAM, recentBlockhash: BLOCKHASH,
    });
    const result = evaluateTransactionPolicy(raw, defaultLimits(OWNER, 0n));
    expect(result.violations.map((v) => v.violation)).toEqual([]);
    expect(result.allowed).toBe(true);
  });

  it('binds to a close intent, with zero lamport outflow', () => {
    const now = 1_700_000_000_000;
    const raw = encodeCloseAccountTransaction({
      owner: OWNER, tokenAccount: ATA, tokenProgram: TOKEN_PROGRAM, recentBlockhash: BLOCKHASH,
    });
    const policy = evaluateTransactionPolicy(raw, defaultLimits(OWNER, 0n));
    expect(policy.decoded).not.toBeNull();
    const intent = closeAccountIntent({
      mint: ATA, nowUtcMs: now, maxTotalFeeLamports: 10_000n,
      strategyVersion: 'test', riskSnapshotHash: 'test',
    });
    const b = evaluateBinding(policy.decoded!, intent, now);
    // A close performs no System transfer, so nothing can leave. That is a property of the
    // instruction set, not an assertion about our own good behaviour.
    expect(b.lamportOutflow).toBe(0n);
    expect(b.priorityFeeLamports).toBe(0n);
    expect(b.bound).toBe(true);
  });

  it('refuses an expired intent rather than signing a stale blockhash', () => {
    const now = 1_700_000_000_000;
    const raw = encodeCloseAccountTransaction({
      owner: OWNER, tokenAccount: ATA, tokenProgram: TOKEN_PROGRAM, recentBlockhash: BLOCKHASH,
    });
    const policy = evaluateTransactionPolicy(raw, defaultLimits(OWNER, 0n));
    const intent = closeAccountIntent({
      mint: ATA, nowUtcMs: now, maxTotalFeeLamports: 10_000n,
      strategyVersion: 'test', riskSnapshotHash: 'test', ttlMs: 1_000,
    });
    const b = evaluateBinding(policy.decoded!, intent, now + 5_000);
    expect(b.bound).toBe(false);
    expect(b.violations.map((v) => v.violation)).toContain('intent_expired');
  });

  it('refuses to close an account into itself', () => {
    expect(() => encodeCloseAccountTransaction({
      owner: OWNER, tokenAccount: OWNER, tokenProgram: TOKEN_PROGRAM, recentBlockhash: BLOCKHASH,
    })).toThrow(CloseBuildError);
  });

  it('refuses a blockhash of all zeros, which is the policy catching a missing one', () => {
    const raw = encodeCloseAccountTransaction({
      owner: OWNER, tokenAccount: ATA, tokenProgram: TOKEN_PROGRAM,
      recentBlockhash: '11111111111111111111111111111111',
    });
    const result = evaluateTransactionPolicy(raw, defaultLimits(OWNER, 0n));
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.violation)).toContain('blockhash_missing');
  });
});
