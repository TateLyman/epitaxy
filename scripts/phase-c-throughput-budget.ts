/**
 * `pnpm throughput:budget` — what a collection window would cost in calendar time.
 *
 * §3.1 of the measurement-power directive, which is a gate and not a report:
 * "if projected days to required_n exceeds 120, stop and report before
 * collecting. Do not begin a window that cannot finish."
 *
 * Every rate below is measured from the corpus rather than assumed, because the
 * directive's own expectation — that the bottleneck is eligible signal arrival
 * and not simulation — is a hypothesis this can confirm or refute.
 *
 * THE SAMPLING UNIT IS THE MINT
 *
 * 704 trajectories exist over 174 distinct mints, 4.05 rows per mint, because
 * one mint carries several treatments and entry clocks. Counting rows as
 * positions inflates the achievable rate by exactly that factor and would turn a
 * three-year window into a nine-month one on paper. The required n from §1.2 is
 * in mints, so the arrival rate has to be in mints too.
 *
 * Read-only. No network call. Nothing is signed, submitted, or funded.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { MARK_OFFSETS_MS } from '../packages/pipeline/src/mark-path.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

/** §3.1's own limit. A window longer than this may not be started. */
const MAX_PROJECTED_DAYS = 120;
/** apps/simulatord/src/main.ts. Serialized FIFO, and §2.5 defers changing it. */
const MAX_ACTIVE_SURFNETS = 1;
const MS_PER_DAY = 86_400_000;

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : (((s[m - 1] as number) + (s[m] as number)) / 2);
};
const quantile = (xs: readonly number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] as number;
};

// ---------------------------------------------------------------------------
// 1 — MARKS
// ---------------------------------------------------------------------------

const markRows = db
  .prepare(
    `SELECT COUNT(*) AS marks, COUNT(DISTINCT trajectory_id) AS trajectories,
            SUM(CASE WHEN sla_status = 'ON_TIME' THEN 1 ELSE 0 END) AS onTime,
            SUM(CASE WHEN sla_status = 'MISSED_HORIZON' THEN 1 ELSE 0 END) AS missed,
            SUM(CASE WHEN sla_status IS NULL THEN 1 ELSE 0 END) AS unjudged
       FROM trajectory_marks`,
  )
  .get() as { marks: number; trajectories: number; onTime: number; missed: number; unjudged: number };
const slaBound = (
  db.prepare(`SELECT sla_bound_ms AS b, COUNT(*) AS n FROM trajectory_marks WHERE sla_bound_ms IS NOT NULL
              GROUP BY sla_bound_ms ORDER BY n DESC LIMIT 1`).get() as { b: number; n: number } | undefined
)?.b ?? null;
const lateness = (
  db.prepare(`SELECT lateness_ms AS l FROM trajectory_marks WHERE lateness_ms IS NOT NULL`).all() as { l: number }[]
).map((r) => r.l);

/** The scheduled marks that fall inside the first hour of a position's life. */
const marksInFirstHour = MARK_OFFSETS_MS.filter((o) => o <= 3_600_000).length;
const judged = markRows.onTime + markRows.missed;

const marks = {
  scheduledOffsetsMs: [...MARK_OFFSETS_MS],
  scheduledPerPosition: MARK_OFFSETS_MS.length,
  marksPerPositionPerHourScheduled: marksInFirstHour,
  realisedPerPosition: markRows.trajectories === 0 ? null : markRows.marks / markRows.trajectories,
  slaBoundMs: slaBound,
  judged,
  onTime: markRows.onTime,
  missedHorizon: markRows.missed,
  unjudged: markRows.unjudged,
  onTimeFraction: judged === 0 ? null : markRows.onTime / judged,
  latenessP50Ms: quantile(lateness, 0.5),
  latenessP90Ms: quantile(lateness, 0.9),
  latenessMaxMs: lateness.length === 0 ? null : Math.max(...lateness),
  /** Marks that land inside the SLA, per position per hour. */
  marksPerPositionPerHourWithinSla:
    judged === 0 ? null : marksInFirstHour * (markRows.onTime / judged),
};

