import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import { insertTrajectorySettlement, settlementTotals } from '../../packages/storage/src/trajectory-repo.js';
import { legSettlementFromRuntime, BASE_FEE_PER_SIGNATURE_LAMPORTS } from '../../packages/pipeline/src/leg-settlement.js';
import { buildTrajectorySettlement, checkIdentities } from '../../packages/domain/src/trajectory-settlement.js';
import type { CreatedAccount } from '../../packages/solana/src/created-accounts.js';

/**
 * P5 — the canonical settlement, WIRED.
 *
 * `buildTrajectorySettlement` was correct and unreachable for several commits:
 * its only call site was the trajectory kernel, which the collector never
 * reaches, and no table existed to store a result. Every trajectory's net PnL
 * was UNKNOWN BY CONSTRUCTION rather than for want of a sample — the collector
 * measured a full round trip and then discarded the economics.
 */

const TAKER = 'GgSuFAyZRqpzYNE32WNv5uihdENhz1nPHB7MquioFMj3';
const ATA = '8MNXnWvhMvzfkNrySGQiPSiTYUxs2TboM9pzXCZw7AJ3';
const QUOTE_VAULT = '9kivsjTqAEPWuJWbsGsuo4NxFKRec5Z7tw7W3cTJBEjx';
const MINT = '24fTiNwEG3dEusEjT1GfskFwKpYZhx6MDigceXt2pump';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** An SPL token account holding `amount` at offset 64. */
const tok = (pubkey: string, lamports: bigint, amount: bigint) => ({
  pubkey,
  owner: TOKEN_PROGRAM,
  lamports,
  dataLen: 165,
  dataBase64: (() => {
    const b = Buffer.alloc(165);
    b.writeBigUInt64LE(amount, 64);
    return b.toString('base64');
  })(),
});

const sys = (pubkey: string, lamports: bigint) => ({
  pubkey,
  owner: '11111111111111111111111111111111',
  lamports,
  dataLen: 0,
  dataBase64: '',
});

const leg = (over: Record<string, unknown> = {}) =>
  legSettlementFromRuntime({
    observationId: 'obs',
    simulationJobId: 'job',
    side: 'buy',
    capabilityFingerprint: 'fp',
    taker: TAKER,
    takerBaseAta: ATA,
    mint: MINT,
    baseTokenProgram: TOKEN_PROGRAM,
    poolQuoteVault: QUOTE_VAULT,
    requested: 20_000_000n,
    minimumOut: 0n,
    pre: [sys(TAKER, 500_000_000_000n), tok(QUOTE_VAULT, 2_039_280n, 100_000_000n), tok(ATA, 0n, 0n)],
    post: [sys(TAKER, 499_979_995_000n), tok(QUOTE_VAULT, 2_039_280n, 120_000_000n), tok(ATA, 0n, 5_000n)],
    createdAccounts: [],
    closedAccounts: [],
    runtimeOk: true,
    incompleteness: [],
    fullAccountCoverage: true,
    snapshotManifestHash: null,
    ...over,
  } as never);

describe('P5 — a runtime leg becomes a measured settlement', () => {
  it('derives every figure from the payer native delta', () => {
    const s = leg();
    // 500,000,000,000 -> 479,994,995,000
    expect(s.payerNativeDeltaLamports).toBe(-20_005_000n);
    expect(s.input.kind).toBe('native_sol');
    if (s.input.kind === 'native_sol') {
      // The pool's quote vault rose by 20,000,000: that is the trade, separated
      // from the fee, which is what the round trip needs kept apart.
      expect(s.input.actualTradeDebitLamports).toBe(20_000_000n);
      expect(s.input.totalPayerDebitLamports).toBe(20_005_000n);
    }
  });

  it('reconciles to ZERO unexplained when the model is complete', () => {
    // 20,000,000 trade + 5,000 base fee accounts for the whole payer delta.
    const s = leg();
    expect(s.costs.unexplainedLamports).toBe(0n);
    expect(s.costs.baseFeeLamports).toBe(BASE_FEE_PER_SIGNATURE_LAMPORTS);
  });

  it('SURFACES a residue rather than absorbing it', () => {
    // The payer lost an extra 777 lamports that no named cost explains. A
    // residue is not rounding: it is a cost the model does not know about.
    const s = leg({
      post: [sys(TAKER, 499_979_994_223n), tok(QUOTE_VAULT, 2_039_280n, 120_000_000n), tok(ATA, 0n, 5_000n)],
    });
    expect(s.costs.unexplainedLamports).toBe(-777n);
  });

  it('counts rent created and recovered separately, never netted away', () => {
    const created: CreatedAccount[] = [
      {
        pubkey: ATA,
        owner: TOKEN_PROGRAM,
        space: 165,
        rentExemptMinimumLamports: 2_039_280n,
        excessLamports: 0n,
        scope: 'WALLET_TOKEN_MINT',
        recoverability: 'RECOVERABLE_BY_US',
        sharedWithOtherTraders: false,
      },
    ];
    const s = leg({ createdAccounts: created, closedAccounts: [ATA] });
    expect(s.costs.rentCreatedLamports).toBe(2_039_280n);
    expect(s.costs.rentRecoveredLamports).toBe(2_039_280n);
  });

  it('marks the leg incomplete when the payer was not observed', () => {
    const s = leg({ pre: [tok(QUOTE_VAULT, 2_039_280n, 100_000_000n)] });
    expect(s.complete).toBe(false);
    expect(s.incompleteness.join(' ')).toContain('payer was not observed');
  });
});

