import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import { migrationCandidates, samplingSpread } from '../../packages/storage/src/trajectory-repo.js';

/**
 * P14 — a hundred paths across three pools is not a hundred outcomes.
 *
 * `migrationCandidates` was `ORDER BY slot DESC LIMIT ?` with no reference to
 * what had already been sampled. Observed in the first ten minutes of the first
 * window: cycles 1 and 2 opened the SAME three mints, and the corpus was filling
 * with repeated measurements of three pools while the threshold that matters is
 * 100 valid paths per policy-cohort.
 */

function db() {
  const d = openDb({ path: join(mkdtempSync(join(tmpdir(), 'spread-')), 'x.db'), skipBackup: true });
  const mig = d.prepare(
    `INSERT INTO confirmed_migrations
       (signature, instruction_index, program_id, mint, bonding_curve, canonical_pool,
        slot, block_time, commitment, reversal_status, identity_source, observed_utc_ms)
     VALUES (?,0,'prog',?,'curve',?,?,1,'confirmed','CONFIRMED','test',1)`,
  );
  for (const [m, slot] of [['mintA', 300], ['mintB', 200], ['mintC', 100]] as const) {
    mig.run(`sig-${m}`, m, `pool-${m}`, slot);
  }
  return d;
}

const openTrajectory = (d: ReturnType<typeof db>, id: string, mint: string, state: string): void => {
  d.prepare(
    `INSERT INTO development_trajectories
       (trajectory_id, entry_observation_id, entry_simulation_job_id, entry_settlement_id,
        venue, pool, capability_fingerprint, snapshot_hash, mint, cohort, stratum,
        migration_age_ms, notional_lamports, entry_policy_inputs, entry_policy, exit_policy,
        state, evidence_grade, max_attainable_grade, quote_impact_ratio, base_impact_ratio,
        max_impact_ratio, haircut_bps, within_small_impact, opened_utc_ms, refusals)
     VALUES (?,'o','j','s','PUMPSWAP_DIRECT','p','f','h',?,'FIRST_HOUR','S',
             NULL,'1','{}','E','X',?,'SIMULATED_EXECUTION','SIMULATED_EXECUTION',0,0,0,0,1,0,'[]')`,
  ).run(id, mint, state);
};

describe('14 — the sampler spreads before it deepens', () => {
  it('returns every unsampled mint when nothing has been opened', () => {
    const d = db();
    expect(migrationCandidates(d, 10).map((c) => c.mint)).toEqual(['mintA', 'mintB', 'mintC']);
    d.close();
  });

  it('EXCLUDES a mint that already has an open trajectory', () => {
    // Two concurrent trajectories on one pool share a mark path and duplicate
    // each other exactly. This is the defect the first window exposed.
    const d = db();
    openTrajectory(d, 't1', 'mintA', 'AWAITING_FILL_OBSERVATION');
    expect(migrationCandidates(d, 10).map((c) => c.mint)).toEqual(['mintB', 'mintC']);
    d.close();
  });

  it('lets a SETTLED mint back in, because a later hour is a different market', () => {
    const d = db();
    openTrajectory(d, 't1', 'mintA', 'SETTLED');
    expect(migrationCandidates(d, 10).map((c) => c.mint)).toContain('mintA');
    d.close();
  });

  it('orders LEAST-SAMPLED first, so coverage spreads before it deepens', () => {
    const d = db();
    // mintA is the newest by slot and would have led under the old ordering.
    openTrajectory(d, 't1', 'mintA', 'SETTLED');
    expect(migrationCandidates(d, 10).map((c) => c.mint)).toEqual(['mintB', 'mintC', 'mintA']);
    d.close();
  });

  it('caps how much any one pool can contribute', () => {
    const d = db();
    for (let i = 0; i < 3; i++) openTrajectory(d, `t${i}`, 'mintA', 'SETTLED');
    // A cap rather than a ban: a repeat is informative, but a corpus dominated
    // by one pool cannot support a claim about a population.
    expect(migrationCandidates(d, 10, 3).map((c) => c.mint)).not.toContain('mintA');
    expect(migrationCandidates(d, 10, 5).map((c) => c.mint)).toContain('mintA');
    d.close();
  });

  it('reports the concentration, so it cannot go unnoticed again', () => {
    const d = db();
    for (let i = 0; i < 4; i++) openTrajectory(d, `a${i}`, 'mintA', 'SETTLED');
    openTrajectory(d, 'b1', 'mintB', 'SETTLED');
    const s = samplingSpread(d);
    expect(s.trajectories).toBe(5);
    expect(s.distinctMints).toBe(2);
    expect(s.maxPerMint).toBe(4);
    d.close();
  });
});
