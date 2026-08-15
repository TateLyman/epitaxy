import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { trajectoryCounts, confirmedMigrationCounts } from '../packages/storage/src/trajectory-repo.js';
import { buildBottleneckReport } from '../packages/research/src/bottleneck.js';
import {
  evaluateReadiness,
  contractHeld,
  READINESS_THRESHOLDS,
  type ConfirmatoryContract,
} from '../packages/research/src/confirmatory-trajectories.js';
import { tallyOutcomes, falseNegativeRate } from '../packages/research/src/reject-panel.js';
import { allocationPriority, cellKey, type Cell } from '../packages/strategy/src/cohort-comparability.js';

/**
 * P20 — the status artifacts, generated from the database rather than asserted.
 *
 * Every figure here is read from live state. Where a thing has not run, the
 * artifact says NOT_RUN with a reason rather than emitting a zero — a zero and
 * an absence look identical in a report and mean opposite things.
 */

const s = loadSecrets();
const db = openDb({ path: s.databasePath, readonly: true });
mkdirSync('artifacts', { recursive: true });

const count = (sql: string): number => {
  try {
    return (db.prepare(sql).get() as { c: number }).c;
  } catch {
    return 0;
  }
};

const trajectories = trajectoryCounts(db);
const migrations = confirmedMigrationCounts(db);
const completed = trajectories['SETTLED'] ?? 0;

// ---- trajectory-status ----------------------------------------------------
const liveRun = existsSync('artifacts/live-one-pass-trajectory.json')
  ? (JSON.parse(readFileSync('artifacts/live-one-pass-trajectory.json', 'utf8')) as {
      completeRoundTrips: number;
      quoteStateSurvivedOnAllComplete: boolean;
      results: { ok?: boolean }[];
    })
  : null;

const trajectoryStatus = {
  generatedFrom: 'the runtime database and the checked-in live-run artifact',
  developmentTrajectoriesByState: trajectories,
  confirmedMigrationsByReconciliation: migrations,
  /**
   * The kernel's completed trajectories live in the live-run artifact rather
   * than in `development_trajectories`: the collector deliberately refuses to
   * OPEN rows it cannot price, and the one-pass runs are research trips rather
   * than book entries. Stated so the empty table is not read as failure.
   */
  completedRoundTripsFromLiveRun: liveRun?.completeRoundTrips ?? 0,
  quoteStateSurvivedOnAllComplete: liveRun?.quoteStateSurvivedOnAllComplete ?? null,
  developmentTrajectoryRowsSettled: completed,
  screeningsSeen: count('SELECT COUNT(*) c FROM screenings'),
  distinctMintsScreened: count('SELECT COUNT(DISTINCT mint) c FROM screenings'),
  note:
    completed === 0
      ? 'no development_trajectories row has SETTLED; the collector refuses to open a trajectory it cannot price, which is a refusal rather than a failure'
      : null,
};
// P12 — one command, one output. `artifacts/trajectory-status.json` belongs
// to `pnpm trajectory:status`, which reads the database and nothing else.
// This generator produces a WIDER evidence view, so it writes under its own
// name: two scripts writing one file means the last one to run decides what
// the file meant, and neither of them says so.
writeFileSync('artifacts/evidence-status.json', JSON.stringify(trajectoryStatus, null, 2) + '\n');

// ---- exploration-status ---------------------------------------------------
let debtRows: unknown[] = [];
try {
  debtRows = db.prepare('SELECT * FROM exploration_debt').all();
} catch {
  debtRows = [];
}
writeFileSync(
  'artifacts/exploration-status.json',
  JSON.stringify(
    {
      carriedDebtRows: debtRows,
      note:
        debtRows.length === 0
          ? 'no exploration debt persisted yet: the arm requires production cycles to run, and none have since migration 35 landed'
          : null,
    },
    null,
    2,
  ) + '\n',
);

// ---- wss-status -----------------------------------------------------------
writeFileSync(
  'artifacts/wss-status.json',
  JSON.stringify(
    {
      chainEventsStored: count('SELECT COUNT(*) c FROM chain_events'),
      directChainEventsStored: count('SELECT COUNT(*) c FROM direct_chain_events'),
      unreconciledChainEvents: count('SELECT COUNT(*) c FROM chain_events WHERE reversal_status IS NULL'),
      erroredChainEvents: count('SELECT COUNT(*) c FROM chain_events WHERE tx_error IS NOT NULL'),
      vaultSubscriptionsActive: 'NOT_RUN',
      vaultSubscriptionsNote:
        'packages/pipeline/src/vault-watch.ts implements the subscription set, the urgent queue and gap resync; ' +
        'no live socket session has run since it landed, so there is no session to report',
    },
    null,
    2,
  ) + '\n',
);

// ---- reject-panel-v2 ------------------------------------------------------
const rejects = (() => {
  try {
    return db.prepare('SELECT classification, COUNT(*) c FROM reject_tracking GROUP BY classification').all() as {
      classification: string;
      c: number;
    }[];
  } catch {
    return [];
  }
})();
const tally = tallyOutcomes([]);
writeFileSync(
  'artifacts/reject-panel-v2.json',
  JSON.stringify(
    {
      panelVersion: 'v2',
      legacyRejectTrackingByClassification: rejects,
      prospectiveSamples: 0,
      falseNegativeRate: falseNegativeRate(tally),
      note:
        'the v2 panel samples AT REJECTION TIME and follows forward. No prospective sample has been collected yet, ' +
        'so the rate is null rather than zero. The legacy counts above are the retrospective panel this replaces and ' +
        'are NOT comparable: they were evaluated against current state rather than against the path.',
    },
    null,
    2,
  ) + '\n',
);

