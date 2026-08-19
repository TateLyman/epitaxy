import { createHash } from 'node:crypto';

/**
 * P12 — statistics for a sample whose mean is not a fact.
 *
 * Epitaxy's three settled windows told three different stories:
 *
 *     window A   n=15   FIXED_15M +1.23m    FLOW/LIQ +14.59m lamports
 *     window B   n=45   FIXED_15M -3.93m    FLOW/LIQ -35.12m
 *     window C   n=13   FIXED_15M +9.59m    FLOW/LIQ  +8.73m
 *
 * In window C only 2 of 13 paths were positive and ONE ~+14m winner carried the
 * total; remove it and both policies are negative. The largest window is
 * negative. Those sign flips are not a measurement problem to be averaged away
 * — they are the actual shape of memecoin returns, and any statistic that
 * assumes otherwise will keep producing confident nonsense.
 *
 * So:
 *
 *  - THE SAMPLING UNIT IS THE MINT. Not a policy outcome and not a delayed-entry
 *    row. Two clocks × three policies on one token is SIX rows and ONE draw from
 *    the market; treating them as six independent observations understates the
 *    uncertainty by roughly the square root of six, which is most of the
 *    difference between "significant" and "noise".
 *
 *  - UNCERTAINTY IS RESAMPLED BY CLUSTER, never computed from a formula that
 *    assumes independence.
 *
 *  - FRAGILITY IS REPORTED ALWAYS. A result that dies when the best mint is
 *    removed is a result about one token.
 */

export interface MintOutcome {
  readonly mint: string;
  /** UTC day, so a whole-day block bootstrap can resample it. */
  readonly utcDay: string;
  /** Log return, all costs included. The quantity the portfolio objective uses. */
  readonly logReturn: number;
  /** Net PnL in lamports, for profit factor and CVaR. */
  readonly netPnlLamports: bigint;
  readonly catastrophic: boolean;
  readonly blockedExit: boolean;
}

export interface RobustSummary {
  readonly nMints: number;
  readonly nUtcDays: number;
  readonly meanLogReturn: number | null;
  readonly medianLogReturn: number | null;
  /** Median of means over k blocks: resistant to a single dominating outcome. */
  readonly medianOfMeans: number | null;
  readonly profitFactor: number | null;
  readonly catastrophicIncidence: number | null;
  readonly blockedExitIncidence: number | null;
  readonly cvar95: number | null;
  readonly maxDrawdown: number | null;
}

function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

/**
 * Median of means.
 *
 * Splits the sample into k blocks, takes each block's mean, returns the median
 * of those. One enormous winner moves ONE block's mean and cannot move the
 * median of the rest — which is precisely the failure mode window C exhibits.
 * k is chosen as sqrt(n) and floored at 3, because fewer blocks makes the
 * median meaningless and more makes each block's mean pure noise.
 */
export function medianOfMeans(xs: readonly number[], k?: number): number | null {
  if (xs.length === 0) return null;
  const blocks = k ?? Math.max(3, Math.floor(Math.sqrt(xs.length)));
  if (xs.length < blocks) return mean(xs);
  const out: number[] = [];
  const size = Math.floor(xs.length / blocks);
  for (let i = 0; i < blocks; i++) {
    const slice = xs.slice(i * size, i === blocks - 1 ? xs.length : (i + 1) * size);
    const m = mean(slice);
    if (m !== null) out.push(m);
  }
  return median(out);
}

export function summarise(outcomes: readonly MintOutcome[]): RobustSummary {
  const rets = outcomes.map((o) => o.logReturn);
  const wins = outcomes.filter((o) => o.netPnlLamports > 0n).reduce((a, o) => a + o.netPnlLamports, 0n);
  const losses = outcomes.filter((o) => o.netPnlLamports < 0n).reduce((a, o) => a - o.netPnlLamports, 0n);

  // CVaR at 95%: the mean of the worst 5% of outcomes. With a handful of mints
  // that is one or two paths, which is exactly the point — it names the tail
  // rather than describing the middle.
  const sorted = [...rets].sort((a, b) => a - b);
  const tailCount = Math.max(1, Math.floor(sorted.length * 0.05));
  const cvar = sorted.length === 0 ? null : mean(sorted.slice(0, tailCount));

  // Max drawdown over the chronological equity path in log space.
  let peak = 0;
  let equity = 0;
  let worst = 0;
  for (const r of rets) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    if (dd < worst) worst = dd;
  }

  return {
    nMints: new Set(outcomes.map((o) => o.mint)).size,
    nUtcDays: new Set(outcomes.map((o) => o.utcDay)).size,
    meanLogReturn: mean(rets),
    medianLogReturn: median(rets),
    medianOfMeans: medianOfMeans(rets),
    profitFactor: losses === 0n ? null : Number((wins * 10_000n) / losses) / 10_000,
    catastrophicIncidence: outcomes.length === 0 ? null : outcomes.filter((o) => o.catastrophic).length / outcomes.length,
    blockedExitIncidence: outcomes.length === 0 ? null : outcomes.filter((o) => o.blockedExit).length / outcomes.length,
    cvar95: cvar,
    maxDrawdown: rets.length === 0 ? null : worst,
  };
}