// ---------------------------------------------------------------------------
// 2 — JUPITER
// ---------------------------------------------------------------------------

const buildsPerTrajectory = (
  db
    .prepare(
      `SELECT COUNT(*) AS builds,
              (SELECT COUNT(*) FROM development_trajectories) AS trajectories,
              (SELECT COUNT(DISTINCT mint) FROM development_trajectories) AS mints
         FROM execution_observations`,
    )
    .get() as { builds: number; trajectories: number; mints: number }
);

/**
 * WHICH OF THOSE BUILDS IS ACTUALLY A JUPITER CALL, AND IN WHICH ERA.
 *
 * A corpus-wide builds-per-mint ratio says 252 and makes Jupiter look like the
 * second-tightest constraint. It is an artifact of two different architectures
 * sharing one table: the 43,096 `BUILD_CUSTOM` rows are the older paper-engine
 * shadow books, which priced every mark through the ROUTER, and they stop before
 * the trajectory collector starts. The collector's own legs are `DIRECT_VENUE` —
 * built from stored pool bytes with no router in the path at all.
 *
 * So the figure that matters is the one from the collector era, by family.
 */
const trajectoryEraStart = (
  db.prepare(`SELECT MIN(opened_utc_ms) AS t FROM development_trajectories`).get() as { t: number | null }
).t;
const byFamilyInEra = (
  trajectoryEraStart === null
    ? []
    : (db
        .prepare(
          `SELECT family, COUNT(*) AS n, COUNT(DISTINCT mint) AS mints
             FROM execution_observations WHERE requested_utc_ms >= ? GROUP BY family`,
        )
        .all(trajectoryEraStart) as { family: string; n: number; mints: number }[])
);
const routerFamilies = new Set(['ORDER_EXECUTE', 'BUILD_CUSTOM', 'QUOTE_ONLY_BENCHMARK']);
const routerCallsInEra = byFamilyInEra.filter((r) => routerFamilies.has(r.family)).reduce((a, r) => a + r.n, 0);
const directCallsInEra = byFamilyInEra.filter((r) => !routerFamilies.has(r.family)).reduce((a, r) => a + r.n, 0);
const mintsInEra = Math.max(...byFamilyInEra.map((r) => r.mints), 0);
const jupiterBuckets = JSON.parse(readFileSync('config/source-limits.json', 'utf8')) as {
  buckets: { name: string; requestsPerSecond: number; withKeyRequestsPerSecond?: number }[];
};
const jupMain = jupiterBuckets.buckets.find((b) => b.name === 'jupiter_main');
const jupPerSecond = jupMain?.withKeyRequestsPerSecond ?? jupMain?.requestsPerSecond ?? null;
const jupCallsPerDayAvailable = jupPerSecond === null ? null : jupPerSecond * 86_400;

const buildsPerMint = buildsPerTrajectory.mints === 0 ? null : buildsPerTrajectory.builds / buildsPerTrajectory.mints;
/** The number the projection uses: ROUTER calls per mint, collector era only. */
const routerCallsPerMint = mintsInEra === 0 ? null : routerCallsInEra / mintsInEra;

// ---------------------------------------------------------------------------
// 3 — THE SIMULATOR
// ---------------------------------------------------------------------------

const jobElapsed = (
  db
    .prepare(
      `SELECT completed_utc_ms - requested_utc_ms AS ms
         FROM simulation_jobs
        WHERE completed_utc_ms IS NOT NULL AND completed_utc_ms - requested_utc_ms > 0`,
    )
    .all() as { ms: number }[]
).map((r) => r.ms);
const jobsTotal = (db.prepare(`SELECT COUNT(*) AS n FROM simulation_jobs WHERE completed_utc_ms IS NOT NULL`).get() as {
  n: number;
}).n;
const stepsPerJob = (() => {
  const r = db
    .prepare(`SELECT COUNT(*) AS steps, COUNT(DISTINCT job_id) AS jobs FROM simulation_steps`)
    .get() as { steps: number; jobs: number };
  return r.jobs === 0 ? null : r.steps / r.jobs;
})();

