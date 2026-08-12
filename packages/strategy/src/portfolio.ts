import type { AppConfig } from '../../domain/src/config.js';
import { maxBigint, minBigint } from '../../domain/src/amounts.js';

/**
 * Position sizing and portfolio caps.
 *
 * Sizing is derived from the loss we are willing to plan for, not from the
 * gain we hope for. The stop distance is known before entry, so the notional
 * that puts exactly `riskBudgetPctPerTrade` of NAV at risk is arithmetic, not
 * judgement. Every cap below is a hard refusal, never a soft preference.
 */

export interface PortfolioState {
  readonly navLamports: bigint;
  readonly freeLamports: bigint;
  readonly openPositions: number;
  readonly totalExposureLamports: bigint;
  readonly realizedTodayLamports: bigint;
  /** Realised P&L over the trailing 7 UTC days, for `weeklyLossHaltPct`. */
  readonly realizedWeekLamports: bigint;
  /**
   * Sum of PLANNED loss across open positions — each position's notional times
   * its stop distance. Bounds what the book can lose if every stop fills at its
   * level, which `maxAggregatePlannedLossPct` caps.
   */
  readonly plannedLossLamports: bigint;
  /**
   * Highest NAV this experiment has ever reached. Compared against
   * `navLamports` to enforce `drawdownHaltPct`. Peak rather than starting NAV,
   * so a strategy that earns and then gives it all back is halted on the give-
   * back rather than being credited for having started low.
   */
  readonly peakNavLamports: bigint;
}

export type SizingRefusal =
  | 'position_slots_full'
  | 'exposure_cap'
  | 'reserve_floor'
  | 'daily_loss_cap'
  | 'drawdown_halt'
  | 'daily_loss_halt'
  | 'weekly_loss_halt'
  | 'aggregate_planned_loss'
  | 'size_below_viable'
  | 'score_below_threshold';

export interface SizingDecision {
  readonly allowed: boolean;
  readonly lamports: bigint;
  readonly refusal: SizingRefusal | null;
  readonly detail: string;
}

function refuse(refusal: SizingRefusal, detail: string): SizingDecision {
  return { allowed: false, lamports: 0n, refusal, detail };
}

/**
 * Non-recoverable cost of one complete round trip.
 *
 * ATA rent is deliberately NOT counted in full. Rent is returned when the token
 * account is closed, so on a successful exit it is a temporary lockup rather
 * than a cost. It is only truly lost when the position cannot be sold at all,
 * because a token account holding a nonzero balance cannot be closed. Charging
 * the whole rent as a fee overstated the floor by roughly an order of magnitude
 * and made every otherwise-valid trade look unviable.
 */
export function roundTripCostLamports(config: AppConfig): bigint {
  const perTx = config.assumedSignatureFeeLamports + config.assumedPriorityFeeLamports;
  const rentAtRisk =
    (config.assumedAtaRentLamports * BigInt(Math.round((1 - config.assumedRentRecoveryRate) * 10_000))) / 10_000n;
  return perTx * 2n + rentAtRisk;
}

/** Smallest notional on which round-trip cost stays within `maxFeeFractionBps`. */
export function viableFloorLamports(config: AppConfig): bigint {
  return (roundTripCostLamports(config) * 10_000n) / BigInt(config.maxFeeFractionBps);
}

