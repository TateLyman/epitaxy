import BN from 'bn.js';
import { createHash } from 'node:crypto';

/**
 * P14 — the dynamic fee tiers, and what they do to the mechanics floor.
 *
 * The size surface reported an AMM drag of 241.5 bps that was **flat across
 * every size in the grid**, and it was right to. What that result does not say,
 * and what reading it carelessly would imply, is that 241.5 bps is a constant
 * of the venue.
 *
 * It is not. PumpSwap's fee is a step function of the pool's MARKET CAP: the
 * fee config carries a table of tiers, each with a lamport threshold and its
 * own lp / protocol / creator split, and the creator component falls as the cap
 * rises. The drag is flat in size and a step function across tokens.
 *
 * A mechanics gate calibrated on one measurement is therefore calibrated on
 * whichever tier those particular mints happened to sit in, and a token one
 * lamport of market cap below a threshold pays a different round trip from one
 * a lamport above it.
 *
 * This module reads that table out of the fee config the swap already decodes.
 * No network, no new dependency, and no arithmetic of my own — the SDK's own
 * decoder produces the tiers and this only makes them legible.
 */

export interface FeeSplit {
  readonly lpFeeBps: number;
  readonly protocolFeeBps: number;
  readonly creatorFeeBps: number;
  /** What a single leg pays. The three components are additive. */
  readonly totalBps: number;
}

export interface FeeTier {
  readonly marketCapLamportsThreshold: bigint;
  readonly fees: FeeSplit;
  /** Both legs. A round trip pays the tier twice. */
  readonly roundTripBps: number;
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (v instanceof BN) return v.toNumber();
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'object' && v !== null && 'toString' in v) return Number((v as { toString(): string }).toString());
  return 0;
};

const big = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  if (v instanceof BN) return BigInt(v.toString());
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v);
  if (typeof v === 'object' && v !== null && 'toString' in v) return BigInt((v as { toString(): string }).toString());
  return 0n;
};

function splitOf(fees: Record<string, unknown>): FeeSplit {
  const lp = num(fees['lpFeeBps']);
  const protocol = num(fees['protocolFeeBps']);
  const creator = num(fees['creatorFeeBps']);
  return { lpFeeBps: lp, protocolFeeBps: protocol, creatorFeeBps: creator, totalBps: lp + protocol + creator };
}

/** The tier table, ordered by threshold ascending. */
export function feeTiersOf(decodedFeeConfig: unknown): FeeTier[] {
  const cfg = decodedFeeConfig as { feeTiers?: { marketCapLamportsThreshold: unknown; fees: Record<string, unknown> }[] };
  const tiers = cfg.feeTiers ?? [];
  return tiers
    .map((t) => {
      const fees = splitOf(t.fees);
      return {
        marketCapLamportsThreshold: big(t.marketCapLamportsThreshold),
        fees,
        roundTripBps: fees.totalBps * 2,
      };
    })
    .sort((a, b) =>
      a.marketCapLamportsThreshold < b.marketCapLamportsThreshold
        ? -1
        : a.marketCapLamportsThreshold > b.marketCapLamportsThreshold
          ? 1
          : 0,
    );
}

/** The flat fee used when no tier applies. */
export function flatFeeOf(decodedFeeConfig: unknown): FeeSplit {
  const cfg = decodedFeeConfig as { flatFees?: Record<string, unknown> };
  return splitOf(cfg.flatFees ?? {});
}

/**
 * The tier a pool of `marketCapLamports` falls in.
 *
 * The **highest** threshold not exceeding the cap. Returns null for an empty
 * table rather than inventing a default, because a fee config with no tiers is
 * a fee config this code has not understood.
 */
export function tierFor(tiers: readonly FeeTier[], marketCapLamports: bigint): FeeTier | null {
  let found: FeeTier | null = null;
  for (const t of tiers) {
    if (t.marketCapLamportsThreshold <= marketCapLamports) found = t;
    else break;
  }
  return found;
}

/**
 * The market caps at which the round-trip cost changes, and by how much.
 *
 * These are the sizes a parity matrix has to straddle to have tested the
 * boundary at all. Sampling a token in the middle of a tier tests the tier; it
 * says nothing about the step.
 */
export interface Boundary {
  readonly marketCapLamports: bigint;
  readonly belowRoundTripBps: number;
  readonly aboveRoundTripBps: number;
  readonly stepBps: number;
}

export function boundaries(tiers: readonly FeeTier[]): Boundary[] {
  const out: Boundary[] = [];
  for (let i = 1; i < tiers.length; i++) {
    const below = tiers[i - 1] as FeeTier;
    const above = tiers[i] as FeeTier;
    if (below.roundTripBps === above.roundTripBps) continue;
    out.push({
      marketCapLamports: above.marketCapLamportsThreshold,
      belowRoundTripBps: below.roundTripBps,
      aboveRoundTripBps: above.roundTripBps,
      stepBps: above.roundTripBps - below.roundTripBps,
    });
  }
  return out;
}

/**
 * The spread of the mechanics floor across the whole table.
 *
 * The number a size surface measured is one point in this range, and which
 * point depends entirely on the market caps of the mints that happened to be
 * sampled.
 */
export function floorRange(tiers: readonly FeeTier[]): { minBps: number; maxBps: number; spreadBps: number } | null {
  if (tiers.length === 0) return null;
  const rts = tiers.map((t) => t.roundTripBps);
  const minBps = Math.min(...rts);
  const maxBps = Math.max(...rts);
  return { minBps, maxBps, spreadBps: maxBps - minBps };
}

