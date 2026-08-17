import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import { insertTrajectorySettlement, settlementTotals } from '../../packages/storage/src/trajectory-repo.js';
import { legSettlementFromRuntime, coverageGap, BASE_FEE_PER_SIGNATURE_LAMPORTS } from '../../packages/pipeline/src/leg-settlement.js';
import { buildTrajectorySettlement,
  DURABLE_EVIDENCE, checkIdentities } from '../../packages/domain/src/trajectory-settlement.js';
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

/**
 * An SPL token account holding `amount` at offset 64.
 *
 * For a WSOL vault the lamports and the token amount move together — wrapped
 * SOL IS lamports — so a fixture that changes one without the other describes
 * an account that cannot exist, and the conservation identity correctly
 * reports the difference as unattributed.
 */
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
    pre: [sys(TAKER, 500_000_000_000n), tok(QUOTE_VAULT, 102_039_280n, 100_000_000n), tok(ATA, 0n, 0n)],
    post: [sys(TAKER, 499_979_995_000n), tok(QUOTE_VAULT, 122_039_280n, 120_000_000n), tok(ATA, 0n, 5_000n)],
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
      post: [sys(TAKER, 499_979_994_223n), tok(QUOTE_VAULT, 122_039_280n, 120_000_000n), tok(ATA, 0n, 5_000n)],
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
    const s = leg({ pre: [tok(QUOTE_VAULT, 102_039_280n, 100_000_000n)] });
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
      pre: [sys(TAKER, 499_979_995_000n), tok(QUOTE_VAULT, 122_039_280n, 120_000_000n), tok(ATA, 0n, 5_000n)],
      post: [sys(TAKER, 499_999_490_000n), tok(QUOTE_VAULT, 102_539_280n, 100_500_000n), tok(ATA, 0n, 0n)],
    });
    const s = buildTrajectorySettlement({
      trajectoryId: 't1',
      entry,
      exit,
      // Both legs above are built from complete observed pre/post state, so
      // their durability is stated rather than defaulted. An unstated
      // durability is UNKNOWN, and unknown blocks.
      legEvidence: { entry: DURABLE_EVIDENCE, exit: DURABLE_EVIDENCE },
    });
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

  /**
   * L-1 from the 8f73cef runtime audit, corrected.
   *
   * This test used to assert that the second answer was DISCARDED and the row
   * count stayed at one — which is what `INSERT OR IGNORE` did, and it passed.
   * The audit's finding is that discarding is not refusing: the writer returned
   * `void`, so the caller could not tell a lost write from a market fact, and
   * with several daemons racing the same open trajectories the two are
   * indistinguishable afterwards.
   *
   * The row still does not change. What changed is that the caller is told.
   */
  it('a second, DIFFERENT answer for the same trajectory is REFUSED, loudly', () => {
    const db = freshDb();
    const a = settlementOf(false);
    const b = settlementOf(true);
    insertTrajectorySettlement(db, 't1', 'IMMEDIATE_MECHANICS', a, [], 1);
    expect(() => insertTrajectorySettlement(db, 't1', 'IMMEDIATE_MECHANICS', b, [], 2)).toThrow(
      /a DIFFERENT settlement already exists/,
    );
    // The first answer survives untouched. Refusing must not also corrupt.
    expect(settlementTotals(db).settlements).toBe(1);
    expect(settlementTotals(db).withNetPnl).toBe(0);
    db.close();
  });

  it('the SAME answer twice is idempotent, because a retry is not a conflict', () => {
    const db = freshDb();
    const a = settlementOf(false);
    insertTrajectorySettlement(db, 't1', 'IMMEDIATE_MECHANICS', a, [], 1);
    expect(() => insertTrajectorySettlement(db, 't1', 'IMMEDIATE_MECHANICS', a, [], 2)).not.toThrow();
    expect(settlementTotals(db).settlements).toBe(1);
    db.close();
  });

  it('refuses a settlement for a trajectory that does not exist', () => {
    const db = freshDb();
    const s = settlementOf(false);
    expect(() => insertTrajectorySettlement(db, 'nope', 'IMMEDIATE_MECHANICS', s, [], 1)).toThrow(/FOREIGN KEY/);
    db.close();
  });
});

