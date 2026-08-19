import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  censoredWide,
  coefficientOfVariation,
  conditionsOf,
  followable,
  phaseCState,
  treatmentAggregate,
  type Conditions,
  type CopierCellRow,
} from '../../packages/research/src/copier-lag.js';
import { requiredPositions } from '../../packages/domain/src/confirmatory.js';

/**
 * Phase C §3 — MT079's four conditions, and the arithmetic underneath them.
 *
 * The ways this rule could be quietly defeated, each of which has a test below:
 *
 *   1. charging the cost floor to a censored position, which reports a loss larger
 *      than the capital deployed and makes the censored treatment look worse than
 *      total loss;
 *   2. giving the two treatments different denominators, which turns a statement
 *      about CENSORING into a statement about two different populations and makes
 *      the sign-agreement condition meaningless;
 *   3. computing the CV on the GROSS return, which understates the required sample
 *      because the floor shrinks a small positive mean and inflates the CV;
 *   4. treating a null estimate as a passed condition, so a cell with no data
 *      reads as a clearance;
 *   5. collapsing "the data cannot answer" into "the answer is no".
 */

const row = (over: Partial<CopierCellRow> = {}): CopierCellRow => ({
  n: 100,
  nCensored: 50,
  nWide: 120,
  sumCopierRet: 20,
  sumCopierRetSq: 500,
  sumCopierRetWide: 12,
  ...over,
});

describe('treatmentAggregate', () => {
  it('charges the floor only to positions that traded', () => {
    const r = row();
    const floor = 0.02669;
    // AS_PRICED: 100 positions summing to +20, less the floor on each.
    expect(treatmentAggregate(r, 'AS_PRICED', floor)).toEqual({ n: 100, sum: 20 - floor * 100 });
    // CENSORED: the same 100 traded positions, plus 50 at exactly -1. The floor is
    // NOT charged to the censored 50 — a total loss already includes every cost.
    const cen = treatmentAggregate(r, 'CENSORED', floor);
    expect(cen).toEqual({ n: 150, sum: 20 - floor * 100 - 50 });
    // The censored mean can never be below -1, which is the point of not charging
    // the floor twice.
    const allDead = treatmentAggregate(row({ n: 0, sumCopierRet: 0, nCensored: 50 }), 'CENSORED', floor);
    expect(allDead.sum / allDead.n).toBe(-1);
  });

  it('gives the two treatments the SAME denominator, so the pair is about censoring', () => {
    const r = row();
    expect(treatmentAggregate(r, 'CENSORED', 0).n).toBe(followable(r));
    expect(treatmentAggregate(r, 'CENSORED_WIDE', 0).n).toBe(followable(r));
    expect(followable(r)).toBe(150);
  });

  it('derives the wide-window censored count from the followable set', () => {
    expect(censoredWide(row({ n: 100, nCensored: 50, nWide: 120 }))).toBe(30);
    // A wide count larger than the followable set would be a query defect. Clamped,
    // rather than silently producing a negative count that still looks plausible.
    expect(censoredWide(row({ n: 100, nCensored: 50, nWide: 999 }))).toBe(0);
  });

  it('reduces to the pooled mean when the floor is zero and nothing is censored', () => {
    const a = treatmentAggregate(row({ nCensored: 0 }), 'AS_PRICED', 0);
    const b = treatmentAggregate(row({ nCensored: 0 }), 'CENSORED', 0);
    expect(a).toEqual(b);
    expect(a.sum / a.n).toBeCloseTo(0.2, 12);
  });

  it('prices the wide window on its own count, not on the narrow one', () => {
    const r = row();
    const w = treatmentAggregate(r, 'AS_PRICED_WIDE', 0.02669);
    expect(w.n).toBe(120);
    expect(w.sum).toBeCloseTo(12 - 0.02669 * 120, 12);
  });
});

