import { rentExemptLamports } from '../../simulator/src/sequential-runtime.js';

/**
 * P6 — who pays to open which account, and whether that money ever comes back.
 *
 * The artifacts showed a warm 0.02 SOL round trip costing about 0.000509 SOL
 * (~254 bps) while cold runs lost several millisol, and reported ZERO created
 * account rent on every row. The observe set simply missed the accounts the
 * transaction created, and an account nobody observed reports identically to
 * one that cost nothing.
 *
 * The wrong response to that is a bigger notional. Amortising a first-trader's
 * rent over a larger trade does not make the rent smaller; it hides it, and it
 * hides it behind a size the strategy then has to justify on other grounds.
 *
 * The right response is to know WHICH accounts a leg opens, WHO can close them,
 * and whether another organic transaction would have opened them anyway. Rent
 * on an account we can close is a float. Rent on a shared protocol account we
 * cannot close is a transfer from us to whoever trades next.
 */

/**
 * What an account belongs to.
 *
 * The distinction that matters economically is not "is it ours" but "how many
 * future trades does opening it serve". A wallet-global account is opened once
 * ever; a mint-specific one is opened once per token, by whoever gets there
 * first.
 */
export type EconomicScope =
  /** Opened once per wallet, for every token and every pool. */
  | 'WALLET_GLOBAL'
  /** Once per wallet per quote mint — the WSOL ATA. */
  | 'WALLET_QUOTE_MINT'
  /** Once per wallet per traded token — the base ATA. */
  | 'WALLET_TOKEN_MINT'
  /** The coin creator's, opened by whichever trader first pays them a fee. */
  | 'CREATOR_GLOBAL'
  | 'CREATOR_QUOTE_MINT'
  /** The pool's own accounts. */
  | 'POOL_GLOBAL'
  | 'POOL_QUOTE_MINT'
  /** Specific to this mint and no wallet — an accumulator, a metadata account. */
  | 'MINT_SPECIFIC'
  /** Exists only for the duration of the transaction. */
  | 'TRANSACTION_ONLY'
  /** Named, never guessed. An unclassified account is not a free one. */
  | 'UNKNOWN';

/**
 * Whether the rent comes back, and to whom.
 *
 * `RECOVERABLE_BY_US` is a float: the lamports sit in an account we hold close
 * authority over, and closing it returns them. `NOT_RECOVERABLE_BY_US` is a
 * cost, whoever eventually benefits.
 */
export type Recoverability =
  | 'RECOVERABLE_BY_US'
  /** Someone else can close it and take the rent. We cannot. */
  | 'RECOVERABLE_BY_OTHER'
  /** Nobody closes it. The lamports are gone from everyone. */
  | 'NOT_RECOVERABLE'
  | 'UNKNOWN';

export interface ScopeContext {
  readonly taker: string;
  readonly takerBaseAta: string;
  readonly takerQuoteAta: string;
  readonly pool: string;
  readonly poolBaseVault: string;
  readonly poolQuoteVault: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly coinCreator?: string | null;
  readonly coinCreatorVaultAta?: string | null;
  readonly coinCreatorVaultAuthority?: string | null;
  readonly userVolumeAccumulator?: string | null;
  readonly globalVolumeAccumulator?: string | null;
  /** The accumulator's WSOL ATA — where PumpSwap cashback actually lands. */
  readonly accumulatorWsolAta?: string | null;
  /** The `pool-v2` PDA the SDK appends whenever the pool names a coin creator. */
  readonly poolV2?: string | null;
  /**
   * The PROTOCOL's own fee-collection accounts, read off the built plan.
   *
   * The protocol fee recipient and the buyback fee recipient are SELECTED by
   * the SDK from a list in the global config, so no derivation can name them —
   * they have to come from the instruction that ran. Measured on 2026-08-16:
   * a cold entry created two of them at 2,039,280 lamports of rent each, and
   * because they were absent from the observe set the payer's outflow into them
   * landed nowhere and appeared as an unexplained remainder.
   *
   * They are the clearest possible case of P6's subsidy: rent WE pay to open an
   * account the PROTOCOL collects into, which every later trader through it then
   * uses for free.
   */
  readonly protocolFeeAccounts?: readonly string[];
}

