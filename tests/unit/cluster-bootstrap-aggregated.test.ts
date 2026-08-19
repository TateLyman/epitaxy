import { describe, it, expect } from 'vitest';
import {
  clusterBootstrap,
  clusterBootstrapAggregated,
  clusterBootstrapDifference,
  type ClusterAggregate,
  type MintOutcome,
} from '../../packages/research/src/robust-stats.js';

/**
 * The aggregated day-clustered bootstrap has to be the SAME estimator as the one
 * Phase B used, not an approximation of it, because MT073's decision rule is a
 * lower bound and the two phases' intervals are compared to each other.
 *
 * The claim being tested is exact: a cluster bootstrap of a mean depends on the
 * rows only through each cluster's (n, sum), so computing it from (n, sum) is a
 * change of representation and not of statistic.
 */

const outcome = (utcDay: string, i: number, logReturn: number): MintOutcome => ({
  mint: `${utcDay}-${i}`,
  utcDay,
  logReturn,
  netPnlLamports: 0n,
  catastrophic: false,
  blockedExit: false,
});

/** Deliberately uneven: different counts per day, one huge value, one empty-ish day. */
const PANEL: Record<string, number[]> = {
  '2026-07-01': [0.1, -0.2, 0.35, -0.05],
  '2026-07-02': [-0.4],
  '2026-07-03': [1.9, -0.3, -0.3, -0.3, -0.3, -0.3],
  '2026-07-04': [0.02, 0.03],
  '2026-07-05': [-0.9, -0.85, -0.95],
  '2026-07-06': [12.5, -0.99, -0.99, -0.99, -0.99],
};

const rows: MintOutcome[] = Object.entries(PANEL).flatMap(([day, xs]) =>
  xs.map((x, i) => outcome(day, i, x)),
);
const aggs: ClusterAggregate[] = Object.entries(PANEL).map(([day, xs]) => ({
  cluster: day,
  n: xs.length,
  sum: xs.reduce((a, b) => a + b, 0),
}));

describe('clusterBootstrapAggregated', () => {
  it('reproduces clusterBootstrap exactly on the same sample', () => {
    const full = clusterBootstrap(rows, 'UTC_DAY', 500);
    const agg = clusterBootstrapAggregated(aggs, 500);
    expect(agg.resamples).toBe(full.resamples);
    expect(agg.point as number).toBeCloseTo(full.point as number, 12);
    expect(agg.lower).toBeCloseTo(full.lower, 12);
    expect(agg.upper).toBeCloseTo(full.upper, 12);
  });

  it('is invariant to how a day distributes its rows, since only (n, sum) enter', () => {
    // Same per-day n and sum, wildly different within-day values.
    const flattened: MintOutcome[] = aggs.flatMap((a) =>
      Array.from({ length: a.n }, (_, i) => outcome(a.cluster, i, a.sum / a.n)),
    );
    const a = clusterBootstrap(rows, 'UTC_DAY', 400);
    const b = clusterBootstrap(flattened, 'UTC_DAY', 400);
    expect(b.point as number).toBeCloseTo(a.point as number, 12);
    expect(b.lower).toBeCloseTo(a.lower, 12);
    expect(b.upper).toBeCloseTo(a.upper, 12);
  });

  it('weights by n, so the point estimate is the pooled mean and not the mean of day means', () => {
    const pooled = clusterBootstrapAggregated(
      [
        { cluster: 'a', n: 1, sum: 1 },
        { cluster: 'b', n: 99, sum: 0 },
      ],
      200,
    );
    expect(pooled.point as number).toBeCloseTo(0.01, 12);
  });

  it('folds duplicate cluster keys rather than treating them as separate days', () => {
    const split = clusterBootstrapAggregated(
      [
        { cluster: 'd', n: 2, sum: 0.4 },
        { cluster: 'd', n: 3, sum: -0.9 },
      ],
      200,
    );
    const one = clusterBootstrapAggregated([{ cluster: 'd', n: 5, sum: -0.5 }], 200);
    expect(split.point as number).toBeCloseTo(one.point as number, 12);
    // A single cluster has no between-cluster variation, so the interval collapses.
    expect(split.lower).toBeCloseTo(split.upper, 12);
  });

  it('returns a null point and no resamples on an empty or all-zero-n panel', () => {
    expect(clusterBootstrapAggregated([], 100).point).toBeNull();
    expect(clusterBootstrapAggregated([{ cluster: 'x', n: 0, sum: 0 }], 100).resamples).toBe(0);
  });

  it('widens when the between-day spread widens, at fixed n', () => {
    const tight = clusterBootstrapAggregated(
      Array.from({ length: 20 }, (_, i) => ({ cluster: `d${i}`, n: 10, sum: 1 })),
      800,
    );
    const wide = clusterBootstrapAggregated(
      Array.from({ length: 20 }, (_, i) => ({ cluster: `d${i}`, n: 10, sum: i % 2 === 0 ? 11 : -9 })),
      800,
    );
    expect(tight.point as number).toBeCloseTo(wide.point as number, 9);
    expect(wide.upper - wide.lower).toBeGreaterThan(tight.upper - tight.lower);
  });
});

