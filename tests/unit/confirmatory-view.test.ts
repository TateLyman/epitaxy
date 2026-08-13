import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * P14 — one canonical evidence view, and every clause mutated.
 *
 * The clauses lived in five places: `legIsConfirmatory`, the readiness SQL,
 * `canaryEvidenceGates`, the report queries and the capability matrix. Five
 * copies of one definition is five chances to drift, and the way you find out
 * they have drifted is that a gate refuses a position the report already
 * counted — or, worse, the other way round.
 *
 * Each test below breaks exactly one clause and asserts the row disappears. A
 * clause nothing can break is a clause that is not being enforced.
 */

const T0 = 1_760_000_000_000;
const WSOL = 'So11111111111111111111111111111111111111112';
let dir: string;
let db: DatabaseSync;

/** A position that satisfies every clause. Each test spoils one thing. */
function seedConfirmatory(): void {
  db.prepare(
    `INSERT INTO run_contexts
       (context_hash,source_commit,strategy_version,strategy_config_hash,risk_policy_hash,
        schema_version,paper_engine_version,quote_adapter_version,data_regime_id,mode,
        first_seen_utc_ms,last_seen_utc_ms)
     VALUES ('ctx','abc123','v1','sch','rph','schema-v23','pe','qa','dr','paper',?,?)`,
  ).run(T0, T0);

  for (const [id, side] of [
    ['obs-e', 'buy'],
    ['obs-x', 'sell'],
  ] as const) {
    db.prepare(
      `INSERT INTO execution_observations
         (observation_id,family,mint,side,purpose,input_mint,output_mint,requested_amount,
          expected_output,minimum_output,instruction_policy,transaction_policy,simulation,
          raw_payload_hash,requested_utc_ms,received_utc_ms,simulation_effect,
          exact_transaction_blob,endpoint)
       VALUES (?,'BUILD_CUSTOM','Mint1',?,?,?,?,'1','1','1','PASS','PASS','SIMULATED_OK',
               'rph',?,?,'SIMULATED_EFFECT_OK','blob','/build')`,
    ).run(id, side, side === 'buy' ? 'entry' : 'exit', side === 'buy' ? WSOL : 'Mint1', side === 'buy' ? 'Mint1' : WSOL, T0, T0);

    db.prepare(
      `INSERT INTO simulation_jobs
         (job_id,request_hash,execution_observation_id,mode,status,requested_utc_ms,
          confirmatory,validity,simulated_effect_ok,account_coverage_ok)
       VALUES (?,?,?,'CONFIRMATORY_OFFLINE','SIMULATED_OK',?,1,'VALID_CONFIRMATORY',1,1)`,
    ).run(`job-${id}`, `rh-${id}`, id, T0);
  }

  db.prepare(
    `INSERT INTO positions
       (position_id,mint,state,token_amount,cost_lamports,realized_lamports,net_pnl_lamports,
        opened_utc_ms,closed_utc_ms,strategy_version,simulated,context_hash,
        entry_observation_id,exit_observation_id)
     VALUES ('pos','Mint1','CLOSED','0','20000000','21000000','1000000',?,?,'v1',1,'ctx','obs-e','obs-x')`,
  ).run(T0, T0 + 3_600_000);
}

const rows = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM confirmatory_positions_v1').get() as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'confirm-'));
  db = openDb({ path: join(dir, 'c.db'), skipBackup: true });
  seedConfirmatory();
});

afterEach(() => {
  try {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows holds -wal briefly */
  }
});

describe('P14 — the view exists and admits a complete position', () => {
  it('admits one that satisfies every clause', () => {
    expect(rows()).toBe(1);
  });

  it('carries the fields a gate and a report both need', () => {
    const r = db.prepare('SELECT * FROM confirmatory_positions_v1').get() as Record<string, unknown>;
    for (const k of ['position_id', 'mint', 'cost_lamports', 'net_pnl_lamports', 'family', 'source_commit']) {
      expect(r[k], k).toBeDefined();
    }
  });
});

describe('P14 — every clause, mutated', () => {
  const breaks: readonly (readonly [string, string])[] = [
    ['still open', "UPDATE positions SET closed_utc_ms = NULL"],
    ['residual token balance', "UPDATE positions SET token_amount = '1'"],
    ['dirty source commit', "UPDATE run_contexts SET source_commit = 'abc123+dirty'"],
    ['cross-family round trip', "UPDATE execution_observations SET family = 'ORDER_EXECUTE' WHERE side = 'sell'"],
    ['instruction policy', "UPDATE execution_observations SET instruction_policy = 'FAIL' WHERE side = 'sell'"],
    ['transaction policy', "UPDATE execution_observations SET transaction_policy = 'FAIL' WHERE side = 'buy'"],
    ['effect not verified', "UPDATE execution_observations SET simulation_effect = 'EFFECT_REFUSED' WHERE side = 'sell'"],
    ['job effect not ok', 'UPDATE simulation_jobs SET simulated_effect_ok = 0'],
    ['not confirmatory', 'UPDATE simulation_jobs SET confirmatory = 0'],
    ['validity is development', "UPDATE simulation_jobs SET validity = 'VALID_DEVELOPMENT'"],
    ['incomplete account coverage', 'UPDATE simulation_jobs SET account_coverage_ok = 0'],
    ['exact bytes not retained', 'UPDATE execution_observations SET exact_transaction_blob = NULL'],
    ['raw payload not retained', 'UPDATE execution_observations SET raw_payload_hash = NULL'],
    ['net PnL unknown', 'UPDATE positions SET net_pnl_lamports = NULL'],
  ];

  for (const [label, sql] of breaks) {
    it(`refuses a position with ${label}`, () => {
      expect(rows()).toBe(1);
      db.prepare(sql).run();
      expect(rows(), `breaking "${label}" must remove the row`).toBe(0);
    });
  }

  it('refuses every position while a clock discontinuity is unresolved', () => {
    // Not a property of THIS position: an unresolved gap in the record means
    // no position in the corpus can be trusted to sit where it claims in time.
    expect(rows()).toBe(1);
    db.prepare(
      `INSERT INTO clock_checkpoints
         (checkpoint_id,pid,monotonic_ms,wall_utc_ms,resync_required,resync_done_utc_ms)
       VALUES ('k',1,1.0,?,1,NULL)`,
    ).run(T0);
    expect(rows()).toBe(0);
  });

  it('a resolved discontinuity does not block anything', () => {
    db.prepare(
      `INSERT INTO clock_checkpoints
         (checkpoint_id,pid,monotonic_ms,wall_utc_ms,resync_required,resync_done_utc_ms)
       VALUES ('k',1,1.0,?,1,?)`,
    ).run(T0, T0 + 1);
    expect(rows()).toBe(1);
  });

  it('a missing entry or exit observation does not partially qualify', () => {
    // The joins are inner on purpose.
    db.prepare("UPDATE positions SET exit_observation_id = NULL").run();
    expect(rows()).toBe(0);
  });
});
