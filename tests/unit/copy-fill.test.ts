import { describe, it, expect } from 'vitest';
import {
  FillNotPriceable,
  priceBuy,
  priceRoundTrip,
  priceSell,
  roundTripFloorBps,
  totalFeeBps,
  type PoolFeeLadder,
  type PoolReserves,
} from '../../packages/intelligence/src/copy-fill.js';

/**
 * Pricing a follower's round trip off the reserve path.
 *
 * This is the module that replaces a trade tape with an invariant, and it is the
 * reason MT104 cannot inherit the censoring that killed Phases C through G. It
 * is also the module where a wrong constant is worth basis points on every
 * position, so the fee rule and the sign conventions are pinned here.
 */

/** Bottom tier: LP 2 / protocol 93 / creator 30 = 125 bps a leg. */
const BOTTOM: PoolFeeLadder = {
  lpFeeBasisPoints: 2n,
  protocolFeeBasisPoints: 93n,
  coinCreatorFeeBasisPoints: 30n,
};
/** The tier 71.7% of flagged buys land on: LP 20 / protocol 5 / creator 0. */
const CHEAP: PoolFeeLadder = {
  lpFeeBasisPoints: 20n,
  protocolFeeBasisPoints: 5n,
  coinCreatorFeeBasisPoints: 0n,
};

const SOL = 1_000_000_000n;
/** A pool at the flagged-population median: ~108 SOL of quote. */
const DEEP: PoolReserves = { base: 500_000_000_000_000n, quote: 108n * SOL };
/**
 * A pool at what our own collector admits: ~25 SOL of quote, and scaled to the
 * SAME price as DEEP.
 *
 * Scaling matters and the first version of this file got it wrong: holding the
 * base fixed and lowering the quote makes the token four times CHEAPER, not the
 * pool shallower, and a buy then returns more base for reasons that have nothing
 * to do with depth. Same price, less depth, is the only comparison that isolates
 * impact.
 */
const THIN: PoolReserves = { base: (500_000_000_000_000n * 25n) / 108n, quote: 25n * SOL };

describe('the fee ladder', () => {
  it('sums all three components', () => {
    expect(totalFeeBps(BOTTOM)).toBe(125n);
    expect(totalFeeBps(CHEAP)).toBe(25n);
  });

  it('REFUSES when the creator component is unknown', () => {
    /**
     * At the bottom tier the creator fee is 30 of 125 bps. Assuming zero would
     * understate the leg by a quarter, and an optimistic fee is
     * indistinguishable from edge in every downstream number.
     */
    expect(() => totalFeeBps({ ...BOTTOM, coinCreatorFeeBasisPoints: null })).toThrow(FillNotPriceable);
    expect(() => totalFeeBps({ ...BOTTOM, coinCreatorFeeBasisPoints: null })).toThrow(/30 of 125/);
  });
});

describe('the buy side', () => {
  it('takes the fee off the input, so the pool receives quote/(1+f)', () => {
    const fill = priceBuy(DEEP, SOL, BOTTOM);
    const toPool = fill.reservesAfter.quote - DEEP.quote;
    // 1 SOL / 1.0125 = 987,654,320 lamports, to integer division.
    expect(toPool).toBe((SOL * 10_000n) / 10_125n);
  });

  it('conserves the invariant on the pool side', () => {
    const fill = priceBuy(DEEP, SOL, BOTTOM);
    const kBefore = DEEP.base * DEEP.quote;
    const kAfter = fill.reservesAfter.base * fill.reservesAfter.quote;
    // Integer division only ever loses a fraction of one base unit.
    expect(kAfter).toBeLessThanOrEqual(kBefore);
    expect(kBefore - kAfter).toBeLessThan(fill.reservesAfter.quote);
  });

  it('executes further from mid in a thinner pool at the same price — that is impact', () => {
    // Effective price against the pool mid. Absolute baseOut cannot be compared
    // across pools of different size; the DISTANCE FROM MID can.
    const slip = (r: PoolReserves): number => {
      const fill = priceBuy(r, SOL, BOTTOM);
      const effective = Number(SOL) / Number(fill.baseOut);
      const mid = Number(r.quote) / Number(r.base);
      return effective / mid - 1;
    };
    expect(slip(THIN)).toBeGreaterThan(slip(DEEP));
    expect(slip(DEEP)).toBeGreaterThan(0);
  });

  it('refuses a pool with no reserves rather than dividing by it', () => {
    expect(() => priceBuy({ base: 0n, quote: SOL }, SOL, BOTTOM)).toThrow(FillNotPriceable);
    expect(() => priceBuy(DEEP, 0n, BOTTOM)).toThrow(FillNotPriceable);
  });
});

