import type { GateResult, RoundTrip } from '../../domain/src/types.js';
import type { MintInformation } from '../../adapters/src/jupiter/schemas.js';
import { normalize } from '../../intelligence/src/gates.js';

/**
 * Opportunity score, v0.1.0 — "delayed momentum".
 *
 * Thesis: we deliberately concede the first-block race. The edge sought is a
 * token that has already survived its first minutes, is still cheap to trade
 * round-trip, and shows breadth of participation rather than one wallet
 * recycling volume.
 *
 * The score is a weighted sum of bounded components, then multiplied by
 * (1 - softRisk). It is intentionally simple and fully deterministic: every
 * component must be attributable in `scoreComponents` so observe mode can
 * later measure which component actually predicted anything.
 */

/**
 * The strategy version.
 *
 * This constant said v0.2.0 while every config file said v0.3.0, so anything
 * comparing the two -- a replay filter, a regime key, a report header -- was
 * comparing a value against a different value that meant the same thing.
 *
 * v0.4.0 is a real semantic bump, not a tidy-up. Between v0.3.0 and here the
 * ENTRY path changed in four ways that alter which tokens are eligible:
 *   - price impact is read from the signed adverse magnitude, not Math.abs;
 *   - a missing provider timestamp is unknown rather than perfectly fresh;
 *   - an unresolved or unverified holder counts as wallet concentration;
 *   - sizing assumes catastrophic rather than stop-bounded loss.
 * Rows written under v0.3.0 are not comparable and replay must not pool them.
 */
/**
 * v0.6.0.
 *
 * v0.5.0 was a HARD PROVENANCE DEFECT: the code computed v0.5 semantics while
 * every config file still stamped rows `delayed-momentum-v0.4.0`. So every row
 * written since that change claims to have been produced by a scorer that no
 * longer existed, and no reader could tell which semantics a row used.
 *
 * A version is only a version when the rows carry it. This bump lands in the
 * code AND in all four config files in the same commit, and there is a test
 * that fails if they diverge again.
 */
export const STRATEGY_VERSION = 'delayed-momentum-v0.6.0';

/** Below this fraction of total weight, the score is refused. Frozen. */
export const MIN_SCORE_COVERAGE = 0.5;

export interface ScoreResult {
  readonly score: number;
  readonly components: Record<string, number>;
}

const WEIGHTS = {
  breadth: 0.30,
  liquidity: 0.20,
  organic: 0.20,
  tradability: 0.20,
  freshness: 0.10,
} as const;

