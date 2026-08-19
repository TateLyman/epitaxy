import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  binaryReturn,
  mirrorWeights,
  proportionalReturn,
  residualWeight,
  type WalletLeg,
} from '../../packages/research/src/proportional-exit.js';

/**
 * Phase E §1.3 — "the estimand must be computable from a prefix of the tape ending
 * at T_k. Assert this by test."
 *
 * This is the test that clause asks for, and it is the reason the mirroring
 * arithmetic lives in a module rather than only inside a Dune query: the property is
 * about what the function may not see, and a SQL window function cannot be
 * interrogated about that.
 *
 * The three ways lookahead could enter, each of which the property below forbids:
 *
 *   1. normalising by the wallet's EVENTUAL total sold, which is only known at the
 *      end — a copier using it would size every leg with tomorrow's information;
 *   2. treating the last sell specially, e.g. dumping the remainder on it, which
 *      requires knowing that it IS the last;
 *   3. counting the legs in advance to split the position evenly, which is the same
 *      violation wearing a different arithmetic.
 *
 * Each of those would make an emitted weight change when the sequence is extended.
 * Prefix stability rules out all three at once.
 */

const legsArb = fc.array(
  fc.oneof(
    fc.record({ side: fc.constant('BUY' as const), tokens: fc.double({ min: 0.001, max: 1e6, noNaN: true }) }),
    fc.record({ side: fc.constant('SELL' as const), tokens: fc.double({ min: 0.001, max: 1e6, noNaN: true }) }),
  ),
  { minLength: 1, maxLength: 12 },
);

