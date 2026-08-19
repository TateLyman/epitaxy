import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Phase B — the conditioning phase, and the one substitution that would have
 * turned it into a finding.
 *
 * Phase B searched 630 (trigger × population × tier × notional) cells for a
 * conditional mean that makes the experiment decidable, and found one: entry on a
 * market-cap crossing returns +193% to +341% at the 60-minute mark.
 *
 * On a population this system cannot enter. A fee tier is a property of a
 * PumpSwap POOL; 276 of 158,085 snapshotted mints ever migrated; and 99.4% of the
 * mints firing those triggers had no pool at the moment the trigger fired, so the
 * tier assigned to them is the tier a pool WOULD have been in and the entry is one
 * the collector could not have built. Restricted to mints already migrated at
 * entry, every trigger's conditional mean is NEGATIVE — and so is the baseline.
 *
 * What these tests guard is that the population split cannot quietly disappear:
 *
 *   1. the verdict is taken from the tradable population, never from all cells;
 *   2. both means are reported per trigger, so the sign flip stays visible;
 *   3. the two unmodelled costs stay UNKNOWN and the upper-bound wording stays;
 *   4. the tier schedule is one schedule across the corpus, since a republished
 *      fee table is a regime change and would invalidate every surface above.
 */

const SCHEDULE = 'artifacts/fee-tier-schedule.json';
const ASSIGNMENT = 'artifacts/tier-assignment.json';
const BY_TIER = 'artifacts/cost-surface-by-tier.json';
const CELLS = 'artifacts/trigger-cells.json';
const CELL_LEDGER = 'docs/PHASE_B_CELL_LEDGER.csv';

const load = <T>(path: string): T | null => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null);

interface Schedule {
  isEvidence: boolean;
  distinctSchedules: number;
  tierCount: number;
  tiers: { tierIndex: number; marketCapThresholdSol: number; oneWayBps: number; roundTripBps: number }[];
  instructionShape: { verdict: string; buildsBeforeUpgrade: number; distinctShapes: number; shapesDifferentiallyRebuilt: number };
  unmodelledCosts: { quoteToLandSlippage: string; crowding: string };
}
interface Assignment {
  isEvidence: boolean;
  scheduleAgreesWithArtifact: boolean | null;
  crossCheck: { pools: number; sameTierFraction: number | null; ratioProviderOverProgram: { p50: number | null } };
  reach: { band: string; mintsWithAnyTier: number; atOrAboveTier: { tierIndex: number; mints: number; fraction: number }[] }[];
}
interface ByTier {
  isEvidence: boolean;
  exitPricedAgainst: string;
  strata: {
    tierIndex: number;
    scheduleRoundTripBps: number | null;
    costFloorPct: number | null;
    effectiveQuoteReserveSol: { p50: number | null };
    observedGrossMean: number | null;
    observedGrossMeanMigratedAtEntry: number | null;
    grid: { notionalSol: number; poolsAdmissible: number }[];
  }[];
}
interface Cells {
  isEvidence: boolean;
  finalState: string;
  cellCount: number;
  evaluableCellCount: number;
  expectedFalsePositives: number;
  tradablePopulation: {
    cells: number;
    evaluable: number;
    passOnPointEstimate: number;
    passOnHoldoutLowerBound: number;
    expectedFalsePositives: number;
    migratedMintsInCorpus: number;
    snapshottedMints: number;
  };
  decidableCells: { trigger: string }[];
  triggers: {
    trigger: string;
    firedMigratedAtEntry: number;
    firedMigratedFraction: number | null;
    grossMeanMigrated: number | null;
    grossMeanAllSnapshotted: number | null;
    fixedHoldMeanMigrated: number | null;
  }[];
  chronologicalSplit: { fitDays: string[]; holdoutDays: string[] };
  executableMarkCheck: { rows: { offsetMs: number; n: number; mean: number | null; median: number; p10: number }[] };
  unmodelledCosts: { quoteToLandSlippage: string; crowding: string; statement: string };
  referenceTargets: { s: number; sigma: number; meanNeededFor120Days: number }[];
}