describe('the sell side', () => {
  it('takes the fee off the OUTPUT, which is the asymmetry Phase G had to measure', () => {
    /**
     * Phase G probed the program rather than assuming symmetry: a buy has the
     * pool keep quote/(1+f) and a sell has the trader receive quote x (1-f).
     * The obvious alternative agrees at tier 0 by coincidence and separates at
     * tier 16.
     */
    const sell = priceSell(DEEP, 1_000_000_000_000n, BOTTOM);
    const fromPool = DEEP.quote - sell.reservesAfter.quote;
    expect(sell.quoteOut).toBe((fromPool * 9_875n) / 10_000n);
    expect(sell.quoteOut).toBeLessThan(fromPool);
  });

  it('is not the inverse of a buy, because the fee is charged on both legs', () => {
    const buy = priceBuy(DEEP, SOL, BOTTOM);
    const back = priceSell(buy.reservesAfter, buy.baseOut, BOTTOM);
    expect(back.quoteOut).toBeLessThan(SOL);
  });
});

describe('the round trip', () => {
  it('loses 246.9 bps at the bottom tier, NOT the 250 that two legs of 125 suggests', () => {
    /**
     * The programme has quoted 250 bps throughout, as 2 x 125. The measured
     * rule does not compound that way: a buy pays f/(1+f) of the input, which
     * is 123.46 bps rather than 125, and the sell then takes 125 bps of a
     * slightly smaller output. The true instant round trip is 246.9 bps.
     *
     * Three basis points is not worth an argument by itself. It is worth a test
     * because it shows the naive doubling is not what the program does, and the
     * same asymmetry is what separates the tiers at the other end of the ladder.
     */
    const rt = priceRoundTrip(DEEP, DEEP, SOL, BOTTOM, BOTTOM);
    expect(rt.pnl).toBeLessThan(0n);
    const floor = roundTripFloorBps(DEEP, SOL, BOTTOM);
    expect(floor).toBeGreaterThan(246);
    expect(floor).toBeLessThan(248);
  });

  it('shows the cheap tier costing about a fifth of the bottom tier', () => {
    /**
     * This is the measured re-rating: 71.7% of flagged buys land on the 20/5
     * tier. Every prior phase priced against 2.669%, which is the bottom tier
     * plus impact on a pool a fifth the size.
     */
    const bottom = roundTripFloorBps(DEEP, SOL, BOTTOM);
    const cheap = roundTripFloorBps(DEEP, SOL, CHEAP);
    expect(cheap).toBeGreaterThan(49);
    expect(cheap).toBeLessThan(51);
    expect(bottom / cheap).toBeGreaterThan(4.9);
  });

  it('IMPACT CANCELS on an instant round trip, so the floor is the fee and nothing else', () => {
    /**
     * This corrects an intuition I had wrong. Constant product is path
     * independent: buying and immediately selling the same base back traverses
     * the curve in reverse and returns the same quote, so slippage nets to zero
     * and only the fee remains. A thin pool and a deep pool have the SAME
     * instant round-trip floor.
     *
     * Where depth actually pays is elsewhere, and the next test is where: size
     * costs when the exit happens at reserves the entry did not leave behind.
     * That is also why a 150 bps impact cap is a CAPACITY bound rather than a
     * cost - it limits how far we may move the pool, not what the move charges.
     */
    expect(roundTripFloorBps(THIN, SOL, CHEAP)).toBeCloseTo(roundTripFloorBps(DEEP, SOL, CHEAP), 6);
  });

  it('profits when the price rose enough between entry and exit to clear both legs', () => {
    // Quote reserves up 20% against the same base: the token appreciated.
    const exit: PoolReserves = { base: DEEP.base, quote: (DEEP.quote * 120n) / 100n };
    const rt = priceRoundTrip(DEEP, exit, SOL, CHEAP, CHEAP);
    expect(rt.pnl).toBeGreaterThan(0n);
    expect(rt.returnFraction).toBeGreaterThan(0.15);
  });

  it('loses when the price fell, and the loss exceeds the move by the fee', () => {
    const exit: PoolReserves = { base: DEEP.base, quote: (DEEP.quote * 80n) / 100n };
    const rt = priceRoundTrip(DEEP, exit, SOL, CHEAP, CHEAP);
    expect(rt.returnFraction).toBeLessThan(-0.2);
  });

  it('CARRIES our own footprint, so a static-pool round trip is the pure fee and nothing else', () => {
    /**
     * THIS TEST USED TO ASSERT THE OPPOSITE, and the old assertion was wrong.
     *
     * It required a larger notional to return strictly less, on the reasoning that a
     * round trip ignoring its own impact "would report an edge that vanishes at any
     * real notional". But `priceRoundTrip` was handing the sell an exit pool that had
     * never received our buy, so the position paid its own impact TWICE rather than
     * zero times, and this test was locking that defect in.
     *
     * On a constant-product curve a buy and an immediate sell of the same base is
     * exactly reversible — you traverse the curve up and back. What remains is the fee
     * on each leg, taken off the input going in and the output coming out:
     *
     *     return = (1 - f) / (1 + f) - 1
     *
     * which contains no notional term at all. So the correct invariant is INVARIANCE,
     * and it is asserted directly against the closed form rather than as an inequality.
     */
    const f = Number(totalFeeBps(CHEAP)) / 1e4;
    const closedForm = (1 - f) / (1 + f) - 1;
    const small = priceRoundTrip(DEEP, DEEP, 20_000_000n, CHEAP, CHEAP).returnFraction;
    const large = priceRoundTrip(DEEP, DEEP, 10n * SOL, CHEAP, CHEAP).returnFraction;
    // 7 decimals, not 8: amounts are bigint and every division truncates, so a
    // 0.02 SOL leg carries ~2e-8 of rounding. 7 decimals still pins the return to
    // 0.00005 bps, far inside anything that could matter. The tolerance is mine and
    // it is being set to the instrument's real precision — the closed form itself is
    // not being relaxed.
    expect(small).toBeCloseTo(closedForm, 7);
    expect(large).toBeCloseTo(closedForm, 7);
    // Invariant to within integer division, which is the only thing separating them.
    expect(Math.abs(large - small)).toBeLessThan(1e-7);
  });

  it('REFUSES a position the exit pool cannot absorb rather than inventing a price', () => {
    // Size is still a real constraint — it just is not a per-round-trip impact tax.
    // A position at least as large as the whole exit pool has no exit price, and
    // fabricating one is the most flattering error available here.
    const drained: PoolReserves = { base: DEEP.base / 1000n, quote: DEEP.quote };
    expect(() => priceRoundTrip(DEEP, drained, 100n * SOL, CHEAP, CHEAP)).toThrow(FillNotPriceable);
  });

  it('refuses to price anything when the creator fee is unknown', () => {
    const unknown: PoolFeeLadder = { ...BOTTOM, coinCreatorFeeBasisPoints: null };
    expect(() => priceRoundTrip(DEEP, DEEP, SOL, unknown, unknown)).toThrow(FillNotPriceable);
  });

  it('keeps every amount a bigint, because these are token amounts', () => {
    const rt = priceRoundTrip(DEEP, DEEP, SOL, CHEAP, CHEAP);
    expect(typeof rt.quoteIn).toBe('bigint');
    expect(typeof rt.quoteOut).toBe('bigint');
    expect(typeof rt.pnl).toBe('bigint');
  });
});

