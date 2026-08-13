import { describe, it, expect } from 'vitest';
import {
  classifyRejectOutcome,
  rejectReturnBps,
  summariseOutcomes,
  isReturnBearing,
  isConfirmedWorthless,
  REJECT_OUTCOMES,
  type HorizonEvidence,
} from '../../packages/domain/src/rejectoutcome.js';

/**
 * §17 — the corpus that decides whether the gates throw away money, and the
 * one error that would make every gate look brilliant.
 */

const evidence = (over: Partial<HorizonEvidence> = {}): HorizonEvidence => ({
  providerAnswered: true,
  routeExists: true,
  executableValueLamports: 15_000_000n,
  buildable: true,
  poolReservesLamports: 500_000_000n,
  sourceGap: false,
  ...over,
});

describe('classifyRejectOutcome', () => {
  it('does NOT call a vanished provider a total loss', () => {
    // THE defect. A token the provider stops listing has a null price, a null
    // price read as a number is zero, and zero means it went to nothing. Every
    // gate then looks brilliant for rejecting things that "went to zero".
    const o = classifyRejectOutcome(evidence({ providerAnswered: false, executableValueLamports: null, routeExists: null }));
    expect(o).toBe('PROVIDER_MISSING');
    expect(isConfirmedWorthless(o)).toBe(false);
    expect(rejectReturnBps(o, 20_000_000n, null)).toBeNull();
  });

  it('checks our own blindness before anything else', () => {
    // If we were not watching, nothing we think we know about that window is
    // evidence — including a provider that appears to have answered.
    expect(classifyRejectOutcome(evidence({ sourceGap: true, providerAnswered: false }))).toBe('SOURCE_GAP');
    expect(classifyRejectOutcome(evidence({ sourceGap: true, routeExists: false }))).toBe('SOURCE_GAP');
  });

  it('accepts a confirmed no-route as a real total loss', () => {
    // The provider answered and said there is no route. That IS about the token.
    const o = classifyRejectOutcome(evidence({ routeExists: false, executableValueLamports: null }));
    expect(o).toBe('NO_ROUTE_CONFIRMED');
    expect(isConfirmedWorthless(o)).toBe(true);
    expect(rejectReturnBps(o, 20_000_000n, null)).toBe(-10_000);
  });

  it('accepts an on-chain drained pool as a real total loss', () => {
    const o = classifyRejectOutcome(evidence({ poolReservesLamports: 0n, executableValueLamports: null }));
    expect(o).toBe('POOL_DRAIN_CONFIRMED');
    expect(rejectReturnBps(o, 20_000_000n, null)).toBe(-10_000);
  });

  it('does not read unknown reserves as drained', () => {
    // Null reserves is "we did not look", which is exactly the confusion the
    // whole module exists to prevent.
    expect(classifyRejectOutcome(evidence({ poolReservesLamports: null }))).toBe('EXECUTABLE_VALUE');
  });

  it('refuses to price a route that cannot be built', () => {
    // A quoted value we could not have realised is not a return.
    const o = classifyRejectOutcome(evidence({ buildable: false }));
    expect(o).toBe('UNBUILDABLE');
    expect(rejectReturnBps(o, 20_000_000n, 15_000_000n)).toBeNull();
  });

  it('prices a genuine executable value', () => {
    const o = classifyRejectOutcome(evidence());
    expect(o).toBe('EXECUTABLE_VALUE');
    // 15,000,000 against 20,000,000 is -25%.
    expect(rejectReturnBps(o, 20_000_000n, 15_000_000n)).toBe(-2_500);
  });

  it('falls through to UNKNOWN rather than inventing a number', () => {
    expect(classifyRejectOutcome(evidence({ executableValueLamports: null, poolReservesLamports: null }))).toBe('UNKNOWN');
  });
});

describe('rejectReturnBps', () => {
  it('returns null, never zero, for anything unpriceable', () => {
    // Zero is a claim that the position was flat. Null is a refusal to claim.
    for (const o of REJECT_OUTCOMES) {
      if (isReturnBearing(o) || isConfirmedWorthless(o)) continue;
      expect(rejectReturnBps(o, 20_000_000n, 15_000_000n)).toBeNull();
    }
  });

  it('handles a gain', () => {
    expect(rejectReturnBps('EXECUTABLE_VALUE', 20_000_000n, 60_000_000n)).toBe(20_000);
  });
});

describe('summariseOutcomes', () => {
  it('reports the unpriceable share, which is the number to read first', () => {
    const mix = summariseOutcomes([
      'EXECUTABLE_VALUE',
      'NO_ROUTE_CONFIRMED',
      'PROVIDER_MISSING',
      'PROVIDER_MISSING',
    ]);
    expect(mix.priceable).toBe(2);
    // A reject study where half the horizons are PROVIDER_MISSING is a study of
    // provider coverage wearing the name of a study of rejected tokens.
    expect(mix.unpriceableFraction).toBe(0.5);
    expect(mix.counts.PROVIDER_MISSING).toBe(2);
  });

  it('treats an empty set as wholly unpriceable rather than perfect', () => {
    expect(summariseOutcomes([]).unpriceableFraction).toBe(1);
  });
});