/**
 * A deterministic PRNG.
 *
 * `Math.random()` would make every bootstrap interval a different number on
 * every run, so a result could not be reproduced and a borderline interval
 * could be re-rolled until it cleared. Seeded from the sample itself, so the
 * same sample always yields the same interval and a different sample yields a
 * different one.
 */
function seededRng(seed: string): () => number {
  let h = createHash('sha256').update(seed).digest();
  let i = 0;
  return () => {
    if (i + 4 > h.length) {
      h = createHash('sha256').update(h).digest();
      i = 0;
    }
    const v = h.readUInt32BE(i) / 0x1_0000_0000;
    i += 4;
    return v;
  };
}

export interface BootstrapInterval {
  readonly point: number | null;
  readonly lower: number;
  readonly upper: number;
  readonly resamples: number;
  readonly clusterKind: 'MINT' | 'UTC_DAY';
}

/**
 * Cluster bootstrap over whole mints or whole UTC days.
 *
 * Resamples CLUSTERS with replacement, not rows. Resampling rows would treat
 * the six rows a single mint produces as six independent draws and would
 * report an interval far too narrow — the error that makes a noise result look
 * decisive.
 */
export function clusterBootstrap(
  outcomes: readonly MintOutcome[],
  clusterKind: 'MINT' | 'UTC_DAY',
  resamples = 2_000,
  alpha = 0.05,
): BootstrapInterval {
  const key = (o: MintOutcome): string => (clusterKind === 'MINT' ? o.mint : o.utcDay);
  const clusters = new Map<string, MintOutcome[]>();
  for (const o of outcomes) {
    const list = clusters.get(key(o));
    if (list === undefined) clusters.set(key(o), [o]);
    else list.push(o);
  }
  const ids = [...clusters.keys()].sort();
  if (ids.length === 0) return { point: null, lower: 0, upper: 0, resamples: 0, clusterKind };

  const rng = seededRng(`${clusterKind}|${ids.join(',')}|${outcomes.length}`);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const drawn: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      const pick = ids[Math.floor(rng() * ids.length)] as string;
      for (const o of clusters.get(pick) ?? []) drawn.push(o.logReturn);
    }
    const m = mean(drawn);
    if (m !== null) means.push(m);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(means.length * (alpha / 2))] ?? 0;
  const hi = means[Math.min(means.length - 1, Math.floor(means.length * (1 - alpha / 2)))] ?? 0;
  return {
    point: mean(outcomes.map((o) => o.logReturn)),
    lower: lo,
    upper: hi,
    resamples: means.length,
    clusterKind,
  };
}

export interface Fragility {
  readonly full: number | null;
  readonly withoutTop1: number | null;
  readonly withoutTop3: number | null;
  readonly withoutTop5: number | null;
  readonly withoutTop10: number | null;
  readonly withoutBestDay: number | null;
  readonly withoutBestFiveMints: number | null;
  /** True when every one of the above is positive. */
  readonly survivesAll: boolean;
}

/**
 * Fragility, computed on MINT-LEVEL outcomes.
 *
 * "Remove the top 3" must remove the three best MINTS, not the three best rows.
 * With two clocks and three policies per token, the three best rows are
 * routinely the same token three times, so a row-level removal deletes one
 * mint and reports that the result survived losing three.
 */
