/**
 * Phase E — mirroring the FRACTION of each wallet sell, not the event.
 *
 * Phase D found that a copier treating the first observed sell as a full exit
 * forfeits most of the wallet's return before paying any slippage: the wallet's
 * realised return is 3–6× its first-sell return. This is the arithmetic of the
 * smallest change that could recover that, and it lives here rather than only in
 * SQL for one reason: the no-lookahead property MT087 asserts is a property of this
 * function, and it is testable here and not testable in a Dune query.
 *
 * THE CONSTRUCTION
 *
 * The wallet's holding evolves along its own legs. At each sell it disposes of
 *
 *     fraction_k = tokens_sold_k / tokens_held_before_k
 *
 * The copier opens one normalised unit at T_buy + L and, at each T_k + L, sells
 * `fraction_k` of ITS OWN remaining, so its remaining after leg k is
 *
 *     remaining_k = PRODUCT over j <= k of (1 - fraction_j)
 *
 * and the weight it liquidates at leg k is `remaining_{k-1} * fraction_k`. Those
 * weights sum to at most 1 and equal 1 exactly when the wallet's holding reaches
 * zero — the copier mirrors the shape of the exit without ever needing to know how
 * many legs are coming.
 *
 * WHY THAT LAST CLAUSE IS THE WHOLE POINT
 *
 * `fraction_k` depends only on the tape up to and including T_k: cumulative buys
 * minus cumulative sells, both observable as they happen. Nothing here uses the
 * number of future sells, the wallet's eventual total, or whether a given sell turns
 * out to be the last. `mirrorWeights` is therefore prefix-stable — extending the
 * leg sequence never changes a weight already emitted — and the test asserts that
 * against every prefix rather than trusting this paragraph.
 */

/** One wallet leg, in tape order. `tokens` is always positive. */
export interface WalletLeg {
  readonly side: 'BUY' | 'SELL';
  readonly tokens: number;
}

export interface MirrorLeg {
  /** Index into the input sequence, so a caller can pair a weight with its price. */
  readonly index: number;
  /** tokens_sold_k / tokens_held_before_k, clamped to [0, 1]. */
  readonly fraction: number;
  /** The copier's remaining before this leg, as a share of its opening unit. */
  readonly remainingBefore: number;
  /** remainingBefore * fraction: the share the copier liquidates at this leg. */
  readonly weight: number;
}

/**
 * The copier's per-leg liquidation weights.
 *
 * Legs are consumed in the order given, which must be tape order. A sell arriving
 * when the wallet holds nothing has no defined fraction and is skipped rather than
 * treated as a full exit — that shape occurs when tokens entered the position from
 * outside the WSOL swap stream, which `external_inflow` already excludes upstream,
 * and silently reading it as fraction = 1 would fabricate an exit.
 */
export function mirrorWeights(legs: readonly WalletLeg[]): MirrorLeg[] {
  let held = 0;
  let remaining = 1;
  const out: MirrorLeg[] = [];
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i] as WalletLeg;
    if (leg.side === 'BUY') {
      held += leg.tokens;
      continue;
    }
    if (held <= 0) continue;
    const fraction = Math.min(Math.max(leg.tokens / held, 0), 1);
    const weight = remaining * fraction;
    out.push({ index: i, fraction, remainingBefore: remaining, weight });
    held -= Math.min(leg.tokens, held);
    remaining -= weight;
  }
  return out;
}

/** What the copier still holds after mirroring every leg. Zero iff the wallet exited. */
export function residualWeight(legs: readonly WalletLeg[]): number {
  const w = mirrorWeights(legs);
  return Math.max(1 - w.reduce((a, l) => a + l.weight, 0), 0);
}

export interface ProportionalReturnInput {
  /** Per-leg liquidation weights, from `mirrorWeights`. */
  readonly legs: readonly MirrorLeg[];
  /** The copier's own exit price at each leg, aligned to `legs`. NULL if unpriceable. */
  readonly exitPrices: readonly (number | null)[];
  readonly entryPrice: number;
  /** The full round-trip floor, charged once against the round trip. */
  readonly roundTripFloor: number;
  /**
   * Extra fixed cost per ADDITIONAL sell leg, as a fraction of the entry notional.
   *
   * The venue fee and the price impact are proportional to leg value, so splitting
   * one exit into K legs does not multiply them. What it does multiply is the
   * per-transaction base-plus-priority fee, and that is the only cost of extra legs
   * this data can charge honestly.
   */
  readonly extraLegCostFraction: number;
}

export interface ProportionalReturn {
  /** Proceeds as a share of the entry notional, over legs that could be priced. */
  readonly proceeds: number;
  /** The share of its position the copier actually liquidated. */
  readonly soldWeight: number;
  /** Legs whose exit price was unavailable, so the copier kept holding that share. */
  readonly unpricedLegs: number;
  readonly pricedLegs: number;
  /**
   * Return with everything unsold treated as worthless. Bounded below by -1 minus
   * the extra-leg cost, and the analogue of Phase D's open-at--100%.
   */
  readonly returnDead: number;
  /**
   * Return over the part that could be mirrored, renormalised. NULL when nothing
   * was sold, because a return on a position never exited is not a number.
   */
  readonly returnMirrored: number | null;
}

export function proportionalReturn(x: ProportionalReturnInput): ProportionalReturn {
  let proceeds = 0;
  let soldWeight = 0;
  let unpriced = 0;
  let priced = 0;
  for (let i = 0; i < x.legs.length; i += 1) {
    const leg = x.legs[i] as MirrorLeg;
    const px = x.exitPrices[i] ?? null;
    if (px === null || !(px > 0)) {
      unpriced += 1;
      continue;
    }
    priced += 1;
    proceeds += (leg.weight * px) / x.entryPrice;
    soldWeight += leg.weight;
  }
  const extra = Math.max(priced - 1, 0) * x.extraLegCostFraction;
  const returnDead = proceeds - 1 - x.roundTripFloor - extra;
  return {
    proceeds,
    soldWeight,
    unpricedLegs: unpriced,
    pricedLegs: priced,
    returnDead,
    returnMirrored: soldWeight > 0 ? proceeds / soldWeight - 1 - x.roundTripFloor - extra : null,
  };
}

/**
 * The binary control: the first sell that can be priced, taken as a full exit.
 *
 * This is Phase D's estimand computed on the same position, which is what makes the
 * MT087 condition-5 comparison paired rather than two separate studies.
 */
export function binaryReturn(x: ProportionalReturnInput): number | null {
  for (let i = 0; i < x.legs.length; i += 1) {
    const px = x.exitPrices[i] ?? null;
    if (px !== null && px > 0) return px / x.entryPrice - 1 - x.roundTripFloor;
  }
  return null;
}