const simMedianMs = median(jobElapsed);
const simulator = {
  maxActiveSurfnets: MAX_ACTIVE_SURFNETS,
  jobsWithCompletion: jobsTotal,
  jobsWithMeasurableElapsed: jobElapsed.length,
  /**
   * The rest completed inside the same millisecond they were requested, which
   * is an idempotent ATTACH to an in-flight or finished job rather than a run.
   * Counted separately: averaging them in would report a simulator twice as fast
   * as the one that has to do the work.
   */
  attachedWithoutRunning: jobsTotal - jobElapsed.length,
  medianSimulationMs: simMedianMs,
  p90SimulationMs: quantile(jobElapsed, 0.9),
  maxSimulationMs: jobElapsed.length === 0 ? null : Math.max(...jobElapsed),
  stepsPerJob,
  /**
   * Surfnet startup is NOT measured here and is not reported as zero.
   *
   * These legs ran in the offline LiteSVM worker, one process per job, so the
   * elapsed time above already contains process start. A Surfpool startup figure
   * would have to come from a Surfpool run, and none is in the corpus.
   */
  surfnetStartupMs: null as number | null,
  surfnetStartupBasis: 'not measured: these jobs ran in the offline LiteSVM worker, not Surfpool',
  simulationsPerDayAchievable:
    simMedianMs === null || simMedianMs <= 0 ? null : Math.floor((MS_PER_DAY / simMedianMs) * MAX_ACTIVE_SURFNETS),
};

// ---------------------------------------------------------------------------
// 4 — ARRIVALS, IN MINTS PER DAY
// ---------------------------------------------------------------------------

const migrationsByDay = (
  db
    .prepare(
      `SELECT date(block_time, 'unixepoch') AS d, COUNT(DISTINCT mint) AS n
         FROM confirmed_migrations WHERE block_time IS NOT NULL GROUP BY 1 ORDER BY 1`,
    )
    .all() as { d: string; n: number }[]
);
const mintsByDay = (
  db
    .prepare(
      `SELECT date(opened_utc_ms / 1000, 'unixepoch') AS d, COUNT(DISTINCT mint) AS n
         FROM development_trajectories GROUP BY 1 ORDER BY 1`,
    )
    .all() as { d: string; n: number }[]
);
const trajectoriesPerMint = (() => {
  const r = db
    .prepare(`SELECT COUNT(*) AS rows, COUNT(DISTINCT mint) AS mints FROM development_trajectories`)
    .get() as { rows: number; mints: number };
  return r.mints === 0 ? null : r.rows / r.mints;
})();
const settledByDay = (
  db
    .prepare(
      `SELECT date(t.settled_utc_ms / 1000, 'unixepoch') AS d, COUNT(DISTINCT d2.mint) AS n
         FROM trajectory_settlements t JOIN development_trajectories d2 ON d2.trajectory_id = t.trajectory_id
        GROUP BY 1 ORDER BY 1`,
    )
    .all() as { d: string; n: number }[]
);

const arrivals = {
  confirmedMigrationsPerDay: {
    days: migrationsByDay.length,
    median: median(migrationsByDay.map((r) => r.n)),
    best: migrationsByDay.length === 0 ? null : Math.max(...migrationsByDay.map((r) => r.n)),
    worst: migrationsByDay.length === 0 ? null : Math.min(...migrationsByDay.map((r) => r.n)),
    byDay: migrationsByDay,
  },
  distinctMintsOpenedPerDay: {
    days: mintsByDay.length,
    median: median(mintsByDay.map((r) => r.n)),
    best: mintsByDay.length === 0 ? null : Math.max(...mintsByDay.map((r) => r.n)),
    byDay: mintsByDay,
  },
  distinctMintsSettledPerDay: {
    days: settledByDay.length,
    median: median(settledByDay.map((r) => r.n)),
    best: settledByDay.length === 0 ? null : Math.max(...settledByDay.map((r) => r.n)),
    byDay: settledByDay,
  },
  trajectoriesPerMint,
};

