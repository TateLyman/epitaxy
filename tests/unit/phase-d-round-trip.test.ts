import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  COVERAGE_REPORT_THRESHOLD,
  COVERAGE_STOP_THRESHOLD,
  conditionsOf,
  coverageOf,
  coverageVerdict,
  phaseDState,
  roundTripAggregate,
  type Conditions,
  type RoundTripCellRow,
} from '../../packages/research/src/copier-lag.js';

/**
 * Phase D §1–§3 — the paired round trip, and the coverage gate in front of it.
 *
 * The failure modes this guards against:
 *
 *   1. charging the cost floor to an open position entered at -1.0, which reports a
 *      loss larger than the capital deployed;
 *   2. letting the coverage rule be applied by judgement. The directive says a cell
 *      under 70% is not reported as an estimate, and the temptation to make an
 *      exception arrives only after seeing which cells look good, so the threshold
 *      is a constant and the verdict is a function;
 *   3. crediting condition 2 on an arm where it cannot be evaluated — the gated arms,
 *      where query 7 returns open positions as one count per cell rather than broken
 *      out by gate;
 *   4. collapsing "the treatments disagree" into "the answer is no".
 */

const row = (over: Partial<RoundTripCellRow> = {}): RoundTripCellRow => ({
  nFollowable: 200,
  nBoth: 100,
  nOpenEntryPriced: 40,
  sumRet: 20,
  sumRetSq: 500,
  ...over,
});

describe('roundTripAggregate', () => {
  const floor = 0.02669;

  it('charges the floor only to the round trips that happened', () => {
    expect(roundTripAggregate(row(), 'CLOSED_ONLY', floor)).toEqual({ n: 100, sum: 20 - floor * 100 });
    expect(roundTripAggregate(row(), 'OPEN_AT_MINUS_100', floor)).toEqual({
      n: 140,
      sum: 20 - floor * 100 - 40,
    });
  });

  it('cannot report a loss worse than total on an all-open cell', () => {
    const a = roundTripAggregate(row({ nBoth: 0, sumRet: 0, nOpenEntryPriced: 40 }), 'OPEN_AT_MINUS_100', floor);
    expect(a.sum / a.n).toBe(-1);
  });

  it('collapses to one estimate when nothing is open', () => {
    const closed = roundTripAggregate(row({ nOpenEntryPriced: 0 }), 'CLOSED_ONLY', floor);
    const open = roundTripAggregate(row({ nOpenEntryPriced: 0 }), 'OPEN_AT_MINUS_100', floor);
    expect(open).toEqual(closed);
  });

  it('moves the open treatment monotonically down as more positions stay open', () => {
    const mean = (n: number): number => {
      const a = roundTripAggregate(row({ nOpenEntryPriced: n }), 'OPEN_AT_MINUS_100', floor);
      return a.sum / a.n;
    };
    expect(mean(0)).toBeGreaterThan(mean(10));
    expect(mean(10)).toBeGreaterThan(mean(100));
  });
});

describe('the coverage gate', () => {
  it('uses the directive\'s thresholds, not the data\'s', () => {
    expect(COVERAGE_REPORT_THRESHOLD).toBe(0.9);
    expect(COVERAGE_STOP_THRESHOLD).toBe(0.7);
  });

  it('computes coverage against followable, not against priced', () => {
    expect(coverageOf(row({ nFollowable: 200, nBoth: 100 }))).toBeCloseTo(0.5, 12);
    expect(coverageOf(row({ nFollowable: 0 }))).toBeNull();
  });

  it('classifies the three bands, with the boundaries inclusive upward', () => {
    expect(coverageVerdict(0.95)).toBe('OK');
    expect(coverageVerdict(0.9)).toBe('OK');
    expect(coverageVerdict(0.8999)).toBe('BELOW_REPORT_THRESHOLD');
    expect(coverageVerdict(0.7)).toBe('BELOW_REPORT_THRESHOLD');
    expect(coverageVerdict(0.6999)).toBe('BELOW_STOP_THRESHOLD');
    expect(coverageVerdict(null)).toBe('BELOW_STOP_THRESHOLD');
  });
});

describe('phaseDState', () => {
  const c = (over: Partial<Conditions>): Conditions => ({
    c1: false,
    c2: true,
    c3: true,
    c4: false,
    copyable: false,
    ...over,
  });

  it('separates a decision from an absence of one', () => {
    // All conditions fail but the treatments AGREE: that is a decision.
    expect(phaseDState([c({ c2: true })])).toBe('NO_COPYABLE_LAG');
    // A disagreement is not an answer, and must not be reported as one.
    expect(phaseDState([c({ c2: false })])).toBe('UNDECIDABLE_CENSORING');
  });

  it('names a copyable lag when one exists, over either other state', () => {
    expect(phaseDState([c({ c2: false }), c({ copyable: true })])).toBe('COPYABLE_LAG_IDENTIFIED');
  });
});

describe('condition 2 on an arm where it cannot be evaluated', () => {
  it('fails rather than passes when the open treatment is absent', () => {
    const base = { asPricedPoint: 0.24, asPricedLower: 0.09, venue: 'pumpswap', n: 10_000, requiredN: 500 };
    expect(conditionsOf({ ...base, censoredPoint: 0.05 }).c2).toBe(true);
    expect(conditionsOf({ ...base, censoredPoint: null }).c2).toBe(false);
    expect(conditionsOf({ ...base, censoredPoint: null }).copyable).toBe(false);
  });
});