describe('coefficientOfVariation', () => {
  it('is computed on the NET return, so the floor raises the required sample', () => {
    // mean 0.20 gross; SD from sum_sq: E[x^2]=5, mean^2=0.04, var=4.96, sd=2.227
    const rows = [row({ nCensored: 0 })];
    const gross = coefficientOfVariation(rows, 0) as number;
    const net = coefficientOfVariation(rows, 0.02669) as number;
    expect(gross).toBeCloseTo(Math.sqrt(5 - 0.04) / 0.2, 6);
    // Subtracting a constant leaves the variance and shrinks the mean, so the CV
    // rises and the required n rises with its square.
    expect(net).toBeGreaterThan(gross);
    expect(requiredPositions(net) as number).toBeGreaterThan(requiredPositions(gross) as number);
  });

  it('returns null rather than infinity when the mean is zero or n is too small', () => {
    expect(coefficientOfVariation([row({ n: 1 })], 0)).toBeNull();
    expect(coefficientOfVariation([row({ n: 100, sumCopierRet: 0, sumCopierRetSq: 500 })], 0)).toBeNull();
    expect(coefficientOfVariation([], 0)).toBeNull();
  });

  it('never returns a negative variance from floating-point cancellation', () => {
    // A cell where every observation is identical: variance is exactly zero, and a
    // naive E[x^2] - mean^2 can land slightly below it.
    const cv = coefficientOfVariation([{ ...row({ nCensored: 0 }), sumCopierRet: 100, sumCopierRetSq: 100 }], 0);
    expect(cv).not.toBeNull();
    expect(cv as number).toBeGreaterThanOrEqual(0);
  });
});

describe('conditionsOf', () => {
  const base = {
    asPricedPoint: 0.2,
    asPricedLower: 0.1,
    censoredPoint: 0.05,
    venue: 'pumpswap',
    n: 10_000,
    requiredN: 500,
  };

  it('passes only when all four hold', () => {
    expect(conditionsOf(base).copyable).toBe(true);
    expect(conditionsOf({ ...base, asPricedLower: -0.01 }).copyable).toBe(false);
    expect(conditionsOf({ ...base, censoredPoint: -0.3 }).copyable).toBe(false);
    expect(conditionsOf({ ...base, venue: 'pumpdotfun' }).copyable).toBe(false);
    expect(conditionsOf({ ...base, n: 100 }).copyable).toBe(false);
  });

  it('fails a sign disagreement — the condition H2 failed — regardless of the interval', () => {
    const c = conditionsOf({ ...base, asPricedPoint: 0.24, asPricedLower: 0.09, censoredPoint: -0.33 });
    expect(c.c1).toBe(true);
    expect(c.c2).toBe(false);
    expect(c.copyable).toBe(false);
  });

  it('treats a null estimate as a failure and never as a clearance', () => {
    const c = conditionsOf({ ...base, asPricedPoint: null, censoredPoint: null });
    expect(c.c1).toBe(false);
    expect(c.c2).toBe(false);
    expect(c.copyable).toBe(false);
  });

  it('does not count a lower bound of exactly zero as above zero', () => {
    expect(conditionsOf({ ...base, asPricedLower: 0 }).c1).toBe(false);
  });

  it('requires the venue this apparatus can enter, whatever the curve returns', () => {
    expect(conditionsOf({ ...base, venue: 'pumpdotfun', asPricedPoint: 3.4, asPricedLower: 2.0 }).c3).toBe(false);
  });

  it('fails the power condition when the CV is undefined', () => {
    expect(conditionsOf({ ...base, requiredN: null }).c4).toBe(false);
  });
});

describe('phaseCState', () => {
  const c = (over: Partial<Conditions>): Conditions => ({
    c1: false,
    c2: true,
    c3: true,
    c4: false,
    copyable: false,
    ...over,
  });

  it('names a copyable lag when one exists', () => {
    expect(phaseCState([c({}), c({ copyable: true })])).toBe('COPYABLE_LAG_IDENTIFIED');
  });

  it('does not collapse "cannot answer" into "the answer is no"', () => {
    expect(phaseCState([c({ c2: false })])).toBe('UNDECIDABLE_CENSORING');
    expect(phaseCState([c({ c2: true })])).toBe('EDGE_IS_EXECUTION_ONLY');
  });

  it('prefers a copyable cell over an undecidable one, and undecidable over closed', () => {
    expect(phaseCState([c({ c2: false }), c({ copyable: true })])).toBe('COPYABLE_LAG_IDENTIFIED');
    expect(phaseCState([c({ c2: false }), c({ c2: true })])).toBe('UNDECIDABLE_CENSORING');
  });
});

