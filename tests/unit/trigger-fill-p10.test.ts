import { describe, it, expect } from 'vitest';
import { resolveFill, FROZEN_FILL_LATENCY_MS, lookAheadBiasLamports } from '../../packages/domain/src/fill-latency.js';
import { MANAGED_STATES } from '../../packages/storage/src/observation-repo.js';

/**
 * P10 — a trigger is not a fill.
 *
 * The engine observed a route, decided to exit, and closed against that same
 * observation: a fill at the instant of noticing, with no reaction, build,
 * simulation, signature or landing in between. The bias is systematically
 * favourable, because a policy fires exactly when the price is most extreme.
 */
const T = 1_000_000;

const cand = (over: Partial<Parameters<typeof resolveFill>[2][number]> = {}) => ({
  observationId: 'obs',
  observedUtcMs: T + FROZEN_FILL_LATENCY_MS,
  family: 'BUILD_CUSTOM',
  effectValid: true,
  executableLamports: 19_000_000n,
  ...over,
});

describe('P10 — the trigger observation can never be the fill', () => {
  it('refuses an observation at the trigger instant', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [cand({ observedUtcMs: T })]);
    expect(r.kind).toBe('blocked');
  });

  it('refuses one a millisecond short of the frozen latency', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [cand({ observedUtcMs: T + FROZEN_FILL_LATENCY_MS - 1 })]);
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.reason).toMatch(/at least 1200ms/);
  });

  it('fills at exactly the latency boundary', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [cand()]);
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') expect(r.latencyMs).toBe(FROZEN_FILL_LATENCY_MS);
  });

  it('refuses a fill in a different market', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [cand({ family: 'PUMP_DIRECT' })]);
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.reason).toMatch(/cross-family/);
  });

  it('refuses to inherit the trigger verdict: the fill must verify on its own', () => {
    const r = resolveFill(T, 'BUILD_CUSTOM', [cand({ effectValid: false })]);
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.reason).toMatch(/not effect-valid/);
  });

  it('refuses an unpriced fill rather than inventing a price', () => {
    // A fill at an unknown price is a number invented at the moment it matters
    // most.
    const r = resolveFill(T, 'BUILD_CUSTOM', [cand({ executableLamports: null })]);
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.reason).toMatch(/unpriced/);
  });

  it('takes the FIRST valid later observation, not the best one', () => {
    // Taking the best would be choosing the fill after seeing the outcomes,
    // which is the same look-ahead wearing a different hat.
    const r = resolveFill(T, 'BUILD_CUSTOM', [
      cand({ observationId: 'first', observedUtcMs: T + 1_300, executableLamports: 18_000_000n }),
      cand({ observationId: 'better', observedUtcMs: T + 5_000, executableLamports: 25_000_000n }),
    ]);
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') expect(r.at.observationId).toBe('first');
  });

  it('sizes the look-ahead bias rather than leaving it a reputation', () => {
    // Positive means filling at the trigger would have flattered the result.
    const fill = resolveFill(T, 'BUILD_CUSTOM', [cand()]);
    expect(lookAheadBiasLamports(21_000_000n, fill)).toBe(2_000_000n);
    // Unfilled has no bias to report, and null is not zero.
    const blocked = resolveFill(T, 'BUILD_CUSTOM', [cand({ observedUtcMs: T })]);
    expect(lookAheadBiasLamports(21_000_000n, blocked)).toBeNull();
  });

  it('keeps a triggered position in the managed set', () => {
    // It still HOLDS the tokens. Omitting it repeats the EXIT_BLOCKED mistake:
    // the state that most needs attention being the one nothing looks at.
    expect(MANAGED_STATES).toContain('AWAITING_FILL_OBSERVATION');
  });
});