describe('Phase B §1.1 — the fee schedule', () => {
  it('is one schedule across the whole corpus', () => {
    const a = load<Schedule>(SCHEDULE);
    if (a === null) return;
    // More than one would be a REGIME CHANGE inside the corpus and would
    // invalidate every surface that pooled across the boundary.
    expect(a.distinctSchedules).toBe(1);
  });

  it('decodes a monotone tier table that starts at the dearest bucket', () => {
    const a = load<Schedule>(SCHEDULE);
    if (a === null) return;
    expect(a.tierCount).toBeGreaterThan(1);
    const first = a.tiers[0];
    expect(first?.marketCapThresholdSol).toBe(0);
    for (let i = 1; i < a.tiers.length; i += 1) {
      const prev = a.tiers[i - 1];
      const cur = a.tiers[i];
      if (prev === undefined || cur === undefined) continue;
      expect(cur.marketCapThresholdSol).toBeGreaterThan(prev.marketCapThresholdSol);
      expect(cur.roundTripBps).toBeLessThanOrEqual(prev.roundTripBps);
    }
  });

  it('settles the 2026-04-28 shape question by date AND by rebuild', () => {
    const a = load<Schedule>(SCHEDULE);
    if (a === null) return;
    expect(a.instructionShape.buildsBeforeUpgrade).toBe(0);
    // Every distinct stored shape rebuilt through the pinned SDK, not a sample.
    expect(a.instructionShape.shapesDifferentiallyRebuilt).toBe(a.instructionShape.distinctShapes);
    expect(a.instructionShape.verdict).toBe('CURRENT_INSTRUCTION_SHAPE');
  });
});

describe('Phase B §1.2 — the tier assignment', () => {
  it('validates the provider market cap against the program own before using it', () => {
    const a = load<Assignment>(ASSIGNMENT);
    if (a === null) return;
    expect(a.crossCheck.pools).toBeGreaterThan(50);
    // The whole assignment rests on this: if the provider's market cap and the
    // program's disagree by more than a tier width, every tier below is a
    // different quantity wearing the tier's name.
    expect(a.crossCheck.ratioProviderOverProgram.p50).toBeGreaterThan(0.9);
    expect(a.crossCheck.ratioProviderOverProgram.p50).toBeLessThan(1.1);
    expect(a.crossCheck.sameTierFraction).toBeGreaterThan(0.9);
  });

  it('agrees with the schedule §1.1 decoded', () => {
    const a = load<Assignment>(ASSIGNMENT);
    if (a === null) return;
    if (a.scheduleAgreesWithArtifact === null) return;
    expect(a.scheduleAgreesWithArtifact).toBe(true);
  });

  it('answers the specific question: who reaches tier 2 inside 2m-60m', () => {
    const a = load<Assignment>(ASSIGNMENT);
    if (a === null) return;
    const band = a.reach.find((r) => r.band === '2m-60m');
    expect(band).toBeDefined();
    const tier2 = band?.atOrAboveTier.find((t) => t.tierIndex === 2);
    expect(tier2).toBeDefined();
    // A fraction, not a count, and a small one: the answer is the number.
    expect(tier2?.fraction).toBeGreaterThan(0);
    expect(tier2?.fraction).toBeLessThan(0.1);
  });
});

describe('Phase B §1.3 — the cost surface per tier', () => {
  it('keeps the exit priced against the same state as D70B4A9A', () => {
    const a = load<ByTier>(BY_TIER);
    if (a === null) return;
    expect(a.exitPricedAgainst).toBe('PRE_BUY_RESERVES');
  });

  it('shows the cost floor falling and the depth rising with the tier', () => {
    const a = load<ByTier>(BY_TIER);
    if (a === null) return;
    const ordered = [...a.strata].sort((x, y) => x.tierIndex - y.tierIndex);
    const floors = ordered.map((s) => s.costFloorPct).filter((v): v is number => v !== null);
    const reserves = ordered
      .map((s) => s.effectiveQuoteReserveSol.p50)
      .filter((v): v is number => v !== null);
    expect(floors.length).toBeGreaterThan(1);
    // Both monotone: a better tier is cheaper AND deeper, which is why the gain
    // is not only the fee saving.
    for (let i = 1; i < floors.length; i += 1) expect(floors[i] as number).toBeLessThan(floors[i - 1] as number);
    for (let i = 1; i < reserves.length; i += 1) expect(reserves[i] as number).toBeGreaterThan(reserves[i - 1] as number);
  });

  it('reports each tier gross mean on BOTH populations', () => {
    const a = load<ByTier>(BY_TIER);
    if (a === null) return;
    for (const s of a.strata) {
      // The field must exist even when it is null, because its absence is what
      // would let the untradable mean stand alone.
      expect(s).toHaveProperty('observedGrossMeanMigratedAtEntry');
    }
  });
});

