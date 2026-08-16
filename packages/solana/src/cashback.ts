import { findProgramAddress, associatedTokenAddress } from './pda.js';
import { base58Decode } from './base58.js';
import { PUMPSWAP_PROGRAM } from './pump.js';

/**
 * P6/P7 — Pump cashback, decoded from the shipped SDK rather than described.
 *
 * ## The correction (F13)
 *
 * This file used to state, as its first substantive claim:
 *
 * > `sell` has no volume accumulator account at all. Only `buy` carries
 * > `user_volume_accumulator`. Cashback therefore accrues on BUY volume, not on
 * > round-trip volume.
 *
 * **That is wrong, and it halved the modelled cashback.** The claim came from
 * reading the IDL's NAMED accounts, where `user_volume_accumulator` really does
 * appear only on the instructions that manage it directly. But the cashback
 * accounts are not named on either leg — they are optional POSITIONAL remaining
 * accounts, and `sell` takes two of them:
 *
 * ```
 * BUY   remaining[0] = the UserVolumeAccumulator's WSOL ATA
 * SELL  remaining[0] = the UserVolumeAccumulator's WSOL ATA
 * SELL  remaining[1] = the UserVolumeAccumulator PDA
 * ```
 *
 * Read on 2026-08-16 from the installed `@pump-fun/pump-swap-sdk` 1.19.0
 * (`src/sdk/offlinePumpAmm.ts`: buy pushes one account, sell pushes two) and
 * confirmed against `pump-fun/pump-public-docs/docs/PUMP_CASHBACK_README.md`.
 * Both legs are then followed by the coin creator's `pool-v2` PDA when the pool
 * names a creator, so the cashback accounts are the FIRST remaining accounts,
 * not the last. See docs/PUMPSWAP_CASHBACK_V2.md.
 *
 * The absence of the accumulator from `sell`'s named accounts is exactly what
 * the old claim mistook for its absence from `sell`.
 *
 * ## Why this module fails closed
 *
 * Optional means a builder that omits the accounts still produces a VALID
 * transaction that lands and trades normally — it simply accrues no cashback,
 * and the creator fee goes to the creator. There is no error. A cashback coin
 * whose builder omitted the account is indistinguishable from one that claimed
 * it, right up until the PnL is wrong by the entire creator fee, which at the
 * bottom canonical tier is 30 bps per leg.
 *
 * Positional means presence is not enough. The program reads index 0 and index
 * 1; an account that is present in the wrong place is a different account as far
 * as the program is concerned, so the check is on the ORDERED tail.
 *
 * ## The three quantities
 *
 * Kept apart everywhere, because collapsing them books a receivable as revenue:
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
 * The accumulator WSOL ATA is optional and positional, so omitting it produces a
 * valid transaction that trades normally and accrues nothing. Calling that
 * "cashback" overstates PnL by the whole creator fee, which at the bottom
 * canonical tier is 30 bps per leg.
 *
 * Returns the reason it will not accrue, or null when it will.
 *
 * This checks index 0 only, which is complete for `buy` and INCOMPLETE for
 * `sell` — the sell also needs the accumulator PDA at index 1. Prefer
 * `remainingTailRefusal`, which knows the difference; this remains because a
 * check on the buy's index 0 is exactly right for the buy.
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

export type SwapLeg = 'buy' | 'sell';

export interface RemainingTail {
  /** The accounts the swap instruction must carry, in order. */
  readonly accounts: readonly string[];
  /** Why each one is there, for the refusal message. */
  readonly roles: readonly string[];
  /** Named derivations the caller could not supply. Never treated as "absent". */
  readonly underivable: readonly string[];
  /**
   * How many accounts sit AFTER the verifiable ones, whose addresses the SDK
   * SELECTS rather than derives.
   *
   * PumpSwap appends `[buybackFeeRecipient, buybackFeeRecipientTokenAccount]`
   * to the remaining accounts of every buy and every sell, unconditionally and
   * last. The recipient is chosen from a list in the global config, so it is
   * not predictable from the pool — which is the whole of F12 and the reason
   * the account plan is frozen from the built bytes.
   *
   * They are therefore OBSERVED, not predicted. Ignoring them instead would
   * mean comparing the cashback accounts against the wrong two positions, which
   * is exactly the failure this constant exists to record: the first version of
   * this check compared a one-account tail against the final account and
   * refused every candidate on the chain.
   */
  readonly trailingSelectedCount: number;
}