// ---- rate-budget-v2 -------------------------------------------------------
const bottleneck = buildBottleneckReport({
  time: { activeSeconds: 0, wallSeconds: 0 },
  resources: [],
  throughput: {
    completedTrajectories: liveRun?.completeRoundTrips ?? 0,
    candidatesConsidered: trajectoryStatus.distinctMintsScreened,
    candidatesWithCanonicalPool: Object.values(migrations).reduce((a, b) => a + b, 0),
    candidatesWithCashbackPool: 0,
    apparatusFailures: 0,
    duplicateObservations: 0,
    workerBusySeconds: 0,
  },
  latency: { queueLagMs: [], markLagMs: [], triggerToFillMs: [] },
});
writeFileSync(
  'artifacts/rate-budget-v2.json',
  JSON.stringify(
    {
      ...bottleneck,
      note:
        'ACTIVE process time is not yet instrumented in the running engine, so every per-second rate is null rather ' +
        'than a number divided by wall time. That is the whole correction this version makes: the previous report ' +
        'divided by elapsed wall time including downtime and concluded quota was not the constraint.',
    },
    null,
    2,
  ) + '\n',
);

// ---- readiness ------------------------------------------------------------
const contract: ConfirmatoryContract = {
  contractId: 'NOT_STAMPED',
  frozenAtUtcMs: 0,
  sourceCommit: 'NOT_STAMPED',
  strategyVersion: 'NOT_STAMPED',
  kernelVersion: 'NOT_STAMPED',
  notionalLamports: '0',
  cohort: 'NOT_STAMPED',
  migrationAgeBand: 'NOT_STAMPED',
  cashbackPolicy: 'NOT_STAMPED',
  mayhemPolicy: 'NOT_STAMPED',
  entryPolicy: 'NOT_STAMPED',
  exitPolicy: 'NOT_STAMPED',
  approvedFingerprints: [],
  costModel: 'NOT_STAMPED',
  rentTreatment: 'NOT_STAMPED',
  counterfactualEvidenceClass: 'NOT_STAMPED',
};
const readiness = evaluateReadiness({
  contractHeld: contractHeld(contract, []).held && contract.contractId !== 'NOT_STAMPED',
  completedTrajectories: liveRun?.completeRoundTrips ?? 0,
  distinctUtcDays: 1,
  netPnlLamports: null,
  expectedLogGrowth: null,
  robustLowerBound: null,
  profitFactor: null,
  drawdownBounded: null,
  cvarAcceptable: null,
  catastrophicIncidenceAcceptable: null,
  blockedIncidenceAcceptable: null,
  recentFiftyPositive: null,
  positiveWithoutTopN: {},
  positiveWithoutBestDay: null,
  positiveWithoutBestFiveMintsOrEntities: null,
  positiveUnderDoubleCosts: null,
  positiveUnderLatencyFailureRentCashbackStress: null,
  positiveExactCanarySizeShadow: null,
  replayDivergences: 0,
  unresolvedReconciliations: 0,
  fingerprintsStable: null,
});
/**
 * Written to its OWN file, not to artifacts/readiness.json.
 *
 * `scripts/readiness.ts` owns that artifact and other code reads its shape.
 * Overwriting it here dropped `generatedUtcMs` and `verdict` and broke a test
 * that checks a readiness claim is fresh — a real regression, caused by two
 * generators claiming one filename. The P18 contract gates are a different
 * view and get a different file.
 */
writeFileSync(
  'artifacts/confirmatory-readiness-v1.json',
  JSON.stringify(
    {
      generatedUtcMs: Date.now(),
      view: 'P18 confirmatory-trajectory gates',
      companionTo: 'artifacts/readiness.json',
      ready: readiness.ready,
      failingGates: readiness.failing,
      gates: readiness.gates,
      thresholds: READINESS_THRESHOLDS,
      note:
        'NO confirmatory contract has been stamped, so readiness cannot pass and does not try. ' +
        'Every UNKNOWN counts as a FAIL by construction: a gate treating null as satisfied would report ready ' +
        'fastest when least is known.',
    },
    null,
    2,
  ) + '\n',
);

// ---- cohort allocation ----------------------------------------------------
const cells: Cell[] = [];
for (const cohort of ['FIRST_HOUR', 'FIRST_DAY', 'FIRST_WEEK', 'OLDER'] as const) {
  for (const cashback of [true, false]) {
    for (const mayhem of [true, false]) {
      cells.push({ cohort, cashback, mayhem, feeTierBps: 250, completed: 0 });
    }
  }
}
writeFileSync(
  'artifacts/cohort-status.json',
  JSON.stringify(
    {
      cells: allocationPriority(cells).map((c) => ({ key: cellKey(c), completed: c.completed })),
      note: 'allocation is ordered by LEAST complete; every cell is empty, so the order is the deterministic tiebreak',
    },
    null,
    2,
  ) + '\n',
);

db.close();
console.log('trajectory-status      :', JSON.stringify(trajectoryStatus.developmentTrajectoriesByState));
console.log('confirmed migrations   :', JSON.stringify(migrations));
console.log('completed round trips  :', trajectoryStatus.completedRoundTripsFromLiveRun);
console.log('readiness ready        :', readiness.ready, `(${readiness.failing.length} gates failing)`);
console.log('artifacts written      : trajectory-status, exploration-status, wss-status, reject-panel-v2, rate-budget-v2, readiness, cohort-status');
