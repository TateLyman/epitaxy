import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expectedRemainingTail,
  remainingTailRefusal,
  legCashbackDeltas,
  cashbackPositionFrom,
  claimIsWorthwhile,
} from '../../packages/solana/src/cashback.js';
import { openDb } from '../../packages/storage/src/db.js';
import { insertLegCashback, legCashbackFor, cashbackLegTotals } from '../../packages/storage/src/trajectory-repo.js';

/**
 * The directive's P7 items 34–39.
 *
 * F13 is the finding. This repository asserted, in a doc comment that drove the
 * economic model:
 *
 * > `sell` has no volume accumulator account at all.
 *
 * It has two, as optional POSITIONAL remaining accounts — exactly as `buy` has
 * one. The assertion came from reading the IDL's NAMED accounts, where the
 * accumulator appears only on the instructions that manage it directly.
 * Modelling one leg's creator-fee recovery instead of two understated the
 * retained round trip by roughly half.
 *
 * Confirmed on 2026-08-16 against @pump-fun/pump-swap-sdk 1.19.0
 * (offlinePumpAmm.ts: buy pushes one account, sell pushes two) and the official
 * cashback README. See docs/PUMPSWAP_CASHBACK_V2.md.
 */

const ACCUM_ATA = 'CashbackAta1111111111111111111111111111111';
const UVA = 'UserVolAccum111111111111111111111111111111';
const POOL_V2 = 'PoolV2Pda11111111111111111111111111111111';
const CREATOR_VAULT = 'CreatorVault111111111111111111111111111111';
const FEE_RECIPIENT = 'FeeRecipient11111111111111111111111111111';

/** The named accounts an instruction carries before the remaining ones. */
const NAMED = ['n0', 'n1', 'n2', 'n3'];

/**
 * The two accounts PumpSwap appends after everything else, on every leg.
 *
 * `buybackFeeRecipient` is chosen from a list in the global config, so it is
 * not predictable from the pool. The check reads them rather than deriving
 * them, and the first version of that check did not know they existed - it
 * compared the expected tail against the final accounts and refused every
 * candidate on the chain.
 */
const SELECTED = ['BuybackRecipient11111111111111111111111', 'BuybackAta1111111111111111111111111111111'];

const tail = (leg: 'buy' | 'sell', over: Record<string, unknown> = {}) =>
  expectedRemainingTail({
    leg,
    isCashbackCoin: true,
    hasCoinCreator: true,
    accumulatorWsolAta: ACCUM_ATA,
    userVolumeAccumulator: UVA,
    poolV2: POOL_V2,
    ...over,
  } as never);

describe('34/35 — the tail is exact, and BUY and SELL are different lengths', () => {
  it('BUY expects one cashback account, then the pool-v2 PDA', () => {
    expect(tail('buy').accounts).toEqual([ACCUM_ATA, POOL_V2]);
  });

  it('SELL expects TWO cashback accounts — the correction F13 names', () => {
    // The accumulator PDA at index 1 is the account this repository asserted
    // did not exist on sell.
    expect(tail('sell').accounts).toEqual([ACCUM_ATA, UVA, POOL_V2]);
  });

  it('accepts an instruction that ends with exactly that tail', () => {
    expect(
      remainingTailRefusal({
        leg: 'sell',
        swapInstructionAccounts: [...NAMED, ACCUM_ATA, UVA, POOL_V2, ...SELECTED],
        expected: tail('sell'),
      }),
    ).toBeNull();
  });

  it('refuses a SELL that carries only the buy-shaped tail', () => {
    // This is the defect the old model would have produced: the sell built as
    // though it were a buy, landing and trading normally, paying the creator
    // fee to the creator.
    const r = remainingTailRefusal({
      leg: 'sell',
      swapInstructionAccounts: [...NAMED, ACCUM_ATA, POOL_V2, ...SELECTED],
      expected: tail('sell'),
    });
    expect(r).not.toBeNull();
    expect(r).toContain('would land and trade normally');
  });

  it('refuses accounts that are PRESENT but in the wrong position', () => {
    // Position is the identity. The program reads remaining index 0 and 1;
    // anything else there is a different account as far as it is concerned.
    const r = remainingTailRefusal({
      leg: 'sell',
      swapInstructionAccounts: [...NAMED, UVA, ACCUM_ATA, POOL_V2, ...SELECTED],
      expected: tail('sell'),
    });
    expect(r).toContain('position 0');
  });

  it('refuses an instruction too short to carry the tail at all', () => {
    expect(
      remainingTailRefusal({
        leg: 'sell',
        swapInstructionAccounts: [ACCUM_ATA],
        expected: tail('sell'),
      }),
    ).toContain('fewer than');
  });
});