describe('clusterBootstrapDifference', () => {
  it('is paired: a common day effect cancels instead of inflating the interval', () => {
    // Day effect of +/- 5, and a constant gap of 1 on every day. The difference
    // is 1 with no uncertainty; an unpaired interval would be enormous.
    const dayEffect = [5, -5, 5, -5, 5, -5, 5, -5];
    const a = dayEffect.map((e, i) => ({ cluster: `d${i}`, n: 10, sum: 10 * (e + 1) }));
    const b = dayEffect.map((e, i) => ({ cluster: `d${i}`, n: 10, sum: 10 * e }));
    const d = clusterBootstrapDifference(a, b, 1_000);
    expect(d.point as number).toBeCloseTo(1, 9);
    expect(d.lower).toBeCloseTo(1, 6);
    expect(d.upper).toBeCloseTo(1, 6);
    expect(d.daysBothPresent).toBe(8);

    // The same two cohorts bootstrapped independently: each side's own interval
    // spans the day effect, so a difference of two of them cannot resolve a gap
    // of 1. This is the failure the paired form avoids.
    const ia = clusterBootstrapAggregated(a, 1_000);
    const ib = clusterBootstrapAggregated(b, 1_000);
    expect(ia.upper - ia.lower).toBeGreaterThan(3);
    expect(ib.upper - ib.lower).toBeGreaterThan(3);
  });

  it('brackets zero when the two cohorts are the same population', () => {
    const same = Array.from({ length: 12 }, (_, i) => ({ cluster: `d${i}`, n: 8, sum: (i % 3) - 1 }));
    const d = clusterBootstrapDifference(same, same, 800);
    expect(d.point as number).toBeCloseTo(0, 12);
    expect(d.lower).toBeLessThanOrEqual(0);
    expect(d.upper).toBeGreaterThanOrEqual(0);
  });

  it('counts unpaired days honestly and still returns an estimate', () => {
    const a = [
      { cluster: 'd1', n: 5, sum: 1 },
      { cluster: 'd2', n: 5, sum: 1 },
      { cluster: 'd3', n: 5, sum: 1 },
    ];
    const b = [
      { cluster: 'd2', n: 5, sum: 0 },
      { cluster: 'd3', n: 5, sum: 0 },
    ];
    const d = clusterBootstrapDifference(a, b, 400);
    expect(d.daysBothPresent).toBe(2);
    expect(d.point as number).toBeCloseTo(0.2, 12);
    expect(d.resamples).toBeGreaterThan(0);
  });

  it('is deterministic: the same panel gives the same interval twice', () => {
    const a = Array.from({ length: 9 }, (_, i) => ({ cluster: `d${i}`, n: 4 + i, sum: i - 3 }));
    const b = Array.from({ length: 9 }, (_, i) => ({ cluster: `d${i}`, n: 7, sum: 1 - i }));
    const x = clusterBootstrapDifference(a, b, 600);
    const y = clusterBootstrapDifference(a, b, 600);
    expect(y.lower).toBe(x.lower);
    expect(y.upper).toBe(x.upper);
  });
});
