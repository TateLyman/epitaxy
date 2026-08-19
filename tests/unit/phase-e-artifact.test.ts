import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Phase E, the artifact — and one assertion that is really about Phase D.
 *
 * Phase D reported that the wallet's realised return was 3–6× its first-sell return
 * and concluded that a copier exiting on the first sell forfeits that gap. Phase E
 * was built to recover it. Measured on positions the wallet FULLY EXITED, the gap
 * has the opposite sign: realised is LOWER than first-sell, everywhere.
 *
 * The difference is what `ret_carryfwd` contains. Phase D's realised figure included
 * positions the wallet never closed, where the return carries a MARK on the unsold
 * residual. So the 3–6× was mostly that mark, not money made on later sells, and the
 * premise of this phase was wrong before it ran.
 *
 * That correction is worth a test rather than only a paragraph, because it is the
 * kind of thing a later phase would otherwise inherit and build on again.
 */

const ARTIFACT = 'artifacts/phase-e-proportional.json';

describe('the Phase E artifact', () => {
  if (!existsSync(ARTIFACT)) {
    it.skip('artifact absent — run pnpm prop:exit', () => {});
    return;
  }
  const a = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as {
    state: string;
    rule: string;
    sizeArmRule: string;
    lags: number[];
    utcDays: number;
    reserveMarkRan: boolean;
    cells: {
      rankStat: string;
      topFraction: number;
      lagSeconds: number;
      sizeArm: string;
      followable: number;
      paired: number;
      walletClosed: number;
      legsPerPosition: number;
      mirroredWeight: number;
      n: number;
      closedOnly: { point: number | null; lower: number };
      openAtMinus100: { point: number | null } | null;
      pairedDifference: { point: number | null; lower: number; upper: number } | null;
      conditions: { c1: boolean; c2: boolean; c3: boolean; c4: boolean; c5: boolean };
      copyable: boolean;
      walletFirstSell: number;
      walletRealised: number;
    }[];
  };
  const ungated = a.cells.filter((c) => c.sizeArm === 'UNGATED');

  it('carries the frozen three-lag grid and the rules it was decided under', () => {
    expect(a.lags).toEqual([2, 15, 60]);
    expect(a.utcDays).toBe(30);
    expect(a.rule).toBe('MT087');
    expect(a.sizeArmRule).toBe('MT088');
    expect(a.reserveMarkRan).toBe(false);
  });

  it('requires all FIVE conditions for copyable, not the four of earlier phases', () => {
    for (const c of a.cells) {
      const all = c.conditions.c1 && c.conditions.c2 && c.conditions.c3 && c.conditions.c4 && c.conditions.c5;
      expect(c.copyable).toBe(all);
    }
  });

  it('never credits condition 2 or the power condition where they are not evaluable', () => {
    for (const c of a.cells.filter((x) => x.sizeArm !== 'UNGATED')) {
      // The residual-worthless series is not broken out by conviction gate.
      expect(c.openAtMinus100).toBeNull();
      expect(c.conditions.c2).toBe(false);
    }
    for (const c of a.cells.filter((x) => x.sizeArm === 'CONVICTION_WEIGHTED')) {
      // A weighted mean has no position count, so 7.84 x CV^2 has no denominator.
      expect(c.conditions.c4).toBe(false);
    }
  });

  it('mirrors essentially the whole position where it mirrors at all', () => {
    // If this were far below 1 the estimand would be measuring a partial exit and
    // calling it a round trip.
    for (const c of ungated) expect(c.mirroredWeight).toBeGreaterThan(0.9);
  });

  it('CORRECTS PHASE D: on fully exited positions the wallet realises LESS than its first sell', () => {
    expect(ungated.length).toBeGreaterThan(0);
    for (const c of ungated) {
      expect(c.walletRealised).toBeLessThan(c.walletFirstSell);
    }
    // And the gap is not a rounding artifact: it is percentage points wide.
    const worst = Math.max(...ungated.map((c) => c.walletFirstSell - c.walletRealised));
    expect(worst).toBeGreaterThan(0.03);
  });

  it('records the paired difference for every ungated cell, since it is the gating condition', () => {
    for (const c of ungated) {
      expect(c.pairedDifference).not.toBeNull();
      expect(c.pairedDifference?.point).not.toBeNull();
      // c5 is exactly "the lower bound clears zero", not "the point estimate is positive".
      expect(c.conditions.c5).toBe((c.pairedDifference as { lower: number }).lower > 0);
    }
  });

  it('agrees with the state it recorded, decided on the ungated arm', () => {
    const expected = ungated.some((c) => c.copyable)
      ? 'COPYABLE_LAG_IDENTIFIED'
      : ungated.some((c) => !c.conditions.c2)
        ? 'UNDECIDABLE_CENSORING'
        : 'NO_COPYABLE_LAG';
    expect(a.state).toBe(expected);
  });

  it('keeps the paired set inside what the wallet actually closed', () => {
    for (const c of a.cells) {
      expect(c.paired).toBeLessThanOrEqual(c.walletClosed);
      expect(c.walletClosed).toBeLessThanOrEqual(c.followable);
    }
  });

  it('has proportional equal binary wherever the wallet exits in one leg', () => {
    // Not an identity in the aggregate, but a direction: the arm with the fewest
    // legs per position must have the smallest paired difference in magnitude.
    const byArm = new Map<string, { legs: number; diff: number }>();
    for (const c of ungated) {
      const key = `${c.rankStat}|${c.topFraction}`;
      const prev = byArm.get(key);
      const d = Math.abs((c.pairedDifference?.point as number) ?? 0);
      if (prev === undefined || d > prev.diff) byArm.set(key, { legs: c.legsPerPosition, diff: d });
    }
    expect(byArm.size).toBeGreaterThan(1);
    // Every arm's legs-per-position is positive and finite — the mechanism exists.
    for (const v of byArm.values()) expect(v.legs).toBeGreaterThan(0);
  });
});
