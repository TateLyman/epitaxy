/**
 * SOL/USD, derived from the corpus rather than fetched.
 *
 * The provider quotes memecoin prices and market caps in USD. The bankroll,
 * every fee, every rent and every reserve is in SOL. Comparing a USD return
 * against a SOL cost is not a rounding error: measured on this corpus the
 * 5h-24h cohort's mean is +0.04% in USD and -1.22% in SOL, and the difference
 * is half the whole cost floor.
 *
 * There is no stored SOL/USD series — `regime_samples.sol_usd` exists and is
 * empty — so it is derived from two things the corpus does hold:
 *
 *   a stored BUY quote     SOL lamports in, token atoms out  -> price in SOL
 *   a stored snapshot      the same mint's usdPrice          -> price in USD
 *
 * and their ratio is SOL/USD at that moment. Bucketed hourly by median, because
 * a single pair carries that one route's fee and impact.
 *
 * WHAT IS WRONG WITH IT, SAID OUT LOUD
 *
 * The quote's SOL price includes the buy leg's own fee and impact, so the
 * derived level is biased LOW by roughly a percent. In a ratio of two of them —
 * which is the only way this module is used, converting an entry price and an
 * exit price — that bias cancels to first order. Any use that reads the level
 * itself as a spot rate should not be using this.
 */
import type { Db } from '../../storage/src/db.js';

export interface SolUsdBucket {
  readonly bucketUtcMs: number;
  readonly solUsd: number;
  readonly pairs: number;
}

export interface SolUsdSeries {
  readonly buckets: readonly SolUsdBucket[];
  readonly pairsTotal: number;
  readonly quotesConsidered: number;
  readonly medianSolUsd: number | null;
  readonly bucketMs: number;
  readonly pairMaxGapMs: number;
  readonly derivation: string;
}

/** How far apart a quote and a snapshot may be to price one against the other. */
export const SOL_USD_PAIR_MAX_GAP_MS = 300_000;
export const SOL_USD_BUCKET_MS = 3_600_000;
/** Beyond this from the nearest bucket, the rate is unknown rather than stale. */
export const SOL_USD_MAX_BUCKET_DISTANCE_MS = 6 * 3_600_000;

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : (((s[m - 1] as number) + (s[m] as number)) / 2);
};

export function deriveSolUsd(db: Db): SolUsdSeries {
  const quotes = db
    .prepare(
      `SELECT mint, in_amount AS inAmount, out_amount AS outAmount, requested_utc_ms AS t
         FROM quotes
        WHERE side = 'buy' AND CAST(out_amount AS INTEGER) > 0 AND CAST(in_amount AS INTEGER) > 0`,
    )
    .all() as { mint: string; inAmount: string; outAmount: string; t: number }[];

  const near = db.prepare(
    `SELECT json_extract(features_json, '$.usdPrice') AS usd,
            json_extract(raw_inputs_json, '$.decimals') AS decimals,
            ABS(taken_utc_ms - ?) AS gap
       FROM decision_snapshots
      WHERE mint = ?
      ORDER BY gap ASC
      LIMIT 1`,
  );

  const byBucket = new Map<number, number[]>();
  let pairs = 0;
  for (const q of quotes) {
    const row = near.get(q.t, q.mint) as { usd: number | null; decimals: number | null; gap: number } | undefined;
    if (row === undefined || row.usd === null || row.decimals === null) continue;
    if (row.gap > SOL_USD_PAIR_MAX_GAP_MS) continue;
    const tokensOut = Number(BigInt(q.outAmount)) / 10 ** row.decimals;
    if (!Number.isFinite(tokensOut) || tokensOut <= 0) continue;
    const solIn = Number(BigInt(q.inAmount)) / 1e9;
    const priceSol = solIn / tokensOut;
    if (!Number.isFinite(priceSol) || priceSol <= 0) continue;
    const solUsd = row.usd / priceSol;
    if (!Number.isFinite(solUsd) || solUsd <= 0) continue;
    const bucket = Math.floor(q.t / SOL_USD_BUCKET_MS) * SOL_USD_BUCKET_MS;
    const list = byBucket.get(bucket);
    if (list === undefined) byBucket.set(bucket, [solUsd]);
    else list.push(solUsd);
    pairs += 1;
  }

  const buckets = [...byBucket.entries()]
    .map(([bucketUtcMs, vals]) => ({ bucketUtcMs, solUsd: median(vals) as number, pairs: vals.length }))
    .sort((a, b) => a.bucketUtcMs - b.bucketUtcMs);

  return {
    buckets,
    pairsTotal: pairs,
    quotesConsidered: quotes.length,
    medianSolUsd: median(buckets.map((b) => b.solUsd)),
    bucketMs: SOL_USD_BUCKET_MS,
    pairMaxGapMs: SOL_USD_PAIR_MAX_GAP_MS,
    derivation:
      'stored buy quotes (SOL in, atoms out) against the same mint stored USD price within 5 minutes; ' +
      'hourly median. Carries the buy leg fee, which cancels in a ratio of two.',
  };
}

/**
 * The rate at a moment: the nearest hourly bucket, or null.
 *
 * Null rather than the series median. A rate substituted for one that is not
 * there converts a price with a number from a different day and reports the
 * difference as a return.
 */
export function solUsdAt(series: SolUsdSeries, utcMs: number): number | null {
  if (series.buckets.length === 0) return null;
  // The buckets are sorted, so a binary search finds the neighbour without
  // walking 115 of them per call — this is invoked once per snapshot, and the
  // corpus has 837,876 of those.
  let lo = 0;
  let hi = series.buckets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((series.buckets[mid] as SolUsdBucket).bucketUtcMs < utcMs) lo = mid + 1;
    else hi = mid;
  }
  let best: SolUsdBucket | null = null;
  for (const i of [lo - 1, lo, lo + 1]) {
    const b = series.buckets[i];
    if (b === undefined) continue;
    if (best === null || Math.abs(b.bucketUtcMs - utcMs) < Math.abs(best.bucketUtcMs - utcMs)) best = b;
  }
  if (best === null || Math.abs(best.bucketUtcMs - utcMs) > SOL_USD_MAX_BUCKET_DISTANCE_MS) return null;
  return best.solUsd;
}
