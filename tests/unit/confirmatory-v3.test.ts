import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../packages/storage/src/db.js';

/**
 * P16 — one position must produce exactly one row.
 *
 * v1 and v2 JOIN `simulation_jobs` on the observation id. The live corpus has
 * observations with THREE simulation jobs, so a position with three qualifying
 * entry jobs and three qualifying exit jobs yields NINE rows — and every count,
 * mean and bootstrap over the view is inflated by a factor invisible from
 * outside it.
 */
function db() {
  const dir = mkdtempSync(join(tmpdir(), 'confv3-'));
  const d = openDb({ path: join(dir, 'x.db') });
  migrate(d);
  return { d, dir };
}

/** A position that qualifies under v3, with `jobs` simulation jobs per leg. */
function seed(d: ReturnType<typeof openDb>, jobsPerLeg: number): void {
  d.prepare(
    `INSERT INTO run_contexts
       (context_hash,source_commit,strategy_version,strategy_config_hash,risk_policy_hash,
        schema_version,paper_engine_version,quote_adapter_version,data_regime_id,mode,
        first_seen_utc_ms,last_seen_utc_ms)
     VALUES ('ctx','abc123','v1','s','r','schema','pe','qa','dr','paper',1,1)`,
  ).run();

  for (const [id, side] of [
    ['obs-buy', 'buy'],
    ['obs-sell', 'sell'],
  ] as const) {
    d.prepare(
      `INSERT INTO execution_observations
         (observation_id,family,mint,side,purpose,input_mint,output_mint,requested_amount,
          slippage_bps,requested_utc_ms,received_utc_ms,latency_ms,endpoint,
          instruction_policy,transaction_policy,simulation,simulation_effect,
          exact_transaction_blob,raw_payload_hash,context_hash)
       VALUES (?,'BUILD_CUSTOM','M',?,'entry','A','B','1',300,1,1,1,'e',
               'PASS','PASS','SIMULATED_OK','SIMULATED_EFFECT_OK','blob','payload','ctx')`,
    ).run(id, side);

    // The defect's raw material: several qualifying jobs for ONE observation.
    for (let i = 0; i < jobsPerLeg; i++) {
      d.prepare(
        `INSERT INTO simulation_jobs
           (job_id,request_hash,execution_observation_id,mode,status,requested_utc_ms,
            confirmatory,validity,simulated_effect_ok,account_coverage_ok,
            snapshot_manifest_hash,replayable)
         VALUES (?,?,?,'CONFIRMATORY_OFFLINE','SIMULATED_OK',1,1,'VALID_CONFIRMATORY',1,1,?,'REPLAYABLE')`,
      ).run(`job-${id}-${i}`, `rh-${id}-${i}`, id, `manifest-${id}-${i}`);
    }
  }

  d.prepare(
    `INSERT INTO positions
       (position_id,mint,state,token_amount,cost_lamports,realized_lamports,
        opened_utc_ms,closed_utc_ms,strategy_version,simulated,context_hash,
        entry_observation_id,exit_observation_id,
        net_pnl_lamports,execution_cost_lamports,gross_proceeds_lamports,
        entry_cash_out_lamports,exit_cash_in_lamports,locked_rent_lamports,
        residual_token_atoms,cohort,exit_triggered_utc_ms,exit_fill_latency_ms)
     VALUES ('p1','M','POSITION_CLOSED','0','24087331','-8884603',
             1,2,'v1',1,'ctx','obs-buy','obs-sell',
             '-8884603','4087331','15202728',
             '24087331','15202728','4078560',
             '0','AGE_2M_60M',1,1300)`,
  ).run();
}

describe('P16 — confirmatory_positions_v3 cannot duplicate a position', () => {
  it('emits ONE row where v2 emits nine', () => {
    const { d, dir } = db();
    try {
      seed(d, 3);
      const v2 = (d.prepare('SELECT COUNT(*) n FROM confirmatory_positions_v2').get() as { n: number }).n;
      const v3 = (d.prepare('SELECT COUNT(*) n FROM confirmatory_positions_v3').get() as { n: number }).n;

      // 3 entry jobs x 3 exit jobs.
      expect(v2).toBe(9);
      expect(v3).toBe(1);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still emits one row when there is exactly one job per leg', () => {
    const { d, dir } = db();
    try {
      seed(d, 1);
      expect((d.prepare('SELECT COUNT(*) n FROM confirmatory_positions_v3').get() as { n: number }).n).toBe(1);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a position whose net PnL does not equal cash in minus cash out', () => {
    const { d, dir } = db();
    try {
      seed(d, 1);
      // The identity is recomputed by the view, not trusted.
      d.prepare("UPDATE positions SET net_pnl_lamports = '999' WHERE position_id = 'p1'").run();
      expect((d.prepare('SELECT COUNT(*) n FROM confirmatory_positions_v3').get() as { n: number }).n).toBe(0);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a position whose execution cost reaches its cash out', () => {
    const { d, dir } = db();
    try {
      seed(d, 1);
      // P4: execution cost is costs only. Reaching cash out means principal
      // got in, which is exactly what production was writing.
      d.prepare("UPDATE positions SET execution_cost_lamports = '24087331' WHERE position_id = 'p1'").run();
      expect((d.prepare('SELECT COUNT(*) n FROM confirmatory_positions_v3').get() as { n: number }).n).toBe(0);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a trigger that was its own fill', () => {
    const { d, dir } = db();
    try {
      seed(d, 1);
      d.prepare("UPDATE positions SET exit_fill_latency_ms = 0 WHERE position_id = 'p1'").run();
      expect((d.prepare('SELECT COUNT(*) n FROM confirmatory_positions_v3').get() as { n: number }).n).toBe(0);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a leg with no durable replay manifest', () => {
    const { d, dir } = db();
    try {
      seed(d, 1);
      // The state a JIT run genuinely lands in: real evidence about the
      // strategy, and not offline evidence.
      d.prepare("UPDATE simulation_jobs SET replayable = 'JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE'").run();
      expect((d.prepare('SELECT COUNT(*) n FROM confirmatory_positions_v3').get() as { n: number }).n).toBe(0);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a position still holding tokens, whatever its state column says', () => {
    const { d, dir } = db();
    try {
      seed(d, 1);
      d.prepare("UPDATE positions SET token_amount = '5' WHERE position_id = 'p1'").run();
      expect((d.prepare('SELECT COUNT(*) n FROM confirmatory_positions_v3').get() as { n: number }).n).toBe(0);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
