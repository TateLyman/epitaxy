import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import {
  grantExploration,
  consumeExploration,
  entitlements,
  explorationRealised,
} from '../../packages/storage/src/exploration-repo.js';
import { EXPLORATION_FRACTION } from '../../packages/strategy/src/exploration.js';

/**
 * Directive item 55 — exploration entitlement survives restart.
 *
 * `pnpm exploration:status` aliased `cohort:status`, which answers which CELLS
 * ARE UNDER-FILLED. That is a different question from HOW MUCH EXPLORATION
 * BUDGET REMAINS, and the alias is why nobody noticed the exploration arm had
 * never run at all: `allocate()` existed, was tested, was pure, and no
 * production caller invoked it. A command called `exploration:status` printed a
 * healthy-looking report about something else.
 */

const W = 'DEV_WINDOW_V1';
const S = 'CANONICAL_CASHBACK';

const freshDb = () => openDb({ path: join(mkdtempSync(join(tmpdir(), 'expl-')), 'x.db'), skipBackup: true });

const openTrajectory = (
  d: ReturnType<typeof freshDb>,
  id: string,
  arm: string | null,
  p: number | null,
): void => {
  d.prepare(
    `INSERT INTO development_trajectories
       (trajectory_id, entry_observation_id, entry_simulation_job_id, entry_settlement_id,
        venue, pool, capability_fingerprint, snapshot_hash, mint, cohort, stratum,
        migration_age_ms, notional_lamports, entry_policy_inputs, entry_policy, exit_policy,
        state, evidence_grade, max_attainable_grade, quote_impact_ratio, base_impact_ratio,
        max_impact_ratio, haircut_bps, within_small_impact, opened_utc_ms, refusals,
        exploration_arm, inclusion_probability, exploration_window)
     VALUES (?,'o','j','s','PUMPSWAP_DIRECT','p','f','h','m','FIRST_HOUR','S',
             NULL,'1','{}','E','X','SETTLED','SIMULATED_EXECUTION',
             'SIMULATED_EXECUTION',0,0,0,0,1,0,'[]',?,?,?)`,
  ).run(id, arm, p, arm === null ? null : W);
};

describe('55 — the entitlement is a LEDGER, so a restart resumes it', () => {
  it('grants, spends, and reports what remains', () => {
    const db = freshDb();
    grantExploration(db, W, S, EXPLORATION_FRACTION, 8, 1);
    // ceil(8 * 0.25) = 2. The trailing argument is nowMs, not an amount —
    // consume always spends exactly one unit.
    expect(entitlements(db, W)[0]?.granted).toBe(2);
    expect(consumeExploration(db, W, S, 2)).toBe(true);
    expect(entitlements(db, W)[0]?.remaining).toBe(1);
    db.close();
  });

  it('SURVIVES a restart, because the process holds none of the state', () => {
    // The collector is a daemon that restarts. An entitlement held in memory
    // turns a 25% fraction into "25% of whatever happened between crashes",
    // and nothing in the corpus would record that it had happened.
    const dir = mkdtempSync(join(tmpdir(), 'expl-restart-'));
    const path = join(dir, 'x.db');

    const first = openDb({ path, skipBackup: true });
    grantExploration(first, W, S, EXPLORATION_FRACTION, 8, 1);
    consumeExploration(first, W, S, 2);
    first.close();

    // A whole new process would see exactly this.
    const second = openDb({ path, skipBackup: true });
    const e = entitlements(second, W)[0];
    expect(e?.granted).toBe(2);
    expect(e?.consumed).toBe(1);
    expect(e?.remaining).toBe(1);
    second.close();
  });

  it('REFUSES to overspend, so the recorded fraction is what happened', () => {
    const db = freshDb();
    grantExploration(db, W, S, EXPLORATION_FRACTION, 4, 1); // ceil(1) = 1
    expect(consumeExploration(db, W, S, 2)).toBe(true);
    // The budget is now exhausted. A silent overspend would make the recorded
    // fraction a description of intent rather than of what happened.
    expect(consumeExploration(db, W, S, 3)).toBe(false);
    expect(entitlements(db, W)[0]?.consumed).toBe(1);
    db.close();
  });

  it('refuses to spend from a stratum that was never granted anything', () => {
    const db = freshDb();
    expect(consumeExploration(db, W, 'NEVER_GRANTED', 1)).toBe(false);
    db.close();
  });

  it('never rounds the arm out of existence on a small budget', () => {
    // floor(2 * 0.25) is 0 and the exploration arm never runs. Ceil buys one.
    const db = freshDb();
    grantExploration(db, W, S, EXPLORATION_FRACTION, 2, 1);
    expect(entitlements(db, W)[0]?.granted).toBe(1);
    db.close();
  });

  it('accumulates across cycles rather than being recomputed from a total', () => {
    const db = freshDb();
    grantExploration(db, W, S, EXPLORATION_FRACTION, 8, 1);
    grantExploration(db, W, S, EXPLORATION_FRACTION, 8, 2);
    expect(entitlements(db, W)[0]?.granted).toBe(4);
    db.close();
  });

  it('keeps windows apart, so one window cannot spend another budget', () => {
    const db = freshDb();
    grantExploration(db, W, S, EXPLORATION_FRACTION, 8, 1);
    expect(consumeExploration(db, 'DEV_WINDOW_V2', S, 2)).toBe(false);
    db.close();
  });
});

describe('55 — the LEDGER and the CORPUS are reported apart', () => {
  it('counts the arms actually recorded on trajectory rows', () => {
    const db = freshDb();
    openTrajectory(db, 't1', 'explore', 0.25);
    openTrajectory(db, 't2', 'exploit', 0.9);
    openTrajectory(db, 't3', 'exploit', 0.9);
    openTrajectory(db, 't4', 'exploit', 0.9);
    const r = explorationRealised(db);
    expect(r.explore).toBe(1);
    expect(r.exploit).toBe(3);
    expect(r.realisedFraction).toBe(0.25);
    db.close();
  });

  it('counts rows opened BEFORE the arm existed as unassigned, not as exploitation', () => {
    // "We did not record it" is not "it was exploitation", and folding one into
    // the other would report a corpus with no exploration as a corpus that
    // chose not to explore.
    const db = freshDb();
    openTrajectory(db, 't1', null, null);
    openTrajectory(db, 't2', 'explore', 0.25);
    const r = explorationRealised(db);
    expect(r.unassigned).toBe(1);
    expect(r.exploit).toBe(0);
    expect(r.realisedFraction).toBe(1);
    db.close();
  });

  it('reports no fraction at all when nothing has been assigned', () => {
    const db = freshDb();
    openTrajectory(db, 't1', null, null);
    // Null, never 0. A corpus with no arms recorded has not explored 0%; it has
    // not been measured.
    expect(explorationRealised(db).realisedFraction).toBeNull();
    db.close();
  });
});