export function opportunityScore(
  info: MintInformation,
  roundTrip: RoundTrip | null,
  softRiskScore: number,
  tokenAgeMs: number | null,
): ScoreResult {
  const s5 = info.stats5m;

  /**
   * P17 -- an absent field is UNKNOWN, and unknown is not zero.
   *
   * `?? 0` made a provider that did not answer indistinguishable from a token
   * with no buyers, no liquidity and no organic activity. Those are opposite
   * facts: one is a gap in our coverage, the other is a statement about the
   * token, and only the second is evidence.
   *
   * Reading them as zero is not conservative either. It is conservative in the
   * SCORE and permissive everywhere the absence should have blocked something,
   * and it is systematically worse for the tokens with the thinnest data --
   * which are the new ones this strategy exists to trade.
   */
  const unknown: string[] = [];
  const known = (v: number | null | undefined, name: string): number | null => {
    if (v === null || v === undefined || !Number.isFinite(v)) {
      unknown.push(name);
      return null;
    }
    return v;
  };

  // Breadth: distinct participants matter more than raw transaction count,
  // because transaction count is the cheapest thing on chain to fake.
  //
  // Net buyers are NOT backfilled from gross buys. A gross buy count with the
  // sells removed is a different quantity, and substituting one for the other
  // makes wash trading look like breadth.
  const netBuyers = known(s5?.numNetBuyers, 'numNetBuyers');
  const traders = known(s5?.numTraders, 'numTraders');
  /**
   * P18 — renormalised WITHIN the component.
   *
   * This was `0.6 * f(netBuyers ?? 0) + 0.4 * f(traders ?? 0)`. With one
   * subfeature missing the other was multiplied by 0.6 or 0.4 — and then the
   * whole component still received its full 0.30 weight. A token with strong
   * trader breadth and no net-buyer figure scored 40% of what the same token
   * scored with both, for a gap in our coverage rather than a fact about it.
   */
  const breadthTerms: readonly (readonly [number, number | null])[] = [
    [0.6, netBuyers === null ? null : normalize(netBuyers, 0, 60)],
    [0.4, traders === null ? null : normalize(traders, 0, 150)],
  ];
  let breadthWeighted = 0;
  let breadthWeight = 0;
  for (const [w, v] of breadthTerms) {
    if (v === null) continue;
    breadthWeighted += w * v;
    breadthWeight += w;
  }
  const breadth = breadthWeight === 0 ? null : breadthWeighted / breadthWeight;

  // Liquidity: log-ish shape. Past ~$150k the marginal safety gain is small.
  const liq = known(info.liquidity, 'liquidity');
  const liquidity = liq === null ? null : normalize(Math.log10(Math.max(liq, 1)), Math.log10(5_000), Math.log10(150_000));

  // The provider's own score. Absent means the provider did not answer -- it is
  // 0 for EVERY token under about an hour old, measured n=461 with no
  // exceptions -- and it is graded ONCE, by the `organic_score_unavailable`
  // soft-risk gate at 0.25.
  //
  // It used to be charged twice: that soft risk AND a zero score component at
  // full weight. The component now drops out entirely, so the gap is priced in
  // one place. Two penalties for one absence is not caution, it is an error
  // that compounds against exactly the young tokens this strategy trades.
  const organicRaw = known(info.organicScore, 'organicScore');
  /**
   * P18 — a provider zero here is NOT COMPUTED, and the gate already says so.
   *
   * The `organic_score_unavailable` soft-risk gate treats 0 as "not computed"
   * — it is 0 for every token under about an hour old, n=461 with no
   * exceptions. The score treated the same 0 as an OBSERVED zero and charged
   * it at full weight. One absence, two penalties, landing hardest on exactly
   * the young tokens this strategy trades.
   *
   * Null here means the component drops out and the gap is priced once.
   */
  const organic = organicRaw === null || organicRaw === 0 ? null : normalize(organicRaw, 0, 80);
  if (organicRaw === 0 && !unknown.includes('organicScore')) unknown.push('organicScore');

  // Tradability: the actual measured cost of getting in and back out.
  const rtLoss = roundTrip?.roundTripLossBps ?? null;
  // P18 — unknown tradability is NULL. A zero here is the maximum penalty and
  // it was being applied for not having measured, which is our gap.
  const tradability = rtLoss === null ? null : 1 - normalize(rtLoss, 100, 600);
  if (rtLoss === null) unknown.push('roundTripLossBps');

  // Freshness: peaks in the middle of the eligible window. Too young is
  // unverifiable, too old means the move has already been distributed.
  // P18 — an unknown age is NULL. Scoring it zero says "too young to verify",
  // which is a claim about the token made from an absence in our data.
  const ageMin = tokenAgeMs === null ? null : tokenAgeMs / 60_000;
  const freshness =
    ageMin === null ? null : ageMin <= 0 ? 0 : ageMin <= 10 ? normalize(ageMin, 2, 10) : 1 - normalize(ageMin, 10, 60);
  if (ageMin === null) unknown.push('tokenAgeMs');

  const components: Record<string, number> = {
    breadth: round4(breadth ?? 0),
    liquidity: round4(liquidity ?? 0),
    organic: round4(organic ?? 0),
    tradability: round4(tradability ?? 0),
    freshness: round4(freshness ?? 0),
  };

  /**
   * Renormalised over the components that were actually observed.
   *
   * A missing component contributes neither score nor weight. Scoring it as
   * zero against its full weight is a penalty for our own coverage gap, and it
   * lands hardest on the youngest tokens -- exactly the ones the strategy is
   * about.
   *
   * `observedWeight` is reported so a reader can see how much of the score is
   * actually supported. A score assembled from two of five components is not
   * the same number as one assembled from five, and it must not look like it.
   */
  const terms: readonly (readonly [number, number | null])[] = [
    [WEIGHTS.breadth, breadth],
    [WEIGHTS.liquidity, liquidity],
    [WEIGHTS.organic, organic],
    [WEIGHTS.tradability, tradability],
    [WEIGHTS.freshness, freshness],
  ];
  let weighted = 0;
  let observedWeight = 0;
  for (const [w, v] of terms) {
    if (v === null) continue;
    weighted += w * v;
    observedWeight += w;
  }
  const raw = observedWeight === 0 ? 0 : weighted / observedWeight;

  /**
   * P18 — a score assembled from too little is not a score.
   *
   * Renormalising keeps the SCALE honest but not the CONFIDENCE: two of five
   * components renormalise to a number between 0 and 1 that looks exactly like
   * one built from all five. Below half the total weight the number is
   * refused rather than reported, because a ranking built on it is a ranking
   * of which tokens happened to have data.
   */
  const totalWeight = terms.reduce((acc, [w]) => acc + w, 0);
  const coverage = totalWeight === 0 ? 0 : observedWeight / totalWeight;
  const insufficientCoverage = coverage < MIN_SCORE_COVERAGE;

  /**
   * Coverage is REPORTED, not folded into the number.
   *
   * Zeroing the score here would make a token we barely measured
   * indistinguishable from one measured thoroughly and found worthless. Those
   * are opposite facts. `insufficientCoverage` is the flag eligibility reads;
   * the score stays on its own scale so a ranking of the well-measured tokens
   * is still a ranking.
   */
  const riskAdjusted = raw * (1 - Math.max(0, Math.min(1, softRiskScore)));
  components['raw'] = round4(raw);
  components['softRisk'] = round4(softRiskScore);
  components['observedWeight'] = round4(observedWeight);
  components['unknownComponents'] = unknown.length;
  components['coverage'] = round4(coverage);
  components['insufficientCoverage'] = insufficientCoverage ? 1 : 0;

  return { score: round4(riskAdjusted), components };
}