export function sizePosition(
  state: PortfolioState,
  config: AppConfig,
  opportunityScore: number,
): SizingDecision {
  const risk = config.risk;

  if (state.openPositions >= risk.maxSimultaneousPositions) {
    return refuse('position_slots_full', `${state.openPositions}/${risk.maxSimultaneousPositions} slots used`);
  }

  // The daily loss cap halts new risk for the rest of the day. It is checked
  // before sizing so that a bad day cannot be "traded back".
  if (-state.realizedTodayLamports >= risk.dailyLossCapLamports && risk.dailyLossCapLamports > 0n) {
    return refuse('daily_loss_cap', `realized ${state.realizedTodayLamports} today`);
  }

  // The percentage halts. All three were declared in RiskConfigSchema and
  // listed in SAFER_WHEN_LOWER — the tree would refuse to loosen them — while
  // no code read the values (O040). An operator reading config/live.json would
  // reasonably have believed a 1.5% daily and 4% weekly halt were active. They
  // were not. These are the enforcement branches; each has a test.
  //
  // Expressed against NAV rather than a fixed lamport amount, so they scale
  // with the book instead of silently tightening as it grows.
  const pctOfNav = (pct: number): bigint => (state.navLamports * BigInt(Math.round(pct * 100))) / 10_000n;

  if (risk.dailyLossHaltPct > 0 && -state.realizedTodayLamports >= pctOfNav(risk.dailyLossHaltPct)) {
    return refuse(
      'daily_loss_halt',
      `realised ${state.realizedTodayLamports} today >= ${risk.dailyLossHaltPct}% of nav`,
    );
  }

  if (risk.weeklyLossHaltPct > 0 && -state.realizedWeekLamports >= pctOfNav(risk.weeklyLossHaltPct)) {
    return refuse(
      'weekly_loss_halt',
      `realised ${state.realizedWeekLamports} over 7d >= ${risk.weeklyLossHaltPct}% of nav`,
    );
  }

  if (risk.maxAggregatePlannedLossPct > 0 && state.plannedLossLamports >= pctOfNav(risk.maxAggregatePlannedLossPct)) {
    return refuse(
      'aggregate_planned_loss',
      `planned loss ${state.plannedLossLamports} >= ${risk.maxAggregatePlannedLossPct}% of nav`,
    );
  }

  // NAV drawdown from peak.
  //
  // `drawdownHaltPct` was the first of the four O040 halts to be implemented,
  // because it is also a preregistered P8 readiness gate and the backstop that
  // lets the daily cap be sized for measurement rather than capital
  // preservation. The other three are enforced directly above.
  if (risk.drawdownHaltPct > 0 && state.peakNavLamports > 0n) {
    const drawdown = state.peakNavLamports - state.navLamports;
    const limit = (state.peakNavLamports * BigInt(Math.round(risk.drawdownHaltPct * 100))) / 10_000n;
    if (drawdown >= limit) {
      return refuse(
        'drawdown_halt',
        `nav ${state.navLamports} is ${drawdown} below peak ${state.peakNavLamports}; limit ${limit}`,
      );
    }
  }

  if (opportunityScore < config.minOpportunityScore) {
    return refuse('score_below_threshold', `${opportunityScore} < ${config.minOpportunityScore}`);
  }

  // Risk-budget sizing: notional such that a full stop-loss move costs exactly
  // the per-trade risk budget.
  const budget = (state.navLamports * BigInt(Math.round(risk.riskBudgetPctPerTrade * 100))) / 10_000n;
  const stopFraction = BigInt(config.exits.stopLossBps);
  const riskSized = stopFraction === 0n ? budget : (budget * 10_000n) / stopFraction;

  const notionalCap = (state.navLamports * BigInt(Math.round(risk.maxNotionalPctPerPosition * 100))) / 10_000n;

  // Score scales size within the allowed band rather than beyond it: a strong
  // signal may use the full cap, a marginal one may not.
  const scaled = (riskSized * BigInt(Math.round(Math.max(0, Math.min(1, opportunityScore)) * 1000))) / 1000n;

  let size = minBigint(minBigint(scaled, notionalCap), risk.maxEntryLamports);

  const exposureHeadroom = risk.maxTotalExposureLamports - state.totalExposureLamports;
  if (exposureHeadroom <= 0n) {
    return refuse('exposure_cap', `exposure ${state.totalExposureLamports} at cap`);
  }
  size = minBigint(size, exposureHeadroom);

  // The SOL reserve is untouchable: it pays for the fees of exiting everything
  // already held. Spending it to open one more position is how a portfolio
  // becomes unsellable.
  const spendable = maxBigint(0n, state.freeLamports - risk.minSolReserveLamports);
  if (spendable <= 0n) {
    return refuse('reserve_floor', `free ${state.freeLamports} at or below reserve ${risk.minSolReserveLamports}`);
  }
  size = minBigint(size, spendable);

  // Below this, fixed costs dominate and the trade cannot clear its own overhead
  // regardless of how right the thesis is.
  const viableFloor = viableFloorLamports(config);
  if (size < viableFloor) {
    return refuse('size_below_viable', `size ${size} < viable floor ${viableFloor}`);
  }

  return { allowed: true, lamports: size, refusal: null, detail: '' };
}
