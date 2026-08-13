import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  holdsExposure,
  promote,
  currentClass,
  nearTrigger,
  schedulePriority,
  IllegalShadowTransition,
  type ShadowState,
  type EvidenceEvent,
} from '../../packages/domain/src/shadow-lifecycle.js';

/**
 * P11 — shadow lifecycles.
 *
 * A shadow may not close at its trigger observation, for the same reason a
 * portfolio position may not: the observation that says "get out" is not the
 * price you get out at.
 *
 * Evidence is immutable at each event. A position is promoted by appending a
 * new event, never by editing what an old one meant — otherwise a shadow opened
 * when nothing was effect-verified silently becomes valid the moment some later
 * run passes, and the corpus improves its own past.
 */

describe('P11 — the exit state machine', () => {
  it('cannot close at the trigger', () => {
    // THE rule. A machine that can skip from triggered to closed is a machine
    // that fills at the trigger price.
    expect(canTransition('EXIT_TRIGGERED', 'POSITION_CLOSED')).toBe(false);
    expect(() => assertTransition('EXIT_TRIGGERED', 'POSITION_CLOSED')).toThrow(IllegalShadowTransition);
    expect(() => assertTransition('EXIT_TRIGGERED', 'POSITION_CLOSED')).toThrow(/may not close at its trigger/);
  });

  it('must pass through awaiting-fill', () => {
    expect(canTransition('EXIT_TRIGGERED', 'AWAITING_FILL_OBSERVATION')).toBe(true);
    expect(canTransition('AWAITING_FILL_OBSERVATION', 'POSITION_CLOSED')).toBe(true);
  });

  it('can block while awaiting, and unblock later', () => {
    expect(canTransition('AWAITING_FILL_OBSERVATION', 'EXIT_BLOCKED')).toBe(true);
    // Blocked is not terminal: the tokens are still held and retries continue.
    expect(canTransition('EXIT_BLOCKED', 'AWAITING_FILL_OBSERVATION')).toBe(true);
  });

  it('cannot reopen a closed position', () => {
    for (const to of ['POSITION_OPEN', 'EXIT_TRIGGERED', 'EXIT_BLOCKED'] as ShadowState[]) {
      expect(canTransition('POSITION_CLOSED', to)).toBe(false);
    }
  });

  it('cannot skip from open straight to closed', () => {
    expect(canTransition('POSITION_OPEN', 'POSITION_CLOSED')).toBe(false);
  });

  it('every state except closed still carries exposure', () => {
    // Including EXIT_BLOCKED. A position that cannot be closed is exposure
    // whatever its state column says.
    for (const s of ['POSITION_OPEN', 'EXIT_TRIGGERED', 'AWAITING_FILL_OBSERVATION', 'EXIT_BLOCKED'] as ShadowState[]) {
      expect(holdsExposure(s), s).toBe(true);
    }
    expect(holdsExposure('POSITION_CLOSED')).toBe(false);
  });
});

describe('P11 — evidence is appended, never rewritten', () => {
  const ev = (evidenceClass: EvidenceEvent['evidenceClass'], at = 1): EvidenceEvent => ({
    at,
    evidenceClass,
    reason: 'r',
  });

  it('promotes by appending a new event', () => {
    const h = promote([ev('STRUCTURAL_ONLY')], ev('JIT_EFFECT_VALID', 2));
    expect(h).toHaveLength(2);
    // The history stays readable: what was believed at the time is still there.
    expect(h[0]?.evidenceClass).toBe('STRUCTURAL_ONLY');
    expect(currentClass(h)).toBe('JIT_EFFECT_VALID');
  });

  it('re-asserting the same class is a no-op, not a duplicate row', () => {
    const h = promote([ev('JIT_EFFECT_VALID')], ev('JIT_EFFECT_VALID', 2));
    expect(h).toHaveLength(1);
  });

  it('REFUSES a silent demotion', () => {
    // An earlier claim being wrong is a correction, not a promotion, and it
    // must be made deliberately rather than as a side effect of a re-run.
    expect(() => promote([ev('CONFIRMATORY')], ev('STRUCTURAL_ONLY', 2))).toThrow(/refusing to silently demote/);
  });

  it('an empty history is structural, not undefined', () => {
    expect(currentClass([])).toBe('STRUCTURAL_ONLY');
  });
});

describe('P11 — nearTrigger uses distance, not peak alone', () => {
  const base = {
    executableLamports: 20_000_000n,
    peakLamports: 20_000_000n,
    costLamports: 20_000_000n,
    stopBps: 2_500,
    trailBps: 3_000,
    takeProfitBps: 6_000,
    ageMs: 0,
    maxHoldMs: 1_800_000,
  };

  it('an unpriced position is the MOST urgent thing there is', () => {
    // A position nobody can value is one nobody can exit, and it stays that
    // way until somebody looks.
    expect(nearTrigger({ ...base, executableLamports: null })).toBe(0);
  });

  it('a position just above its stop is more urgent than one at its peak', () => {
    const atPeak = nearTrigger(base);
    const nearStop = nearTrigger({ ...base, executableLamports: 15_200_000n, peakLamports: 20_000_000n });
    // The old rule was peak alone, which made the position LEAST likely to
    // need attention look the most urgent.
    expect(nearStop).toBeLessThan(atPeak);
  });

  it('counts time to max hold on the same scale', () => {
    const fresh = nearTrigger(base);
    const old = nearTrigger({ ...base, ageMs: 1_700_000 });
    expect(old).toBeLessThan(fresh);
  });

  it('a position near its take-profit is urgent too', () => {
    // Urgency is not only about losses: a target reached and not acted on is
    // a target missed.
    const near = nearTrigger({ ...base, executableLamports: 31_000_000n });
    expect(near).toBeLessThan(nearTrigger(base));
  });
});

describe('P11 — scheduling order', () => {
  it('puts blocked first, then triggered, then near-trigger, then the rest', () => {
    const blocked = schedulePriority('EXIT_BLOCKED', 9_000, 0);
    const triggered = schedulePriority('EXIT_TRIGGERED', 9_000, 0);
    const near = schedulePriority('POSITION_OPEN', 100, 0);
    const far = schedulePriority('POSITION_OPEN', 9_000, 0);
    expect(blocked).toBeLessThan(triggered);
    expect(triggered).toBeLessThan(near);
    expect(near).toBeLessThan(far);
  });

  it('within a tier, the most overdue goes first', () => {
    expect(schedulePriority('POSITION_OPEN', 9_000, 60_000)).toBeLessThan(
      schedulePriority('POSITION_OPEN', 9_000, 1_000),
    );
  });
});
