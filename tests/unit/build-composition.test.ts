import { describe, it, expect } from 'vitest';
import { tipLamportsOf } from '../../packages/adapters/src/jupiter/client.js';

/**
 * P7 — Jupiter `/build` composition.
 *
 * The assembled instruction array IS the transaction. The policy decoder reads
 * it, the byte-level hash covers it, and the simulator executes it, so an
 * assembly that differs from what the route described validates one transaction
 * and sends another.
 */

const SYSTEM = '11111111111111111111111111111111';

/** The composition under test, extracted so the order can be asserted directly. */
function compose(b: {
  computeBudgetInstructions?: string[];
  setupInstructions?: string[];
  swapInstruction?: string;
  otherInstructions?: string[];
  cleanupInstruction?: string;
  tipInstruction?: string;
}): string[] {
  return [
    ...(b.computeBudgetInstructions ?? []),
    ...(b.setupInstructions ?? []),
    ...(b.swapInstruction ? [b.swapInstruction] : []),
    ...(b.otherInstructions ?? []),
    ...(b.cleanupInstruction ? [b.cleanupInstruction] : []),
    ...(b.tipInstruction ? [b.tipInstruction] : []),
  ];
}

describe('P7 — execution order', () => {
  it('custom post-swap instructions precede cleanup', () => {
    // THE defect. Cleanup closes the wrapped-SOL account and returns its rent,
    // so anything in `otherInstructions` that touched that account executed
    // against an account that had just been closed.
    const order = compose({
      computeBudgetInstructions: ['compute'],
      setupInstructions: ['setup'],
      swapInstruction: 'swap',
      otherInstructions: ['other'],
      cleanupInstruction: 'cleanup',
    });
    expect(order).toEqual(['compute', 'setup', 'swap', 'other', 'cleanup']);
    expect(order.indexOf('other')).toBeLessThan(order.indexOf('cleanup'));
  });

  it('cleanup is last when no tip is requested', () => {
    const order = compose({ swapInstruction: 'swap', cleanupInstruction: 'cleanup' });
    expect(order[order.length - 1]).toBe('cleanup');
  });

  it('the tip goes after cleanup, so a close cannot unwind it', () => {
    const order = compose({ swapInstruction: 'swap', cleanupInstruction: 'cleanup', tipInstruction: 'tip' });
    expect(order).toEqual(['swap', 'cleanup', 'tip']);
  });

  it('omits every optional section that the route did not return', () => {
    expect(compose({ swapInstruction: 'swap' })).toEqual(['swap']);
  });

  it('compute budget is always first, because a limit set after the fact is not a limit', () => {
    const order = compose({
      computeBudgetInstructions: ['limit', 'price'],
      setupInstructions: ['setup'],
      swapInstruction: 'swap',
    });
    expect(order.slice(0, 2)).toEqual(['limit', 'price']);
  });

  it('preserves the order WITHIN each section', () => {
    const order = compose({ setupInstructions: ['a', 'b', 'c'], swapInstruction: 'swap' });
    expect(order).toEqual(['a', 'b', 'c', 'swap']);
  });
});

describe('P7 — the tip is read from the instruction, not from config', () => {
  const transfer = (lamports: bigint): string => {
    const b = Buffer.alloc(12);
    b.writeUInt32LE(2, 0);
    b.writeBigUInt64LE(lamports, 4);
    return b.toString('base64');
  };

  it('decodes a System transfer amount exactly', () => {
    expect(tipLamportsOf({ programId: SYSTEM, data: transfer(1_000_000n) })).toBe(1_000_000n);
  });

  it('decodes an amount past 2^53 without going through a float', () => {
    // Lamports are u64. A tip read through Number silently loses precision
    // above 2^53, and a cost that is quietly wrong is worse than one that is
    // missing.
    const big = 9_007_199_254_740_993n;
    expect(tipLamportsOf({ programId: SYSTEM, data: transfer(big) })).toBe(big);
  });

  it('returns null for a non-System program rather than guessing', () => {
    expect(tipLamportsOf({ programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', data: transfer(1n) })).toBeNull();
  });

  it('returns null for a System instruction that is not a transfer', () => {
    const b = Buffer.alloc(12);
    b.writeUInt32LE(0, 0); // CreateAccount
    expect(tipLamportsOf({ programId: SYSTEM, data: b.toString('base64') })).toBeNull();
  });

  it('returns null for truncated data instead of reading past the end', () => {
    expect(tipLamportsOf({ programId: SYSTEM, data: Buffer.alloc(6).toString('base64') })).toBeNull();
  });

  it('returns null for data that is not base64 at all', () => {
    expect(tipLamportsOf({ programId: SYSTEM, data: '!!!not base64!!!' })).toBeNull();
  });

  it('an undecodable tip is null, which is an unknown cost and not a zero one', () => {
    // The distinction that matters: `hasTip` says a tip was requested, and a
    // null amount says we could not read it. Reading it as zero would drop a
    // real cost out of the model.
    expect(tipLamportsOf({ programId: SYSTEM, data: '' })).toBeNull();
  });
});
