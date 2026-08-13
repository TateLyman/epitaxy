import { describe, it, expect } from 'vitest';
import {
  resolveFill,
  lookAheadBiasLamports,
  FROZEN_FILL_LATENCY_MS,
  type FillCandidate,
} from '../../packages/domain/src/fill-latency.js';

/**
 * P10 — the trigger observation is never its own fill.
 *
 * A stop that triggers at T and fills at T's price is a backtest that reacts
 * instantly and at no cost. Real execution has to notice, build, sign and land,
 * and the price moves during all four.
 *
 * The bias runs one way: the faster the price is falling, the larger the gap
 * between the trigger and the fill. Filling at the trigger makes every stop look
 * like it worked and makes a collapse look survivable.
 */

const T = 1_760_000_000_000;

const obs = (over: Partial<FillCandidate> = {}): FillCandidate => ({
  observationId: 'o',
  observedUtcMs: T,
  family: 'BUILD_CUSTOM',
  effectValid: true,
  executableLamports: 1_000_000n,
  ...over,
});

describe('P10 — the trigger cannot fill itself', () => {
  it('refuses an observation at the trigger instant', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [obs({ observationId: 'trigger', observedUtcMs: T })]);
    expect(r.kind).toBe('blocked');
  });

  it('refuses one inside the frozen latency', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [obs({ observedUtcMs: T + FROZEN_FILL_LATENCY_MS - 1 })]);
    expect(r.kind).toBe('blocked');
    expect(r.kind === 'blocked' && r.reason).toMatch(/at least 1200ms/);
  });

  it('fills on the first observation past the latency', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [
      obs({ observationId: 'too-soon', observedUtcMs: T + 500 }),
      obs({ observationId: 'fill', observedUtcMs: T + 1_500 }),
      obs({ observationId: 'later', observedUtcMs: T + 9_000 }),
    ]);
    expect(r.kind).toBe('filled');
    expect(r.kind === 'filled' && r.at.observationId).toBe('fill');
    expect(r.kind === 'filled' && r.latencyMs).toBe(1_500);
  });
});

describe('P10 — the fill observation stands on its own', () => {
  it('skips a cross-family observation', () => {
    // A fill in a different family is a fill in a different market.
    const r = resolveFill(T, 'BUILD_CUSTOM', [
      obs({ observedUtcMs: T + 2_000, family: 'ORDER_EXECUTE' }),
      obs({ observationId: 'ok', observedUtcMs: T + 3_000 }),
    ]);
    expect(r.kind === 'filled' && r.at.observationId).toBe('ok');
  });

  it('skips one whose own effect did not verify', () => {
    // Inheriting the trigger's verdict would mean filling against a price
    // nobody verified.
    const r = resolveFill(T, 'BUILD_CUSTOM', [
      obs({ observedUtcMs: T + 2_000, effectValid: false }),
      obs({ observationId: 'ok', observedUtcMs: T + 3_000 }),
    ]);
    expect(r.kind === 'filled' && r.at.observationId).toBe('ok');
  });

  it('skips an unpriced observation', () => {
    // Null is an unknown. A fill at an unknown price is a number invented at
    // the moment it matters most.
    const r = resolveFill(T, 'BUILD_CUSTOM', [
      obs({ observedUtcMs: T + 2_000, executableLamports: null }),
      obs({ observationId: 'ok', observedUtcMs: T + 3_000 }),
    ]);
    expect(r.kind === 'filled' && r.at.observationId).toBe('ok');
  });

  it('blocks when later observations exist and none qualifies, and says why', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [
      obs({ observedUtcMs: T + 2_000, family: 'ORDER_EXECUTE' }),
      obs({ observedUtcMs: T + 3_000, effectValid: false }),
      obs({ observedUtcMs: T + 4_000, executableLamports: null }),
    ]);
    expect(r.kind).toBe('blocked');
    expect(r.kind === 'blocked' && r.reason).toMatch(/1 cross-family/);
    expect(r.kind === 'blocked' && r.reason).toMatch(/1 not effect-valid/);
    expect(r.kind === 'blocked' && r.reason).toMatch(/1 unpriced/);
  });

  it('blocks on an empty candidate list rather than inventing a fill', () => {
    expect(resolveFill(T, 'BUILD_CUSTOM', []).kind).toBe('blocked');
  });
});

describe('P10 — the look-ahead has a size, not a reputation', () => {
  it('reports what filling at the trigger would have been worth', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [obs({ observedUtcMs: T + 2_000, executableLamports: 800_000n })]);
    // Triggered at 1,000,000 and filled at 800,000: the instant-fill backtest
    // would have booked 200,000 lamports that never existed.
    expect(lookAheadBiasLamports(1_000_000n, r)).toBe(200_000n);
  });

  it('is negative when the price moved in our favour, which does happen', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [obs({ observedUtcMs: T + 2_000, executableLamports: 1_200_000n })]);
    expect(lookAheadBiasLamports(1_000_000n, r)).toBe(-200_000n);
  });

  it('is null when there was no fill to compare against', () => {
    expect(lookAheadBiasLamports(1_000_000n, { kind: 'blocked', reason: 'x' })).toBeNull();
  });

  it('is null when either side is unpriced, rather than zero', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [obs({ observedUtcMs: T + 2_000 })]);
    expect(lookAheadBiasLamports(null, r)).toBeNull();
  });
});

describe('P10 — the latency is frozen', () => {
  it('is stated once and is not optimistic', () => {
    // Notice on the next mark, build, simulate, sign, submit, land. A figure
    // chosen to flatter the strategy silently rewrites every exit in the
    // corpus, so it is pinned here and moves only through the ledger.
    expect(FROZEN_FILL_LATENCY_MS).toBe(1_200);
  });
});
