/**
 * Decoding a PumpSwap trade out of a transaction log line.
 *
 * `pump_amm` emits `BuyEvent` and `SellEvent` with Anchor's `emit!`, so the
 * borsh-serialised event lands in the logs as `Program data: <base64>`. That is
 * measured, not assumed: `pnpm venue:probe` decoded 84,810 BuyEvents and 91,155
 * SellEvents from 599 seconds of a free public `logsSubscribe`, with ZERO log
 * truncation.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 *
 * The event carries `user`. That single field is what lets a watchlist be
 * matched LOCALLY rather than pushed to a provider, which is what removes the
 * 128-wallet bound MT101 was built around — a bound that came from the polled
 * source's 8 req/s budget and from nothing about the market.
 *
 * It also carries `pool_base_token_reserves` and `pool_quote_token_reserves`
 * AFTER the trade, and the whole fee ladder in basis points. Those are the two
 * quantities five phases spent Dune credits reconstructing, arriving for free
 * on every trade.
 *
 * THE OFFSETS ARE THE DANGEROUS PART, so they are derived from the IDL field
 * order and asserted by tests against real captured events rather than trusted.
 * A field read one slot late is not an error that announces itself: reading
 * `quote_amount_in` at the wrong offset returned `lp_fee_basis_points`, a small
 * integer that renders as 0.0000 SOL and looks exactly like an empty field.
 * That happened, in the first version of the probe.
 */

import { base58Encode } from '../../solana/src/base58.js';

/** Anchor discriminators, `sha256("event:<Name>")[0..8]`, from the pinned IDL. */
export const BUY_EVENT_DISCRIMINATOR = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
export const SELL_EVENT_DISCRIMINATOR = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
export const PROGRAM_DATA_PREFIX = 'Program data: ';

export type TradeSide = 'BUY' | 'SELL';

export interface PumpSwapTrade {
  readonly side: TradeSide;
  readonly pool: string;
  readonly user: string;
  /**
   * The POOL's quote leg: `quote_amount_in` on a buy, `quote_amount_out` on a
   * sell.
   *
   * IN THE POOL'S QUOTE MINT, WHICH IS NOT ALWAYS WSOL. The event does not name
   * the quote mint — only the pool — so a caller that wants lamports must
   * resolve the pool first. Reading this as lamports on a non-WSOL pool is how
   * `pnpm venue:verify` produced a 3,897 "SOL" sell against a wallet whose SOL
   * balance went DOWN.
   */
  readonly quoteAmount: bigint;
  /**
   * The TRADER's own quote leg: `user_quote_amount_in` / `user_quote_amount_out`.
   *
   * Different from `quoteAmount` and the difference is the fee. Phase G measured
   * the program's own rule: a buy has the pool keep `quote_gross / (1 + f_total)`
   * and a sell has the trader receive `quote_pool × (1 − f_total)`. So the
   * wallet's economics are THIS field and the pool's are the other one, and
   * using the pool leg for a wallet's cost overstates a sell's proceeds by the
   * whole fee.
   */
  readonly userQuoteAmount: bigint;
  /** `base_amount_out` on a buy, `base_amount_in` on a sell. Raw token units. */
  readonly baseAmount: bigint;
  /**
   * Pool reserves BEFORE the trade. The reserve path, free, on every trade.
   *
   * BEFORE, not after, and this was established rather than assumed. pnpm
   * venue:verify compared 30 single-leg trades against the pool vaults own
   * balances in the same transaction, and the tell was that consecutive trades
   * on one pool CHAIN: the event value of the second trade equals the POST
   * balance of the first, exactly. The direction agrees independently - on a buy
   * the quote rises and the base falls from the event value to the post balance.
   *
   * Reading these as post-trade reserves would shift every reconstructed reserve
   * path by exactly one trade, silently, and the reserve path is the quantity
   * five phases of this programme died on.
   */
  readonly poolBaseReservesBefore: bigint;
  readonly poolQuoteReservesBefore: bigint;
  readonly lpFeeBasisPoints: bigint;
  readonly protocolFeeBasisPoints: bigint;
  /**
   * The third component of the fee, and the one that is easy to miss.
   *
   * At the bottom tier the split is LP 2 / protocol 93 / CREATOR 30, so pricing
   * a fill from lp+protocol alone understates the total by 30 bps - a quarter of
   * the whole 125 bps leg. NULL when the payload is too short to carry it,
   * because a fabricated zero here would make every modelled fill optimistic by
   * exactly the amount nobody was looking at.
   */
  readonly coinCreatorFeeBasisPoints: bigint | null;
  /** Seconds, as the program recorded it. */
  readonly timestamp: bigint;
}