/**
 * The coverage rule, which decides whether a net PnL may exist at all.
 *
 * Measured live: all seven blocking addresses were in the frozen plan and
 * ABSENT ON CHAIN — accounts the transaction was about to create. Reporting an
 * impossibility as an omission made `fullAccountCoverage` false on every leg
 * and refused a net PnL for runs where nothing was actually unmeasured.
 */
describe('P5 — a writable is a coverage gap only if it EXISTED', () => {
  const pre = [
    { pubkey: 'existed', lamports: 2_039_280n },
    // Present in the observation but empty: an account the leg is about to open.
    { pubkey: 'aboutToBeCreated', lamports: 0n },
  ];

  it('flags a writable that was there all along and nobody read', () => {
    expect(coverageGap(['existed'], pre)).toEqual(['existed']);
  });

  it('does NOT flag an account the leg creates', () => {
    expect(coverageGap(['aboutToBeCreated'], pre)).toEqual([]);
  });

  it('does NOT flag an account absent from the pre-state entirely', () => {
    // The taker WSOL ATA: the SDK wraps and unwraps it inside the same
    // transaction, so it exists in neither the pre nor the post observation.
    expect(coverageGap(['neverSeen'], pre)).toEqual([]);
  });

  it('checks the PRE state only, so a created account is not counted as existing', () => {
    // An earlier version tested pre OR post. Everything the leg created is in
    // post, so that version excluded nothing at all.
    const post = [{ pubkey: 'aboutToBeCreated', lamports: 2_039_280n }];
    expect(coverageGap(['aboutToBeCreated'], pre)).toEqual([]);
    expect(coverageGap(['aboutToBeCreated'], [...pre, ...post])).toEqual(['aboutToBeCreated']);
  });

  it('matches an entry that carries a reason alongside the address', () => {
    expect(coverageGap(['unobserved on buy: existed'], pre)).toHaveLength(1);
  });
});

/**
 * The venue skim, defined by EXCLUSION rather than enumerated.
 *
 * Three attempts named it by role and each missed a different account: the
 * buyback recipient, then the accumulator, then the PROTOCOL fee recipient —
 * a named account the SDK selects, worth 183,704 lamports on a measured leg.
 * A cost model that depends on somebody remembering every role is wrong on
 * exactly the role nobody remembered.
 */
describe('P5 — the skim is complete by construction', () => {
  const PROTOCOL = 'ProtocolFeeRecipient1111111111111111111';
  const NEW_ROLE = 'SomeRoleNobodyHasNamedYet11111111111111';

  const withSkim = (extraPost: { pubkey: string; lamports: bigint }[]) =>
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
      pre: [sys(TAKER, 500_000_000_000n), tok(QUOTE_VAULT, 102_039_280n, 100_000_000n), tok(ATA, 0n, 0n)],
      post: [
        sys(TAKER, 499_979_995_000n),
        tok(QUOTE_VAULT, 122_039_280n, 120_000_000n),
        tok(ATA, 0n, 5_000n),
        ...extraPost.map((x) => ({ ...x, owner: TOKEN_PROGRAM, dataLen: 165, dataBase64: null })),
      ],
      createdAccounts: [],
      closedAccounts: [],
      runtimeOk: true,
      incompleteness: [],
      fullAccountCoverage: true,
      snapshotManifestHash: null,
    } as never);

  it('captures a fee recipient nobody enumerated', () => {
    // The whole point: a new recipient in a future IDL is captured the day it
    // appears, without anyone naming it.
    expect(withSkim([{ pubkey: NEW_ROLE, lamports: 183_704n }]).costs.protocolFeeLamports).toBe(183_704n);
  });

  it('sums every account that gained, not just the one we thought of', () => {
    const s = withSkim([
      { pubkey: PROTOCOL, lamports: 183_704n },
      { pubkey: NEW_ROLE, lamports: 59_260n },
    ]);
    expect(s.costs.protocolFeeLamports).toBe(242_964n);
  });

  it('never counts the payer, our ATA or the pool vault as a skim', () => {
    // All three legitimately move, and none of them is a fee.
    expect(withSkim([]).costs.protocolFeeLamports).toBe(0n);
  });
});