/**
 * The artifact, asserted against the file rather than against the printed table —
 * the same convention Phase A and Phase B used, and the reason their claims are
 * still checkable.
 */
const ARTIFACT = 'artifacts/phase-c-lag-sweep.json';

describe('the Phase C artifact', () => {
  if (!existsSync(ARTIFACT)) {
    it.skip('artifact absent — run pnpm lag:sweep', () => {});
    return;
  }
  const a = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as {
    state: string;
    primaryFloor: number;
    lags: number[];
    utcDays: number;
    cells: {
      venue: string;
      lagSeconds: number;
      topFraction: number;
      rankStat: string;
      priced: number;
      censored: number;
      followable: number;
      pricedWide: number;
      censoredWide: number;
      conditions: { c1: boolean; c2: boolean; c3: boolean; c4: boolean };
      copyable: boolean;
      asPriced: { point: number | null };
      censoredTreatment: { point: number | null };
      entrySlippage: number | null;
    }[];
  };

  it('carries the frozen lag grid and the tier-0 floor', () => {
    expect(a.lags).toEqual([2, 5, 15, 30, 60, 300]);
    expect(a.primaryFloor).toBeCloseTo(0.02669, 12);
    expect(a.utcDays).toBe(30);
  });

  it('reports a state the directive defines', () => {
    expect(['COPYABLE_LAG_IDENTIFIED', 'UNDECIDABLE_CENSORING', 'EDGE_IS_EXECUTION_ONLY']).toContain(a.state);
  });

  it('keeps the followable identity: priced + censored = followable, in every cell', () => {
    for (const c of a.cells) expect(c.priced + c.censored).toBe(c.followable);
  });

  it('keeps the wide identity: pricedWide + censoredWide = followable, in every cell', () => {
    for (const c of a.cells) expect(c.pricedWide + c.censoredWide).toBe(c.followable);
  });

  it('admits the wide window as a superset of the narrow one', () => {
    for (const c of a.cells) expect(c.pricedWide).toBeGreaterThanOrEqual(c.priced);
  });

  it('marks no cell copyable unless every condition passed', () => {
    for (const c of a.cells) {
      const all = c.conditions.c1 && c.conditions.c2 && c.conditions.c3 && c.conditions.c4;
      expect(c.copyable).toBe(all);
    }
  });

  it('never marks a bonding-curve cell copyable, whatever it returns', () => {
    for (const c of a.cells.filter((x) => x.venue !== 'pumpswap')) {
      expect(c.conditions.c3).toBe(false);
      expect(c.copyable).toBe(false);
    }
  });

  it('agrees with the state it recorded', () => {
    const primary = a.cells.filter((c) => c.venue === 'pumpswap');
    expect(primary.length).toBeGreaterThan(0);
    const expected = primary.some((c) => c.copyable)
      ? 'COPYABLE_LAG_IDENTIFIED'
      : primary.some((c) => !c.conditions.c2)
        ? 'UNDECIDABLE_CENSORING'
        : 'EDGE_IS_EXECUTION_ONLY';
    expect(a.state).toBe(expected);
  });

  it('has entry slippage rising with lag on the primary arm, which is the direction physics allows', () => {
    // Not a decision, a sanity check: a copier that waits longer cannot systematically
    // get a BETTER price than one that waits less, averaged over 30 days. If this
    // inverted, the entry windows would be misaligned.
    for (const rankStat of ['MEAN', 'MEDIAN']) {
      const arm = a.cells
        .filter((c) => c.venue === 'pumpswap' && c.rankStat === rankStat && c.topFraction === 0.01)
        .sort((x, y) => x.lagSeconds - y.lagSeconds);
      expect(arm.length).toBe(6);
      const first = arm[0]?.entrySlippage as number;
      const last = arm[arm.length - 1]?.entrySlippage as number;
      expect(last).toBeGreaterThan(first);
    }
  });
});
