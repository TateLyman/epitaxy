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

export const STRATEGY_VERSION = 'delayed-momentum-v0.1.0';

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

  // Breadth: distinct participants matter more than raw transaction count,
  // because transaction count is the cheapest thing on chain to fake.
  const netBuyers = s5?.numNetBuyers ?? 0;
  const traders = s5?.numTraders ?? 0;
  const breadth = 0.6 * normalize(netBuyers, 0, 60) + 0.4 * normalize(traders, 0, 150);

  // Liquidity: log-ish shape. Past ~$150k the marginal safety gain is small.
  const liq = info.liquidity ?? 0;
  const liquidity = normalize(Math.log10(Math.max(liq, 1)), Math.log10(5_000), Math.log10(150_000));

  const organic = normalize(info.organicScore ?? 0, 0, 80);

  // Tradability: the actual measured cost of getting in and back out.
  const rtLoss = roundTrip?.roundTripLossBps ?? null;
  const tradability = rtLoss === null ? 0 : 1 - normalize(rtLoss, 100, 600);

  // Freshness: peaks in the middle of the eligible window. Too young is
  // unverifiable, too old means the move has already been distributed.
  const ageMin = tokenAgeMs === null ? 0 : tokenAgeMs / 60_000;
  const freshness = ageMin <= 0 ? 0 : ageMin <= 10 ? normalize(ageMin, 2, 10) : 1 - normalize(ageMin, 10, 60);

  const components: Record<string, number> = {
    breadth: round4(breadth),
    liquidity: round4(liquidity),
    organic: round4(organic),
    tradability: round4(tradability),
    freshness: round4(freshness),
  };

  const raw =
    WEIGHTS.breadth * breadth +
    WEIGHTS.liquidity * liquidity +
    WEIGHTS.organic * organic +
    WEIGHTS.tradability * tradability +
    WEIGHTS.freshness * freshness;

  const riskAdjusted = raw * (1 - Math.max(0, Math.min(1, softRiskScore)));
  components['raw'] = round4(raw);
  components['softRisk'] = round4(softRiskScore);

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