export interface CreatedAccount {
  readonly pubkey: string;
  readonly owner: string;
  readonly space: number;
  /** What the chain requires for `space` bytes. Only this is rent. */
  readonly rentExemptMinimumLamports: bigint;
  /**
   * The balance above the exemption.
   *
   * The coin-creator fee vault is opened AND paid in one transaction, so its
   * closing balance is rent plus a fee the pool sent it. Crediting the whole
   * balance back to the payer flattered every sell by a few basis points, and
   * by 94 on one of them.
   */
  readonly excessLamports: bigint;
  readonly scope: EconomicScope;
  readonly recoverability: Recoverability;
  /**
   * Would another trader's organic transaction have opened this?
   *
   * True for every shared account: pool, creator and accumulator state that any
   * trade through this pool creates. Those are the ones worth WAITING for
   * rather than paying for.
   */
  readonly sharedWithOtherTraders: boolean;
}

/**
 * Classify an account this transaction brought into existence.
 *
 * Identity first, owner second. An address that matches a known role IS that
 * role; owner alone cannot tell a taker's ATA from a creator's, and guessing
 * from owner is how a cost lands in the wrong column.
 */
export function classifyCreatedAccount(
  a: { pubkey: string; owner: string; space: number; lamports: bigint },
  ctx: ScopeContext,
): CreatedAccount {
  const rent = rentExemptLamports(BigInt(a.space));
  const charged = a.lamports < rent ? a.lamports : rent;
  const excess = a.lamports - charged;

  const { scope, recoverability, shared } = roleOf(a.pubkey, ctx);

  return {
    pubkey: a.pubkey,
    owner: a.owner,
    space: a.space,
    rentExemptMinimumLamports: charged,
    excessLamports: excess < 0n ? 0n : excess,
    scope,
    recoverability,
    sharedWithOtherTraders: shared,
  };
}

function roleOf(
  pubkey: string,
  ctx: ScopeContext,
): { scope: EconomicScope; recoverability: Recoverability; shared: boolean } {
  // Ours, and closable by us. This rent is a float, not a cost.
  if (pubkey === ctx.takerBaseAta) {
    return { scope: 'WALLET_TOKEN_MINT', recoverability: 'RECOVERABLE_BY_US', shared: false };
  }
  if (pubkey === ctx.takerQuoteAta) {
    return { scope: 'WALLET_QUOTE_MINT', recoverability: 'RECOVERABLE_BY_US', shared: false };
  }
  if (pubkey === ctx.taker) {
    return { scope: 'WALLET_GLOBAL', recoverability: 'RECOVERABLE_BY_US', shared: false };
  }

  // The creator's fee vault. We open it; they can close it. Every later trader
  // through this pool benefits and pays nothing.
  if (ctx.coinCreatorVaultAta !== null && ctx.coinCreatorVaultAta !== undefined && pubkey === ctx.coinCreatorVaultAta) {
    return { scope: 'CREATOR_QUOTE_MINT', recoverability: 'RECOVERABLE_BY_OTHER', shared: true };
  }
  if (
    ctx.coinCreatorVaultAuthority !== null &&
    ctx.coinCreatorVaultAuthority !== undefined &&
    pubkey === ctx.coinCreatorVaultAuthority
  ) {
    return { scope: 'CREATOR_GLOBAL', recoverability: 'RECOVERABLE_BY_OTHER', shared: true };
  }

  // Accumulators. The user one is per wallet; the global one is shared and is
  // opened by whoever trades this mint first.
  if (
    ctx.userVolumeAccumulator !== null &&
    ctx.userVolumeAccumulator !== undefined &&
    pubkey === ctx.userVolumeAccumulator
  ) {
    // A PDA of the pump program. We cannot close it, and neither can anyone
    // else: it has no close authority.
    return { scope: 'WALLET_GLOBAL', recoverability: 'NOT_RECOVERABLE', shared: false };
  }
  if (
    ctx.globalVolumeAccumulator !== null &&
    ctx.globalVolumeAccumulator !== undefined &&
    pubkey === ctx.globalVolumeAccumulator
  ) {
    return { scope: 'MINT_SPECIFIC', recoverability: 'NOT_RECOVERABLE', shared: true };
  }

  /**
   * The accumulator's WSOL ATA — where PumpSwap cashback actually lands.
   *
   * Per wallet per quote mint, like our own WSOL ATA, but owned by a program
   * PDA rather than by us. We cannot sign for the PDA, so we cannot close it;
   * only `claim_cashback` moves anything out. It is not shared, because no
   * other trader's transaction opens OUR accumulator's ATA — so this is rent we
   * pay once, ever, and never get back.
   */
  if (ctx.accumulatorWsolAta !== null && ctx.accumulatorWsolAta !== undefined && pubkey === ctx.accumulatorWsolAta) {
    return { scope: 'WALLET_QUOTE_MINT', recoverability: 'NOT_RECOVERABLE', shared: false };
  }

  // Per base mint, opened by whichever trader reaches the pool first.
  if (ctx.poolV2 !== null && ctx.poolV2 !== undefined && pubkey === ctx.poolV2) {
    return { scope: 'MINT_SPECIFIC', recoverability: 'NOT_RECOVERABLE', shared: true };
  }

  if (pubkey === ctx.poolBaseVault || pubkey === ctx.poolQuoteVault) {
    return { scope: 'POOL_QUOTE_MINT', recoverability: 'NOT_RECOVERABLE', shared: true };
  }
  if (pubkey === ctx.pool) {
    return { scope: 'POOL_GLOBAL', recoverability: 'NOT_RECOVERABLE', shared: true };
  }

  /**
   * The protocol's own fee-collection accounts.
   *
   * Not ours, not the creator's, and not closable by us. Whoever trades next
   * finds them already open, which makes our rent a transfer to them — the
   * subsidy the whole cold/warm hypothesis is about.
   */
  if (ctx.protocolFeeAccounts?.includes(pubkey) === true) {
    return { scope: 'POOL_GLOBAL', recoverability: 'NOT_RECOVERABLE', shared: true };
  }

  // Not recognised.
  //
  // `shared` stays false because it is a CLAIM about who else benefits and we
  // have no basis for one. The safety comes from `recoverability: 'UNKNOWN'`,
  // which the summary counts and the warm gate refuses on — an unclassified
  // account is never assumed to be ours, closable, or free.
  return { scope: 'UNKNOWN', recoverability: 'UNKNOWN', shared: false };
}

