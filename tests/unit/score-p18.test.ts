import { describe, it, expect } from 'vitest';
import { opportunityScore, MIN_SCORE_COVERAGE, STRATEGY_VERSION } from '../../packages/strategy/src/score.js';

/**
 * P18 — arithmetic that is wrong independent of any outcome.
 *
 * None of these assertions depend on whether the strategy makes money. They
 * depend on the score not charging a coverage gap as a fact about a token.
 */
const RT = { roundTripLossBps: 200 } as never;
const FULL = { stats5m: { numNetBuyers: 30, numTraders: 80 }, liquidity: 50_000, organicScore: 60 } as never;

describe('P18 — the score does not penalise our own gaps', () => {
  it('renormalises breadth WITHIN the component', () => {
    // Both subfeatures present.
    const both = opportunityScore(
      { stats5m: { numNetBuyers: 30, numTraders: 80 }, liquidity: 50_000, organicScore: 60 } as never,
      RT,
      0,
      5 * 60_000,
    );
    // Only traders. This scored 0.4 x its value and then took the FULL 0.30
    // component weight — 60% of the component thrown away for a missing field.
    const onlyTraders = opportunityScore(
      { stats5m: { numTraders: 80 }, liquidity: 50_000, organicScore: 60 } as never,
      RT,
      0,
      5 * 60_000,
    );
    // normalize(80, 0, 150) = 0.5333, and that is now the whole component.
    expect(onlyTraders.components['breadth']).toBeCloseTo(0.5333, 3);
    // 0.6 x normalize(30,0,60) + 0.4 x normalize(80,0,150) = 0.3 + 0.2133.
    expect(both.components['breadth']).toBeCloseTo(0.5133, 3);
  });

  it('treats a provider organicScore of 0 as not computed', () => {
    const zero = opportunityScore({ ...(FULL as object), organicScore: 0 } as never, RT, 0, 5 * 60_000);
    const absent = opportunityScore(
      { stats5m: { numNetBuyers: 30, numTraders: 80 }, liquidity: 50_000 } as never,
      RT,
      0,
      5 * 60_000,
    );
    // The same statement, so the same score. It used to be charged twice: a
    // zero component at full weight AND the soft-risk gate.
    expect(zero.score).toBe(absent.score);
    expect(zero.components['organic']).toBe(0);
  });

  it('drops unknown tradability out of the weighting instead of scoring it zero', () => {
    const known = opportunityScore(FULL, RT, 0, 5 * 60_000);
    const unknown = opportunityScore(FULL, null as never, 0, 5 * 60_000);
    // A zero tradability is the MAXIMUM penalty and it was applied for not
    // having measured. Dropping it out must raise the score, not lower it.
    expect(unknown.score).toBeGreaterThan(0);
    expect(unknown.components['observedWeight']).toBeLessThan(known.components['observedWeight'] as number);
  });

  it('drops an unknown token age out instead of calling it too young', () => {
    const unknownAge = opportunityScore(FULL, RT, 0, null);
    expect(unknownAge.components['freshness']).toBe(0);
    // Freshness carried no weight, so what remains is fully supported.
    expect(unknownAge.components['coverage']).toBeLessThan(1);
    expect(unknownAge.score).toBeGreaterThan(0);
  });

  it('flags insufficient coverage rather than folding it into the number', () => {
    // Almost nothing measured: liquidity alone.
    const thin = opportunityScore({ liquidity: 50_000 } as never, null as never, 0, null);
    expect(thin.components['insufficientCoverage']).toBe(1);
    expect((thin.components['coverage'] as number) < MIN_SCORE_COVERAGE).toBe(true);

    // Zeroing it would make a barely-measured token indistinguishable from a
    // thoroughly measured worthless one — the same error being fixed.
    expect(thin.score).toBeGreaterThan(0);

    const full = opportunityScore(FULL, RT, 0, 5 * 60_000);
    expect(full.components['insufficientCoverage']).toBe(0);
  });

  it('bumped the strategy version, because the produced number changed meaning', () => {
    expect(STRATEGY_VERSION).toBe('delayed-momentum-v0.5.0');
  });
});