/**
 * F15 — the pool's MARKET CAP, which is what selects the tier.
 *
 * Pump's fee documentation defines the canonical tier by
 *
 * ```
 * current token price in SOL × 1,000,000,000 tokens
 * ```
 *
 * and the SDK implements exactly that as
 *
 * ```
 * marketCap = quoteReserve × baseMintSupply / baseReserve
 * ```
 *
 * (`src/sdk/util.ts:poolMarketCap`) — the middle term is the supply because the
 * canonical supply IS one billion tokens, so the documentation's constant and
 * the SDK's variable are the same quantity.
 *
 * The classification path was passing RAW QUOTE RESERVE instead. Those are not
 * the same number and they are not even proportional: a pool with a small quote
 * reserve and a tiny base reserve is a HIGH market cap, and reading it off the
 * quote side alone puts it in the bottom tier — which then reports a 250 bps
 * round-trip floor for a pool the program is charging 50.
 *
 * Refuses on a zero base reserve rather than dividing, matching the SDK.
 */
export function poolMarketCapLamports(p: {
  quoteReserveLamports: bigint;
  baseReserveAtoms: bigint;
  baseMintSupplyAtoms: bigint;
}): bigint {
  if (p.baseReserveAtoms === 0n) {
    throw new Error('cannot compute market cap: the pool base reserve is zero');
  }
  return (p.quoteReserveLamports * p.baseMintSupplyAtoms) / p.baseReserveAtoms;
}

/**
 * The tier the program will actually charge, by the SDK's own rule.
 *
 * `tierFor` returns null below the first threshold, which reads as "no tier
 * applies". The program disagrees: `calculateFeeTier` returns the FIRST tier's
 * fees for any market cap under the first threshold, so a brand-new pool is
 * charged the bottom tier rather than nothing. Reporting null there understates
 * the floor for exactly the pools this system samples most — the ones that just
 * migrated.
 *
 * Replicated rather than imported because the SDK does not export it. Verified
 * against `src/sdk/fees.ts:calculateFeeTier` at version 1.19.0 on 2026-08-16;
 * the branch order below is that function's, including the reverse scan.
 */
export function selectFeeTier(tiers: readonly FeeTier[], marketCapLamports: bigint): FeeTier | null {
  const first = tiers[0];
  if (first === undefined) return null;
  if (marketCapLamports < first.marketCapLamportsThreshold) return first;
  for (let i = tiers.length - 1; i >= 0; i--) {
    const t = tiers[i] as FeeTier;
    if (marketCapLamports >= t.marketCapLamportsThreshold) return t;
  }
  return first;
}

/**
 * A stable identity for the fee table that priced a leg.
 *
 * Persisted alongside the selected tier so a replay can tell "the tier changed"
 * from "Pump republished the table". Pump has already changed fee-recipient
 * behaviour once; a stored tier with no record of the table it came from cannot
 * survive that.
 */
export function feeConfigHash(tiers: readonly FeeTier[], flat: FeeSplit): string {
  const h = createHash('sha256');
  for (const t of tiers) {
    h.update(
      `|${t.marketCapLamportsThreshold}:${t.fees.lpFeeBps}:${t.fees.protocolFeeBps}:${t.fees.creatorFeeBps}`,
    );
  }
  h.update(`|flat:${flat.lpFeeBps}:${flat.protocolFeeBps}:${flat.creatorFeeBps}`);
  return h.digest('hex');
}

export interface SelectedTier {
  readonly tier: FeeTier | null;
  readonly marketCapLamports: bigint | null;
  /** Why no tier could be selected. Null when one was. */
  readonly refusal: string | null;
}

/**
 * The tier for a pool, from its reserves and its supply.
 *
 * The one entry point classification should use. Every call site in this
 * repository was passing raw quote reserve — sometimes plus virtual reserves,
 * once a hardcoded zero — to a function whose parameter is a MARKET CAP. That
 * put pools in the bottom tier by default and reported a 250 bps floor for
 * pools the program charges 50.
 *
 * Refuses by name rather than defaulting. A tier nobody could select is not the
 * bottom tier; it is an unknown, and the difference is 200 bps of round trip.
 */
export function tierForPool(
  tiers: readonly FeeTier[],
  p: {
    quoteReserveLamports: bigint;
    baseReserveAtoms: bigint;
    baseMintSupplyAtoms: bigint | null;
  },
): SelectedTier {
  if (tiers.length === 0) {
    return { tier: null, marketCapLamports: null, refusal: 'the fee config carries no tier table' };
  }
  if (p.baseMintSupplyAtoms === null) {
    return {
      tier: null,
      marketCapLamports: null,
      refusal: 'the base mint supply was not read, and the tier cannot be derived from reserves alone',
    };
  }
  if (p.baseReserveAtoms === 0n) {
    return { tier: null, marketCapLamports: null, refusal: 'the pool base reserve is zero' };
  }
  const cap = poolMarketCapLamports({
    quoteReserveLamports: p.quoteReserveLamports,
    baseReserveAtoms: p.baseReserveAtoms,
    baseMintSupplyAtoms: p.baseMintSupplyAtoms,
  });
  return { tier: selectFeeTier(tiers, cap), marketCapLamports: cap, refusal: null };
}
