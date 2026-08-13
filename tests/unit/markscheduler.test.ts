import { describe, it, expect } from 'vitest';
import {
  scheduleMarks,
  assessBacklog,
  type MarkCandidate,
} from '../../packages/strategy/src/markscheduler.js';

/**
 * §12.4 — the scheduler, and the starvation it replaces.
 *
 * `openShadowPositions(db).slice(0, cap)` sorted by `opened_utc_ms`, so with 179
 * open shadows and a per-cycle cap the same oldest positions were marked every
 * cycle and the newest were never marked at all. A position with no marks looks
 * exactly like a position whose value did not move.
 */

const INTERVAL = 10_000;
const NOW = 1_000_000;

const c = (over: Partial<MarkCandidate> & { id: string }): MarkCandidate => ({
  openedUtcMs: NOW - 60_000,
  lastMarkUtcMs: NOW - 11_000,
  blocked: false,
  nearTrigger: false,
  ...over,
});

describe('scheduleMarks', () => {
  it('does NOT order by age', () => {
    // The whole defect. The oldest position here is the least overdue, and an
    // age sort would mark it first every cycle forever.
    const out = scheduleMarks(
      [
        c({ id: 'ancient-but-fresh', openedUtcMs: 0, lastMarkUtcMs: NOW - 1_000 }),
        c({ id: 'new-and-overdue', openedUtcMs: NOW - 5_000, lastMarkUtcMs: NOW - 90_000 }),
      ],
      INTERVAL,
      NOW,
    );
    expect(out[0]?.id).toBe('new-and-overdue');
  });

  it('puts a blocked position first, because it needs watching more not less', () => {
    const out = scheduleMarks(
      [
        c({ id: 'very-overdue', lastMarkUtcMs: NOW - 500_000 }),
        c({ id: 'blocked', lastMarkUtcMs: NOW - 11_000, blocked: true }),
      ],
      INTERVAL,
      NOW,
    );
    expect(out[0]?.id).toBe('blocked');
    expect(out[0]?.urgency).toBe('BLOCKED');
  });

  it('puts a near-trigger position ahead of a merely overdue one', () => {
    // A mark near a stop can still change what happens. A mark on something
    // sitting mid-range cannot, however late it is.
    const out = scheduleMarks(
      [
        c({ id: 'overdue', lastMarkUtcMs: NOW - 500_000 }),
        c({ id: 'near', lastMarkUtcMs: NOW - 11_000, nearTrigger: true }),
      ],
      INTERVAL,
      NOW,
    );
    expect(out[0]?.id).toBe('near');
  });

  it('treats a never-marked position as due since it opened', () => {
    // Maximally overdue, not least. It has no marks at all.
    const out = scheduleMarks(
      [
        c({ id: 'marked-recently', lastMarkUtcMs: NOW - 11_000 }),
        c({ id: 'never-marked', openedUtcMs: NOW - 300_000, lastMarkUtcMs: null }),
      ],
      INTERVAL,
      NOW,
    );
    expect(out[0]?.id).toBe('never-marked');
    expect(out[0]?.lagMs).toBe(300_000);
  });

  it('breaks a tie by preferring the NEWER position', () => {
    // A young memecoin moves fastest, so its mark decays quickest and a stale
    // one is more wrong.
    const out = scheduleMarks(
      [
        c({ id: 'older', openedUtcMs: NOW - 900_000, lastMarkUtcMs: NOW - 50_000 }),
        c({ id: 'newer', openedUtcMs: NOW - 20_000, lastMarkUtcMs: NOW - 50_000 }),
      ],
      INTERVAL,
      NOW,
    );
    expect(out[0]?.id).toBe('newer');
  });

  it('counts missed intervals rather than just lateness', () => {
    const [only] = scheduleMarks([c({ id: 'x', lastMarkUtcMs: NOW - 55_000 })], INTERVAL, NOW);
    // Due at now-45,000, so 45,000 late = 4 whole intervals missed.
    expect(only?.lagMs).toBe(45_000);
    expect(only?.missedMarks).toBe(4);
  });

  it('marks something not yet due as NOT_DUE and ranks it last', () => {
    const out = scheduleMarks(
      [c({ id: 'fresh', lastMarkUtcMs: NOW - 1_000 }), c({ id: 'due', lastMarkUtcMs: NOW - 20_000 })],
      INTERVAL,
      NOW,
    );
    expect(out[1]?.urgency).toBe('NOT_DUE');
    expect(out[1]?.missedMarks).toBe(0);
  });

  it('returns every candidate, so a caller can report what it skipped', () => {
    // A scheduler that silently drops the tail is how a backlog stays invisible.
    const many = Array.from({ length: 50 }, (_, i) => c({ id: `p${i}` }));
    expect(scheduleMarks(many, INTERVAL, NOW)).toHaveLength(50);
  });
});

describe('assessBacklog', () => {
  it('says plainly when the book cannot be maintained', () => {
    const due = Array.from({ length: 179 }, (_, i) => c({ id: `p${i}`, lastMarkUtcMs: NOW - 60_000 }));
    const state = assessBacklog(scheduleMarks(due, INTERVAL, NOW), 12, NOW);
    expect(state.overCapacity).toBe(true);
    expect(state.due).toBe(179);
    expect(state.marked).toBe(12);
    expect(state.skipped).toBe(167);
    expect(state.detail).toContain('Stop opening new shadows');
  });

  it('reports the worst lag and the total misses, not an average', () => {
    // An average hides the position that has not been marked in an hour.
    const state = assessBacklog(
      scheduleMarks([c({ id: 'a', lastMarkUtcMs: NOW - 11_000 }), c({ id: 'b', lastMarkUtcMs: NOW - 610_000 })], INTERVAL, NOW),
      10,
      NOW,
    );
    expect(state.worstLagMs).toBe(600_000);
    expect(state.totalMissedMarks).toBe(60);
  });

  it('is content when capacity covers what is due', () => {
    const state = assessBacklog(scheduleMarks([c({ id: 'a' })], INTERVAL, NOW), 10, NOW);
    expect(state.overCapacity).toBe(false);
    expect(state.skipped).toBe(0);
  });
});
