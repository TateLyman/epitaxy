/**
 * What a follower's round trip actually costs, priced off the reserve path.
 *
 * MT104's metric is an own-fill return. The venue tape carries the pool reserves
 * BEFORE every trade and the exact fee ladder on every trade, so a follower's
 * entry and exit can be priced from the constant-product invariant with no
 * quote, no RPC call and — this is the point — NO CENSORING. Phases C through G
 * all died because 46% to 97% of positions had no exit price in a trade tape.
 * A reserve path always has one.
 *
 * THE FEE RULE IS MEASURED, NOT ASSUMED. Phase G probed the program directly and
 * found the two sides are not symmetric:
 *
 *     BUY   the pool keeps    quote_gross / (1 + f_total)
 *     SELL  the trader gets   quote_pool  x (1 - f_total)
 *
 * and it falsified the obvious alternative — `1 - (protocol+creator)/1e4` — which
 * agrees at tier 0 to half a basis point by coincidence and separates at tier 16.
 * Both sides were reproduced to six decimal places across five pools.
 *
 * `f_total` IS ALL THREE COMPONENTS. At the bottom tier the split is LP 2 /
 * protocol 93 / creator 30, so pricing from lp+protocol alone understates the
 * leg by 30 of 125 basis points. When the creator component is unknown this
 * REFUSES rather than assuming zero: an optimistic fee is indistinguishable from
 * edge, and it is exactly the error that would survive every downstream check.
 *
 * WHAT THIS IS AND IS NOT. It is a model of the venue's own arithmetic, and the
 * arithmetic is verified — the LP decomposition measured constant-product
 * conservation on these pools to 6.6e-6, and the reserve decode reproduces the
 * chain exactly on 55 of 55 trades. It is NOT a built, simulated and
 * effect-verified transaction, which is what this repository means by an
 * executable fill. Anything priced here is graded as modelled and must be
 * validated against real executable quotes before it decides anything.
 */

export class FillNotPriceable extends Error {}

export interface PoolFeeLadder {
  readonly lpFeeBasisPoints: bigint;
  readonly protocolFeeBasisPoints: bigint;
  readonly coinCreatorFeeBasisPoints: bigint | null;
}

export interface PoolReserves {
  readonly base: bigint;
  readonly quote: bigint;
}

const BPS = 10_000n;
/** Fixed-point scale for the fee divisions. 1e12 keeps a 9-decimal amount exact. */
const SCALE = 1_000_000_000_000n;

/**
 * Total fee in basis points, all three components.
 *
 * Refuses when the creator component is unknown. The caller's correct response
 * is to skip the trade and count it, not to price it at a fee nobody measured.
 */
export function totalFeeBps(f: PoolFeeLadder): bigint {
  if (f.coinCreatorFeeBasisPoints === null) {
    throw new FillNotPriceable(
      'the creator fee component is unknown, and it is 30 of 125 bps at the bottom tier; ' +
        'pricing without it would understate the cost by a quarter of the leg',
    );
  }
  return f.lpFeeBasisPoints + f.protocolFeeBasisPoints + f.coinCreatorFeeBasisPoints;
}

export interface BuyFill {
  /** What we sent. */
  readonly quoteIn: bigint;
  /** Base units received. */
  readonly baseOut: bigint;
  /** Reserves after our own trade, which the next fill prices against. */
  readonly reservesAfter: PoolReserves;
  readonly feeBps: bigint;
}

/**
 * Buy `quoteIn` of the base token against these reserves.
 *
 * The pool receives `quoteIn / (1 + f)` — the fee is taken off the top and never
 * enters the invariant — and the base out follows from constant product.
 */
export function priceBuy(reserves: PoolReserves, quoteIn: bigint, fees: PoolFeeLadder): BuyFill {
  if (quoteIn <= 0n) throw new FillNotPriceable('a buy of zero or less is not a fill');
  if (reserves.base <= 0n || reserves.quote <= 0n) {
    throw new FillNotPriceable(`a pool with reserves ${reserves.base}/${reserves.quote} cannot price a fill`);
  }
  const f = totalFeeBps(fees);
  const k = reserves.base * reserves.quote;
  // quoteIn / (1 + f/1e4) == quoteIn * 1e4 / (1e4 + f)
  const quoteToPool = (quoteIn * BPS) / (BPS + f);
  const newQuote = reserves.quote + quoteToPool;
  const newBase = k / newQuote;
  const baseOut = reserves.base - newBase;
  if (baseOut <= 0n) throw new FillNotPriceable('the trade is too small to move a whole base unit');
  return {
    quoteIn,
    baseOut,
    reservesAfter: { base: newBase, quote: newQuote },
    feeBps: f,
  };
}

export interface SellFill {
  readonly baseIn: bigint;
  /** What the TRADER receives, net of the fee. Not the pool's leg. */
  readonly quoteOut: bigint;
  readonly reservesAfter: PoolReserves;
  readonly feeBps: bigint;
}

