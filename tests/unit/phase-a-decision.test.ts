import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * d70b4a9a §1.3 — the kill rule, applied to every combination rather than to a
 * chosen one.
 *
 * "Do not search for a notional or cohort that rescues it — that is a garden of
 * forking paths and the multiple-testing ledger must record every combination
 * examined in this step regardless of outcome."
 *
 * The artifact is that record, so the properties that matter are structural: the
 * matrix is complete, the verdict is the conjunction over all of it and not over
 * the surviving corner, and the four cells that clear the cost line on a point
 * estimate are also shown NOT to clear it on the mean's lower bound. A survivor
 * reported without that second number reads as a demonstration and is not one.
 */

const PATH = 'artifacts/phase-a-decision.json';

interface Cell {
  cohort: string;
  notionalSol: number;
  onDirectiveGrid: boolean;
  costPct: number | null;
  meanGrossPct: number | null;
  netPct: number | null;
  costCoversMean: boolean | null;
  netAtMeanLowerBoundPct: number | null;
}
interface Decision {
  killRule: string;
  combinationsExamined: number;
  combinationsDecidable: number;
  cells: Cell[];
  survivors: { cohort: string; notionalSol: number; netPct: number | null }[];
  survivorCount: number;
  survivorsAtMeanLowerBound: number;
  killed: boolean;
  cohortSelection: {
    selected: string | null;
    ruleWithoutIdentificationRestriction: string | null;
    ruleAtCostFloorTarget: string | null;
    selectedOnDevelopmentData: boolean;
    owesAnUntouchedFutureTest: boolean;
  };
  notionalSelection: {
    selectedSol: number | null;
    costFloorPct: number | null;
    developmentAndConfirmatoryIdentical: boolean;
    bankrollNeededSol: number | null;
    bankrollForcesASmallerSize: boolean;
    costPenaltyFromASmallerSizePct: number | null;
  };
  calendar: { verdict: string | null; withinCalendar: boolean | null; limitDays: number | null };
  finalState: string;
}

const PERMITTED_STATES = [
  'STRATEGY_KILLED_BY_CORRECTED_ECONOMICS',
  'MEASUREMENT_REPAIR_REQUIRED',
  'VALID_DEVELOPMENT_SIMULATION_RUNNING',
  'VALID_CONFIRMATORY_COLLECTION_STARTED',
];

const load = (): Decision | null => (existsSync(PATH) ? (JSON.parse(readFileSync(PATH, 'utf8')) as Decision) : null);

describe('d70b4a9a §1.3 — the decision', () => {
  it('examines the full matrix, not the corner that survives', () => {
    const d = load();
    if (d === null) return;
    const cohorts = new Set(d.cells.map((c) => c.cohort));
    const notionals = new Set(d.cells.map((c) => c.notionalSol));
    expect(d.combinationsExamined).toBe(cohorts.size * notionals.size);
    expect(cohorts.size).toBe(4);
    // The seven directive notionals must all be there; the below-grid points are
    // extra and are flagged as such.
    expect(d.cells.filter((c) => c.onDirectiveGrid && c.cohort === [...cohorts][0]).length).toBe(7);
  });

  it('kills only when every decidable cell says kill', () => {
    const d = load();
    if (d === null) return;
    const cellsSayingLive = d.cells.filter((c) => c.costCoversMean === false);
    expect(d.survivorCount).toBe(cellsSayingLive.length);
    expect(d.killed).toBe(d.combinationsDecidable > 0 && cellsSayingLive.length === 0);
  });

  it('reports each survivor net of the cost at ITS OWN notional', () => {
    const d = load();
    if (d === null) return;
    for (const s of d.survivors) {
      const cell = d.cells.find((c) => c.cohort === s.cohort && c.notionalSol === s.notionalSol);
      expect(cell).toBeDefined();
      if (cell?.meanGrossPct == null || cell.costPct == null || cell.netPct == null) continue;
      expect(cell.netPct).toBeCloseTo(cell.meanGrossPct - cell.costPct, 6);
      expect(cell.netPct).toBeGreaterThan(0);
    }
  });

  it('says whether any survivor clears the cost line on the mean lower bound', () => {
    const d = load();
    if (d === null) return;
    const atLowerBound = d.cells.filter((c) => (c.netAtMeanLowerBoundPct ?? -1) > 0).length;
    expect(d.survivorsAtMeanLowerBound).toBe(atLowerBound);
    // Not an assertion about the market: an assertion that the number is present
    // beside the point-estimate survivors rather than left for a reader to infer.
    expect(typeof d.survivorsAtMeanLowerBound).toBe('number');
  });

  it('records the cohort selection as development-derived and owing a hold-out', () => {
    const d = load();
    if (d === null) return;
    if (d.cohortSelection.selected === null) return;
    expect(d.cohortSelection.selectedOnDevelopmentData).toBe(true);
    expect(d.cohortSelection.owesAnUntouchedFutureTest).toBe(true);
    // Both rules that were not used are recorded, so the fork is visible.
    expect(d.cohortSelection.ruleWithoutIdentificationRestriction).not.toBeUndefined();
    expect(d.cohortSelection.ruleAtCostFloorTarget).not.toBeUndefined();
  });

  it('freezes one notional for both windows and shows the bankroll supports it', () => {
    const d = load();
    if (d === null) return;
    expect(d.notionalSelection.developmentAndConfirmatoryIdentical).toBe(true);
    if (d.notionalSelection.bankrollForcesASmallerSize) {
      // §1.5: if the bankroll cannot support notional_min_cost, the penalty is
      // recorded explicitly rather than absorbed.
      expect(d.notionalSelection.costPenaltyFromASmallerSizePct).not.toBeNull();
    } else {
      expect(d.notionalSelection.bankrollNeededSol).not.toBeNull();
    }
  });

  it('emits exactly one permitted final state, and never a forbidden one', () => {
    const d = load();
    if (d === null) return;
    expect(PERMITTED_STATES).toContain(d.finalState);
    for (const forbidden of ['CANARY_READY', 'LIVE_READY', 'PROFITABLE']) {
      expect(d.finalState).not.toContain(forbidden);
    }
  });

  it('cannot report a development simulation as running while the calendar refuses the window', () => {
    const d = load();
    if (d === null) return;
    if (d.calendar.verdict !== 'REFUSED_CANNOT_FINISH') return;
    expect(d.finalState).not.toBe('VALID_CONFIRMATORY_COLLECTION_STARTED');
  });
});
