import { findProgramAddress, associatedTokenAddress } from './pda.js';
import { base58Decode } from './base58.js';
import { PUMPSWAP_PROGRAM } from './pump.js';

/**
 * P6 — Pump cashback, decoded from the shipped IDL rather than described.
 *
 * Every fact below was read out of `@pump-fun/pump-swap-sdk`'s `pump_amm` IDL,
 * not transcribed from documentation prose. Two of them change the economics and
 * neither is obvious:
 *
 * 1. **`sell` has no volume accumulator account at all.** Only `buy` carries
 *    `user_volume_accumulator`. Cashback therefore accrues on BUY volume, not on
 *    round-trip volume, and a model that credits both legs overstates it by
 *    roughly a factor of two.
 *
 * 2. **The accumulator WSOL ATA is optional and positional.** The IDL's own
 *    words on `buy`: "For cashback coins, optionally pass
 *    user_volume_accumulator_wsol_ata as remaining_accounts[0]." Optional means
 *    a builder that omits it still produces a VALID transaction that lands and
 *    trades — it simply accrues no cashback, and the creator fee goes to the
 *    creator.
 *
 * That second point is the whole reason this module fails closed. A cashback
 * coin whose builder omitted the account looks identical to one that claimed it,
 * right up until the PnL is wrong by the entire creator fee.
 *
 * The three quantities are kept apart everywhere, because collapsing them books
 * a receivable as revenue:
 *
 * ```
 * accrued    cashback_earned            what the program has credited
 * claimable  the accumulator ATA's WSOL what could actually be released now
 * claimed    total_cashback_claimed     what has reached the wallet
 * ```
 *
 * Only `claimed` belongs in PnL. See packages/domain/src/trajectory-settlement.ts.
 */

export const USER_VOLUME_ACCUMULATOR_SEED = 'user_volume_accumulator';
export const GLOBAL_VOLUME_ACCUMULATOR_SEED = 'global_volume_accumulator';

/** From the IDL: `UserVolumeAccumulator` anchor discriminator. */
export const USER_VOLUME_ACCUMULATOR_DISCRIMINATOR = Uint8Array.from([86, 255, 112, 14, 102, 53, 154, 250]);

/**
 * PDA seeds `["user_volume_accumulator", user]` on the PumpSwap program.
 * Read from the IDL's `claim_cashback` and `buy` account definitions.
 */
export function userVolumeAccumulatorPda(user: string, programId: string = PUMPSWAP_PROGRAM): string {
  return findProgramAddress([USER_VOLUME_ACCUMULATOR_SEED, base58Decode(user)], programId).address;
}

export function globalVolumeAccumulatorPda(programId: string = PUMPSWAP_PROGRAM): string {
  return findProgramAddress([GLOBAL_VOLUME_ACCUMULATOR_SEED], programId).address;
}

/**
 * The accumulator's WSOL account.
 *
 * The IDL derives it with seeds `[user_volume_accumulator, quote_token_program,
 * quote_mint]`, which is the standard associated-token-account derivation with
 * the accumulator PDA as the owner. It is an ATA, not a bespoke PDA.
 */
export function accumulatorWsolAta(
  accumulator: string,
  quoteMint: string,
  quoteTokenProgram: string,
): string {
  return associatedTokenAddress(accumulator, quoteMint, quoteTokenProgram);
}

export interface UserVolumeAccumulator {
  readonly user: string;
  readonly needsClaim: boolean;
  readonly totalUnclaimedTokens: bigint;
  readonly totalClaimedTokens: bigint;
  readonly currentSolVolume: bigint;
  readonly lastUpdateTimestamp: bigint;
  readonly hasTotalClaimedTokens: boolean;
  /** Lamports of cashback the program has credited. A receivable, not cash. */
  readonly cashbackEarned: bigint;
  /** Lamports that have actually been claimed to the wallet. */
  readonly totalCashbackClaimed: bigint;
}

export class CashbackUndecodable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`cashback state not decodable: ${reason}`);
    this.name = 'CashbackUndecodable';
    this.reason = reason;
  }
}

/**
 * Decode a `UserVolumeAccumulator`.
 *
 * Field order is taken from the IDL struct verbatim:
 * user, needs_claim, total_unclaimed_tokens, total_claimed_tokens,
 * current_sol_volume, last_update_timestamp, has_total_claimed_tokens,
 * cashback_earned, total_cashback_claimed.
 */
export function decodeUserVolumeAccumulator(data: Uint8Array, encodeBase58: (b: Uint8Array) => string): UserVolumeAccumulator {
  const MIN = 8 + 32 + 1 + 8 + 8 + 8 + 8 + 1 + 8 + 8;
  if (data.length < MIN) {
    throw new CashbackUndecodable(`accumulator is ${data.length} bytes, expected at least ${MIN}`);
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== USER_VOLUME_ACCUMULATOR_DISCRIMINATOR[i]) {
      throw new CashbackUndecodable('the discriminator is not UserVolumeAccumulator');
    }
  }
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const user = encodeBase58(data.subarray(o, o + 32));
  o += 32;
  const needsClaim = b.readUInt8(o) !== 0;
  o += 1;
  const totalUnclaimedTokens = b.readBigUInt64LE(o);
  o += 8;
  const totalClaimedTokens = b.readBigUInt64LE(o);
  o += 8;
  const currentSolVolume = b.readBigUInt64LE(o);
  o += 8;
  const lastUpdateTimestamp = b.readBigInt64LE(o);
  o += 8;
  const hasTotalClaimedTokens = b.readUInt8(o) !== 0;
  o += 1;
  const cashbackEarned = b.readBigUInt64LE(o);
  o += 8;
  const totalCashbackClaimed = b.readBigUInt64LE(o);

  return {
    user,
    needsClaim,
    totalUnclaimedTokens,
    totalClaimedTokens,
    currentSolVolume,
    lastUpdateTimestamp,
    hasTotalClaimedTokens,
    cashbackEarned,
    totalCashbackClaimed,
  };
}