/**
 * Sell `baseIn` back against these reserves.
 *
 * The pool releases its leg by constant product and the trader receives that
 * times `(1 - f)`. Note the asymmetry with the buy: the fee is applied to the
 * OUTPUT here and to the INPUT there, which is the thing Phase G had to measure
 * because assuming symmetry gets tier 16 wrong.
 */
export function priceSell(reserves: PoolReserves, baseIn: bigint, fees: PoolFeeLadder): SellFill {
  if (baseIn <= 0n) throw new FillNotPriceable('a sell of zero or less is not a fill');
  if (reserves.base <= 0n || reserves.quote <= 0n) {
    throw new FillNotPriceable(`a pool with reserves ${reserves.base}/${reserves.quote} cannot price a fill`);
  }
  const f = totalFeeBps(fees);
  const k = reserves.base * reserves.quote;
  const newBase = reserves.base + baseIn;
  const newQuote = k / newBase;
  const quoteFromPool = reserves.quote - newQuote;
  if (quoteFromPool <= 0n) throw new FillNotPriceable('the trade is too small to move a whole quote unit');
  const quoteOut = (quoteFromPool * (BPS - f)) / BPS;
  return { baseIn, quoteOut, reservesAfter: { base: newBase, quote: newQuote }, feeBps: f };
}

export interface RoundTrip {
  readonly quoteIn: bigint;
  readonly quoteOut: bigint;
  /** Signed lamports. */
  readonly pnl: bigint;
  /** Return as a fraction, to 12 decimal places of fixed point. */
  readonly returnFraction: number;
  readonly entryFeeBps: bigint;
  readonly exitFeeBps: bigint;
}

/**
 * Enter at `entryReserves`, exit at `exitReserves`, same notional.
 *
 * `exitReserves` are the pool's reserves at the exit moment as the tape recorded
 * them — NOT the reserves our own entry left behind. The difference is every
 * trade the market did in between, which is exactly the thing being measured.
 *
 * Our own entry impact IS included, and CARRYING THE FOOTPRINT IS THE WHOLE POINT.
 *
 * D1 — this used to hand `exitReserves` to `priceSell` unmodified while claiming in
 * this very comment that the sell was priced "against the exit pool plus our own
 * size". It was not. The buy took `baseOut` OUT of the entry pool and then the sell
 * pushed it back into a pool that had never received it, so the round trip paid its
 * own impact TWICE instead of zero times. On a constant-product curve a buy and an
 * immediate sell of the same base is exactly reversible: you traverse the curve up
 * and back, and only the fee remains.
 *
 * The spurious cost was about 2 * notional / quote, which is small in a deep pool and
 * enormous in a shallow one — it is why the shallow arm of MT111 read -6.685% when the
 * corrected figure is near -3.6%, and roughly half of the published "you pay ~6.7% a
 * round trip outside deep pools" was this bug rather than the market.
 *
 * With the footprint carried, an unchanged pool collapses to the closed form
 * `(1 - f) / (1 + f) - 1`, which is the pure fee and is notional-invariant. That
 * invariance is the test, and it is asserted in the suite.
 */
export function priceRoundTrip(
  entryReserves: PoolReserves,
  exitReserves: PoolReserves,
  quoteIn: bigint,
  entryFees: PoolFeeLadder,
  exitFees: PoolFeeLadder,
): RoundTrip {
  const buy = priceBuy(entryReserves, quoteIn, entryFees);
  // Our own footprint: the base we removed and the quote we added on the way in.
  const quoteAdded = buy.reservesAfter.quote - entryReserves.quote;
  const exitWithOurFootprint: PoolReserves = {
    base: exitReserves.base - buy.baseOut,
    quote: exitReserves.quote + quoteAdded,
  };
  if (exitWithOurFootprint.base <= 0n) {
    // Our position is at least the whole exit pool. There is no price at which this
    // exits, and inventing one is the single most flattering error available here.
    throw new FillNotPriceable(
      `a position of ${buy.baseOut} base cannot exit a pool holding ${exitReserves.base}`,
    );
  }
  const sell = priceSell(exitWithOurFootprint, buy.baseOut, exitFees);
  const pnl = sell.quoteOut - quoteIn;
  return {
    quoteIn,
    quoteOut: sell.quoteOut,
    pnl,
    returnFraction: Number((pnl * SCALE) / quoteIn) / Number(SCALE),
    entryFeeBps: buy.feeBps,
    exitFeeBps: sell.feeBps,
  };
}

/**
 * The round-trip cost floor these reserves and fees imply, in basis points.
 *
 * Entering and exiting instantly at the same reserves: the whole loss is fee
 * plus our own impact. This is the per-position floor MT104's decision rule
 * compares against — "the cost floor of its own tier" — computed from the pool
 * we actually traded rather than from a corpus-wide constant.
 */
export function roundTripFloorBps(reserves: PoolReserves, quoteIn: bigint, fees: PoolFeeLadder): number {
  const buy = priceBuy(reserves, quoteIn, fees);
  const sell = priceSell(buy.reservesAfter, buy.baseOut, fees);
  const loss = quoteIn - sell.quoteOut;
  return Number((loss * BPS * SCALE) / quoteIn) / Number(SCALE);
}
