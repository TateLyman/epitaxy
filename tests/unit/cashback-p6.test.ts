import { describe, it, expect } from 'vitest';
import {
  userVolumeAccumulatorPda,
  accumulatorWsolAta,
  decodeUserVolumeAccumulator,
  cashbackPositionFrom,
  cashbackAccrualRefusal,
  mechanicsStratum,
  claimIsWorthwhile,
  CashbackUndecodable,
  USER_VOLUME_ACCUMULATOR_DISCRIMINATOR,
  type UserVolumeAccumulator,
} from '../../packages/solana/src/cashback.js';
import { base58Encode } from '../../packages/solana/src/base58.js';
import { WSOL_MINT } from '../../packages/solana/src/pumpswap-offline.js';
import { TOKEN_PROGRAM } from '../../packages/solana/src/pda.js';

/**
 * P6 — Pump cashback.
 *
 * Two facts from the shipped `pump_amm` IDL drive everything here, and neither
 * is stated in the prose documentation:
 *
 * 1. `sell` carries NO volume accumulator account. Cashback accrues on BUY
 *    volume, so a model crediting both legs overstates it about twofold.
 * 2. The accumulator WSOL ATA is an OPTIONAL positional remaining account on
 *    `buy`. A builder that omits it still lands a valid trade that accrues
 *    nothing, and the creator fee goes to the creator.
 */

const USER = 'CVXFtBqZTNPNMqTPGgFxTCJKGSPkyEBHYWTmXVvQsFtR';

function accumulatorBytes(over: { earned?: bigint; claimed?: bigint; volume?: bigint } = {}): Uint8Array {
  const b = Buffer.alloc(8 + 32 + 1 + 8 + 8 + 8 + 8 + 1 + 8 + 8);
  Buffer.from(USER_VOLUME_ACCUMULATOR_DISCRIMINATOR).copy(b, 0);
  let o = 40; // discriminator + user pubkey
  b.writeUInt8(1, o); // needs_claim
  o += 1;
  b.writeBigUInt64LE(0n, o); // total_unclaimed_tokens
  o += 8;
  b.writeBigUInt64LE(0n, o); // total_claimed_tokens
  o += 8;
  b.writeBigUInt64LE(over.volume ?? 5_000_000_000n, o); // current_sol_volume
  o += 8;
  b.writeBigInt64LE(1_760_000_000n, o); // last_update_timestamp
  o += 8;
  b.writeUInt8(1, o); // has_total_claimed_tokens
  o += 1;
  b.writeBigUInt64LE(over.earned ?? 400_000n, o); // cashback_earned
  o += 8;
  b.writeBigUInt64LE(over.claimed ?? 0n, o); // total_cashback_claimed
  return new Uint8Array(b);
}

const decoded = (over = {}): UserVolumeAccumulator =>
  decodeUserVolumeAccumulator(accumulatorBytes(over), base58Encode);

describe('P6 — the derivations are the IDL’s, not an approximation of them', () => {
  it('derives the user volume accumulator deterministically', () => {
    // Cross-checked against the SDK's own `userVolumeAccumulatorPda` in
    // scripts/cashback-mechanics-surface.ts; this pins the value so a silent
    // change to the seeds shows up as a test failure rather than as an
    // InvalidCashbackAccumulator on a transaction that spent money.
    expect(userVolumeAccumulatorPda(USER)).toBe('CdUPz4c3j4G4ndL71oLoYVHhovFqoAmAbFJMPX6bHzua');
  });

  it('derives the accumulator WSOL ATA with an off-curve owner', () => {
    // The accumulator is a PDA, so a derivation refusing off-curve owners is
    // wrong here.
    expect(accumulatorWsolAta(userVolumeAccumulatorPda(USER), WSOL_MINT, TOKEN_PROGRAM)).toBe(
      'DQRMRE6hZfWjKnxTBiAQfGnscsDRaahJigmYtTUZjjeF',
    );
  });
});

describe('P6 — the accumulator decodes by the IDL field order', () => {
  it('reads cashback_earned and total_cashback_claimed', () => {
    const a = decoded({ earned: 400_000n, claimed: 150_000n });
    expect(a.cashbackEarned).toBe(400_000n);
    expect(a.totalCashbackClaimed).toBe(150_000n);
    expect(a.currentSolVolume).toBe(5_000_000_000n);
    expect(a.needsClaim).toBe(true);
  });

  it('refuses bytes whose discriminator is not UserVolumeAccumulator', () => {
    const b = accumulatorBytes();
    b[0] = 0;
    expect(() => decodeUserVolumeAccumulator(b, base58Encode)).toThrow(/discriminator/);
  });

  it('refuses a truncated account rather than reading past the end', () => {
    expect(() => decodeUserVolumeAccumulator(accumulatorBytes().slice(0, 40), base58Encode)).toThrow(
      CashbackUndecodable,
    );
  });
});

