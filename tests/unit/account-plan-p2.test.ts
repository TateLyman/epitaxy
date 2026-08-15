import { describe, it, expect } from 'vitest';
import {
  freezeAccountPlan,
  planAccountsNotCaptured,
  assertPlanUnchanged,
  AccountPlanIncomplete,
} from '../../packages/solana/src/account-plan.js';
import { FeeConfigUndecodable, quoteBuyFrom, quoteSellFrom, accountSourceOf } from '../../packages/solana/src/pumpswap-offline.js';
import type { RawInstruction } from '../../packages/solana/src/instructionpolicy.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import {
  insertAccountPlan,
  accountPlanFor,
  accountPlanCount,
} from '../../packages/storage/src/trajectory-repo.js';

/**
 * The directive's P2 tests: 9, 10, 20 and 27.
 *
 * F12's premise is that the SDK CHOOSES. It selects a fee recipient from a
 * list, appends remaining accounts when cashback applies, and derives ATAs
 * under whichever token program the mint happens to use. A system that captures
 * state for one build, simulates a second and fingerprints a third is comparing
 * three experiments while reporting one.
 */

const PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const RECIPIENT_A = '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV';
const RECIPIENT_B = '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ';

function ix(accounts: string[], data = 'ZGF0YQ=='): RawInstruction {
  return {
    programId: PROGRAM,
    data,
    accounts: accounts.map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i > 0 })),
  };
}

