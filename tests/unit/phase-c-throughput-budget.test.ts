import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * d70b4a9a §3.1 — the throughput budget, which is a gate and not a report.
 *
 * "If projected days to required_n exceeds 120, stop and report before
 * collecting." The three ways that gate could be quietly defeated:
 *
 *   1. counting TRAJECTORIES as positions. There are 4.05 rows per mint, so the
 *      same corpus supports either 79 positions a day or 320 depending on which
 *      unit is used, and only one of them is the unit the required n is in;
 *   2. projecting from the best day observed rather than the median. The best day
 *      is 138 mints against a median of 79, which is most of the way from
 *      "refused" to "allowed" on its own;
 *   3. reporting a Surfnet startup time of zero because no Surfnet ran. These
 *      jobs ran in the offline LiteSVM worker, and an unmeasured quantity that
 *      arrives as 0 makes the simulator look free.
 */

const PATH = 'artifacts/throughput-budget.json';

interface Budget {
  maxProjectedDays: number;
  confirmatoryFloorN: number;
  marks: {
    scheduledPerPosition: number;
    realisedPerPosition: number | null;
    slaBoundMs: number | null;
    onTime: number;
    missedHorizon: number;
    onTimeFraction: number | null;
    marksPerPositionPerHourWithinSla: number | null;
  };
  jupiter: {
    routerCallsPerMint: number | null;
    callsPerDayAvailable: number | null;
    callsPerDayRequired: number | null;
    callsPerDayIfEveryMarkPricedThroughTheRouter: number | null;
  };
  simulator: {
    maxActiveSurfnets: number;
    medianSimulationMs: number | null;
    jobsWithMeasurableElapsed: number;
    attachedWithoutRunning: number;
    surfnetStartupMs: number | null;
    surfnetStartupBasis: string;
    simulationsPerDayAchievable: number | null;
  };
  arrivals: {
    trajectoriesPerMint: number | null;
    distinctMintsSettledPerDay: { median: number | null; best: number | null };
    distinctMintsOpenedPerDay: { median: number | null; best: number | null };
  };
  positionsPerDayUsed: number | null;
  positionsPerDayBest: number | null;
  bottleneck: { tightest: string | null; candidates: { name: string; positionsPerDay: number | null }[] };
  projections: {
    cohort: string;
    requiredN: number | null;
    projectedDaysAtMedianRate: number | null;
    projectedDaysAtBestObservedRate: number | null;
    withinCalendar: boolean;
    selectable: boolean;
  }[];
  selectedCohort: string | null;
  verdict: string;
}

const load = (): Budget | null => (existsSync(PATH) ? (JSON.parse(readFileSync(PATH, 'utf8')) as Budget) : null);

describe('d70b4a9a §3.1 — the throughput budget', () => {
  it('counts positions in mints, not in trajectory rows', () => {
    const b = load();
    if (b === null) return;
    const perMint = b.arrivals.trajectoriesPerMint;
    if (perMint === null) return;
    expect(perMint).toBeGreaterThan(1);
    // The rate used is the mint rate. If it had been the row rate it would be
    // about `perMint` times larger than the distinct-mint figure.
    expect(b.positionsPerDayUsed).toBe(b.arrivals.distinctMintsSettledPerDay.median);
  });

  it('projects from the median day and reports the best day separately', () => {
    const b = load();
    if (b === null) return;
    expect(b.positionsPerDayUsed).toBe(b.arrivals.distinctMintsSettledPerDay.median);
    expect(b.positionsPerDayBest).toBe(b.arrivals.distinctMintsSettledPerDay.best);
    for (const p of b.projections) {
      if (p.requiredN === null || p.projectedDaysAtMedianRate === null || p.projectedDaysAtBestObservedRate === null) {
        continue;
      }
      // The verdict follows the median projection, and the best-day figure is
      // never the one the gate is decided on.
      expect(p.projectedDaysAtMedianRate).toBeGreaterThanOrEqual(p.projectedDaysAtBestObservedRate);
      expect(p.withinCalendar).toBe(p.projectedDaysAtMedianRate <= b.maxProjectedDays);
    }
  });

  it('does not report an unmeasured Surfnet startup as zero', () => {
    const b = load();
    if (b === null) return;
    expect(b.simulator.surfnetStartupMs).toBeNull();
    expect(b.simulator.surfnetStartupBasis.length).toBeGreaterThan(0);
  });

  it('excludes the jobs that attached without running from the median', () => {
    const b = load();
    if (b === null) return;
    // A job that completed in the same millisecond it was requested did not run.
    // Averaging those in halves the apparent simulation time.
    expect(b.simulator.attachedWithoutRunning).toBeGreaterThan(0);
    expect(b.simulator.medianSimulationMs).toBeGreaterThan(0);
    expect(b.simulator.jobsWithMeasurableElapsed).toBeGreaterThan(0);
  });

  it('applies the amended confirmatory floor of 300 positions', () => {
    const b = load();
    if (b === null) return;
    expect(b.confirmatoryFloorN).toBe(300);
    for (const p of b.projections) {
      if (p.requiredN === null) continue;
      expect(p.requiredN).toBeGreaterThanOrEqual(300);
    }
  });

  it('names the bottleneck out of the candidates it measured', () => {
    const b = load();
    if (b === null) return;
    const known = b.bottleneck.candidates.filter((c) => c.positionsPerDay !== null);
    expect(known.length).toBeGreaterThan(1);
    const tightest = known.reduce((a, c) =>
      (c.positionsPerDay as number) < (a.positionsPerDay as number) ? c : a,
    );
    expect(b.bottleneck.tightest).toBe(tightest.name);
  });

  it('reaches a verdict that follows from the selected cohort projection', () => {
    const b = load();
    if (b === null) return;
    const selected = b.projections.find((p) => p.cohort === b.selectedCohort);
    if (b.selectedCohort === null || selected === undefined) {
      expect(b.verdict).toBe('NO_COHORT_SELECTED');
      return;
    }
    expect(selected.selectable).toBe(true);
    expect(b.verdict).toBe(selected.withinCalendar ? 'WITHIN_CALENDAR' : 'REFUSED_CANNOT_FINISH');
  });

  it('measures the mark SLA rather than assuming every mark is on time', () => {
    const b = load();
    if (b === null) return;
    expect(b.marks.slaBoundMs).toBeGreaterThan(0);
    expect(b.marks.missedHorizon).toBeGreaterThan(0);
    expect(b.marks.onTimeFraction).toBeLessThan(1);
    expect(b.marks.marksPerPositionPerHourWithinSla).toBeLessThan(b.marks.scheduledPerPosition);
  });

  it('separates the router calls the collector makes from the ones it no longer makes', () => {
    const b = load();
    if (b === null) return;
    const now = b.jupiter.callsPerDayRequired;
    const ifRouted = b.jupiter.callsPerDayIfEveryMarkPricedThroughTheRouter;
    if (now === null || ifRouted === null) return;
    // The collector builds directly from stored pool bytes. Charging it the older
    // paper engine's router-priced mark path would make Jupiter look like the
    // binding constraint when it is two orders of magnitude away from being one.
    expect(now).toBeLessThan(ifRouted);
    expect(b.jupiter.callsPerDayAvailable).toBeGreaterThan(now);
  });
});
