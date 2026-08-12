import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseAmount,
  formatAmount,
  applyBpsDown,
  feeFromBpsUp,
  lossBps,
  minOutWithSlippage,
  minBigint,
  maxBigint,
  AmountError,
} from '../../packages/domain/src/amounts.js';

/**
 * Amount math is where a rounding decision becomes a real loss. Example-based
 * tests pin the cases someone thought of; these pin the cases nobody did.
 *
 * The generators deliberately reach into u64 territory and past it. A token
 * with 9 decimals and a large supply produces raw amounts that overflow a
 * double long before they overflow a bigint, and the whole point of this module
 * is that such a number never becomes a float.
 */

const rawAmount = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
const decimals = fc.integer({ min: 0, max: 18 });
const bps = fc.integer({ min: 0, max: 10_000 });

describe('rounding conserves value', () => {
  /**
   * The invariant that matters most: what you keep plus what you pay is exactly
   * what you started with. Both functions round, and they round in OPPOSITE
   * directions on purpose — outputs down, fees up. If those two roundings did
   * not cancel, every trade would silently create or destroy a lamport, and the
   * direction of the error would be invisible until the ledger disagreed with
   * the chain.
   */
  it('applyBpsDown and feeFromBpsUp partition the amount with nothing left over', () => {
    fc.assert(
      fc.property(rawAmount, bps, (amount, b) => {
        expect(applyBpsDown(amount, b) + feeFromBpsUp(amount, b)).toBe(amount);
      }),
    );
  });

  it('never overstates what survives a fee', () => {
    fc.assert(
      fc.property(rawAmount, bps, (amount, b) => {
        expect(applyBpsDown(amount, b)).toBeLessThanOrEqual(amount);
      }),
    );
  });

  it('never understates a fee', () => {
    fc.assert(
      fc.property(rawAmount, fc.integer({ min: 1, max: 10_000 }), (amount, b) => {
        // Exact fee scaled by 10_000 to stay in integers.
        expect(feeFromBpsUp(amount, b) * 10_000n).toBeGreaterThanOrEqual(amount * BigInt(b));
      }),
    );
  });

  it('is monotone: a larger bps never leaves you with more', () => {
    fc.assert(
      fc.property(rawAmount, bps, bps, (amount, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(applyBpsDown(amount, hi)).toBeLessThanOrEqual(applyBpsDown(amount, lo));
      }),
    );
  });

  it('rejects a bps outside [0, 10000] rather than clamping it', () => {
    fc.assert(
      fc.property(
        rawAmount,
        fc.oneof(fc.integer({ min: -10_000, max: -1 }), fc.integer({ min: 10_001, max: 100_000 })),
        (amount, b) => {
          expect(() => applyBpsDown(amount, b)).toThrow(AmountError);
          expect(() => feeFromBpsUp(amount, b)).toThrow(AmountError);
        },
      ),
    );
  });
});

describe('decimal string conversion is lossless', () => {
  it('round-trips any raw amount through its decimal rendering', () => {
    fc.assert(
      fc.property(rawAmount, decimals, (raw, d) => {
        expect(parseAmount(formatAmount(raw, d), d)).toBe(raw);
      }),
    );
  });

  it('round-trips negative raw amounts too', () => {
    fc.assert(
      fc.property(rawAmount, decimals, (raw, d) => {
        expect(parseAmount(formatAmount(-raw, d), d)).toBe(-raw);
      }),
    );
  });

  /**
   * Truncation, not rounding, and toward zero on both signs. A parse that
   * rounded up could produce an input amount larger than the one authorised,
   * which is the one direction this system must never move in.
   */
  it('truncates excess precision toward zero, never away from it', () => {
    fc.assert(
      fc.property(rawAmount, fc.integer({ min: 0, max: 9 }), fc.string({ maxLength: 6 }), (raw, d, noise) => {
        const extra = noise.replace(/\D/g, '');
        fc.pre(extra.length > 0);
        // formatAmount strips trailing zeros, so the rendering must be re-padded
        // to full precision before the noise is appended. Appending straight
        // onto the stripped form would land digits in SIGNIFICANT decimal
        // places, which is a different claim than the one being tested.
        const [whole, frac = ''] = formatAmount(raw, d).split('.');
        const padded = d === 0 ? `${whole}.` : `${whole}.${frac.padEnd(d, '0')}`;
        const withFraction = `${padded}${extra}`;
        const parsed = parseAmount(withFraction, d);
        expect(parsed).toBe(raw);
        const negative = parseAmount(`-${withFraction}`, d);
        expect(negative).toBe(-raw);
      }),
    );
  });

  it('refuses anything that is not a decimal numeral', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 24 }).filter((s) => !/^-?\d*(\.\d*)?$/.test(s.trim())),
        decimals,
        (s, d) => {
          expect(() => parseAmount(s, d)).toThrow(AmountError);
        },
      ),
    );
  });
});

describe('loss measurement', () => {
  /**
   * The sign is never WRONG, which is the property a caller depends on. It is
   * not the stronger claim that the sign is always non-zero: lossBps truncates,
   * so a change smaller than before/10^7 reads as 0. An earlier version of this
   * test asserted the stronger claim, was therefore false, and fast-check spent
   * 98s and ~7GB shrinking a counterexample it could always find.
   */
  it('never reports the wrong direction', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (before, after) => {
          const bps = lossBps(before, after);
          expect(bps).not.toBeNull();
          if (after < before) expect(bps!).toBeGreaterThanOrEqual(0);
          else if (after > before) expect(bps!).toBeLessThanOrEqual(0);
          else expect(bps!).toBe(0);
        },
      ),
    );
  });

  /** Above the resolution floor the sign is strict, which is what makes it usable. */
  it('reports a strictly nonzero loss once the change exceeds its resolution', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (before, after) => {
          const delta = before - after;
          // Exactly the condition under which the scaled numerator survives the
          // integer division, written as a bigint comparison so the test does
          // not reintroduce the float it is checking for.
          fc.pre((delta < 0n ? -delta : delta) * 10_000n * 1000n >= before);
          const bps = lossBps(before, after)!;
          if (after < before) expect(bps).toBeGreaterThan(0);
          else expect(bps).toBeLessThan(0);
        },
      ),
    );
  });

  it('returns null rather than infinity when there was nothing to lose', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -1000n, max: 0n }), rawAmount, (before, after) => {
        expect(lossBps(before, after)).toBeNull();
      }),
    );
  });
});

describe('slippage floor', () => {
  it('never permits an output above the quote', () => {
    fc.assert(
      fc.property(rawAmount, bps, (quoted, slippage) => {
        expect(minOutWithSlippage(quoted, slippage)).toBeLessThanOrEqual(quoted);
      }),
    );
  });
});

describe('bigint selection helpers', () => {
  it('minBigint agrees with a sort over any non-empty list', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt(), { minLength: 1, maxLength: 12 }), (values) => {
        const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        expect(minBigint(...values)).toBe(sorted[0]);
      }),
    );
  });

  it('maxBigint returns an operand and dominates both', () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt(), (a, b) => {
        const m = maxBigint(a, b);
        expect(m === a || m === b).toBe(true);
        expect(m).toBeGreaterThanOrEqual(a);
        expect(m).toBeGreaterThanOrEqual(b);
      }),
    );
  });

  it('refuses an empty list rather than inventing a zero', () => {
    expect(() => minBigint()).toThrow(AmountError);
  });
});
