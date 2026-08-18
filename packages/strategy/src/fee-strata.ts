/**
 * P8 — the fee/cashback structure as a STRATIFICATION, not as a claim.
 *
 * The current Pump canonical SOL fee schedule is economically unusual:
 *
 *     0–420 SOL      creator 30 bps + protocol 93 bps + LP 2 bps = 125 bps/leg
 *     >= 420 SOL     protocol 5 bps + LP 20 bps, creator varies by tier
 *
 * Cashback redirects the CREATOR component back to the user, but only when the
 * required current remaining accounts are present AND the cashback actually
 * accrues. So, when fully measured and claimable:
 *
 *     bottom tier with cashback     ~95 bps/leg   ~190 bps round trip
 *     >= 420 SOL with cashback      ~25 bps/leg    ~50 bps round trip
 *
 * A round trip costing 50 bps instead of 190 is not a small difference — it is
 * most of the edge a memecoin strategy could plausibly have. If that gap is
 * real, the strategy's job may be mostly to find the cell where it applies.
 *
 * THOSE ARE MECHANICS HYPOTHESES FROM A PUBLISHED FEE SCHEDULE. They are not
 * Epitaxy profitability results and this module does not treat them as such. It
 * labels trajectories so the question can be ASKED, and it refuses to let a
 * flag stand in for a measurement.
 *
 * One trajectory receives immutable labels. There are not sixteen collectors.
 */

export type FeeTierStratum = 'BOTTOM_TIER' | 'HIGHER_TIER' | 'UNKNOWN_TIER';
export type CashbackStratum = 'CASHBACK' | 'NONCASHBACK' | 'UNKNOWN_CASHBACK';
export type MayhemStratum = 'MAYHEM' | 'NON_MAYHEM' | 'UNKNOWN_MAYHEM';
export type TokenProgramStratum = 'LEGACY_TOKEN' | 'TOKEN_2022' | 'UNKNOWN_TOKEN_PROGRAM';

/** The four cells the directive requires be analysed separately. */
export type FeeCashbackCell =
  | 'BOTTOM_CASHBACK'
  | 'BOTTOM_NONCASHBACK'
  | 'HIGHER_TIER_CASHBACK'
  | 'HIGHER_TIER_NONCASHBACK'
  | 'UNKNOWN_CELL';

/** The market-cap boundary in the current published schedule. */
export const HIGHER_TIER_MARKET_CAP_LAMPORTS = 420n * 1_000_000_000n;

export interface StratumInput {
  /**
   * The fee config this trajectory was priced against. A stratum derived
   * without one is UNKNOWN: a fee schedule that changed under us would
   * otherwise relabel historical rows silently.
   */
  readonly feeConfigHash: string | null;
  readonly marketCapLamports: bigint | null;
  readonly selectedTier: string | null;
  /**
   * Whether cashback was VERIFIED to accrue — not whether the pool advertises
   * it. See `cashbackEconomics` for why the distinction is the whole point.
   */
  readonly cashbackVerified: boolean | null;
  readonly isMayhem: boolean | null;
  readonly isToken2022: boolean | null;
}

export interface Strata {
  readonly feeTier: FeeTierStratum;
  readonly cashback: CashbackStratum;
  readonly mayhem: MayhemStratum;
  readonly tokenProgram: TokenProgramStratum;
  readonly cell: FeeCashbackCell;
}

