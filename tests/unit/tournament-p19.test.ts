import { describe, it, expect } from 'vitest';
import {
  ARMS,
  ENTRY_ARMS,
  EXIT_ARMS,
  CHECKPOINTS,
  allocateArm,
  armId,
  judgeArm,
  type ArmObservation,
} from '../../packages/domain/src/tournament.js';

/**
 * P19 — the tournament, preregistered and allocated but not yet run.
 *
 * The whole value of a preregistration is that it was written before the data.
 * These tests fix the arms, the checkpoints and the elimination rule in place
 * so a later change to any of them is a visible, deliberate act rather than a
 * quiet adjustment made while looking at a result.
 */

const baseline: ArmObservation = {
  completedTrajectories: 60,
  netLamports: 5_000_000n,
  netWithoutTopThreeLamports: 2_000_000n,
  catastrophicCount: 1,
  blockedExitCount: 2,
  mechanicsDragBps: 250,
  grossEdgeBps: 900,
  validTrajectoriesPerDay: 8,
  distinctMints: 30,
  distinctUtcDays: 9,
  topMintShare: 0.2,
  topDayShare: 0.2,
};

describe('P19 — the arm set is frozen', () => {
  it('is three entry policies by two exit policies', () => {
    expect(ENTRY_ARMS.length).toBe(3);
    expect(EXIT_ARMS.length).toBe(2);
    expect(ARMS.length).toBe(6);
  });

  it('has no parameter grid', () => {
    // Three distinct hypotheses, not one hypothesis tuned six ways. A grid
    // spends the alpha on the tuning rather than on the question.
    expect(new Set(ENTRY_ARMS).size).toBe(ENTRY_ARMS.length);
    expect(ENTRY_ARMS).toContain('HARD_GATES_RANDOM');
  });

  it('keeps a control that cannot be tuned', () => {
    expect(EXIT_ARMS).toContain('FIXED_TIME_CONTROL');
  });

  it('fixes the checkpoints', () => {
    expect(CHECKPOINTS.INSTRUMENT_SANITY).toBe(10);
    expect(CHECKPOINTS.SIZE_COST_SANITY).toBe(25);
    expect(CHECKPOINTS.EARLY_ELIMINATION).toBe(50);
    expect(CHECKPOINTS.SELECTION_PERMITTED).toBe(100);
  });
});

describe('P19 — allocation is balanced and blind to the candidate', () => {
  it('fills every cell before repeating one', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < ARMS.length; i++) {
      const arm = allocateArm(counts);
      counts.set(armId(arm), (counts.get(armId(arm)) ?? 0) + 1);
    }
    expect(counts.size).toBe(ARMS.length);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it('always gives the next trajectory to the least-filled cell', () => {
    const counts = new Map<string, number>(ARMS.map((a) => [armId(a), 5]));
    const starved = armId(ARMS[3] as (typeof ARMS)[number]);
    counts.set(starved, 1);
    expect(armId(allocateArm(counts))).toBe(starved);
  });

  it('is deterministic, so a restart does not reshuffle the allocation', () => {
    const counts = new Map<string, number>([[armId(ARMS[0] as (typeof ARMS)[number]), 3]]);
    expect(armId(allocateArm(counts))).toBe(armId(allocateArm(counts)));
  });

  it('takes nothing about the candidate as input', () => {
    // Enforced by the signature: there is nowhere to pass a score, a liquidity
    // or an age. Allocating on any of them would measure each arm on a
    // different population.
    expect(allocateArm.length).toBe(1);
  });
});

describe('P19 — an arm is not judged before its checkpoint', () => {
  it('withholds judgement below 50 trajectories', () => {
    const v = judgeArm({ ...baseline, completedTrajectories: 49, netLamports: -9_000_000n });
    expect(v.eligibleForElimination).toBe(false);
    expect(v.eliminate).toBe(false);
  });

  it('judges at 50', () => {
    expect(judgeArm({ ...baseline, completedTrajectories: 50 }).eligibleForElimination).toBe(true);
  });
});

describe('P19 — the elimination rules, each on its own', () => {
  it('keeps an arm that clears everything', () => {
    const v = judgeArm(baseline);
    expect(v.eliminate).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it('kills a net-negative arm', () => {
    expect(judgeArm({ ...baseline, netLamports: -1n }).reasons).toContain('NET_NEGATIVE_AFTER_ALL_COSTS');
  });

  it('kills an arm that is only positive because of three trades', () => {
    expect(judgeArm({ ...baseline, netWithoutTopThreeLamports: -1n }).reasons).toContain(
      'NEGATIVE_WITHOUT_TOP_THREE',
    );
  });

  it('kills an arm whose edge does not clear the mechanics floor', () => {
    // The number the size surface measured. An edge below it is a cost.
    expect(judgeArm({ ...baseline, grossEdgeBps: 240, mechanicsDragBps: 250 }).reasons).toContain(
      'MECHANICS_DRAG_CONSUMES_EDGE',
    );
  });

  it('kills an arm carried by one mint', () => {
    expect(judgeArm({ ...baseline, topMintShare: 0.8 }).reasons).toContain('ONE_MINT_OR_DAY_CARRIES_RESULT');
  });

  it('kills an arm carried by one day', () => {
    expect(judgeArm({ ...baseline, topDayShare: 0.9 }).reasons).toContain('ONE_MINT_OR_DAY_CARRIES_RESULT');
  });

  it('kills an arm that cannot produce labels fast enough to be evaluated', () => {
    expect(judgeArm({ ...baseline, validTrajectoriesPerDay: 1 }).reasons).toContain(
      'VALID_LABEL_THROUGHPUT_TOO_LOW',
    );
  });

  it('kills an arm whose exits are too often blocked', () => {
    expect(judgeArm({ ...baseline, blockedExitCount: 30 }).reasons).toContain(
      'BLOCKED_EXIT_INCIDENCE_UNACCEPTABLE',
    );
  });

  it('gives no special protection to the original thesis', () => {
    // "Do not protect the original 2m-60m thesis" is enforced by there being no
    // branch that could. A losing arm is judged by the same function whatever
    // it is called.
    for (const entry of ENTRY_ARMS) {
      void entry;
      expect(judgeArm({ ...baseline, netLamports: -1n }).eliminate).toBe(true);
    }
  });
});
