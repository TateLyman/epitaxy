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
describe('capital adequacy', () => {
  it('permits a largest position that clears the viability floor', () => {
    const d = sizePosition(state(), base, 1);
    expect(d.refusal).not.toBe('size_below_viable');
    expect(d.allowed).toBe(true);
  });

  it('refuses everything when capital is below the floor, at any score', () => {
    const tiny = state({ navLamports: 2_000_000_000n, freeLamports: 2_000_000_000n });
    for (const score of [0.4, 0.6, 0.8, 1]) {
      const d = sizePosition(tiny, base, score);
      expect(d.allowed).toBe(false);
      expect(d.refusal).toBe('size_below_viable');
    }
  });

  it('a permitted size always covers its own round-trip cost by the configured margin', () => {
    const d = sizePosition(state(), base, 1);
    expect(d.allowed).toBe(true);
    const feeShareBps = (roundTripCostLamports(base) * 10_000n) / d.lamports;
    expect(Number(feeShareBps)).toBeLessThanOrEqual(base.maxFeeFractionBps);
  });
});