describe('36 — omitted accounts receive zero attribution, and a null derivation is not an omission', () => {
  it('expects NO cashback tail on a coin that is not cashback enabled', () => {
    const t = tail('sell', { isCashbackCoin: false });
    expect(t.accounts).toEqual([POOL_V2]);
    expect(
      remainingTailRefusal({ leg: 'sell', swapInstructionAccounts: [...NAMED, POOL_V2, ...SELECTED], expected: t }),
    ).toBeNull();
  });

  it('expects nothing at all when there is neither cashback nor a coin creator', () => {
    const t = tail('buy', { isCashbackCoin: false, hasCoinCreator: false });
    expect(t.accounts).toEqual([]);
    expect(remainingTailRefusal({ leg: 'buy', swapInstructionAccounts: [...NAMED, ...SELECTED], expected: t })).toBeNull();
  });

  it('refuses when an expected address could not be DERIVED, rather than skipping it', () => {
    // A failed derivation must not read as a builder defect, and a builder
    // defect must not read as a failed derivation. Merging them loses both.
    const t = tail('sell', { userVolumeAccumulator: null });
    expect(t.underivable).toHaveLength(1);
    expect(
      remainingTailRefusal({
        leg: 'sell',
        swapInstructionAccounts: [...NAMED, ACCUM_ATA, UVA, POOL_V2, ...SELECTED],
        expected: t,
      }),
    ).toContain('placement cannot be verified');
  });
});

describe('37 — buy and sell accumulator deltas are measured SEPARATELY', () => {
  const measure = (leg: 'buy' | 'sell', pre: Record<string, bigint>, post: Record<string, bigint>) =>
    legCashbackDeltas({
      leg,
      before: (k) => pre[k] ?? null,
      after: (k) => post[k] ?? null,
      accumulatorWsolAta: ACCUM_ATA,
      userVolumeAccumulator: UVA,
      coinCreatorVaultAta: CREATOR_VAULT,
      feeRecipient: FEE_RECIPIENT,
    });

  it('records a buy that accrued to us', () => {
    const d = measure(
      'buy',
      { [ACCUM_ATA]: 2_039_280n, [CREATOR_VAULT]: 0n },
      { [ACCUM_ATA]: 2_099_280n, [CREATOR_VAULT]: 0n },
    );
    expect(d.accumulatorWsolDeltaLamports).toBe(60_000n);
    expect(d.accruedToUs).toBe(true);
  });

  it('records a sell that did NOT — the creator took the fee', () => {
    const d = measure(
      'sell',
      { [ACCUM_ATA]: 2_099_280n, [CREATOR_VAULT]: 0n },
      { [ACCUM_ATA]: 2_099_280n, [CREATOR_VAULT]: 58_000n },
    );
    expect(d.accumulatorWsolDeltaLamports).toBe(0n);
    expect(d.creatorVaultDeltaLamports).toBe(58_000n);
    // This is the row that would falsify the F13 correction if it were the
    // usual case, which is exactly why it is measured rather than assumed.
    expect(d.accruedToUs).toBe(false);
  });

  it('reports UNDETERMINED rather than false when an account was not observed', () => {
    const d = measure('sell', {}, {});
    expect(d.accumulatorWsolDeltaLamports).toBeNull();
    expect(d.accruedToUs).toBeNull();
  });

  it('refuses to call it ours when BOTH moved, because the fee goes to one', () => {
    const d = measure(
      'buy',
      { [ACCUM_ATA]: 0n, [CREATOR_VAULT]: 0n },
      { [ACCUM_ATA]: 60_000n, [CREATOR_VAULT]: 58_000n },
    );
    expect(d.accruedToUs).toBe(false);
  });
});

describe('38 — claimable is not claimed cash', () => {
  it('bounds claimable by the balance actually behind it', () => {
    const p = cashbackPositionFrom({
      accumulator: {
        user: 'u',
        needsClaim: true,
        totalUnclaimedTokens: 0n,
        totalClaimedTokens: 0n,
        currentSolVolume: 0n,
        lastUpdateTimestamp: 0n,
        hasTotalClaimedTokens: true,
        cashbackEarned: 500_000n,
        totalCashbackClaimed: 0n,
      },
      accumulatorWsolLamports: 120_000n,
    });
    expect(p.accruedLamports).toBe(500_000n);
    expect(p.claimableLamports).toBe(120_000n);
    // Nothing has reached the wallet, so nothing enters PnL.
    expect(p.claimedLamports).toBe(0n);
    expect(p.caveats.length).toBeGreaterThan(0);
  });
});

