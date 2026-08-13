import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, loadSecrets, modeFromArgv } from '../packages/domain/src/config.js';
import { strategyConfigHash, riskPolicyHash, sourceCommit, dataRegimeId } from '../packages/domain/src/provenance.js';
import { surfpoolAvailable, packageVersion } from '../packages/simulator/src/surfpool.js';

/**
 * What is actually being collected right now, and what it is worth.
 *
 * Machine-generated, per §21. Every number is a query, not a claim, and the
 * blocker list is derived rather than typed — a hand-maintained blocker list
 * goes stale in exactly the direction that flatters the author.
 */

const config = loadConfig(modeFromArgv() ?? 'paper');
const secrets = loadSecrets();
const db = new DatabaseSync(secrets.databasePath, { readOnly: true });

const one = <T>(sql: string, ...a: unknown[]): T =>
  db.prepare(sql).get(...(a as never[])) as T;
const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

const git = (args: string[]): string => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unavailable';
  }
};

const commit = sourceCommit();
const dirty = commit.endsWith('+dirty');

const obs = one<{ total: number; policy: number; simulated: number; withRaw: number }>(
  `SELECT COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN instruction_policy='PASS' AND transaction_policy='PASS' THEN 1 ELSE 0 END),0) AS policy,
          COALESCE(SUM(CASE WHEN simulation='SIMULATED_OK' THEN 1 ELSE 0 END),0) AS simulated,
          COALESCE(SUM(CASE WHEN raw_payload_hash IS NOT NULL THEN 1 ELSE 0 END),0) AS withRaw
   FROM execution_observations`,
);

const byPurpose = all<{ purpose: string; n: number }>(
  'SELECT purpose, COUNT(*) AS n FROM execution_observations GROUP BY 1 ORDER BY n DESC',
);
const byFamily = all<{ family: string; n: number }>(
  'SELECT family, COUNT(*) AS n FROM execution_observations GROUP BY 1',
);
const shadows = all<{ book: string; state: string; n: number }>(
  'SELECT book, state, COUNT(*) AS n FROM shadow_positions GROUP BY 1,2',
);
const positions = all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM positions GROUP BY 1');
const blocked = one<{ n: number }>("SELECT COUNT(*) AS n FROM positions WHERE state = 'EXIT_BLOCKED'").n;
const unmanaged = one<{ n: number }>(
  `SELECT COUNT(*) AS n FROM positions WHERE closed_utc_ms IS NULL AND CAST(token_amount AS INTEGER) > 0
     AND state NOT IN ('POSITION_OPEN','EXIT_INTENT','EXIT_BLOCKED','RECONCILING')`,
).n;

// Mark cadence and lag across shadow books — §9.4's reporting requirement, even
// though the fair scheduler itself is not yet implemented. Reporting the lag we
// currently produce is how the absence of the scheduler stays visible.
const lag = all<{ shadow_position_id: string; gap: number }>(
  `SELECT shadow_position_id, MAX(observed_utc_ms) - MIN(observed_utc_ms) AS gap
   FROM shadow_marks GROUP BY shadow_position_id`,
);
const gaps = all<{ g: number }>(
  `SELECT (b.observed_utc_ms - a.observed_utc_ms) AS g
   FROM shadow_marks a JOIN shadow_marks b
     ON b.shadow_position_id = a.shadow_position_id AND b.seq = a.seq + 1`,
).map((r) => r.g).sort((x, y) => x - y);
const pct = (p: number): number | null => (gaps.length === 0 ? null : (gaps[Math.floor(gaps.length * p)] ?? gaps[gaps.length - 1]) ?? null);

const contexts = all<{ context_hash: string; data_regime_id: string; source_commit: string }>(
  'SELECT context_hash, data_regime_id, source_commit FROM run_contexts ORDER BY first_seen_utc_ms',
);

const replay = (() => {
  try {
    return one<{ strategy_version: string; replayed: number; divergences: number; run_utc_ms: number }>(
      'SELECT strategy_version, replayed, divergences, run_utc_ms FROM replay_runs ORDER BY run_utc_ms DESC LIMIT 1',
    );
  } catch {
    return null;
  }
})();

const sim = surfpoolAvailable();

// Blockers, derived. Anything that would stop a row becoming confirmatory.
/**
 * Closed shadows whose BOTH legs were effect-verified, by evidence class.
 *
 * Inner joins on purpose: a position missing a job on either leg does not
 * partially qualify.
 */