describe('P6 — accrued, claimable and claimed are three different quantities', () => {
  it('claimable is bounded by what the accumulator actually holds', () => {
    // A receivable larger than the balance behind it is not claimable.
    // Treating it as such turns an unfunded accumulator into phantom revenue.
    const p = cashbackPositionFrom({
      accumulator: decoded({ earned: 400_000n, claimed: 0n }),
      accumulatorWsolLamports: 120_000n,
    });
    expect(p.accruedLamports).toBe(400_000n);
    expect(p.claimableLamports).toBe(120_000n);
    expect(p.claimedLamports).toBe(0n);
    expect(p.caveats.join(' ')).toMatch(/only the balance is claimable/);
  });

  it('an unread balance yields zero claimable WITH a caveat, never an assumption', () => {
    const p = cashbackPositionFrom({
      accumulator: decoded({ earned: 400_000n }),
      accumulatorWsolLamports: null,
    });
    expect(p.claimableLamports).toBe(0n);
    expect(p.caveats.join(' ')).toMatch(/was not read/);
  });

  it('already-claimed cashback is not claimable a second time', () => {
    const p = cashbackPositionFrom({
      accumulator: decoded({ earned: 400_000n, claimed: 400_000n }),
      accumulatorWsolLamports: 400_000n,
    });
    expect(p.claimableLamports).toBe(0n);
    expect(p.claimedLamports).toBe(400_000n);
  });

  it('no accumulator means nothing has ever accrued, and says so', () => {
    const p = cashbackPositionFrom({ accumulator: null, accumulatorWsolLamports: null });
    expect(p.accruedLamports).toBe(0n);
    expect(p.caveats.join(' ')).toMatch(/no user volume accumulator exists/);
  });
});

describe('P6 — fail closed when the builder omits the required account', () => {
  const ata = accumulatorWsolAta(userVolumeAccumulatorPda(USER), WSOL_MINT, TOKEN_PROGRAM);

  it('refuses when a cashback coin is bought with no remaining accounts', () => {
    // The IDL makes it optional, so this transaction LANDS and trades normally.
    // It simply accrues nothing, and the creator fee goes to the creator.
    // Calling it cashback would overstate PnL by 30 bps at the bottom tier.
    const r = cashbackAccrualRefusal({ isCashbackCoin: true, remainingAccounts: [], expectedAccumulatorWsolAta: ata });
    expect(r).toMatch(/remaining_accounts\[0\] is absent/);
    expect(r).toMatch(/creator fee goes to the creator/);
  });

  it('refuses when remaining_accounts[0] is the wrong account', () => {
    const r = cashbackAccrualRefusal({
      isCashbackCoin: true,
      remainingAccounts: [WSOL_MINT],
      expectedAccumulatorWsolAta: ata,
    });
    expect(r).toMatch(/but the accumulator WSOL ATA is/);
  });

  it('accepts when the account is present and correct', () => {
    expect(
      cashbackAccrualRefusal({ isCashbackCoin: true, remainingAccounts: [ata], expectedAccumulatorWsolAta: ata }),
    ).toBeNull();
  });

  it('a non-cashback coin accrues nothing, and that is not a defect', () => {
    expect(
      cashbackAccrualRefusal({ isCashbackCoin: false, remainingAccounts: [], expectedAccumulatorWsolAta: ata }),
    ).toMatch(/not cashback enabled/);
  });
});

describe('P6 — strata are never pooled', () => {
  it('separates the four mechanics regimes', () => {
    expect(mechanicsStratum({ canonicalPool: true, cashbackCoin: true })).toBe('CANONICAL_CASHBACK');
    expect(mechanicsStratum({ canonicalPool: true, cashbackCoin: false })).toBe('CANONICAL_NONCASHBACK');
    expect(mechanicsStratum({ canonicalPool: false, cashbackCoin: true })).toBe('NONCANONICAL_CASHBACK');
    expect(mechanicsStratum({ canonicalPool: false, cashbackCoin: false })).toBe('NONCANONICAL_NONCASHBACK');
  });
});

describe('P6 — a claim is a transaction, and transactions cost', () => {
  it('a tiny claim is a loss and is refused', () => {
    const r = claimIsWorthwhile({ claimableLamports: 900n, claimCostLamports: 5_000n });
    expect(r.worthwhile).toBe(false);
    expect(r.netLamports).toBe(-4_100n);
  });

  it('nothing claimable is not worthwhile, and says why', () => {
    expect(claimIsWorthwhile({ claimableLamports: 0n, claimCostLamports: 5_000n }).reason).toMatch(
      /nothing is claimable/,
    );
  });

  it('a real claim amortised over many trajectories is worthwhile', () => {
    const r = claimIsWorthwhile({
      claimableLamports: 400_000n,
      claimCostLamports: 5_000n,
      amortisedOverTrajectories: 40,
    });
    expect(r.worthwhile).toBe(true);
    expect(r.netLamports).toBe(395_000n);
  });
});