describe('39 — amortisation changes the ALLOCATED economics, not the sentence', () => {
  it('divides the claim cost across the trajectories it is amortised over', () => {
    // The old version computed the count and used it only in the reason string,
    // so every caller charged the whole 5,000 lamports to one trajectory no
    // matter what it passed.
    const one = claimIsWorthwhile({ claimableLamports: 400_000n, claimCostLamports: 5_000n });
    const forty = claimIsWorthwhile({
      claimableLamports: 400_000n,
      claimCostLamports: 5_000n,
      amortisedOverTrajectories: 40,
    });
    expect(one.allocatedCostLamports).toBe(5_000n);
    expect(forty.allocatedCostLamports).toBe(125n);
    expect(forty.allocatedClaimableLamports).toBe(10_000n);
    // The whole-claim net is the same number either way; only the allocation moves.
    expect(one.netLamports).toBe(forty.netLamports);
  });

  it('allocates nothing when the claim is a loss, because it is not made', () => {
    const r = claimIsWorthwhile({ claimableLamports: 900n, claimCostLamports: 5_000n, amortisedOverTrajectories: 40 });
    expect(r.worthwhile).toBe(false);
    expect(r.allocatedCostLamports).toBe(0n);
  });

  it('never divides by zero, whatever the caller passes', () => {
    const r = claimIsWorthwhile({ claimableLamports: 400_000n, claimCostLamports: 5_000n, amortisedOverTrajectories: 0 });
    expect(r.amortisedOverTrajectories).toBe(1);
    expect(r.allocatedCostLamports).toBe(5_000n);
  });
});

describe('P7 persistence — per leg, append-only, and never summed on the way in', () => {
  /**
   * The parent trajectory rows exist first.
   *
   * Item 28 — settlement IDs are EXACT foreign keys. `leg_cashback` references
   * `development_trajectories`, and SQLite enforces it: an attempt to record
   * cashback against a trajectory that does not exist fails rather than
   * accumulating orphan evidence nothing can join back to a trade.
   */
  const freshDb = () => {
    const dir = mkdtempSync(join(tmpdir(), 'p7-cashback-'));
    const d = openDb({ path: join(dir, 'runtime.db'), skipBackup: true });
    for (const id of ['traj-1', 'traj-2']) {
      d.prepare(
        `INSERT INTO development_trajectories
           (trajectory_id, entry_observation_id, entry_simulation_job_id, entry_settlement_id,
            venue, pool, capability_fingerprint, snapshot_hash, mint, cohort, stratum,
            migration_age_ms, notional_lamports, entry_policy_inputs, entry_policy, exit_policy,
            state, evidence_grade, max_attainable_grade, quote_impact_ratio, base_impact_ratio,
            max_impact_ratio, haircut_bps, within_small_impact, opened_utc_ms, refusals)
         VALUES (?,'o','j','s','PUMPSWAP_DIRECT','p','f','h','m','FIRST_HOUR','S',
                 NULL,'1','{}','E','X','AWAITING_FILL_OBSERVATION','SIMULATED_EXECUTION',
                 'SIMULATED_EXECUTION',0,0,0,0,1,0,'[]')`,
      ).run(id);
    }
    return d;
  };

  it('REFUSES cashback recorded against a trajectory that does not exist', () => {
    const db = freshDb();
    expect(() => insertLegCashback(db, 'no-such-trajectory', true, legs, 1)).toThrow(/FOREIGN KEY/);
    db.close();
  });

  const legs = [
    {
      leg: 'buy',
      accumulatorWsolDeltaLamports: 60_000n,
      accumulatorDeltaLamports: 0n,
      creatorVaultDeltaLamports: 0n,
      feeRecipientDeltaLamports: 12_000n,
      accruedToUs: true,
    },
    {
      leg: 'sell',
      accumulatorWsolDeltaLamports: 58_000n,
      accumulatorDeltaLamports: 0n,
      creatorVaultDeltaLamports: 0n,
      feeRecipientDeltaLamports: 11_800n,
      accruedToUs: true,
    },
  ];

  it('stores one row per leg and reads them back', () => {
    const db = freshDb();
    insertLegCashback(db, 'traj-1', true, legs, 1);
    const rows = legCashbackFor(db, 'traj-1');
    expect(rows.map((r) => r.leg)).toEqual(['sell', 'buy']);
    expect(rows.find((r) => r.leg === 'sell')?.accumulator_wsol_delta).toBe('58000');
    db.close();
  });

  it('re-recording the same observation does not double the corpus', () => {
    const db = freshDb();
    insertLegCashback(db, 'traj-1', true, legs, 1);
    insertLegCashback(db, 'traj-1', true, legs, 2);
    expect(cashbackLegTotals(db).legs).toBe(2);
    db.close();
  });

  it('counts buy and sell accrual apart, which is what settles F13', () => {
    const db = freshDb();
    insertLegCashback(db, 'traj-1', true, legs, 1);
    const t = cashbackLegTotals(db);
    expect(t.buyAccrued).toBe(1);
    expect(t.sellAccrued).toBe(1);
    expect(t.accumulatorGainLamports).toBe('118000');
    db.close();
  });

  it('stores an unobserved delta as NULL, never as zero', () => {
    const db = freshDb();
    insertLegCashback(
      db,
      'traj-2',
      false,
      [
        {
          leg: 'buy',
          accumulatorWsolDeltaLamports: null,
          accumulatorDeltaLamports: null,
          creatorVaultDeltaLamports: null,
          feeRecipientDeltaLamports: null,
          accruedToUs: null,
        },
      ],
      1,
    );
    const row = legCashbackFor(db, 'traj-2')[0];
    expect(row?.accumulator_wsol_delta).toBeNull();
    expect(row?.accrued_to_us).toBeNull();
    expect(cashbackLegTotals(db).undetermined).toBe(1);
    db.close();
  });
});

