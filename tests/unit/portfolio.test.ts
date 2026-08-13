import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AppConfigSchema } from '../../packages/domain/src/config.js';
import type { AppConfig } from '../../packages/domain/src/config.js';
import {
  sizePosition,
  roundTripCostLamports,
  viableFloorLamports,
} from '../../packages/strategy/src/portfolio.js';
import type { PortfolioState } from '../../packages/strategy/src/portfolio.js';

const base: AppConfig = AppConfigSchema.parse(JSON.parse(readFileSync('config/paper.json', 'utf8')));

function state(over: Partial<PortfolioState> = {}): PortfolioState {
  const merged = {
    navLamports: base.paperStartLamports,
    freeLamports: base.paperStartLamports,
    openPositions: 0,
    totalExposureLamports: 0n,
    realizedTodayLamports: 0n,
    realizedWeekLamports: 0n,
    plannedLossLamports: 0n,
    observedSevereLossBps: null,
    ...over,
  };
  // Peak defaults to the current NAV, so a test that lowers `navLamports` to
  // describe a SMALL portfolio does not accidentally describe a portfolio in
  // deep drawdown and trip `drawdown_halt` before the rule it meant to test.
  // A test about drawdown passes `peakNavLamports` explicitly.
  return { peakNavLamports: merged.navLamports, ...merged, ...over };
}

function withConfig(over: Partial<AppConfig>): AppConfig {
  return { ...base, ...over };
}

describe('round-trip cost model', () => {
  it('charges two signatures and two priority fees', () => {
    const noRent = withConfig({ assumedAtaRentLamports: 0n });
    expect(roundTripCostLamports(noRent)).toBe(
      (base.assumedSignatureFeeLamports + base.assumedPriorityFeeLamports) * 2n,
    );
  });

  it('treats fully recoverable rent as not a cost', () => {
    const a = roundTripCostLamports(withConfig({ assumedRentRecoveryRate: 1 }));
    const b = roundTripCostLamports(withConfig({ assumedAtaRentLamports: 0n, assumedRentRecoveryRate: 1 }));
    expect(a).toBe(b);
  });

  it('charges the whole rent when none of it comes back', () => {
    const stuck = roundTripCostLamports(withConfig({ assumedRentRecoveryRate: 0 }));
    const free = roundTripCostLamports(withConfig({ assumedRentRecoveryRate: 1 }));
    expect(stuck - free).toBe(base.assumedAtaRentLamports);
  });

  it('scales the floor inversely with the tolerated fee fraction', () => {
    const strict = viableFloorLamports(withConfig({ maxFeeFractionBps: 100 }));
    const loose = viableFloorLamports(withConfig({ maxFeeFractionBps: 1000 }));
    expect(strict).toBe(loose * 10n);
  });
});

describe('sizePosition caps', () => {
  it('refuses when every position slot is taken', () => {
    const d = sizePosition(state({ openPositions: base.risk.maxSimultaneousPositions }), base, 1);
    expect(d.allowed).toBe(false);
    expect(d.refusal).toBe('position_slots_full');
  });

  it('refuses a score below the configured threshold', () => {
    const d = sizePosition(state(), base, base.minOpportunityScore - 0.01);
    expect(d.allowed).toBe(false);
    expect(d.refusal).toBe('score_below_threshold');
  });

  it('never returns more than maxEntryLamports', () => {
    const rich = state({ navLamports: 1_000_000_000_000n, freeLamports: 1_000_000_000_000n });
    const d = sizePosition(rich, base, 1);
    expect(d.allowed).toBe(true);
    expect(d.lamports).toBeLessThanOrEqual(base.risk.maxEntryLamports);
  });

  it('never spends into the SOL reserve', () => {
    const thin = state({ freeLamports: base.risk.minSolReserveLamports });
    const d = sizePosition(thin, base, 1);
    expect(d.allowed).toBe(false);
    expect(d.refusal).toBe('reserve_floor');
  });

  it('refuses once exposure is at the cap', () => {
    const d = sizePosition(state({ totalExposureLamports: base.risk.maxTotalExposureLamports }), base, 1);
    expect(d.allowed).toBe(false);
    expect(d.refusal).toBe('exposure_cap');
  });

  it('halts new risk after the daily loss cap is hit', () => {
    const d = sizePosition(state({ realizedTodayLamports: -base.risk.dailyLossCapLamports }), base, 1);
    expect(d.allowed).toBe(false);
    expect(d.refusal).toBe('daily_loss_cap');
  });

  it('sizes monotonically in the opportunity score', () => {
    const weak = sizePosition(state(), base, 0.5);
    const strong = sizePosition(state(), base, 1);
    expect(strong.lamports).toBeGreaterThanOrEqual(weak.lamports);
  });
});

/**
 * Regression guard for a defect that silently disabled the entire strategy: the
 * risk caps permitted a largest-possible position smaller than the fee-viability
 * floor, so every candidate was refused at sizing. An empty trade log looks the
 * same whether the strategy found nothing or could never act, and only this
 * relationship distinguishes the two.
 */
