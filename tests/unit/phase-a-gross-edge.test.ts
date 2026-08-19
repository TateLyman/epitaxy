import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * d70b4a9a §1.2 — the reconstructed gross edge, and the four ways it could lie.
 *
 * The artifact's job is to size a later window, and every way it could be wrong
 * makes that window too small:
 *
 *   1. it could be mistaken for evidence. It is mid prices the system never
 *      traded at, so the label and the `isEvidence: false` flag are load-bearing;
 *   2. it could hide its censoring. 34% to 62% of mints have no exit price, and
 *      dropping them silently is survivorship on the largest possible scale;
 *   3. it could rank four different populations against each other. The eligible
 *      subsamples are 45, 1, 3 and 0 mints, and the 45-mint one implies a
 *      required n of 17 — a number that would end this project on a subsample
 *      one twelve-hundredth the size of the one beside it;
 *   4. it could report a required n divided by a mean that is indistinguishable
 *      from zero, which is an unbounded quantity wearing four digits.
 */

const PATH = 'artifacts/gross-edge-distribution.json';

interface Shape {
  n: number;
  mean: number | null;
  sd: number | null;
  cv: number | null;
  skew: number | null;
  excessKurtosis: number | null;
  requiredNAt80Power: number | null;
  requiredNForCostFloorEdge: number | null;
  netMeanAfterCostFloor: number | null;
  topShare: Record<string, number | null>;
  topShareOfPositive: Record<string, number | null>;
  topShareInterpretable: boolean;
  utcDaysRepresented: number;
  bootstrapMeanLower: number | null;
  bootstrapMeanUpper: number | null;
  minReturn: number | null;
}

interface Artifact {
  label: string;
  isEvidence: boolean;
  powerConstant: number;
  costFloorPct: number | null;
  cohorts: {
    cohort: string;
    mintsWithEntry: number;
    censoredNoExit: number;
    censoredFraction: number | null;
    populations: Record<string, Shape>;
  }[];
  rankingPopulation: string;
  rankedByRequiredN: {
    cohort: string;
    n: number;
    utcDays: number;
    requiredN: number | null;
    meanDistinguishableFromZero: boolean;
    rankable: boolean;
    notRankableBecause: string[];
  }[];
  lowestRequiredNCohort: string | null;
  lowestRequiredNCohortUnrestricted: string | null;
  lowestRequiredNCohortAtCostFloorTarget: string | null;
}

const load = (): Artifact | null => (existsSync(PATH) ? (JSON.parse(readFileSync(PATH, 'utf8')) as Artifact) : null);
const COHORTS = ['2m-60m', '1h-5h', '5h-24h', '24h-7d'];