export interface SetupEconomics {
  readonly accounts: readonly CreatedAccount[];
  /** Everything paid to open accounts, recoverable or not. */
  readonly totalRentLamports: bigint;
  /** Comes back when we close our own accounts. A float. */
  readonly recoverableLamports: bigint;
  /**
   * Gone. This is the number that belongs in execution cost.
   *
   * It is also the number that a second trade through the same pool does not
   * pay, which is the entire cold/warm hypothesis in one field.
   */
  readonly unrecoverableLamports: bigint;
  /** Paid by us, for accounts every later trader gets free. */
  readonly subsidyToOtherTradersLamports: bigint;
  readonly unknownScopeCount: number;
}

/**
 * Add up a leg's setup, keeping the recoverable and the spent apart.
 *
 * Collapsing them into one "rent" figure is what made a first trade look like a
 * recurring mechanics floor. Most of it is neither recurring nor a floor: it is
 * a one-time payment, and part of it is a payment on behalf of everyone who
 * trades the pool afterwards.
 */
export function summariseSetup(accounts: readonly CreatedAccount[]): SetupEconomics {
  let total = 0n;
  let recoverable = 0n;
  let subsidy = 0n;
  let unknown = 0;

  for (const a of accounts) {
    total += a.rentExemptMinimumLamports;
    if (a.recoverability === 'RECOVERABLE_BY_US') recoverable += a.rentExemptMinimumLamports;
    if (a.sharedWithOtherTraders) subsidy += a.rentExemptMinimumLamports;
    if (a.scope === 'UNKNOWN' || a.recoverability === 'UNKNOWN') unknown++;
  }

  return {
    accounts,
    totalRentLamports: total,
    recoverableLamports: recoverable,
    unrecoverableLamports: total - recoverable,
    subsidyToOtherTradersLamports: subsidy,
    unknownScopeCount: unknown,
  };
}

/**
 * Does this candidate require us to open accounts somebody else could have?
 *
 * P6's primary development gate. A candidate that needs no shared account
 * creation is warm: the pool has already traded, the creator vault exists, and
 * our cost is the venue fee plus our own recoverable ATA rent. One that does
 * not is a COLD_SETUP candidate and belongs in its own stratum rather than in
 * the same average.
 */
export function sharedOrUnknown(a: CreatedAccount): boolean {
  return a.sharedWithOtherTraders || a.scope === 'UNKNOWN' || a.recoverability === 'UNKNOWN';
}

export function requiresSharedAccountCreation(accounts: readonly CreatedAccount[]): boolean {
  // An UNKNOWN account counts. We cannot show that it is ours and recoverable,
  // and "we did not recognise it" must not read the same as "it costs nothing"
  // — that is the same substitution that reported zero created-account rent on
  // every row of the size surface.
  return accounts.some(
    (a) => a.sharedWithOtherTraders || a.scope === 'UNKNOWN' || a.recoverability === 'UNKNOWN',
  );
}