export function fragility(outcomes: readonly MintOutcome[]): Fragility {
  const byMint = new Map<string, number>();
  for (const o of outcomes) byMint.set(o.mint, (byMint.get(o.mint) ?? 0) + o.logReturn);
  const mints = [...byMint.entries()].sort((a, b) => b[1] - a[1]);

  const meanWithout = (drop: ReadonlySet<string>): number | null => {
    const kept = outcomes.filter((o) => !drop.has(o.mint));
    return mean(kept.map((o) => o.logReturn));
  };
  const topMints = (n: number): Set<string> => new Set(mints.slice(0, n).map(([m]) => m));

  const byDay = new Map<string, number>();
  for (const o of outcomes) byDay.set(o.utcDay, (byDay.get(o.utcDay) ?? 0) + o.logReturn);
  const bestDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const withoutBestDay =
    bestDay === null ? null : mean(outcomes.filter((o) => o.utcDay !== bestDay).map((o) => o.logReturn));

  const f: Omit<Fragility, 'survivesAll'> = {
    full: mean(outcomes.map((o) => o.logReturn)),
    withoutTop1: meanWithout(topMints(1)),
    withoutTop3: meanWithout(topMints(3)),
    withoutTop5: meanWithout(topMints(5)),
    withoutTop10: meanWithout(topMints(10)),
    withoutBestDay,
    withoutBestFiveMints: meanWithout(topMints(5)),
  };
  const values = Object.values(f);
  return { ...f, survivesAll: values.every((v) => v !== null && v > 0) };
}

/**
 * Paired mint-level deltas between two policies.
 *
 * Paired, because both policies saw the SAME tokens: an unpaired comparison is
 * dominated by which tokens each arm drew, and that variance is far larger than
 * any plausible difference between the policies. A mint on which only one
 * policy has an outcome contributes NOTHING — including it as if the other
 * scored zero would silently reward the policy that traded less.
 */
export function pairedDeltas(
  a: readonly MintOutcome[],
  b: readonly MintOutcome[],
): { deltas: readonly number[]; pairedMints: number; unpairedA: number; unpairedB: number } {
  const byMintA = new Map<string, number>();
  for (const o of a) byMintA.set(o.mint, (byMintA.get(o.mint) ?? 0) + o.logReturn);
  const byMintB = new Map<string, number>();
  for (const o of b) byMintB.set(o.mint, (byMintB.get(o.mint) ?? 0) + o.logReturn);

  const deltas: number[] = [];
  for (const [mint, ra] of byMintA) {
    const rb = byMintB.get(mint);
    if (rb === undefined) continue;
    deltas.push(ra - rb);
  }
  return {
    deltas,
    pairedMints: deltas.length,
    unpairedA: [...byMintA.keys()].filter((m) => !byMintB.has(m)).length,
    unpairedB: [...byMintB.keys()].filter((m) => !byMintA.has(m)).length,
  };
}

// ---------------------------------------------------------------------------
// The same interval, from sufficient statistics
// ---------------------------------------------------------------------------

/**
 * One cluster's sufficient statistics for a MEAN: how many observations it
 * contributed and what they summed to.
 */
export interface ClusterAggregate {
  /** The cluster key. For a day-clustered bootstrap, the UTC day. */
  readonly cluster: string;
  readonly n: number;
  readonly sum: number;
}

/**
 * A day-clustered bootstrap of a mean, computed from per-day (n, sum) instead of
 * from the rows.
 *
 * WHY THIS IS NOT AN APPROXIMATION
 *
 * `clusterBootstrap` resamples whole clusters and takes the unweighted mean of
 * every row drawn, so the statistic on a resample is
 *
 *     SUM over drawn clusters of (cluster sum) / SUM over drawn clusters of (cluster n)
 *
 * which depends on the rows ONLY through each cluster's n and sum. Replacing a
 * cluster's rows by n copies of its own mean leaves both unchanged, so the two
 * functions compute the same number on the same draws. The unit test asserts
 * exactly that against an expanded sample rather than asserting it approximately.
 *
 * WHY IT IS NEEDED AT ALL
 *
 * The wallet-persistence holdout is 11.85M positions over 30 days. Dune bills on
 * datapoints returned, and exporting one row per position to get an interval that
 * needs only 60 (n, sum) pairs would cost more than the monthly allowance — and
 * then 2,000 resamples x 11.85M pushes would not finish. This is O(resamples x
 * days).
 *
 * WHAT IT CANNOT DO: a median, a percentile, or a fragility drop. Those are not
 * functions of (n, sum) and they need the rows.
 */