/*
 * Both events share their first sixteen fields in layout, differing only in
 * what two of them are NAMED — `base_amount_out`/`max_quote_amount_in` on a buy
 * against `base_amount_in`/`min_quote_amount_out` on a sell, and
 * `quote_amount_in` against `quote_amount_out`. The byte positions are
 * identical, which is why one decoder serves both and why the SIDE has to come
 * from the discriminator rather than from anything in the body.
 *
 *   0    discriminator                 8
 *   8    timestamp                     i64
 *   16   base_amount  (out / in)       u64
 *   24   quote_amount bound            u64
 *   32   user_base_token_reserves      u64
 *   40   user_quote_token_reserves     u64
 *   48   pool_base_token_reserves      u64   BEFORE the trade
 *   56   pool_quote_token_reserves     u64   BEFORE the trade
 *   64   quote_amount (in / out)       u64
 *   72   lp_fee_basis_points           u64
 *   80   lp_fee                        u64
 *   88   protocol_fee_basis_points     u64
 *   96   protocol_fee                  u64
 *   104  quote_amount_with_lp_fee      u64
 *   112  user_quote_amount             u64
 *   120  pool                          pubkey
 *   152  user                          pubkey
 */
const OFF = {
  timestamp: 8,
  baseAmount: 16,
  poolBaseReserves: 48,
  poolQuoteReserves: 56,
  quoteAmount: 64,
  lpFeeBps: 72,
  userQuoteAmount: 112,
  protocolFeeBps: 88,
  pool: 120,
  user: 152,
  coinCreatorFeeBps: 344,
} as const;

/** Smallest buffer that carries every REQUIRED field. */
export const MIN_EVENT_BYTES = OFF.user + 32;
/** Smallest buffer that also carries the creator fee, which is optional here. */
export const CREATOR_FEE_BYTES = OFF.coinCreatorFeeBps + 8;

/**
 * Decode one `Program data:` payload, or null when it is not a PumpSwap trade.
 *
 * Null rather than a throw, because a venue-wide subscription delivers many
 * event types and several programs' worth of log lines, and a non-trade is the
 * normal case rather than an error. What IS refused is a payload whose
 * discriminator says trade and whose length cannot hold the fields — that is a
 * layout change, and decoding it partially would produce a plausible wrong
 * number instead of a refusal.
 */
export function decodePumpSwapTrade(payload: Buffer): PumpSwapTrade | null {
  if (payload.length < 8) return null;
  const disc = payload.subarray(0, 8);
  const isBuy = disc.equals(BUY_EVENT_DISCRIMINATOR);
  const isSell = disc.equals(SELL_EVENT_DISCRIMINATOR);
  if (!isBuy && !isSell) return null;
  if (payload.length < MIN_EVENT_BYTES) {
    throw new PumpSwapEventLayoutError(
      `a ${isBuy ? 'BuyEvent' : 'SellEvent'} discriminator on ${payload.length} bytes cannot hold ` +
        `${MIN_EVENT_BYTES}; the layout changed and a partial decode would be a plausible wrong number`,
    );
  }
  return {
    side: isBuy ? 'BUY' : 'SELL',
    pool: base58Encode(payload.subarray(OFF.pool, OFF.pool + 32)),
    user: base58Encode(payload.subarray(OFF.user, OFF.user + 32)),
    quoteAmount: payload.readBigUInt64LE(OFF.quoteAmount),
    userQuoteAmount: payload.readBigUInt64LE(OFF.userQuoteAmount),
    baseAmount: payload.readBigUInt64LE(OFF.baseAmount),
    poolBaseReservesBefore: payload.readBigUInt64LE(OFF.poolBaseReserves),
    poolQuoteReservesBefore: payload.readBigUInt64LE(OFF.poolQuoteReserves),
    lpFeeBasisPoints: payload.readBigUInt64LE(OFF.lpFeeBps),
    protocolFeeBasisPoints: payload.readBigUInt64LE(OFF.protocolFeeBps),
    coinCreatorFeeBasisPoints:
      payload.length >= CREATOR_FEE_BYTES ? payload.readBigUInt64LE(OFF.coinCreatorFeeBps) : null,
    timestamp: payload.readBigInt64LE(OFF.timestamp),
  };
}

export class PumpSwapEventLayoutError extends Error {}

/**
 * Every PumpSwap trade in one transaction's logs.
 *
 * A transaction can carry more than one, and each keeps its position so that
 * `(signature, index)` stays a stable key — the dedupe rule TARGETED_FLOW_V1
 * states, enforced by the key rather than by care. Two swaps in one transaction
 * are two events; the same swap delivered twice by a reconnect is one.
 */
export function tradesFromLogs(logs: readonly string[]): { trade: PumpSwapTrade; index: number }[] {
  const out: { trade: PumpSwapTrade; index: number }[] = [];
  let index = 0;
  for (const line of logs) {
    const at = line.indexOf(PROGRAM_DATA_PREFIX);
    if (at < 0) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(at + PROGRAM_DATA_PREFIX.length).trim(), 'base64');
    } catch {
      continue;
    }
    const trade = decodePumpSwapTrade(buf);
    if (trade === null) continue;
    out.push({ trade, index });
    index += 1;
  }
  return out;
}

