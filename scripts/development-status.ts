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
blockers.push('branch protection unavailable: private repository requires GitHub Pro (operator action)');
blockers.push('§5 exact v0 transaction assembly not implemented; policy is instruction-level plus an estimate');
blockers.push('§6.7 simulator parity corpus does not exist');
blockers.push('§7 entry does not request a linked BUILD_CUSTOM buy+sell round-trip pair');
blockers.push('§9.2 signal-episode identity not implemented; rescreens may duplicate a signal');
blockers.push('§9.4 due-time shadow scheduler not implemented; selection is oldest-first');

const status = {
  generatedUtc: new Date().toISOString(),
  source: { commit, dirty, branch: git(['branch', '--show-current']) },
  ci: {
    note: 'read from GitHub Actions; see artifacts/release-manifest.json for the run URL',
  },
  branchProtection: {
    enabled: false,
    reason: 'private repository requires GitHub Pro for branch protection',
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
  validDevelopmentTrades: shadows
    .filter((s) => s.state === 'POSITION_CLOSED')
    .reduce((a, s) => a + s.n, 0),
  validConfirmatoryTrades: 0,
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