const ARTIFACT = 'artifacts/phase-d-round-trip.json';

describe('the Phase D artifact', () => {
  if (!existsSync(ARTIFACT)) {
    it.skip('artifact absent — run pnpm rt:copy', () => {});
    return;
  }
  const a = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as {
    state: string;
    primaryFloor: number;
    lags: number[];
    utcDays: number;
    rollingRerankRan: boolean;
    reserveReconstructionRan: boolean;
    coverageThresholds: { report: number; stop: number };
    gates: { label: string; reserveX: number | null; impactThreshold: number | null }[];
    cells: {
      venue: string;
      gate: string;
      lagSeconds: number;
      followable: number;
      both: number;
      open: number;
      openEntryPriced: number;
      kept: number;
      coverage: number | null;
      coverageVerdict: string;
      reportable: boolean;
      closedOnly: { point: number | null; lower: number };
      openAtMinus100: { point: number | null } | null;
      conditions: { c1: boolean; c2: boolean; c3: boolean; c4: boolean };
      copyable: boolean;
    }[];
  };

  it('carries the frozen grid, the tier-0 floor and the gate mapping', () => {
    expect(a.lags).toEqual([2, 5, 15, 30, 60, 300]);
    expect(a.primaryFloor).toBeCloseTo(0.02669, 12);
    expect(a.utcDays).toBe(30);
    expect(a.coverageThresholds).toEqual({ report: 0.9, stop: 0.7 });
    // MT084's 2x/X mapping, asserted rather than trusted to a comment.
    const byLabel = new Map(a.gates.map((g) => [g.label, g]));
    expect(byLabel.get('DEPTH<=1%')?.impactThreshold).toBeCloseTo(0.02, 12);
    expect(byLabel.get('DEPTH<=3%')?.impactThreshold).toBeCloseTo(0.06, 12);
    expect(byLabel.get('DEPTH<=10%')?.impactThreshold).toBeCloseTo(0.2, 12);
    expect(byLabel.get('UNGATED')?.impactThreshold).toBeNull();
  });

  it('records that the deferred work did not run, rather than leaving it ambiguous', () => {
    expect(a.rollingRerankRan).toBe(false);
    expect(a.reserveReconstructionRan).toBe(false);
  });

  it('keeps coverage consistent with its own counts and verdict', () => {
    for (const c of a.cells) {
      if (c.followable === 0) continue;
      expect(c.coverage as number).toBeCloseTo(c.both / c.followable, 10);
      const expected =
        (c.coverage as number) < 0.7 ? 'BELOW_STOP_THRESHOLD' : (c.coverage as number) < 0.9 ? 'BELOW_REPORT_THRESHOLD' : 'OK';
      expect(c.coverageVerdict).toBe(expected);
      expect(c.reportable).toBe(expected !== 'BELOW_STOP_THRESHOLD');
    }
  });

  it('leaves the open treatment absent on gated arms and present on ungated ones', () => {
    for (const c of a.cells) {
      if (c.gate === 'UNGATED') expect(c.openAtMinus100).not.toBeNull();
      else expect(c.openAtMinus100).toBeNull();
    }
  });

  it('never credits condition 2 where the open treatment is absent', () => {
    for (const c of a.cells.filter((x) => x.openAtMinus100 === null)) expect(c.conditions.c2).toBe(false);
  });

  it('keeps a gate as a subset: kept never exceeds the ungated priced count', () => {
    const ungated = new Map(
      a.cells.filter((c) => c.gate === 'UNGATED').map((c) => [`${c.venue}|${c.lagSeconds}|${c.coverage}`, c.both]),
    );
    for (const c of a.cells.filter((x) => x.gate !== 'UNGATED')) {
      const key = `${c.venue}|${c.lagSeconds}|${c.coverage}`;
      const cap = ungated.get(key);
      if (cap !== undefined) expect(c.kept).toBeLessThanOrEqual(cap);
    }
  });

  it('marks no cell copyable unless every condition passed', () => {
    for (const c of a.cells) {
      expect(c.copyable).toBe(c.conditions.c1 && c.conditions.c2 && c.conditions.c3 && c.conditions.c4);
    }
  });

  it('never marks a bonding-curve cell copyable', () => {
    for (const c of a.cells.filter((x) => x.venue !== 'pumpswap')) {
      expect(c.conditions.c3).toBe(false);
      expect(c.copyable).toBe(false);
    }
  });

  it('decides the state on reportable, ungated, primary cells only', () => {
    const primary = a.cells.filter((c) => c.venue === 'pumpswap' && c.gate === 'UNGATED' && c.reportable);
    expect(primary.length).toBeGreaterThan(0);
    const expected = primary.some((c) => c.copyable)
      ? 'COPYABLE_LAG_IDENTIFIED'
      : primary.some((c) => !c.conditions.c2)
        ? 'UNDECIDABLE_CENSORING'
        : 'NO_COPYABLE_LAG';
    expect(a.state).toBe(expected);
  });

  it('has no cell whose coverage failed yet whose estimate is treated as reportable', () => {
    const contradictions = a.cells.filter((c) => c.coverageVerdict === 'BELOW_STOP_THRESHOLD' && c.reportable);
    expect(contradictions).toEqual([]);
  });
});