/**
 * The rate the projection uses: distinct mints SETTLED per day, at the median.
 *
 * Not opened, because an opened trajectory that never settles is not a valid
 * completed position, and not the best day, because a projection built on the
 * best day observed is a projection that has already chosen its answer.
 */
const positionsPerDay = arrivals.distinctMintsSettledPerDay.median;
const positionsPerDayBest = arrivals.distinctMintsSettledPerDay.best;

// ---------------------------------------------------------------------------
// 5 — THE PROJECTION, AGAINST THE §1.2 REQUIRED N
// ---------------------------------------------------------------------------

interface EdgeArtifact {
  costFloorPct: number | null;
  lowestRequiredNCohort: string | null;
  lowestRequiredNCohortUnrestricted: string | null;
  lowestRequiredNCohortAtCostFloorTarget: string | null;
  rankingPopulation: string;
  rankedByRequiredN: {
    cohort: string;
    requiredN: number | null;
    requiredNForCostFloorEdge: number | null;
    rankable: boolean;
    notRankableBecause: string[];
  }[];
}
const EDGE_PATH = 'artifacts/gross-edge-distribution.json';
const edge: EdgeArtifact | null = existsSync(EDGE_PATH)
  ? (JSON.parse(readFileSync(EDGE_PATH, 'utf8')) as EdgeArtifact)
  : null;

/** §19 as amended by Correction 1: max(300, 7.84 × CV²). */
const CONFIRMATORY_FLOOR_N = 300;
const projections = (edge?.rankedByRequiredN ?? []).map((r) => {
  const requiredN = r.requiredN === null ? null : Math.max(CONFIRMATORY_FLOOR_N, r.requiredN);
  const targetN = r.requiredNForCostFloorEdge === null ? null : Math.max(CONFIRMATORY_FLOOR_N, r.requiredNForCostFloorEdge);
  const days = (n: number | null): number | null =>
    n === null || positionsPerDay === null || positionsPerDay <= 0 ? null : Math.ceil(n / positionsPerDay);
  const daysBest = (n: number | null): number | null =>
    n === null || positionsPerDayBest === null || positionsPerDayBest <= 0 ? null : Math.ceil(n / positionsPerDayBest);
  return {
    cohort: r.cohort,
    selectable: r.rankable,
    notSelectableBecause: r.notRankableBecause,
    requiredN,
    projectedDaysAtMedianRate: days(requiredN),
    projectedDaysAtBestObservedRate: daysBest(requiredN),
    requiredNAtCostFloorTarget: targetN,
    projectedDaysAtCostFloorTarget: days(targetN),
    withinCalendar: (days(requiredN) ?? Number.POSITIVE_INFINITY) <= MAX_PROJECTED_DAYS,
    withinCalendarAtCostFloorTarget: (days(targetN) ?? Number.POSITIVE_INFINITY) <= MAX_PROJECTED_DAYS,
  };
});

const selected = projections.find((p) => p.cohort === edge?.lowestRequiredNCohort) ?? null;
const simulationsPerDayRequired =
  positionsPerDay === null ? null : Math.ceil(positionsPerDay * (marks.realisedPerPosition ?? MARK_OFFSETS_MS.length));

const verdict =
  selected === null
    ? 'NO_COHORT_SELECTED'
    : selected.withinCalendar
      ? 'WITHIN_CALENDAR'
      : 'REFUSED_CANNOT_FINISH';