describe('capital adequacy under catastrophic-loss sizing', () => {
  /**
   * These tests changed meaning TWICE, and both changes are findings.
   *
   * First: sizing used to divide the per-trade risk budget by the nominal 25%
   * stop, which asserts that a stop caps the loss at a quarter of the notional.
   * For this population that is false and the corpus says so — all eight
   * measured collapses fell from above the 10% floor to near zero inside ONE
   * mark interval, faster than any stop could be acted on. A stop is an
   * instruction to the market, not a promise from it. With
   * `catastrophicLossFloorPct` at 100, the same budget buys a quarter of the
   * notional it used to, and at the committed NAV that landed below the
   * viability floor: nothing could be sized at all, and the honest report was
   * that roughly 11.4 SOL would be required against a committed 10.
   *
   * Second, and this is why the numbers moved again: the viability floor was
   * computed against a priority fee of 200,000 lamports that the strategy never
   * pays. Measured from four real routes' own bytes it is 3,018–3,564 — a 56x
   * overstatement carrying a phantom 99 bps per leg and 198 bps per round trip
   * at the 0.02 SOL size. See MT025.
   *
   * With the phantom removed the floor drops and the same NAV clears it. That
   * is a correction to a measurement error, NOT evidence that the strategy
   * works: it says a trade can be sized, and says nothing whatever about
   * whether sizing one is a good idea. Zero valid simulated observations exist.
   *
   * The relationship these tests actually guard is unchanged and is the point:
   * the largest position the risk caps permit must clear the fee-viability
   * floor. When it does not, every candidate is refused at sizing, and an empty
   * trade log looks identical whether the strategy found nothing or could never
   * act.
   */
  it('can size an entry at the committed paper NAV, now that the fee floor is real', () => {
    const d = sizePosition(state(), base, 1);
    expect(d.allowed).toBe(true);
    // Still bounded by the risk budget, not by appetite.
    expect(d.lamports).toBeGreaterThanOrEqual(viableFloorLamports(base));
    expect(d.lamports).toBeLessThanOrEqual(
      (base.paperStartLamports * BigInt(Math.round(base.risk.riskBudgetPctPerTrade * 100))) / 10_000n,
    );
  });

  it('still refuses when the permitted size cannot clear the floor', () => {
    // The guard that matters, exercised at a NAV where it genuinely bites
    // rather than at the one that happens to be configured today.
    const floor = viableFloorLamports(base);
    const justUnder = (floor * 10_000n) / BigInt(Math.round(base.risk.riskBudgetPctPerTrade * 100)) - 1_000_000_000n;
    const d = sizePosition(state({ navLamports: justUnder, freeLamports: justUnder }), base, 1);
    expect(d.allowed).toBe(false);
    expect(d.refusal).toBe('size_below_viable');
  });

  it('refuses everything when capital is below the floor, at any score', () => {
    const tiny = state({ navLamports: 2_000_000_000n, freeLamports: 2_000_000_000n });
    for (const score of [0.4, 0.6, 0.8, 1]) {
      const d = sizePosition(tiny, base, score);
      expect(d.allowed).toBe(false);
      expect(d.refusal).toBe('size_below_viable');
    }
  });

  it('any permitted size still covers its own round-trip cost by the configured margin', () => {
    const floor = viableFloorLamports(base);
    const required = (floor * 10_000n) / BigInt(Math.round(base.risk.riskBudgetPctPerTrade * 100));
    const d = sizePosition(state({ navLamports: required, freeLamports: required }), base, 1);
    expect(d.allowed).toBe(true);
    const feeShareBps = (roundTripCostLamports(base) * 10_000n) / d.lamports;
    expect(Number(feeShareBps)).toBeLessThanOrEqual(base.maxFeeFractionBps);
  });

  it('a measured severe-loss quantile above the stop governs sizing, and below it does not', () => {
    // The floor is only a floor. If observation ever shows losses WORSE than
    // 100% of notional it cannot (there is no worse), but the same maximum
    // applies to the stop: a 25% stop can never make sizing more generous than
    // the measured severe loss.
    const floorOff = { ...base, catastrophicLossFloorPct: 0 };
    // 20 SOL: large enough that both sizes clear the viability floor, small
    // enough that maxEntryLamports does not cap both to the same number and
    // hide the effect being tested.
    const nav = 20n * 1_000_000_000n;
    const withStop = sizePosition(state({ navLamports: nav, freeLamports: nav }), floorOff, 1);
    const withSevere = sizePosition(
      state({ navLamports: nav, freeLamports: nav, observedSevereLossBps: 9_000 }),
      floorOff,
      1,
    );
    expect(withStop.allowed).toBe(true);
    expect(withSevere.allowed).toBe(true);
    expect(withSevere.lamports).toBeLessThan(withStop.lamports);
  });
});