/** The count of trailing SDK-selected accounts on both legs. */
export const TRAILING_SELECTED_ACCOUNTS = 2;

/**
 * The exact remaining-account tail the SDK appends, in order.
 *
 * Derived from the SDK's own branches rather than from a count:
 *
 * ```
 * buy   [accumulatorWsolAta?]                        then [poolV2?]
 * sell  [accumulatorWsolAta?, userVolumeAccumulator?] then [poolV2?]
 * ```
 *
 * A TAIL rather than an index, because the number of NAMED accounts before it
 * is the IDL's business and is free to change. Comparing the tail survives a
 * named-account being added; comparing "account number 17" does not.
 *
 * An address the caller could not derive is reported in `underivable` and left
 * OUT of the expected tail. It is not the same as an account the builder
 * omitted, and merging the two would let a failed derivation read as a builder
 * defect — or worse, let a builder defect read as a failed derivation.
 */
export function expectedRemainingTail(p: {
  leg: SwapLeg;
  isCashbackCoin: boolean;
  hasCoinCreator: boolean;
  accumulatorWsolAta: string | null;
  userVolumeAccumulator: string | null;
  poolV2: string | null;
}): RemainingTail {
  const accounts: string[] = [];
  const roles: string[] = [];
  const underivable: string[] = [];

  const want = (addr: string | null, role: string): void => {
    if (addr === null) {
      underivable.push(role);
      return;
    }
    accounts.push(addr);
    roles.push(role);
  };

  if (p.isCashbackCoin) {
    want(p.accumulatorWsolAta, 'the UserVolumeAccumulator WSOL ATA, where cashback lands');
    // The sell needs the PDA itself as well. This is the account whose absence
    // the repository asserted for two commits.
    if (p.leg === 'sell') want(p.userVolumeAccumulator, 'the UserVolumeAccumulator PDA');
  }
  if (p.hasCoinCreator) want(p.poolV2, "the coin creator's pool-v2 PDA");

  return { accounts, roles, underivable, trailingSelectedCount: TRAILING_SELECTED_ACCOUNTS };
}

/**
 * Does the built instruction actually END with that tail?
 *
 * Fail closed. Returns the reason it does not, or null when it does.
 *
 * The comparison is positional and exact. A cashback account that is present
 * somewhere else in the instruction is not cashback: the program reads index 0
 * and index 1 of the remaining accounts, and anything else there is a different
 * account as far as the program is concerned.
 */
export function remainingTailRefusal(p: {
  leg: SwapLeg;
  /** Every account meta of the SWAP instruction, in order. */
  swapInstructionAccounts: readonly string[];
  expected: RemainingTail;
}): string | null {
  if (p.expected.underivable.length > 0) {
    return `${p.leg}: could not derive ${p.expected.underivable.join(' and ')}, so placement cannot be verified`;
  }
  const want = p.expected.accounts;
  if (want.length === 0) return null;

  /**
   * Skip the trailing SELECTED accounts before comparing.
   *
   * The verifiable accounts do not sit at the very end: the SDK appends the
   * buyback fee recipient and its token account after them, and their addresses
   * come from a list in the global config rather than from the pool.
   *
   * The first version of this check compared the expected one-account tail
   * against the LAST account and refused every candidate on the chain — which
   * is the check doing its job on my own model rather than on the builder, and
   * is why it refuses instead of warning.
   */
  const trailing = p.expected.trailingSelectedCount;
  const end = p.swapInstructionAccounts.length - trailing;
  const start = end - want.length;
  if (start < 0) {
    return (
      `${p.leg}: the instruction has ${p.swapInstructionAccounts.length} accounts, fewer than the ` +
      `${want.length + trailing} the tail requires`
    );
  }
  const got = p.swapInstructionAccounts.slice(start, end);
  for (const [i, w] of want.entries()) {
    if (got[i] !== w) {
      return (
        `${p.leg}: remaining position ${i} is ${(got[i] ?? 'absent').slice(0, 12)} but must be ` +
        `${w.slice(0, 12)} — ${p.expected.roles[i]}. ` +
        'The transaction would land and trade normally, and the creator fee would go to the creator.'
      );
    }
  }
  return null;
}