const bottleneck = (() => {
  const candidates: { name: string; positionsPerDay: number | null }[] = [
    { name: 'eligible signal arrival (distinct mints settled per day)', positionsPerDay },
    {
      name: 'Jupiter router budget (collector era, router families only)',
      positionsPerDay:
        jupCallsPerDayAvailable === null || routerCallsPerMint === null || routerCallsPerMint <= 0
          ? null
          : Math.floor(jupCallsPerDayAvailable / routerCallsPerMint),
    },
    {
      name: 'Jupiter router budget IF every mark priced through the router',
      positionsPerDay:
        jupCallsPerDayAvailable === null || buildsPerMint === null || buildsPerMint <= 0
          ? null
          : Math.floor(jupCallsPerDayAvailable / buildsPerMint),
    },
    {
      name: `simulator at MAX_ACTIVE_SURFNETS=${MAX_ACTIVE_SURFNETS}`,
      positionsPerDay:
        simulator.simulationsPerDayAchievable === null || (marks.realisedPerPosition ?? 0) <= 0
          ? null
          : Math.floor(simulator.simulationsPerDayAchievable / (marks.realisedPerPosition as number)),
    },
  ];
  const known = candidates.filter((c) => c.positionsPerDay !== null);
  const tightest = known.reduce<(typeof candidates)[number] | null>(
    (best, c) => (best === null || (c.positionsPerDay as number) < (best.positionsPerDay as number) ? c : best),
    null,
  );
  return { candidates, tightest: tightest?.name ?? null };
})();

const artifact = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'phase-c-throughput-v1',
    sampleInclusionQuery:
      'trajectory_marks, execution_observations, simulation_jobs/steps, confirmed_migrations, ' +
      'development_trajectories and trajectory_settlements over the whole corpus',
  }),
  directive: 'd70b4a9a §3.1',
  maxProjectedDays: MAX_PROJECTED_DAYS,
  confirmatoryFloorN: CONFIRMATORY_FLOOR_N,
  marks,
  jupiter: {
    buildObservationsTotal: buildsPerTrajectory.builds,
    trajectories: buildsPerTrajectory.trajectories,
    distinctMints: buildsPerTrajectory.mints,
    buildsPerMint,
    trajectoryEraStart,
    byFamilyInEra,
    routerCallsInEra,
    directVenueCallsInEra: directCallsInEra,
    mintsInEra,
    routerCallsPerMint,
    requestsPerSecondAvailable: jupPerSecond,
    callsPerDayAvailable: jupCallsPerDayAvailable,
    callsPerDayRequired:
      positionsPerDay === null || routerCallsPerMint === null ? null : Math.ceil(positionsPerDay * routerCallsPerMint),
    callsPerDayIfEveryMarkPricedThroughTheRouter:
      positionsPerDay === null || buildsPerMint === null ? null : Math.ceil(positionsPerDay * buildsPerMint),
    note:
      'the collector builds its legs DIRECTLY from stored pool bytes, so the router is not on its critical path. ' +
      'The corpus-wide 252 builds per mint belong to the older paper-engine shadow books, which priced every mark ' +
      'through the router; that ratio is reported as the cost of going back to a router-priced mark path.',
  },
  simulator,
  arrivals,
  positionsPerDayUsed: positionsPerDay,
  positionsPerDayBest,
  simulationsPerDayRequired,
  bottleneck,
  projections,
  selectedCohort: edge?.lowestRequiredNCohort ?? null,
  selectedProjection: selected,
  verdict,
  verdictMeaning:
    verdict === 'REFUSED_CANNOT_FINISH'
      ? 'the confirmatory window for the selected cohort cannot finish inside the limit, so §3.1 forbids beginning it'
      : verdict === 'WITHIN_CALENDAR'
        ? 'the confirmatory window fits inside the limit'
        : 'no cohort was selectable, so nothing can be projected',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/throughput-budget.json', JSON.stringify(artifact, null, 2) + '\n');