function countValid(mode: 'jit' | 'offline'): number {
  const modeClause =
    mode === 'offline'
      ? "AND je.mode = 'CONFIRMATORY_OFFLINE' AND jx.mode = 'CONFIRMATORY_OFFLINE' AND je.confirmatory = 1 AND jx.confirmatory = 1"
      : '';
  try {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n FROM shadow_positions s
         JOIN simulation_jobs je ON je.execution_observation_id = s.entry_observation_id
         JOIN simulation_jobs jx ON jx.execution_observation_id = s.entry_sell_observation_id
         WHERE s.closed_utc_ms IS NOT NULL
           AND je.validity LIKE 'VALID_%' AND jx.validity LIKE 'VALID_%'
           AND je.simulated_effect_ok = 1 AND jx.simulated_effect_ok = 1
           ${modeClause}`,
      )
      .get() as { n: number } | undefined;
    return r?.n ?? 0;
  } catch {
    // A query that cannot run has established nothing, and nothing is zero.
    return 0;
  }
}

const validDevelopment = countValid('jit');
const validConfirmatory = countValid('offline');

const blockers: string[] = [];
if (obs.simulated === 0) {
  blockers.push(
    `0 of ${obs.total} observations are simulated. requireLocalSimulation=${String(config.requireLocalSimulation)} ` +
      'and the engine books no fills; every row is DEVELOPMENT_STRUCTURAL.',
  );
}
if (!sim.available) blockers.push(`no local SVM on this platform: ${sim.reason}`);
if (dirty) blockers.push('working tree does not match its commit; nothing produced here is reproducible');
if (blocked > 0) blockers.push(`${blocked} position(s) in EXIT_BLOCKED`);
if (unmanaged > 0) blockers.push(`${unmanaged} position(s) hold tokens outside the managed set`);
if (replay === null || replay.replayed === 0) {
  blockers.push('no replay run has reproduced a snapshot at the current strategy version');
}
/**
 * P22 -- blockers are MEASURED, not hardcoded.
 *
 * Six were printed unconditionally, and by this session four of them had been
 * false for some time: exact v0 assembly is implemented and 1,033 observations
 * carry an exact transaction blob; entry does request a linked same-family
 * buy and sell; signal episodes have identity; the due-time scheduler exists.
 *
 * A status report that lists fixed problems is worse than one that lists none:
 * it trains its reader to skim, and the one real blocker in the list gets
 * skimmed with the rest.
 */
const measured = <T>(sql: string, fallback: T): T => {
  try {
    return (db.prepare(sql).get() as T) ?? fallback;
  } catch {
    return fallback;
  }
};

const exactBlobs = measured<{ n: number }>(
  'SELECT COUNT(*) AS n FROM execution_observations WHERE exact_transaction_blob IS NOT NULL',
  { n: 0 },
).n;
if (exactBlobs === 0) {
  blockers.push('no exact transaction blob has ever been captured; policy is instruction-level only');
}

const roundTrips = measured<{ n: number }>(
  "SELECT COUNT(*) AS n FROM execution_observations WHERE purpose = 'entry_roundtrip'",
  { n: 0 },
).n;
if (roundTrips === 0) {
  blockers.push('entry has never requested a linked same-family buy and sell');
}

const episodes = measured<{ n: number }>(
  'SELECT COUNT(*) AS n FROM shadow_positions WHERE signal_episode_id IS NOT NULL',
  { n: 0 },
).n;
if (episodes === 0) blockers.push('signal-episode identity is not being recorded; rescreens may duplicate a signal');

const instrumentOnly = measured<{ n: number }>(
  "SELECT COUNT(*) AS n FROM simulation_jobs WHERE validity = 'INSTRUMENT_DEVELOPMENT'",
  { n: 0 },
).n;
if (validDevelopment === 0) {
  blockers.push(
    `no effect-verified round trip exists yet (${instrumentOnly} simulation job(s) are INSTRUMENT_DEVELOPMENT and are not evidence)`,
  );
}

const parityCorpus = measured<{ n: number }>(
  "SELECT COUNT(*) AS n FROM simulation_jobs WHERE mode = 'CONFIRMATORY_OFFLINE'",
  { n: 0 },
).n;
if (parityCorpus === 0) blockers.push('no offline confirmatory run exists; reproducibility is unestablished');

const unassignedCohort = measured<{ n: number }>(
  'SELECT COUNT(*) AS n FROM shadow_positions WHERE cohort IS NULL',
  { n: 0 },
).n;
if (unassignedCohort > 0) {
  blockers.push(`${unassignedCohort} shadow position(s) carry no cohort, so the age experiment has no control arm`);
}

const status = {
  generatedUtc: new Date().toISOString(),
  source: { commit, dirty, branch: git(['branch', '--show-current']) },
  ci: {
    note: 'read from GitHub Actions; see artifacts/release-manifest.json for the run URL',
  },
  branchProtection: {
    enabled: false,
    reason: 'branch protection not configured (operator action; the repository is not required to be private)',
  },
  hashes: {
    strategyVersion: config.strategyVersion,
    strategyConfigHash: strategyConfigHash(config),
    riskPolicyHash: riskPolicyHash(config),
    dataRegimeId: dataRegimeId(config, 'schema-v9'),
  },
  executionFamily: config.primaryRouteFamily,
  simulator: {
    available: sim.available,
    reason: sim.reason,
    packageVersion: packageVersion(),
    parityEstablished: false,
    accountSnapshotRegime: 'none — no snapshot capture pipeline yet',
  },
  observations: {
    total: obs.total,
    policyValid: obs.policy,
    simulated: obs.simulated,
    withRawPayload: obs.withRaw,
    byPurpose,
    byFamily,
  },
  shadowPositions: shadows,
  portfolioPositions: positions,
  blockedPositions: blocked,
  unmanagedPositions: unmanaged,
  markCadence: {
    positionsWithMarks: lag.length,
    intervalCount: gaps.length,
    medianGapMs: pct(0.5),
    p95GapMs: pct(0.95),
    maxGapMs: gaps.length === 0 ? null : gaps[gaps.length - 1],
  },
  costModel: {
    priorityFeeFormula: 'ceil(unit_price_micro_lamports * chosen_limit / 1e6)',
    assumedPriorityFeeLamports: config.assumedPriorityFeeLamports.toString(),
    observedRouterUnitPriceMicroLamports: 2054,
    note:
      'the config assumption of 200000 lamports is ~486x the fee the observed router price implies at a ' +
      '200k compute limit (411 lamports). §4.1 replacement with simulated unitsConsumed is NOT done.',
    failedAttemptModel: 'still a single assumed value charged on entry and again on exit (§4.2 open)',
    ataRecoveryTreatment: 'observed, which is currently 0% (withheld transfer fees unobserved)',
  },
  contexts,
  replay,
  /**
   * P22 -- a closed shadow is NOT a valid development trade.
   *
   * This counted every closed shadow position and reported 918. All 918 were
   * `STRUCTURAL_ONLY`: an exact buildable buy and sell existed, and nothing was
   * ever simulated with a request that described an economic leg. Reporting
   * them as valid development overstated the evidence by 918.
   *
   * A trade is valid development only when BOTH of its legs were
   * effect-verified by a job whose request described the leg. Derived here
   * rather than assumed, and it is allowed to be zero.
   */
  validDevelopmentTrades: validDevelopment,
  structuralOnlyClosedShadows: shadows
    .filter((s) => s.state === 'POSITION_CLOSED')
    .reduce((a, s) => a + s.n, 0),
  validConfirmatoryTrades: validConfirmatory,
  blockers,
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/development-status.json', JSON.stringify(status, null, 2));

console.log(`development status — ${status.generatedUtc}\n`);
console.log(`  commit                 ${commit}`);
console.log(`  family                 ${status.executionFamily}`);
console.log(`  regime                 ${status.hashes.dataRegimeId}`);
console.log(`  simulator              ${sim.available ? 'available' : 'NOT available'} — ${sim.reason}`);
console.log(`  observations           ${obs.total} (${obs.policy} policy-valid, ${obs.simulated} simulated)`);
console.log(`  raw payloads retained  ${obs.withRaw}`);
console.log(`  shadow positions       ${shadows.map((s) => `${s.book}/${s.state}=${s.n}`).join(' ')}`);
console.log(`  mark gaps ms           median ${status.markCadence.medianGapMs} p95 ${status.markCadence.p95GapMs} max ${status.markCadence.maxGapMs}`);
console.log(`  valid development      ${status.validDevelopmentTrades} closed shadow position(s)`);
console.log(`  valid confirmatory     ${status.validConfirmatoryTrades}`);
console.log(`\n  blockers (${blockers.length}):`);
for (const b of blockers) console.log(`    - ${b}`);
console.log('\nwritten to artifacts/development-status.json');

db.close();