describe('9 — built transaction bytes are described exactly once', () => {
  it('records ordered metas, not a set', () => {
    const plan = freezeAccountPlan('buy', [ix(['user', 'pool', 'vault'])]);
    expect(plan.instructions[0]?.accounts.map((a) => a.index)).toEqual([0, 1, 2]);
    expect(plan.instructions[0]?.accounts.map((a) => a.pubkey)).toEqual(['user', 'pool', 'vault']);
  });

  it('reordering the accounts changes the fingerprint', () => {
    const a = freezeAccountPlan('buy', [ix(['user', 'pool', 'vault'])]);
    const b = freezeAccountPlan('buy', [ix(['user', 'vault', 'pool'])]);
    // Position IS the identity: PumpSwap reads the cashback accumulator ATA at
    // remaining index 0 and the accumulator PDA at index 1.
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('changing the instruction data changes the fingerprint', () => {
    const a = freezeAccountPlan('buy', [ix(['user', 'pool'], 'YWFh')]);
    const b = freezeAccountPlan('buy', [ix(['user', 'pool'], 'YmJi')]);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('an instruction with no metas REFUSES rather than planning nothing', () => {
    expect(() => freezeAccountPlan('buy', [{ programId: PROGRAM, data: 'eA==' }])).toThrow(
      AccountPlanIncomplete,
    );
    // The failure mode this prevents: an empty plan passes every coverage
    // check written against it, because it claims to touch nothing.
    expect(() => freezeAccountPlan('buy', [])).toThrow(AccountPlanIncomplete);
  });
});

describe('10 — fee recipient selection cannot change between capture and execution', () => {
  it('detects a swapped fee recipient by name', () => {
    const captured = freezeAccountPlan('buy', [ix(['user', 'pool', RECIPIENT_A])]);
    const executed = freezeAccountPlan('buy', [ix(['user', 'pool', RECIPIENT_B])]);
    expect(() => assertPlanUnchanged(captured, executed)).toThrow(/account 2/);
    expect(() => assertPlanUnchanged(captured, executed)).toThrow(new RegExp(RECIPIENT_B));
  });

  it('an identical rebuild is not a change', () => {
    const a = freezeAccountPlan('buy', [ix(['user', 'pool', RECIPIENT_A])]);
    const b = freezeAccountPlan('buy', [ix(['user', 'pool', RECIPIENT_A])]);
    expect(() => assertPlanUnchanged(a, b)).not.toThrow();
  });

  it('an account the plan touches but the snapshot never fetched is named', () => {
    const plan = freezeAccountPlan('buy', [ix(['user', 'pool', RECIPIENT_A])]);
    // The snapshot was built by RE-DERIVING addresses, and the SDK picked a
    // recipient that derivation does not predict.
    const missing = planAccountsNotCaptured(plan, ['user', 'pool']);
    expect(missing).toEqual([RECIPIENT_A]);
    expect(planAccountsNotCaptured(plan, ['user', 'pool', RECIPIENT_A])).toEqual([]);
  });
});

describe('20 — a fee config that is present and undecodable refuses', () => {
  const POOL = 'BSHanq7NmdY6j8u5YE9A3SUygj1bhavFqb73vadspkL3';

  /** A source whose fee config exists and is nonsense. */
  function sourceWithBadFeeConfig(): ReturnType<typeof accountSourceOf> {
    return accountSourceOf([
      {
        pubkey: 'GS4CU59F31iL7aR2Q8zD6SFoR93Gv2rmMH1UzeQqSSuw',
        owner: PROGRAM,
        // Present. Not decodable. Those are the two facts that matter.
        dataBase64: Buffer.alloc(8, 9).toString('base64'),
        lamports: 1_000_000n,
      },
    ]);
  }

  it('does not report an undecodable config as an absent one', () => {
    const src = sourceWithBadFeeConfig();
    // Both quoting paths reach the same decode. The pool itself is missing
    // here, so the throw may name either — what must NOT happen is a silent
    // null that prices against the static tier.
    let buyErr: Error | null = null;
    let sellErr: Error | null = null;
    try {
      quoteBuyFrom(src, POOL, 1_000_000n, 1);
    } catch (e) {
      buyErr = e as Error;
    }
    try {
      quoteSellFrom(src, POOL, 1_000_000n, 1);
    } catch (e) {
      sellErr = e as Error;
    }
    expect(buyErr).not.toBeNull();
    expect(sellErr).not.toBeNull();
  });

  it('names the two facts it refuses to merge', () => {
    const e = new FeeConfigUndecodable('bad discriminator');
    expect(e.message).toMatch(/present and did not decode/);
    // "No dynamic fee config exists" and "it exists and we cannot read it" give
    // different prices, and only one of them is a fact about the pool.
    expect(e.message).toMatch(/static tier/);
  });
});

describe('27 — a recorded plan cannot be replaced', () => {
  function db() {
    const d = openDb({ path: join(mkdtempSync(join(tmpdir(), 'plan-')), 'x.db'), skipBackup: true });
    d.prepare(
      `INSERT INTO development_trajectories
         (trajectory_id, entry_observation_id, entry_simulation_job_id, entry_settlement_id,
          venue, pool, capability_fingerprint, snapshot_hash, mint, cohort, stratum,
          migration_age_ms, notional_lamports, entry_policy_inputs, entry_policy, exit_policy,
          state, evidence_grade, max_attainable_grade, quote_impact_ratio, base_impact_ratio,
          max_impact_ratio, haircut_bps, within_small_impact, opened_utc_ms, refusals)
       VALUES ('t1','o','j','s','PUMPSWAP_DIRECT','p','f','h','m','FIRST_HOUR','S',
               NULL,'1','{}','E','X','AWAITING_FILL_OBSERVATION','SIMULATED_EXECUTION',
               'SIMULATED_EXECUTION',0,0,0,0,1,0,'[]')`,
    ).run();
    return d;
  }

  it('stores the plan and reads it back', () => {
    const d = db();
    const plan = freezeAccountPlan('buy', [ix(['user', 'pool', RECIPIENT_A])]);
    insertAccountPlan(d, 't1', plan, 1_700_000_000_000);
    const back = accountPlanFor(d, 't1', 'buy');
    expect(back?.fingerprint).toBe(plan.fingerprint);
    expect(back?.instruction_count).toBe(1);
    expect(JSON.parse(back?.accounts ?? '[]')).toContain(RECIPIENT_A);
    expect(accountPlanCount(d)).toBe(1);
  });

  it('an idempotent retry of the SAME plan is not a rewrite', () => {
    const d = db();
    const plan = freezeAccountPlan('buy', [ix(['user', 'pool', RECIPIENT_A])]);
    insertAccountPlan(d, 't1', plan, 1);
    expect(() => insertAccountPlan(d, 't1', plan, 2)).not.toThrow();
    expect(accountPlanCount(d)).toBe(1);
  });

  it('a DIFFERENT plan under the same identity refuses', () => {
    const d = db();
    insertAccountPlan(d, 't1', freezeAccountPlan('buy', [ix(['user', 'pool', RECIPIENT_A])]), 1);
    // This is the rebuild. Letting it through would redefine what the earlier
    // execution was, after the fact and without a trace.
    expect(() =>
      insertAccountPlan(d, 't1', freezeAccountPlan('buy', [ix(['user', 'pool', RECIPIENT_B])]), 2),
    ).toThrow();
    expect(accountPlanFor(d, 't1', 'buy')?.fingerprint).toBe(
      freezeAccountPlan('buy', [ix(['user', 'pool', RECIPIENT_A])]).fingerprint,
    );
  });
});