/**
 * Did the runtime truncate this log array?
 *
 * Truncation is the failure mode that would matter most and correlate worst:
 * long log arrays come from busy transactions, so silent losses would cluster
 * exactly where the market is most active. The probe measured zero truncation
 * over 175,965 decoded events, and this exists so that a change in that is
 * counted rather than discovered later as a missing tail.
 */
export function logsWereTruncated(logs: readonly string[]): boolean {
  return logs.some((l) => l.includes('Log truncated'));
}

// ---------------------------------------------------------------------------
// Liquidity events, which are why MT106 was void.
// ---------------------------------------------------------------------------

/**
 * `sha256("event:DepositEvent"|"event:WithdrawEvent")[0..8]`, from the pinned IDL.
 *
 * These matter for one reason. The invariant method recovers fee income from the
 * growth of `k = base * quote`, and it is only valid when k moves for ONE reason.
 * A deposit or a withdrawal moves k without a single trade happening, and MT106
 * measured the consequence directly: k SHRANK in 30.8% of 139,145 steps, against
 * MT100's 1.0% of 623 on a densely sampled population, and the recovered fee rate
 * came out 100 to 1000 times too high. Any step spanning one of these is not a
 * fee measurement and must be excluded rather than averaged in.
 */
export const DEPOSIT_EVENT_DISCRIMINATOR = Buffer.from([120, 248, 61, 83, 31, 142, 107, 144]);
export const WITHDRAW_EVENT_DISCRIMINATOR = Buffer.from([22, 9, 133, 26, 160, 44, 71, 192]);

export type LiquiditySide = 'DEPOSIT' | 'WITHDRAW';

export interface PumpSwapLiquidity {
  readonly side: LiquiditySide;
  readonly pool: string;
  readonly user: string;
  /** Reserves as the event reports them, on the same convention as a trade. */
  readonly poolBaseReserves: bigint;
  readonly poolQuoteReserves: bigint;
  /** LP token supply after the event — the denominator an LP's share is measured in. */
  readonly lpMintSupply: bigint;
  readonly lpTokenAmount: bigint;
  readonly timestamp: bigint;
}

/*
 *   0    discriminator            8
 *   8    timestamp                i64
 *   16   lp_token_amount out/in   u64
 *   56   pool_base_token_reserves u64
 *   64   pool_quote_token_reserves u64
 *   88   lp_mint_supply           u64
 *   96   pool                     pubkey
 *   128  user                     pubkey
 */
const LIQ = {
  timestamp: 8,
  lpTokenAmount: 16,
  poolBase: 56,
  poolQuote: 64,
  lpMintSupply: 88,
  pool: 96,
  user: 128,
} as const;

export const MIN_LIQUIDITY_BYTES = LIQ.user + 32;

/** Decode a deposit or withdrawal, or null when the payload is neither. */
export function decodePumpSwapLiquidity(payload: Buffer): PumpSwapLiquidity | null {
  if (payload.length < 8) return null;
  const disc = payload.subarray(0, 8);
  const isDeposit = disc.equals(DEPOSIT_EVENT_DISCRIMINATOR);
  const isWithdraw = disc.equals(WITHDRAW_EVENT_DISCRIMINATOR);
  if (!isDeposit && !isWithdraw) return null;
  if (payload.length < MIN_LIQUIDITY_BYTES) {
    throw new PumpSwapEventLayoutError(
      `a ${isDeposit ? 'DepositEvent' : 'WithdrawEvent'} discriminator on ${payload.length} bytes cannot hold ` +
        `${MIN_LIQUIDITY_BYTES}; the layout changed and a partial decode would be a plausible wrong number`,
    );
  }
  return {
    side: isDeposit ? 'DEPOSIT' : 'WITHDRAW',
    pool: base58Encode(payload.subarray(LIQ.pool, LIQ.pool + 32)),
    user: base58Encode(payload.subarray(LIQ.user, LIQ.user + 32)),
    poolBaseReserves: payload.readBigUInt64LE(LIQ.poolBase),
    poolQuoteReserves: payload.readBigUInt64LE(LIQ.poolQuote),
    lpMintSupply: payload.readBigUInt64LE(LIQ.lpMintSupply),
    lpTokenAmount: payload.readBigUInt64LE(LIQ.lpTokenAmount),
    timestamp: payload.readBigInt64LE(LIQ.timestamp),
  };
}

/** Every deposit or withdrawal in one transaction's logs. */
export function liquidityFromLogs(logs: readonly string[]): { event: PumpSwapLiquidity; index: number }[] {
  const out: { event: PumpSwapLiquidity; index: number }[] = [];
  let index = 0;
  for (const line of logs) {
    const at = line.indexOf(PROGRAM_DATA_PREFIX);
    if (at < 0) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(at + PROGRAM_DATA_PREFIX.length).trim(), 'base64');
    } catch {
      continue;
    }
    const event = decodePumpSwapLiquidity(buf);
    if (event === null) continue;
    out.push({ event, index });
    index += 1;
  }
  return out;
}
