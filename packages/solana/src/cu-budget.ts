import { MAX_COMPUTE_UNIT_LIMIT } from './computebudget.js';

/**
 * P6 — the compute unit limit a leg should REQUEST, from what it measured.
 *
 * Solana charges the priority fee against the *requested* limit, not the
 * consumed one:
 *
 * ```
 * priority fee = ceil(unit_price × unit_limit / 1e6)
 * ```
 *
 * So a leg that omits `SetComputeUnitLimit` does not pay nothing. It falls back
 * to the derived allocation — 200,000 units per non-builtin instruction — and a
 * five-instruction PumpSwap buy that consumes 90,000 units is then charged
 * against roughly 800,000. At a modest 10,000 µlamport price that is 8,000
 * lamports instead of 900: seven thousand lamports per leg, on a 20,000,000
 * lamport notional, for nothing.
 *
 * That is 35 bps of round-trip drag purchasable by a single instruction, which
 * makes it the cheapest mechanics win available and the one P6 names alongside
 * not paying other traders' rent.
 *
 * The margin is FROZEN rather than tuned. Compute varies run to run — an ATA
 * that already exists skips its creation, a fee tier lookup takes a different
 * branch — and a limit set to the exact measured figure fails the first time a
 * leg costs one unit more. A failed leg costs the whole base fee and the
 * landing interval, so the asymmetry is severe and the margin is deliberately
 * generous in the direction of landing.
 */

/** Frozen for the development window. Not a search parameter. */
export const FROZEN_CU_MARGIN_PCT = 20;

/**
 * Minimum requested limit.
 *
 * Below this the margin stops being meaningful — a 1,000-unit leg with 20%
 * margin has 200 units of headroom, which one changed branch consumes.
 */
export const MIN_REQUESTED_CU = 10_000;

export interface ComputeBudgetPlan {
  readonly measuredUnits: number;
  readonly requestedUnits: number;
  readonly marginPct: number;
  /** True when the measured figure was missing, so nothing was measured at all. */
  readonly derivedFromMeasurement: boolean;
  readonly clamped: boolean;
}

/**
 * The limit to request, given what the leg actually consumed.
 *
 * `null` measurement returns `null` rather than a default. A guessed limit is
 * indistinguishable in the transaction from a measured one and costs real
 * lamports if it is wrong in either direction — too low fails the leg, too high
 * overpays the priority fee on every leg thereafter.
 */
export function frozenComputeLimit(
  measuredUnits: number | null,
  marginPct: number = FROZEN_CU_MARGIN_PCT,
): ComputeBudgetPlan | null {
  if (measuredUnits === null || !Number.isFinite(measuredUnits) || measuredUnits <= 0) return null;

  const withMargin = Math.ceil(measuredUnits * (1 + marginPct / 100));
  const floored = Math.max(withMargin, MIN_REQUESTED_CU);
  const requested = Math.min(floored, MAX_COMPUTE_UNIT_LIMIT);

  return {
    measuredUnits,
    requestedUnits: requested,
    marginPct,
    derivedFromMeasurement: true,
    clamped: floored > MAX_COMPUTE_UNIT_LIMIT,
  };
}

/**
 * What omitting the limit costs, against what requesting the measured one does.
 *
 * Reported rather than assumed: the saving depends on the unit price, and a
 * price of zero makes the whole thing worth nothing. Development legs run in an
 * isolated runtime and pay no priority fee at all, so this is the number that
 * says whether the instruction is worth adding before any live path exists.
 */
export function priorityFeeSaving(p: {
  plan: ComputeBudgetPlan;
  /** What the runtime would have derived with no explicit limit. */
  derivedUnits: number;
  unitPriceMicroLamports: bigint;
}): { withLimitLamports: bigint; withoutLimitLamports: bigint; savedLamports: bigint } {
  const fee = (units: number): bigint => {
    if (p.unitPriceMicroLamports <= 0n || units <= 0) return 0n;
    // CEILING, like the runtime. Flooring is optimistic on every leg.
    return (BigInt(units) * p.unitPriceMicroLamports + 999_999n) / 1_000_000n;
  };
  const withLimit = fee(p.plan.requestedUnits);
  const without = fee(Math.min(p.derivedUnits, MAX_COMPUTE_UNIT_LIMIT));
  return {
    withLimitLamports: withLimit,
    withoutLimitLamports: without,
    // Never negative: a measured leg that consumes more than the derived
    // allocation would not have landed without the explicit limit at all, so
    // the comparison is not a saving and is reported as zero.
    savedLamports: without > withLimit ? without - withLimit : 0n,
  };
}