describe('P5 — the trajectory settlement, and what blocks net PnL', () => {
  it('produces a net PnL when both legs are complete and covered', () => {
    const entry = leg();
    const exit = leg({
      side: 'sell',
      requested: 5_000n,
      pre: [sys(TAKER, 499_979_995_000n), tok(QUOTE_VAULT, 2_039_280n, 120_000_000n), tok(ATA, 0n, 5_000n)],
      post: [sys(TAKER, 499_999_490_000n), tok(QUOTE_VAULT, 2_039_280n, 100_500_000n), tok(ATA, 0n, 0n)],
    });
    const s = buildTrajectorySettlement({ trajectoryId: 't1', entry, exit });
    expect(s.pnlBlockedReasons).toEqual([]);
    expect(s.netPnlLamports).not.toBeNull();
  });

  it('refuses a net PnL when a leg did not observe every writable it touched', () => {
    // UNKNOWN is not zero. A leg that cannot be replayed is not evidence, and a
    // number derived from it is not re-derivable.
    const s = buildTrajectorySettlement({
      trajectoryId: 't1',
      entry: leg({ fullAccountCoverage: false }),
      exit: null,
    });
    expect(s.netPnlLamports).toBeNull();
    expect(s.pnlBlockedReasons.join(' ')).toContain('did not observe every writable');
  });

  it('refuses a net PnL before the trajectory has exited', () => {
    const s = buildTrajectorySettlement({ trajectoryId: 't1', entry: leg(), exit: null });
    expect(s.netPnlLamports).toBeNull();
    expect(s.pnlBlockedReasons.join(' ')).toContain('has not exited');
  });
});

describe('P5 persistence — one settlement, written once', () => {
  const freshDb = () => {
    const d = openDb({ path: join(mkdtempSync(join(tmpdir(), 'p5-')), 'x.db'), skipBackup: true });
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
  };

  const settlementOf = (exitPresent: boolean) =>
    buildTrajectorySettlement({ trajectoryId: 't1', entry: leg(), exit: exitPresent ? leg({ side: 'sell' }) : null });

  it('stores the settlement and reports whether a net PnL exists', () => {
    const db = freshDb();
    const s = settlementOf(false);
    insertTrajectorySettlement(db, 't1', 'IMMEDIATE_MECHANICS', s, checkIdentities(s).violations, 1);
    const t = settlementTotals(db);
    expect(t.settlements).toBe(1);
    // Null net PnL is a REPORTED state, never a zero.
    expect(t.withNetPnl).toBe(0);
    expect(t.topBlockers.length).toBeGreaterThan(0);
    db.close();
  });

  it('a second, DIFFERENT answer for the same trajectory does not overwrite the first', () => {
    const db = freshDb();
    const a = settlementOf(false);
    const b = settlementOf(true);
    insertTrajectorySettlement(db, 't1', 'IMMEDIATE_MECHANICS', a, [], 1);
    insertTrajectorySettlement(db, 't1', 'IMMEDIATE_MECHANICS', b, [], 2);
    // An outcome that can be rewritten is an outcome that can be improved
    // after the fact.
    expect(settlementTotals(db).settlements).toBe(1);
    expect(settlementTotals(db).withNetPnl).toBe(0);
    db.close();
  });

  it('refuses a settlement for a trajectory that does not exist', () => {
    const db = freshDb();
    const s = settlementOf(false);
    expect(() => insertTrajectorySettlement(db, 'nope', 'IMMEDIATE_MECHANICS', s, [], 1)).toThrow(/FOREIGN KEY/);
    db.close();
  });
});