// ---------------------------------------------------------------------------

import {
  BUY_EVENT_DISCRIMINATOR,
  MIN_EVENT_BYTES,
  DEPOSIT_EVENT_DISCRIMINATOR,
  WITHDRAW_EVENT_DISCRIMINATOR,
  MIN_LIQUIDITY_BYTES,
  PROGRAM_DATA_PREFIX,
  PumpSwapEventLayoutError,
  decodePumpSwapLiquidity,
  decodePumpSwapTrade,
  liquidityFromLogs,
} from '../../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../../packages/solana/src/base58.js';

/**
 * Liquidity events, which are the reason MT106 was void.
 *
 * The invariant method recovers fee income from the growth of k = base * quote,
 * and it is valid only when k moves for ONE reason. A deposit or a withdrawal
 * moves k with no trade at all. MT106 measured the consequence: k SHRANK in
 * 30.8% of 139,145 steps against MT100's 1.0% of 623, and the recovered fee rate
 * came out two to three orders of magnitude too high.
 */
const LPOOL = 'GAKj13ZPPekCvYoXt2xwmsbtaQp7EcZxzdqjCUcmASmw';
const LUSER = 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn';

/** A minimal trade event, local to this file so the two suites stay independent. */
function buildTradeEvent(): Buffer {
  const b = Buffer.alloc(MIN_EVENT_BYTES);
  BUY_EVENT_DISCRIMINATOR.copy(b, 0);
  b.writeBigInt64LE(1_700_000_000n, 8);
  b.writeBigUInt64LE(12_345n, 16);
  b.writeBigUInt64LE(999_000n, 48);
  b.writeBigUInt64LE(888_000n, 56);
  b.writeBigUInt64LE(20_000_000n, 64);
  b.writeBigUInt64LE(20n, 72);
  b.writeBigUInt64LE(5n, 88);
  b.writeBigUInt64LE(19_950_000n, 112);
  Buffer.from(base58Decode(LPOOL)).copy(b, 120);
  Buffer.from(base58Decode(LUSER)).copy(b, 152);
  return b;
}