/**
 * The trailing accounts the SDK selected, read off the built instruction.
 *
 * Recorded rather than predicted. F12's rule: the plan describes the bytes that
 * ran, and a recipient chosen from a list is exactly the kind of thing a rebuild
 * is not guaranteed to reproduce.
 */
export function selectedTrailingAccounts(
  swapInstructionAccounts: readonly string[],
  count: number = TRAILING_SELECTED_ACCOUNTS,
): readonly string[] {
  return swapInstructionAccounts.slice(-count);
}

/**
 * What one leg actually moved through the cashback accounts.
 *
 * Measured per leg and never summed into one figure before it is stored: the
 * whole F13 correction is that BOTH legs accrue, so a model that reports one
 * number cannot show whether the second one did.
 */
export interface LegCashbackDeltas {
  readonly leg: SwapLeg;
  /** Lamports the accumulator's WSOL ATA gained. Null when it was not observed. */
  readonly accumulatorWsolDeltaLamports: bigint | null;
  /** The accumulator PDA's own lamport change — rent on creation, then zero. */
  readonly accumulatorDeltaLamports: bigint | null;
  readonly creatorVaultDeltaLamports: bigint | null;
  readonly feeRecipientDeltaLamports: bigint | null;
  /**
   * True when the accumulator ATA gained and the creator vault did not.
   *
   * The two are alternatives: the creator fee goes to one or the other. Both
   * moving, or neither, means something other than the modelled path happened
   * and the leg is not evidence for either.
   */
  readonly accruedToUs: boolean | null;
}

