import BN from 'bn.js';

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