export function labelStrata(input: StratumInput): Strata {
  /**
   * The tier comes from the CURRENT fee config and market-cap calculation.
   *
   * Without a fee config hash the tier is UNKNOWN even when the market cap is
   * known, because the boundary itself is a property of the schedule. A row
   * labelled from a market cap alone would keep its label across a schedule
   * change and would then be describing a tier that no longer exists.
   */
  const feeTier: FeeTierStratum =
    input.feeConfigHash === null || input.marketCapLamports === null
      ? 'UNKNOWN_TIER'
      : input.marketCapLamports >= HIGHER_TIER_MARKET_CAP_LAMPORTS
        ? 'HIGHER_TIER'
        : 'BOTTOM_TIER';

  const cashback: CashbackStratum =
    input.cashbackVerified === null ? 'UNKNOWN_CASHBACK' : input.cashbackVerified ? 'CASHBACK' : 'NONCASHBACK';

  const mayhem: MayhemStratum = input.isMayhem === null ? 'UNKNOWN_MAYHEM' : input.isMayhem ? 'MAYHEM' : 'NON_MAYHEM';

  const tokenProgram: TokenProgramStratum =
    input.isToken2022 === null ? 'UNKNOWN_TOKEN_PROGRAM' : input.isToken2022 ? 'TOKEN_2022' : 'LEGACY_TOKEN';

  const cell: FeeCashbackCell =
    feeTier === 'UNKNOWN_TIER' || cashback === 'UNKNOWN_CASHBACK'
      ? 'UNKNOWN_CELL'
      : feeTier === 'BOTTOM_TIER'
        ? cashback === 'CASHBACK'
          ? 'BOTTOM_CASHBACK'
          : 'BOTTOM_NONCASHBACK'
        : cashback === 'CASHBACK'
          ? 'HIGHER_TIER_CASHBACK'
          : 'HIGHER_TIER_NONCASHBACK';

  return { feeTier, cashback, mayhem, tokenProgram, cell };
}

/**
 * P8 — the four cashback quantities, kept apart.
 *
 * ACCRUED is what the accumulator moved.
 * CLAIMABLE is what the accumulator state says can be taken now.
 * CLAIMED is what was actually taken.
 * CLAIM COST is what taking it cost.
 *
 * They are different numbers and only the last three are money. The failure
 * this prevents is one line long and very easy to write:
 *
 *     if (pool.cashbackFlag) pnl += creatorFee;
 *
 * That subtracts a fee nobody was refunded, on every row where the pool
 * advertises cashback and the remaining accounts were not present, and it
 * improves every result in the corpus by roughly 60 bps per leg.
 */
export interface CashbackState {
  readonly accruedLamports: bigint;
  readonly claimableLamports: bigint;
  readonly claimedLamports: bigint;
  readonly claimCostLamports: bigint;
  /** Whether the accumulator was actually READ, as opposed to assumed. */
  readonly measuredFromAccumulator: boolean;
  /** What the pool ADVERTISES. Never sufficient on its own. */
  readonly poolFlag: boolean;
}

export class CashbackNotMeasured extends Error {}

/**
 * The two PnL figures the directive requires, side by side.
 *
 * `cash` excludes unclaimed cashback entirely — the conservative contract, and
 * the one capital readiness will eventually use. `economic` includes only
 * MEASURED CLAIMABLE cashback net of the amortised cost of claiming it.
 *
 * Throws when a flag is present and no accumulator was read. A silent zero
 * would be safe for `cash` and would make `economic` a lie by omission, and the
 * whole reason both numbers exist is to make the gap between them visible.
 */
export function cashbackAdjustedPnl(
  baseCashPnlLamports: bigint,
  c: CashbackState,
  amortisedClaimCostLamports: bigint,
): { cashPnlLamports: bigint; economicPnlLamports: bigint; note: string } {
  if (c.poolFlag && !c.measuredFromAccumulator) {
    throw new CashbackNotMeasured(
      'the pool advertises cashback and no accumulator state was read; a flag is not an accrual and may not adjust PnL',
    );
  }
  if (!c.measuredFromAccumulator) {
    return {
      cashPnlLamports: baseCashPnlLamports,
      economicPnlLamports: baseCashPnlLamports,
      note: 'no cashback accumulator was read; both figures exclude cashback',
    };
  }
  return {
    cashPnlLamports: baseCashPnlLamports,
    economicPnlLamports: baseCashPnlLamports + c.claimableLamports - amortisedClaimCostLamports,
    note:
      `cash excludes ${c.claimableLamports} claimable lamports; ` +
      `economic includes them less ${amortisedClaimCostLamports} amortised claim cost`,
  };
}
