import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { DEVELOPMENT_LIMITS } from '../packages/intelligence/src/candidate-risk.js';
import { MARK_OFFSETS_MS } from '../packages/pipeline/src/mark-path.js';
import { FROZEN_CU_MARGIN_PCT } from '../packages/solana/src/cu-budget.js';

/**
 * P14 — stamp the window BEFORE its first outcome.
 *
 * A window whose parameters are recorded after its outcomes is a description,
 * not a preregistration. This writes the frozen design and the database
 * baseline, so that "what changed during the window" is answerable by
 * subtraction rather than by memory.
 *
 * The endpoint HOST is recorded and the URL is not: the key lives in the query
 * string, and an artifact is a thing that gets committed.
 */

function main(): void {
  const s = loadSecrets();
  const db = openDb({ path: s.databasePath, readonly: true });
  const one = (q: string): number => (db.prepare(q).get() as { c: number } | undefined)?.c ?? 0;

  let sourceCommit = 'unknown';
  let dirty = true;
  try {
    sourceCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    /* unknown provenance is recorded, never omitted */
  }

  const host = (u: string | null): string | null => {
    if (u === null) return null;
    try {
      return new URL(u).host;
    } catch {
      return 'unparseable';
    }
  };

  const stamp = {
    artifact: 'development-window-v1-stamp',
    directiveSection: 'P14',
    windowId: 'DEV_WINDOW_V1',
    startedUtcMs: Date.now(),
    sourceCommit,
    dirty,
    endpointHost: host(s.rpcHttp),
    fallbackHost: host(s.rpcHttpFallback),
    liveLane: false,
    liveLaneOffBecause:
      'logsSubscribe cannot filter below "mentions this program", so the pump programs deliver ' +
      '219 messages/second measured — ~18.9M/day — to catch a few dozen migrations an hour. The ' +
      'backfill lane reaches the same migrations for one account read per mint.',
    frozen: {
      notionalLamports: '20000000',
      slippagePct: 3,
      markOffsetsMs: MARK_OFFSETS_MS,
      entryPolicy: 'HARD_GATES_RANDOM',
      exitPolicies: ['FIXED_15M_CONTROL', 'FLOW_LIQUIDITY_DETERIORATION_V1'],
      admissionLimits: DEVELOPMENT_LIMITS,
      cuMarginPct: FROZEN_CU_MARGIN_PCT,
    },
    databaseSnapshotAtStart: {
      developmentTrajectories: one('SELECT COUNT(*) c FROM development_trajectories'),
      settled: one("SELECT COUNT(*) c FROM development_trajectories WHERE state='SETTLED'"),
      trajectoryMarks: one('SELECT COUNT(*) c FROM trajectory_marks'),
      policyOutcomes: one('SELECT COUNT(*) c FROM trajectory_policy_outcomes'),
      legAccountPlans: one('SELECT COUNT(*) c FROM leg_account_plans'),
      createdAccounts: one('SELECT COUNT(*) c FROM created_accounts'),
      legCashback: one('SELECT COUNT(*) c FROM leg_cashback'),
      candidateRiskFacts: one('SELECT COUNT(*) c FROM candidate_risk_facts'),
      confirmedMigrations: one('SELECT COUNT(*) c FROM confirmed_migrations'),
    },
    rule: 'nothing frozen above may change inside the window. Changing one ENDS it.',
    notClaimed: 'observe mode. No key, no signature, no submission, no capital at risk.',
  };

  db.close();
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/development-window-v1.json', JSON.stringify(stamp, null, 2));

  console.log(`window stamped at ${sourceCommit.slice(0, 8)}${dirty ? ' DIRTY' : ' (clean)'}`);
  console.log(`endpoint ${stamp.endpointHost}  fallback ${stamp.fallbackHost ?? 'none'}`);
  console.log('baseline:', JSON.stringify(stamp.databaseSnapshotAtStart));
  if (dirty) {
    console.error('');
    console.error('REFUSING to call this a clean window: the working tree does not match its commit.');
    process.exitCode = 1;
  }
}

main();