/**
 * The instrument reproducing the error it was built to correct.
 *
 * Measured on the first live cashback trajectory, 2026-08-16: the BUY created
 * the accumulator WSOL ATA holding 2,039,280 lamports of rent plus 59,260 of
 * cashback, and `legCashbackDeltas` returned `null` for it — reported as
 * unmeasured while the exact number it exists to capture sat in the account.
 *
 * That is the common case, not an edge: the first cashback trade any wallet
 * makes opens its accumulator ATA. Left alone it would have halved the observed
 * accrual and made the SELL look like the only leg that ever pays, which is the
 * original F13 error arrived at from the opposite direction.
 */
describe('37b — an account the leg CREATED has an accrual, not a null', () => {
  const ACCUM = 'CashbackAta1111111111111111111111111111111';
  const RENT = 2_039_280n;

  const measure = (createdExcess?: (k: string) => bigint | null) =>
    legCashbackDeltas({
      leg: 'buy',
      // The account did not exist before the leg ran.
      before: () => null,
      after: (k) => (k === ACCUM ? RENT + 59_260n : null),
      accumulatorWsolAta: ACCUM,
      userVolumeAccumulator: null,
      coinCreatorVaultAta: 'CreatorVault111111111111111111111111111111',
      feeRecipient: null,
      createdExcess,
    });

  it('reads the accrual out of the created balance, EXCLUDING the rent', () => {
    const d = measure((k) => (k === ACCUM ? 59_260n : null));
    // The rent is not accrual. Counting the whole balance would report
    // 2,098,540 and turn a 30 bps fee into a 1,049 bps windfall.
    expect(d.accumulatorWsolDeltaLamports).toBe(59_260n);
  });

  it('still reports null when the leg did not create it and nobody observed it', () => {
    // Absent-and-unobserved must not become zero, or an account nobody looked
    // at reads identically to one that received nothing.
    const d = measure(() => null);
    expect(d.accumulatorWsolDeltaLamports).toBeNull();
    expect(d.accruedToUs).toBeNull();
  });

  it('a created account with rent and nothing else accrued NOTHING, measured', () => {
    const d = legCashbackDeltas({
      leg: 'buy',
      before: () => null,
      after: () => RENT,
      accumulatorWsolAta: ACCUM,
      userVolumeAccumulator: null,
      coinCreatorVaultAta: 'CreatorVault111111111111111111111111111111',
      feeRecipient: null,
      createdExcess: () => 0n,
    });
    // Zero here IS a measurement, and is different from the null above.
    expect(d.accumulatorWsolDeltaLamports).toBe(0n);
  });
});
