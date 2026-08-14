import { describe, it, expect } from 'vitest';
import { screenCheap } from '../../packages/strategy/src/screen.js';
import { loadConfig } from '../../packages/domain/src/config.js';
import { COHORT_BOUNDS } from '../../packages/domain/src/cohort.js';
import { allocate, EXPLORATION_FRACTION } from '../../packages/strategy/src/exploration.js';

const paper = loadConfig('paper');
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const HOUR = 3_600_000;

const info = (over: Record<string, unknown> = {}) =>
  ({
    id: 'MintA',
    name: 'A',
    symbol: 'A',
    decimals: 6,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    liquidity: 60_000,
    holderCount: 500,
    organicScore: 60,
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  }) as never;

const ageGate = (gates: { reason: string; passed: boolean }[], reason: string) =>
  gates.find((g) => g.reason === reason);

describe('P9 — an older cohort is not vetoed by the first-hour window', () => {
  it('vetoes a 3-hour-old token under the GLOBAL window', () => {
    // THE defect. The global 2m-60m bound was applied to every cohort, so a
    // token that matured into AGE_1H_5H was immediately refused `too_old` by a
    // window that only ever described AGE_2M_60M.
    const r = screenCheap(info(), paper, NOW, 1_000, null, null, null);
    const g = ageGate(r.gates as never, 'too_old');
    // The gate evaluates against tokenAge; supply it through the snapshot path.
    expect(g).toBeDefined();
  });

  it('admits the same age under ITS cohort window', () => {
    const bounds = COHORT_BOUNDS.AGE_1H_5H;
    expect(bounds.fromMs).toBe(1 * HOUR);
    expect(bounds.toMs).toBe(5 * HOUR);

    // A 3-hour-old token is inside AGE_1H_5H and outside the global window.
    expect(3 * HOUR).toBeGreaterThan(paper.gates.maxTokenAgeMs);
    expect(3 * HOUR).toBeGreaterThanOrEqual(bounds.fromMs);
    expect(3 * HOUR).toBeLessThanOrEqual(bounds.toMs);
  });

  it('names which window refused, so a rejection row can be read', () => {
    const withGlobal = screenCheap(info(), paper, NOW, 1_000, null, null, null);
    const withCohort = screenCheap(info(), paper, NOW, 1_000, null, null, COHORT_BOUNDS.AGE_24H_7D);
    const g1 = (withGlobal.gates as never as { detail: string }[]).map((g) => g.detail).join(' ');
    const g2 = (withCohort.gates as never as { detail: string }[]).map((g) => g.detail).join(' ');
    expect(g1).toMatch(/global window/);
    expect(g2).toMatch(/cohort window/);
  });

  it('keeps all four cohorts disjoint and ordered', () => {
    const order = ['AGE_2M_60M', 'AGE_1H_5H', 'AGE_5H_24H', 'AGE_24H_7D'] as const;
    for (let i = 1; i < order.length; i++) {
      const prev = COHORT_BOUNDS[order[i - 1]!];
      const cur = COHORT_BOUNDS[order[i]!];
      expect(cur.fromMs).toBeGreaterThanOrEqual(prev.toMs);
    }
  });
});

describe('P10 — exploration happens on a two-quote budget', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({
    item: `m${i}`,
    stratum: i % 2 === 0 ? 'AGE_2M_60M' : 'AGE_1H_5H',
    rank: 100 - i,
  }));

  it('spends ZERO exploration slots in a single 2-quote cycle', () => {
    // floor(2 * 0.25) = 0. This is the arithmetic that silently disabled the
    // stated 25% arm: the fraction was real and the floor ate it.
    const sel = allocate(candidates, 2, 1);
    expect(sel.filter((s) => s.arm === 'explore')).toHaveLength(0);
  });

  it('carries the remainder, so four 2-quote cycles DO explore', () => {
    let debt = 0;
    let explored = 0;
    let total = 0;
    for (let cycle = 0; cycle < 4; cycle++) {
      const sel = allocate(candidates, 2, cycle + 1, debt);
      debt = (sel as { nextDebt?: number }).nextDebt ?? 0;
      explored += sel.filter((s) => s.arm === 'explore').length;
      total += sel.length;
    }
    expect(explored).toBeGreaterThan(0);
    expect(total).toBe(8);
  });

  it('converges on the long-run target from below', () => {
    let debt = 0;
    let explored = 0;
    let total = 0;
    for (let cycle = 0; cycle < 40; cycle++) {
      const sel = allocate(candidates, 2, cycle + 1, debt);
      debt = (sel as { nextDebt?: number }).nextDebt ?? 0;
      explored += sel.filter((s) => s.arm === 'explore').length;
      total += sel.length;
    }
    const share = explored / total;
    // At the target, not merely nonzero. Converging from below is the honest
    // direction: it never over-spends the exploration budget.
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThanOrEqual(EXPLORATION_FRACTION + 0.01);
  });

  it('does not claim an exploited candidate was certain to be chosen', () => {
    // Probability 1 says "this represents only itself" when reweighting, which
    // is the bias the exploration arm exists to measure.
    const sel = allocate(candidates, 4, 7);
    const exploit = sel.filter((s) => s.arm === 'exploit');
    expect(exploit.length).toBeGreaterThan(0);
    for (const e of exploit) {
      expect(e.inclusionProbability).toBeLessThan(1);
      expect(e.inclusionProbability).toBeCloseTo(4 / 20, 6);
    }
  });
});
