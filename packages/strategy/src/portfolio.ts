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
  /**
   * Severe-loss quantile measured from VALID completed observations, in bps of
   * notional. Null until enough exist, which is the current state -- and null
   * means the catastrophic floor governs, not that risk is zero.
   */
  readonly observedSevereLossBps: number | null;
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

  // NOTE: the aggregate planned-loss check moved BELOW sizing, because it must
  // include the trade being proposed. Checking only the existing book lets the
  // cap be crossed by exactly one position every time -- see §6.2.

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

  // Risk-budget sizing.
  //
  // The old version divided the budget by the STOP DISTANCE alone, which says a
  // 25% stop puts 25% of the notional at risk. For this population that is not
  // true and the corpus already says so: all eight measured collapses fell from
  // above the 10% floor to near zero inside a single mark interval, faster than
  // any stop could be acted on. A stop is an instruction to the market, not a
  // promise from it.
  //
  // Planned loss is therefore the WORST of three views (§6.1):
  //   - the nominal stop distance;
  //   - the empirically observed severe-loss quantile, when one exists;
  //   - a configured catastrophic-loss floor.
  // With no valid observations yet, the floor is 100% of principal, so sizing
  // is currently driven by "assume it can all go" rather than by the stop.
  const budget = (state.navLamports * BigInt(Math.round(risk.riskBudgetPctPerTrade * 100))) / 10_000n;
  const plannedLossBps = plannedLossFractionBps(config, state.observedSevereLossBps);
  const riskSized = plannedLossBps === 0 ? budget : (budget * 10_000n) / BigInt(plannedLossBps);

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

  // §6.2 — the aggregate planned-loss cap must include the trade being
  // proposed. Evaluated against the existing book only, the cap was crossable
  // by exactly one position on every single entry: the book was always
  // compliant right up to the moment the new position made it not.
  if (risk.maxAggregatePlannedLossPct > 0) {
    const proposed = (size * BigInt(plannedLossBps)) / 10_000n;
    const total = state.plannedLossLamports + proposed;
    const cap = pctOfNav(risk.maxAggregatePlannedLossPct);
    if (total >= cap) {
      return refuse(
        'aggregate_planned_loss',
        `existing ${state.plannedLossLamports} + proposed ${proposed} = ${total} >= ${risk.maxAggregatePlannedLossPct}% of nav (${cap})`,
      );
    }
  }

  return { allowed: true, lamports: size, refusal: null, detail: '' };
}

/**
 * Fraction of notional treated as at risk, in basis points.
 *
 * The maximum of the nominal stop, any measured severe-loss quantile, and the
 * configured catastrophic floor. Exported because the aggregate cap, the
 * per-trade sizing and the report must all use the same number -- three call
 * sites deriving it separately is how the first version ended up with two
 * different collapse definitions.
 */
export function plannedLossFractionBps(config: AppConfig, observedSevereLossBps: number | null): number {
  const nominal = config.exits.stopLossBps;
  const floor = Math.round(config.catastrophicLossFloorPct * 100);
  const observed = observedSevereLossBps ?? 0;
  return Math.max(nominal, observed, floor);
}