describe('Phase B §2-§4 — the cells and the verdict', () => {
  it('is labelled not-evidence, like every reconstruction in this project', () => {
    for (const p of [SCHEDULE, ASSIGNMENT, BY_TIER, CELLS]) {
      const a = load<{ isEvidence: boolean }>(p);
      if (a === null) continue;
      expect(a.isEvidence).toBe(false);
    }
  });

  it('takes the verdict from the tradable population alone', () => {
    const a = load<Cells>(CELLS);
    if (a === null) return;
    expect(a.finalState).toBe(
      a.tradablePopulation.passOnHoldoutLowerBound === 0 ? 'NO_DECIDABLE_CELL' : 'DECIDABLE_CELL_IDENTIFIED',
    );
    // And every named decidable cell is from that population.
    expect(a.decidableCells.length).toBe(a.tradablePopulation.passOnHoldoutLowerBound);
  });

  it('keeps the sign flip between the two populations visible per trigger', () => {
    const a = load<Cells>(CELLS);
    if (a === null) return;
    expect(a.triggers.length).toBeGreaterThan(1);
    for (const t of a.triggers) {
      expect(t).toHaveProperty('grossMeanMigrated');
      expect(t).toHaveProperty('grossMeanAllSnapshotted');
      expect(t).toHaveProperty('firedMigratedFraction');
    }
    // The tradable population is a small fraction of the fired one; that is the
    // headline, and a build that lost the distinction would show 1.0 here.
    const withFires = a.triggers.filter((t) => (t.firedMigratedFraction ?? 0) > 0);
    for (const t of withFires) expect(t.firedMigratedFraction as number).toBeLessThan(0.5);
  });

  it('reports every cell examined, not only the passing ones', () => {
    const a = load<Cells>(CELLS);
    if (a === null) return;
    expect(a.cellCount).toBeGreaterThan(a.evaluableCellCount);
    if (!existsSync(CELL_LEDGER)) return;
    const lines = readFileSync(CELL_LEDGER, 'utf8').trim().split('\n');
    // One header plus one row per cell EXAMINED.
    expect(lines.length - 1).toBe(a.cellCount);
    expect(lines[0]).toContain('population');
    expect(lines[0]).toContain('days');
    expect(lines[0]).toContain('net_lower_bound');
  });

  it('states the expected false-positive count for the family it searched', () => {
    const a = load<Cells>(CELLS);
    if (a === null) return;
    expect(a.expectedFalsePositives).toBeCloseTo(a.evaluableCellCount * 0.05, 6);
    expect(a.tradablePopulation.expectedFalsePositives).toBeCloseTo(a.tradablePopulation.evaluable * 0.05, 6);
  });

  it('splits chronologically, with no day on both sides', () => {
    const a = load<Cells>(CELLS);
    if (a === null) return;
    const fit = new Set(a.chronologicalSplit.fitDays);
    for (const d of a.chronologicalSplit.holdoutDays) expect(fit.has(d)).toBe(false);
    expect(a.chronologicalSplit.fitDays.length).toBeGreaterThan(0);
    expect(a.chronologicalSplit.holdoutDays.length).toBeGreaterThan(0);
    // Chronological, not random: every fit day precedes every holdout day.
    const lastFit = [...a.chronologicalSplit.fitDays].sort().pop() as string;
    const firstHoldout = [...a.chronologicalSplit.holdoutDays].sort()[0] as string;
    expect(lastFit < firstHoldout).toBe(true);
  });

  it('carries the executable-mark cross-check, which uses no mid price', () => {
    const a = load<Cells>(CELLS);
    if (a === null) return;
    const hour = a.executableMarkCheck.rows.find((r) => r.offsetMs === 3_600_000);
    expect(hour).toBeDefined();
    if (hour === undefined) return;
    expect(hour.n).toBeGreaterThan(100);
    // The corroboration that matters: the median mark at an hour is negative and
    // close to the cost floor, and the mean is well below it. A reconstruction
    // that claimed a positive tradable mean would contradict this.
    expect(hour.median).toBeLessThan(0);
    expect(hour.mean as number).toBeLessThan(hour.median);
  });

  it('keeps both unmodelled costs UNKNOWN and says the result is an upper bound', () => {
    const a = load<Cells>(CELLS);
    if (a === null) return;
    expect(a.unmodelledCosts.quoteToLandSlippage).toBe('UNKNOWN');
    expect(a.unmodelledCosts.crowding).toBe('UNKNOWN');
    expect(a.unmodelledCosts.statement).toContain('UPPER BOUND');
  });

  it('recomputes the reference targets from the formula rather than restating them', () => {
    const a = load<Cells>(CELLS);
    if (a === null) return;
    for (const r of a.referenceTargets) {
      const expected = r.sigma * Math.sqrt(7.84 / (120 * 79 * r.s));
      expect(r.meanNeededFor120Days).toBeCloseTo(expected, 9);
    }
  });
});