console.log('marks');
console.log(`  scheduled offsets          ${MARK_OFFSETS_MS.map((o) => o / 1000 + 's').join(' ')}`);
console.log(`  scheduled per position     ${marks.scheduledPerPosition} (${marks.marksPerPositionPerHourScheduled} inside the first hour)`);
console.log(`  realised per position      ${marks.realisedPerPosition?.toFixed(2) ?? 'none'}`);
console.log(
  `  SLA ${marks.slaBoundMs ?? '?'} ms            ${marks.onTime} on time, ${marks.missedHorizon} missed (${((marks.onTimeFraction ?? 0) * 100).toFixed(1)}% on time over ${marks.judged} judged; ${marks.unjudged} predate the verdict)`,
);
console.log(`  marks/hour within SLA      ${marks.marksPerPositionPerHourWithinSla?.toFixed(2) ?? 'none'}`);
console.log('');
console.log('jupiter');
console.log(`  builds per mint, corpus    ${buildsPerMint?.toFixed(1) ?? 'none'} (router-priced marks, older paper engine)`);
console.log(`  router calls per mint      ${routerCallsPerMint?.toFixed(2) ?? 'none'} in the collector era; ${directCallsInEra} DIRECT_VENUE builds carry the legs`);
console.log(`  rate available             ${jupPerSecond ?? '?'} req/s = ${jupCallsPerDayAvailable ?? '?'} calls/day`);
console.log(`  calls/day required         ${artifact.jupiter.callsPerDayRequired ?? 'none'} (${artifact.jupiter.callsPerDayIfEveryMarkPricedThroughTheRouter ?? '-'} if marks went back through the router)`);
console.log('');
console.log('simulator');
console.log(
  `  median simulation          ${simulator.medianSimulationMs ?? 'none'} ms over ${simulator.jobsWithMeasurableElapsed} jobs (${simulator.attachedWithoutRunning} attached without running)`,
);
console.log(`  surfnet startup            ${simulator.surfnetStartupBasis}`);
console.log(`  simulations/day achievable ${simulator.simulationsPerDayAchievable ?? 'none'} at MAX_ACTIVE_SURFNETS=${MAX_ACTIVE_SURFNETS}`);
console.log(`  simulations/day required   ${simulationsPerDayRequired ?? 'none'}`);
console.log('');
console.log('arrivals, in MINTS per day');
console.log(
  `  confirmed migrations       median ${arrivals.confirmedMigrationsPerDay.median ?? '-'}  best ${arrivals.confirmedMigrationsPerDay.best ?? '-'}  worst ${arrivals.confirmedMigrationsPerDay.worst ?? '-'}  over ${arrivals.confirmedMigrationsPerDay.days} days`,
);
console.log(
  `  distinct mints opened      median ${arrivals.distinctMintsOpenedPerDay.median ?? '-'}  best ${arrivals.distinctMintsOpenedPerDay.best ?? '-'}  over ${arrivals.distinctMintsOpenedPerDay.days} days`,
);
console.log(
  `  distinct mints settled     median ${arrivals.distinctMintsSettledPerDay.median ?? '-'}  best ${arrivals.distinctMintsSettledPerDay.best ?? '-'}  over ${arrivals.distinctMintsSettledPerDay.days} days`,
);
console.log(`  trajectories per mint      ${trajectoriesPerMint?.toFixed(2) ?? '-'}`);
console.log('');
console.log(`bottleneck: ${bottleneck.tightest ?? 'unknown'}`);
for (const c of bottleneck.candidates) {
  console.log(`  ${c.name.padEnd(52)} ${c.positionsPerDay === null ? 'unknown' : c.positionsPerDay + ' positions/day'}`);
}
console.log('');
console.log('projected calendar days to required n');
console.log('  cohort    requiredN   days@median   days@best   targetN   days@target   selectable');
for (const p of projections) {
  console.log(
    `  ${p.cohort.padEnd(9)} ${String(p.requiredN ?? '-').padStart(9)} ${String(p.projectedDaysAtMedianRate ?? '-').padStart(13)} ${String(p.projectedDaysAtBestObservedRate ?? '-').padStart(11)} ${String(p.requiredNAtCostFloorTarget ?? '-').padStart(9)} ${String(p.projectedDaysAtCostFloorTarget ?? '-').padStart(13)}   ${p.selectable ? 'yes' : 'no'}`,
  );
}
console.log('');
console.log(`selected cohort            ${artifact.selectedCohort ?? 'none'}`);
console.log(`limit                      ${MAX_PROJECTED_DAYS} days`);
console.log(`VERDICT                    ${verdict} — ${artifact.verdictMeaning}`);
console.log('');
console.log('wrote artifacts/throughput-budget.json');