export function legCashbackDeltas(p: {
  leg: SwapLeg;
  before: (pubkey: string) => bigint | null;
  after: (pubkey: string) => bigint | null;
  accumulatorWsolAta: string | null;
  userVolumeAccumulator: string | null;
  coinCreatorVaultAta: string | null;
  feeRecipient: string | null;
  /**
   * For an account this leg CREATED: its balance above the rent exemption.
   *
   * Null when the leg did not create it. Without this, every account a leg
   * opens reports its accrual as unmeasured — see `delta` below.
   */
  createdExcess?: (pubkey: string) => bigint | null;
}): LegCashbackDeltas {
  const delta = (key: string | null): bigint | null => {
    if (key === null) return null;
    const a = p.after(key);
    if (a === null) return null;
    const b = p.before(key);

    /**
     * An account this leg CREATED has no "before", and that is not the same as
     * an account nobody observed.
     *
     * Measured on 2026-08-16, first live cashback trajectory: the BUY created
     * the accumulator WSOL ATA holding 2,039,280 rent plus 59,260 lamports of
     * cashback, and this function returned `null` — reported as unmeasured
     * while the very number it exists to capture sat in the account.
     *
     * That is the common case, not an edge: the first cashback trade any wallet
     * makes opens its accumulator ATA. Reading it as unmeasured would have
     * halved the observed accrual and left the sell leg looking like the only
     * one that ever pays — which is the ORIGINAL F13 error, reproduced by the
     * instrument built to correct it.
     *
     * The excess over the rent exemption is exactly the value received, so a
     * created account's accrual is that excess and nothing else.
     */
    if (b === null) {
      const created = p.createdExcess?.(key) ?? null;
      return created;
    }
    return a - b;
  };

  const acc = delta(p.accumulatorWsolAta);
  const creator = delta(p.coinCreatorVaultAta);

  return {
    leg: p.leg,
    accumulatorWsolDeltaLamports: acc,
    accumulatorDeltaLamports: delta(p.userVolumeAccumulator),
    creatorVaultDeltaLamports: creator,
    feeRecipientDeltaLamports: delta(p.feeRecipient),
    accruedToUs: acc === null || creator === null ? null : acc > 0n && creator <= 0n,
  };
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
export interface ClaimEconomics {
  readonly worthwhile: boolean;
  /** Whole-claim net: everything claimed, less the one transaction it costs. */
  readonly netLamports: bigint;
  /**
   * The claim's cost charged to ONE trajectory.
   *
   * This is the number that belongs in a single trajectory's execution cost. It
   * is the point of amortising at all: one claim releases cashback that many
   * trajectories accrued, so charging the whole 5,000 lamports to whichever one
   * happened to trigger it makes that trajectory look worse and every other one
   * look better than either was.
   */
  readonly allocatedCostLamports: bigint;
  /** Cashback allocated to one trajectory, on the same basis. */
  readonly allocatedClaimableLamports: bigint;
  readonly amortisedOverTrajectories: number;
  readonly reason: string;
}

/**
 * The economics of claiming, amortised — in the ALLOCATION, not in the prose.
 *
 * This function used to compute `n` and then use it only inside the reason
 * string: "500 lamports net, amortised over 40 trajectories" described an
 * amortisation that had not happened to any number a caller could read. Every
 * caller therefore charged the full claim cost to one trajectory no matter what
 * it passed.
 *
 * A claim is a transaction. Claiming 900 lamports for a 5,000 lamport fee is a
 * loss, and a per-trajectory claim is almost always exactly that — which is why
 * claim cost is an execution cost, why `claimed` rather than `accrued` enters
 * PnL, and why the allocation has to be real.
 *
 * Division truncates, which under-charges by at most one lamport per
 * trajectory. Deliberate and stated: the alternative rounds up and reports a
 * total cost larger than the transaction actually paid.
 */
export function claimIsWorthwhile(p: {
  claimableLamports: bigint;
  claimCostLamports: bigint;
  /** Trajectories the claim would be amortised over. Never below 1. */
  amortisedOverTrajectories?: number;
}): ClaimEconomics {
  const count = Math.max(1, Math.floor(p.amortisedOverTrajectories ?? 1));
  const n = BigInt(count);
  const net = p.claimableLamports - p.claimCostLamports;
  const allocatedCost = p.claimCostLamports / n;
  const allocatedClaimable = p.claimableLamports / n;

  if (p.claimableLamports === 0n) {
    return {
      worthwhile: false,
      netLamports: 0n,
      // Nothing to allocate, and the cost is not incurred because the claim is
      // not made. Zero here is a decision, not a default.
      allocatedCostLamports: 0n,
      allocatedClaimableLamports: 0n,
      amortisedOverTrajectories: count,
      reason: 'nothing is claimable',
    };
  }
  if (net <= 0n) {
    return {
      worthwhile: false,
      netLamports: net,
      allocatedCostLamports: 0n,
      allocatedClaimableLamports: 0n,
      amortisedOverTrajectories: count,
      reason: `claiming ${p.claimableLamports} costs ${p.claimCostLamports}, which is a loss`,
    };
  }
  return {
    worthwhile: true,
    netLamports: net,
    allocatedCostLamports: allocatedCost,
    allocatedClaimableLamports: allocatedClaimable,
    amortisedOverTrajectories: count,
    reason:
      `${net} lamports net; each of ${count} trajector${count === 1 ? 'y' : 'ies'} carries ` +
      `${allocatedCost} lamports of claim cost against ${allocatedClaimable} of cashback`,
  };
}