/**
 * Mechanics strata. Never pooled: a cashback coin at a high fee tier is a
 * materially different regime from a non-cashback coin at the bottom tier, and
 * averaging them describes neither.
 */
export type MechanicsStratum =
  | 'CANONICAL_CASHBACK'
  | 'CANONICAL_NONCASHBACK'
  | 'NONCANONICAL_CASHBACK'
  | 'NONCANONICAL_NONCASHBACK';

export function mechanicsStratum(p: { canonicalPool: boolean; cashbackCoin: boolean }): MechanicsStratum {
  return p.canonicalPool
    ? p.cashbackCoin
      ? 'CANONICAL_CASHBACK'
      : 'CANONICAL_NONCASHBACK'
    : p.cashbackCoin
      ? 'NONCANONICAL_CASHBACK'
      : 'NONCANONICAL_NONCASHBACK';
}

/**
 * Whether a built buy will ACTUALLY accrue cashback.
 *
 * The IDL makes the accumulator WSOL ATA optional and positional on `buy`, so
 * omitting it produces a valid transaction that trades normally and accrues
 * nothing. Calling that "cashback" overstates PnL by the whole creator fee,
 * which at the bottom canonical tier is 30 bps per leg.
 *
 * Returns the reason it will not accrue, or null when it will.
 */
export function cashbackAccrualRefusal(p: {
  isCashbackCoin: boolean;
  /** remaining_accounts in the order the builder will pass them. */
  remainingAccounts: readonly string[];
  expectedAccumulatorWsolAta: string;
}): string | null {
  if (!p.isCashbackCoin) return 'the coin is not cashback enabled';
  const first = p.remainingAccounts[0];
  if (first === undefined) {
    return 'the coin is cashback enabled but remaining_accounts[0] is absent, so the creator fee goes to the creator';
  }
  if (first !== p.expectedAccumulatorWsolAta) {
    return `remaining_accounts[0] is ${first.slice(0, 12)} but the accumulator WSOL ATA is ${p.expectedAccumulatorWsolAta.slice(0, 12)}`;
  }
  return null;
}

export interface CashbackPosition {
  readonly accruedLamports: bigint;
  readonly claimableLamports: bigint;
  readonly claimedLamports: bigint;
  /** Reasons the figures are bounded rather than exact. Never silently empty. */
  readonly caveats: readonly string[];
}

/**
 * The three quantities, from measured state.
 *
 * `claimable` is the lesser of what the program says is owed and what the
 * accumulator's WSOL account actually holds. A receivable larger than the
 * balance behind it is not claimable, and treating it as such is how an unfunded
 * accumulator becomes phantom revenue.
 */
export function cashbackPositionFrom(p: {
  accumulator: UserVolumeAccumulator | null;
  /** The WSOL balance of the accumulator ATA, or null when it was not read. */
  accumulatorWsolLamports: bigint | null;
}): CashbackPosition {
  const caveats: string[] = [];
  if (p.accumulator === null) {
    return {
      accruedLamports: 0n,
      claimableLamports: 0n,
      claimedLamports: 0n,
      caveats: ['no user volume accumulator exists, so nothing has ever accrued'],
    };
  }

  const accrued = p.accumulator.cashbackEarned;
  const claimed = p.accumulator.totalCashbackClaimed;
  const owed = accrued > claimed ? accrued - claimed : 0n;

  if (p.accumulatorWsolLamports === null) {
    caveats.push('the accumulator WSOL balance was not read, so claimable is bounded above by what is owed');
    return { accruedLamports: accrued, claimableLamports: 0n, claimedLamports: claimed, caveats };
  }

  const claimable = owed < p.accumulatorWsolLamports ? owed : p.accumulatorWsolLamports;
  if (p.accumulatorWsolLamports < owed) {
    caveats.push(
      `the accumulator holds ${p.accumulatorWsolLamports} lamports against ${owed} owed, so only the balance is claimable`,
    );
  }
  return { accruedLamports: accrued, claimableLamports: claimable, claimedLamports: claimed, caveats };
}

/**
 * The economics of claiming, amortised.
 *
 * A claim is a transaction. Claiming 900 lamports for a 5,000 lamport fee is a
 * loss, and a per-trajectory claim is almost always exactly that — which is why
 * claim cost is an execution cost and why `claimed` is what enters PnL rather
 * than `accrued`.
 */
export function claimIsWorthwhile(p: {
  claimableLamports: bigint;
  claimCostLamports: bigint;
  /** Trajectories the claim would be amortised over. Never below 1. */
  amortisedOverTrajectories?: number;
}): { worthwhile: boolean; netLamports: bigint; reason: string } {
  const n = BigInt(Math.max(1, Math.floor(p.amortisedOverTrajectories ?? 1)));
  const net = p.claimableLamports - p.claimCostLamports;
  if (p.claimableLamports === 0n) {
    return { worthwhile: false, netLamports: 0n, reason: 'nothing is claimable' };
  }
  if (net <= 0n) {
    return {
      worthwhile: false,
      netLamports: net,
      reason: `claiming ${p.claimableLamports} costs ${p.claimCostLamports}, which is a loss`,
    };
  }
  return {
    worthwhile: true,
    netLamports: net,
    reason: `${net} lamports net, amortised over ${n} trajector${n === 1n ? 'y' : 'ies'}`,
  };
}