function buildLiquidity(side: 'DEPOSIT' | 'WITHDRAW'): Buffer {
  const b = Buffer.alloc(MIN_LIQUIDITY_BYTES);
  (side === 'DEPOSIT' ? DEPOSIT_EVENT_DISCRIMINATOR : WITHDRAW_EVENT_DISCRIMINATOR).copy(b, 0);
  b.writeBigInt64LE(1_700_000_000n, 8);
  b.writeBigUInt64LE(4_242n, 16);
  b.writeBigUInt64LE(777_000n, 56);
  b.writeBigUInt64LE(888_000n, 64);
  b.writeBigUInt64LE(9_999n, 88);
  Buffer.from(base58Decode(LPOOL)).copy(b, 96);
  Buffer.from(base58Decode(LUSER)).copy(b, 128);
  return b;
}

describe('liquidity events', () => {
  it('reads a deposit back at the offsets the program wrote it', () => {
    const e = decodePumpSwapLiquidity(buildLiquidity('DEPOSIT'))!;
    expect(e.side).toBe('DEPOSIT');
    expect(e.pool).toBe(LPOOL);
    expect(e.user).toBe(LUSER);
    expect(e.poolBaseReserves).toBe(777_000n);
    expect(e.poolQuoteReserves).toBe(888_000n);
    expect(e.lpMintSupply).toBe(9_999n);
    expect(e.lpTokenAmount).toBe(4_242n);
  });

  it('takes the side from the discriminator', () => {
    expect(decodePumpSwapLiquidity(buildLiquidity('WITHDRAW'))!.side).toBe('WITHDRAW');
  });

  it('does not confuse a liquidity event with a trade, or the reverse', () => {
    /**
     * They share a log line format and a pool field at DIFFERENT offsets — 96
     * here against 120 for a trade. Decoding one as the other would return a
     * plausible pubkey from the wrong bytes, which is the failure mode that does
     * not announce itself.
     */
    expect(decodePumpSwapTrade(buildLiquidity('DEPOSIT'))).toBeNull();
    expect(decodePumpSwapLiquidity(buildTradeEvent())).toBeNull();
  });

  it('REFUSES a liquidity discriminator on a short payload', () => {
    const short = buildLiquidity('WITHDRAW').subarray(0, MIN_LIQUIDITY_BYTES - 1);
    expect(() => decodePumpSwapLiquidity(short)).toThrow(PumpSwapEventLayoutError);
  });

  it('finds liquidity events in a log array and leaves trades alone', () => {
    const logs = [
      `${PROGRAM_DATA_PREFIX}${buildTradeEvent().toString('base64')}`,
      `${PROGRAM_DATA_PREFIX}${buildLiquidity('WITHDRAW').toString('base64')}`,
    ];
    const liq = liquidityFromLogs(logs);
    expect(liq).toHaveLength(1);
    expect(liq[0]!.event.side).toBe('WITHDRAW');
  });
});