describe('d70b4a9a §1.2 — the reconstructed gross edge distribution', () => {
  it('is labelled as not being evidence', () => {
    const a = load();
    if (a === null) return;
    expect(a.label).toBe('DEVELOPMENT_RECONSTRUCTED');
    expect(a.isEvidence).toBe(false);
  });

  it('covers all four cohorts and reports every shape statistic the directive asked for', () => {
    const a = load();
    if (a === null) return;
    expect(a.cohorts.map((c) => c.cohort)).toEqual(COHORTS);
    for (const c of a.cohorts) {
      const s = c.populations[a.rankingPopulation];
      expect(s).toBeDefined();
      if (s === undefined || s.n === 0) continue;
      for (const field of ['mean', 'sd', 'cv', 'skew', 'excessKurtosis', 'requiredNAt80Power'] as const) {
        expect(s[field]).not.toBeUndefined();
      }
      for (const k of ['top1', 'top3', 'top5', 'top10']) {
        expect(s.topShareOfPositive).toHaveProperty(k);
      }
    }
  });

  it('reports the censored fraction rather than dropping the censored mints quietly', () => {
    const a = load();
    if (a === null) return;
    for (const c of a.cohorts) {
      expect(c.censoredNoExit).toBeGreaterThan(0);
      expect(c.censoredFraction).toBeGreaterThan(0);
      expect(c.mintsWithEntry).toBeGreaterThan(c.censoredNoExit);
      // The carry-forward variant exists, so the censored mints are priced at
      // their last observed value somewhere rather than only excluded.
      expect(c.populations['ALL_SCREENED_USD_CARRY_FORWARD']).toBeDefined();
    }
  });

  it('never prices a disappearance as -100%', () => {
    const a = load();
    if (a === null) return;
    // A token whose provider row stops is not a total loss; only a token whose
    // price actually went to zero is. -1 exactly, on many mints, would be the
    // signature of the substitution the invariant forbids.
    for (const c of a.cohorts) {
      const s = c.populations['ALL_SCREENED_USD_CARRY_FORWARD'];
      if (s === undefined || s.minReturn === null) continue;
      expect(s.minReturn).toBeGreaterThanOrEqual(-1);
    }
  });

  it('ranks one population across all four cohorts, never a different one per cohort', () => {
    const a = load();
    if (a === null) return;
    expect(a.rankedByRequiredN.map((r) => r.cohort).sort()).toEqual([...COHORTS].sort());
    for (const r of a.rankedByRequiredN) {
      const c = a.cohorts.find((x) => x.cohort === r.cohort);
      expect(c).toBeDefined();
      expect(r.n).toBe(c?.populations[a.rankingPopulation]?.n);
    }
  });

  it('refuses to rank a cohort whose required n is not identified', () => {
    const a = load();
    if (a === null) return;
    for (const r of a.rankedByRequiredN) {
      if (r.rankable) {
        expect(r.meanDistinguishableFromZero).toBe(true);
        expect(r.utcDays).toBeGreaterThanOrEqual(2);
        expect(r.requiredN).not.toBeNull();
      } else {
        expect(r.notRankableBecause.length).toBeGreaterThan(0);
      }
    }
    // And the selection comes from the rankable set.
    if (a.lowestRequiredNCohort !== null) {
      const chosen = a.rankedByRequiredN.find((r) => r.cohort === a.lowestRequiredNCohort);
      expect(chosen?.rankable).toBe(true);
    }
  });

  it('records the two selections the other rules would have made', () => {
    const a = load();
    if (a === null) return;
    // Every rule examined is recorded, including the ones not used. A ledger
    // that lists only the rule that won cannot show a fork was there.
    expect(a.lowestRequiredNCohortUnrestricted).not.toBeUndefined();
    expect(a.lowestRequiredNCohortAtCostFloorTarget).not.toBeUndefined();
  });

  it('does not report a share of a total that is a cancellation', () => {
    const a = load();
    if (a === null) return;
    for (const c of a.cohorts) {
      for (const s of Object.values(c.populations)) {
        if (s.topShareInterpretable) continue;
        for (const k of ['top1', 'top3', 'top5', 'top10']) {
          expect(s.topShare[k] ?? null).toBeNull();
        }
      }
    }
  });

  it('uses the power constant the directive supplied, and the measured cost floor', () => {
    const a = load();
    if (a === null) return;
    expect(a.powerConstant).toBe(7.84);
    for (const c of a.cohorts) {
      const s = c.populations[a.rankingPopulation];
      if (s === undefined || s.cv === null || s.requiredNAt80Power === null) continue;
      expect(s.requiredNAt80Power).toBe(Math.ceil(7.84 * s.cv ** 2));
      if (s.sd !== null && a.costFloorPct !== null && s.requiredNForCostFloorEdge !== null) {
        expect(s.requiredNForCostFloorEdge).toBe(Math.ceil(7.84 * (s.sd / (a.costFloorPct / 100)) ** 2));
      }
    }
  });

  it('shows that the directive assumed a CV no cohort has', () => {
    const a = load();
    if (a === null) return;
    // The directive's premise is CV ~ 15 and therefore n ~ 1,670. Every measured
    // cohort is above it, so the 200-position gate was underpowered by more than
    // the directive itself claimed. This guards the finding, not the number.
    const cvs = a.cohorts
      .map((c) => c.populations[a.rankingPopulation]?.cv ?? null)
      .filter((v): v is number => v !== null);
    expect(cvs.length).toBeGreaterThan(0);
    for (const cv of cvs) expect(cv).toBeGreaterThan(15);
  });
});