export function clusterBootstrapAggregated(
  aggregates: readonly ClusterAggregate[],
  resamples = 2_000,
  alpha = 0.05,
): BootstrapInterval {
  const byCluster = new Map<string, { n: number; sum: number }>();
  for (const a of aggregates) {
    const at = byCluster.get(a.cluster);
    if (at === undefined) byCluster.set(a.cluster, { n: a.n, sum: a.sum });
    else {
      at.n += a.n;
      at.sum += a.sum;
    }
  }
  const ids = [...byCluster.keys()].sort();
  const totalN = ids.reduce((acc, id) => acc + (byCluster.get(id) as { n: number }).n, 0);
  if (ids.length === 0 || totalN === 0) {
    return { point: null, lower: 0, upper: 0, resamples: 0, clusterKind: 'UTC_DAY' };
  }

  // The identical seed string clusterBootstrap would build for the expanded
  // sample, so the two draw the same clusters in the same order.
  const rng = seededRng(`UTC_DAY|${ids.join(',')}|${totalN}`);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let n = 0;
    let sum = 0;
    for (let i = 0; i < ids.length; i++) {
      const pick = byCluster.get(ids[Math.floor(rng() * ids.length)] as string) as { n: number; sum: number };
      n += pick.n;
      sum += pick.sum;
    }
    if (n > 0) means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const totalSum = ids.reduce((acc, id) => acc + (byCluster.get(id) as { sum: number }).sum, 0);
  return {
    point: totalSum / totalN,
    lower: means[Math.floor(means.length * (alpha / 2))] ?? 0,
    upper: means[Math.min(means.length - 1, Math.floor(means.length * (1 - alpha / 2)))] ?? 0,
    resamples: means.length,
    clusterKind: 'UTC_DAY',
  };
}

/**
 * The day-clustered interval for the DIFFERENCE between two cohorts' means.
 *
 * The two cohorts are resampled on the SAME drawn days. A market-wide day moves
 * both cohorts together, and an interval built from two independently resampled
 * bootstraps would attribute that shared movement to each side separately and
 * come out far too wide — which for a difference test means failing to reject
 * for a reason that is an artifact of the procedure. This is the paired form:
 * draw a day, take both cohorts' statistics from it.
 *
 * `a` and `b` need not cover the same days. A day present in one and absent from
 * the other contributes to whichever side has it, which is the honest treatment
 * when a cohort simply did not trade that day; `daysBothPresent` is returned so a
 * caller can see how much of the sample is actually paired.
 */
export function clusterBootstrapDifference(
  a: readonly ClusterAggregate[],
  b: readonly ClusterAggregate[],
  resamples = 2_000,
  alpha = 0.05,
): BootstrapInterval & { readonly daysBothPresent: number } {
  const fold = (xs: readonly ClusterAggregate[]): Map<string, { n: number; sum: number }> => {
    const m = new Map<string, { n: number; sum: number }>();
    for (const x of xs) {
      const at = m.get(x.cluster);
      if (at === undefined) m.set(x.cluster, { n: x.n, sum: x.sum });
      else {
        at.n += x.n;
        at.sum += x.sum;
      }
    }
    return m;
  };
  const A = fold(a);
  const B = fold(b);
  const ids = [...new Set([...A.keys(), ...B.keys()])].sort();
  const both = ids.filter((id) => A.has(id) && B.has(id)).length;
  const pooled = (m: Map<string, { n: number; sum: number }>): { n: number; sum: number } => {
    let n = 0;
    let sum = 0;
    for (const v of m.values()) {
      n += v.n;
      sum += v.sum;
    }
    return { n, sum };
  };
  const pa = pooled(A);
  const pb = pooled(B);
  if (ids.length === 0 || pa.n === 0 || pb.n === 0) {
    return { point: null, lower: 0, upper: 0, resamples: 0, clusterKind: 'UTC_DAY', daysBothPresent: both };
  }

  const rng = seededRng(`UTC_DAY|DIFF|${ids.join(',')}|${pa.n}|${pb.n}`);
  const diffs: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let an = 0;
    let asum = 0;
    let bn = 0;
    let bsum = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[Math.floor(rng() * ids.length)] as string;
      const av = A.get(id);
      const bv = B.get(id);
      if (av !== undefined) {
        an += av.n;
        asum += av.sum;
      }
      if (bv !== undefined) {
        bn += bv.n;
        bsum += bv.sum;
      }
    }
    if (an > 0 && bn > 0) diffs.push(asum / an - bsum / bn);
  }
  diffs.sort((x, y) => x - y);
  return {
    point: pa.sum / pa.n - pb.sum / pb.n,
    lower: diffs[Math.floor(diffs.length * (alpha / 2))] ?? 0,
    upper: diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * (1 - alpha / 2)))] ?? 0,
    resamples: diffs.length,
    clusterKind: 'UTC_DAY',
    daysBothPresent: both,
  };
}