describe('mirrorWeights is prefix-stable: no lookahead is possible', () => {
  it('never changes a weight it has already emitted when the tape is extended', () => {
    fc.assert(
      fc.property(legsArb, (legs) => {
        const full = mirrorWeights(legs);
        for (let cut = 1; cut <= legs.length; cut += 1) {
          const prefix = mirrorWeights(legs.slice(0, cut));
          // Every leg the prefix knows about must agree with the full sequence,
          // leg for leg, to the bit.
          for (let i = 0; i < prefix.length; i += 1) {
            const a = prefix[i];
            const b = full[i];
            expect(a?.index).toBe(b?.index);
            expect(a?.fraction).toBe(b?.fraction);
            expect(a?.remainingBefore).toBe(b?.remainingBefore);
            expect(a?.weight).toBe(b?.weight);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('emits exactly the legs a prefix could have seen, never more', () => {
    fc.assert(
      fc.property(legsArb, (legs) => {
        for (let cut = 0; cut <= legs.length; cut += 1) {
          const prefix = mirrorWeights(legs.slice(0, cut));
          for (const leg of prefix) expect(leg.index).toBeLessThan(cut);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('mirrorWeights arithmetic', () => {
  it('mirrors halves as halves, on the copier\'s own remaining', () => {
    // Buy 100, sell 50 (half), sell 25 (half of the rest), sell 25 (all of the rest).
    const legs: WalletLeg[] = [
      { side: 'BUY', tokens: 100 },
      { side: 'SELL', tokens: 50 },
      { side: 'SELL', tokens: 25 },
      { side: 'SELL', tokens: 25 },
    ];
    const w = mirrorWeights(legs);
    expect(w.map((x) => x.fraction)).toEqual([0.5, 0.5, 1]);
    expect(w.map((x) => x.remainingBefore)).toEqual([1, 0.5, 0.25]);
    expect(w.map((x) => x.weight)).toEqual([0.5, 0.25, 0.25]);
    expect(residualWeight(legs)).toBeCloseTo(0, 12);
  });

  it('leaves a residual exactly equal to what the wallet still holds', () => {
    const legs: WalletLeg[] = [
      { side: 'BUY', tokens: 100 },
      { side: 'SELL', tokens: 40 },
    ];
    expect(residualWeight(legs)).toBeCloseTo(0.6, 12);
  });

  it('handles a buy AFTER a sell without rewriting history', () => {
    const legs: WalletLeg[] = [
      { side: 'BUY', tokens: 100 },
      { side: 'SELL', tokens: 50 },
      { side: 'BUY', tokens: 50 },
      { side: 'SELL', tokens: 50 },
    ];
    const w = mirrorWeights(legs);
    // The second sell is half of the wallet's 100, so the copier sells half of its
    // remaining 0.5. Adding to the wallet's position does not restore the copier's.
    expect(w.map((x) => x.fraction)).toEqual([0.5, 0.5]);
    expect(w.map((x) => x.weight)).toEqual([0.5, 0.25]);
  });

  it('skips a sell with nothing held rather than reading it as a full exit', () => {
    const legs: WalletLeg[] = [
      { side: 'SELL', tokens: 10 },
      { side: 'BUY', tokens: 100 },
      { side: 'SELL', tokens: 100 },
    ];
    const w = mirrorWeights(legs);
    expect(w).toHaveLength(1);
    expect(w[0]?.index).toBe(2);
    expect(w[0]?.weight).toBe(1);
  });

  it('clamps an over-sell to a full exit and never produces a negative remaining', () => {
    fc.assert(
      fc.property(legsArb, (legs) => {
        const w = mirrorWeights(legs);
        let sum = 0;
        for (const leg of w) {
          expect(leg.fraction).toBeGreaterThanOrEqual(0);
          expect(leg.fraction).toBeLessThanOrEqual(1);
          expect(leg.remainingBefore).toBeGreaterThanOrEqual(0);
          sum += leg.weight;
        }
        // The copier can never liquidate more than it opened.
        expect(sum).toBeLessThanOrEqual(1 + 1e-9);
        expect(residualWeight(legs)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });
});

describe('proportionalReturn', () => {
  const base = {
    entryPrice: 1,
    roundTripFloor: 0.02669,
    extraLegCostFraction: 0.003,
  };
  const legs = mirrorWeights([
    { side: 'BUY', tokens: 100 },
    { side: 'SELL', tokens: 50 },
    { side: 'SELL', tokens: 50 },
  ]);

  it('charges the round-trip floor once and the fixed cost per EXTRA leg only', () => {
    const r = proportionalReturn({ ...base, legs, exitPrices: [2, 2] });
    // Both halves liquidated at 2x an entry price of 1: proceeds are 2.0 times the
    // entry notional, so the gross return is +100%, less one floor and one extra leg.
    expect(r.proceeds).toBeCloseTo(2, 12);
    expect(r.soldWeight).toBeCloseTo(1, 12);
    expect(r.pricedLegs).toBe(2);
    expect(r.returnDead).toBeCloseTo(1 - 0.02669 - 0.003, 12);
    // Mirroring only the FIRST half liquidates 0.5 at 2x: proceeds 1.0, so the dead
    // treatment is flat before costs and pays no extra-leg fee at all.
    const single = proportionalReturn({ ...base, legs: legs.slice(0, 1), exitPrices: [2] });
    expect(single.proceeds).toBeCloseTo(1, 12);
    expect(single.returnDead).toBeCloseTo(-0.02669, 12);
    // and the mirrored treatment renormalises the same proceeds over the half sold.
    expect(single.returnMirrored).toBeCloseTo(1 - 0.02669, 12);
  });

  it('keeps an unpriceable leg HELD rather than assuming it was sold', () => {
    const r = proportionalReturn({ ...base, legs, exitPrices: [null, 2] });
    expect(r.unpricedLegs).toBe(1);
    expect(r.soldWeight).toBeCloseTo(0.5, 12);
    // Dead treatment: the unsold half is worthless.
    expect(r.returnDead).toBeCloseTo(1 - 1 - 0.02669, 12);
    // Mirrored treatment: renormalised over what could be sold, so +100%.
    expect(r.returnMirrored).toBeCloseTo(1 - 0.02669, 12);
  });

  it('returns null for the mirrored figure when nothing could be sold', () => {
    const r = proportionalReturn({ ...base, legs, exitPrices: [null, null] });
    expect(r.returnMirrored).toBeNull();
    expect(r.returnDead).toBeCloseTo(-1 - 0.02669, 12);
  });

  it('cannot lose more than the position plus its costs', () => {
    fc.assert(
      fc.property(legsArb, fc.double({ min: 0.01, max: 100, noNaN: true }), (raw, entry) => {
        const w = mirrorWeights(raw);
        const r = proportionalReturn({
          ...base,
          legs: w,
          entryPrice: entry,
          exitPrices: w.map(() => 0.000001),
        });
        expect(r.returnDead).toBeGreaterThanOrEqual(-1 - 0.02669 - 0.003 * Math.max(w.length - 1, 0) - 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it('equals the binary control exactly when the wallet exits in one leg', () => {
    const one = mirrorWeights([
      { side: 'BUY', tokens: 100 },
      { side: 'SELL', tokens: 100 },
    ]);
    const prop = proportionalReturn({ ...base, legs: one, exitPrices: [1.5] });
    const bin = binaryReturn({ ...base, legs: one, exitPrices: [1.5] });
    expect(prop.returnDead).toBeCloseTo(bin as number, 12);
    expect(prop.returnMirrored).toBeCloseTo(bin as number, 12);
  });
});

describe('binaryReturn', () => {
  const base = { entryPrice: 1, roundTripFloor: 0.02669, extraLegCostFraction: 0.003 };
  const legs = mirrorWeights([
    { side: 'BUY', tokens: 100 },
    { side: 'SELL', tokens: 50 },
    { side: 'SELL', tokens: 50 },
  ]);

  it('takes the first PRICEABLE sell as a full exit, and pays no extra-leg cost', () => {
    expect(binaryReturn({ ...base, legs, exitPrices: [3, 2] })).toBeCloseTo(3 - 1 - 0.02669, 12);
    // A copier cannot act on a price that does not exist, so it waits for the next.
    expect(binaryReturn({ ...base, legs, exitPrices: [null, 2] })).toBeCloseTo(2 - 1 - 0.02669, 12);
  });

  it('is null when no leg can be priced, matching the proportional treatment', () => {
    expect(binaryReturn({ ...base, legs, exitPrices: [null, null] })).toBeNull();
  });

  it('is beaten by proportional exactly when later legs price higher', () => {
    const rising = proportionalReturn({ ...base, legs, exitPrices: [1, 3] });
    const risingBin = binaryReturn({ ...base, legs, exitPrices: [1, 3] }) as number;
    expect(rising.returnDead).toBeGreaterThan(risingBin);
    const falling = proportionalReturn({ ...base, legs, exitPrices: [3, 1] });
    const fallingBin = binaryReturn({ ...base, legs, exitPrices: [3, 1] }) as number;
    expect(falling.returnDead).toBeLessThan(fallingBin);
  });
});