/**
 * Features frozen into the decision snapshot. Replay reads only these, so any
 * value used by a gate or the score must appear here.
 */
export function extractFeatures(
  info: MintInformation,
  roundTrip: RoundTrip | null,
  tokenAgeMs: number | null,
): Record<string, number | null> {
  const s5 = info.stats5m;
  const s1h = info.stats1h;
  return {
    tokenAgeMs,
    liquidityUsd: info.liquidity ?? null,
    holderCount: info.holderCount ?? null,
    organicScore: info.organicScore ?? null,
    mcap: info.mcap ?? null,
    fdv: info.fdv ?? null,
    usdPrice: info.usdPrice ?? null,
    topHoldersPct: info.audit?.topHoldersPercentage ?? null,
    devBalancePct: info.audit?.devBalancePercentage ?? null,
    numBuys5m: s5?.numBuys ?? null,
    numSells5m: s5?.numSells ?? null,
    numTraders5m: s5?.numTraders ?? null,
    numNetBuyers5m: s5?.numNetBuyers ?? null,
    buyVolume5m: s5?.buyVolume ?? null,
    sellVolume5m: s5?.sellVolume ?? null,
    priceChange5m: s5?.priceChange ?? null,
    priceChange1h: s1h?.priceChange ?? null,
    liquidityChange5m: s5?.liquidityChange ?? null,
    holderChange5m: s5?.holderChange ?? null,
    roundTripLossBps: roundTrip?.roundTripLossBps ?? null,
    priceImpactBuyBps: roundTrip ? Math.round(roundTrip.buy.priceImpactPct * 10_000) : null,
    buyFeeBps: roundTrip?.buy.platformFeeBps ?? null,
    exitExists: roundTrip ? (roundTrip.exitExists ? 1 : 0) : null,
  };
}

export function primaryReason(gates: readonly GateResult[]): string {
  const failed = gates.find((g) => g.severity === 'hard_veto' && !g.passed);
  if (failed) return failed.reason;
  const worst = [...gates]
    .filter((g) => g.severity === 'soft_risk')
    .sort((a, b) => b.riskContribution - a.riskContribution)[0];
  return worst && worst.riskContribution > 0 ? `soft:${worst.reason}` : 'none';
}

function round4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : 0;
}
