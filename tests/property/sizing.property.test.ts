import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { AppConfigSchema } from '../../packages/domain/src/config.js';
import type { AppConfig } from '../../packages/domain/src/config.js';
import { sizePosition, viableFloorLamports } from '../../packages/strategy/src/portfolio.js';
import type { PortfolioState } from '../../packages/strategy/src/portfolio.js';

/**
 * Position sizing is the last arithmetic between a signal and a spend, and
 * every one of its caps is a promise made to the operator. The unit tests check
 * that each cap binds when it is the binding one. These check something harder:
 * that no combination of portfolio state and configuration lets a cap be
 * exceeded — including the combinations where two caps interact, which is where
 * a `min` in the wrong place stops being visible.
 */

const base: AppConfig = AppConfigSchema.parse(JSON.parse(readFileSync('config/paper.json', 'utf8')));

const SOL = 1_000_000_000n;
const lamports = fc.bigInt({ min: 0n, max: 1_000n * SOL });

/**
 * The COMPLETE state, not a cast over a partial one.
 *
 * This generator previously produced five of the eight fields and the call site
 * wrote `state as PortfolioState`. That cast held while every consumer only
 * COMPARED the missing fields — `undefined >= 0n` is false, so the branch
 * quietly never fired — and broke the moment one of them did arithmetic. The
 * resulting TypeError looked like a production defect in sizing and was a
 * defect in the fixture. A test double has to have the shape of the real thing.
 */
const portfolio = fc.record({
  navLamports: fc.bigInt({ min: 0n, max: 1_000n * SOL }),
  freeLamports: lamports,
  openPositions: fc.integer({ min: 0, max: 6 }),
  totalExposureLamports: lamports,
  realizedTodayLamports: fc.bigInt({ min: -100n * SOL, max: 100n * SOL }),
  realizedWeekLamports: fc.bigInt({ min: -500n * SOL, max: 500n * SOL }),
  plannedLossLamports: fc.bigInt({ min: 0n, max: 100n * SOL }),
  peakNavLamports: fc.bigInt({ min: 0n, max: 1_000n * SOL }),
  observedSevereLossBps: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null }),
});

const riskOverride = fc.record({
  maxSimultaneousPositions: fc.integer({ min: 1, max: 4 }),
  maxEntryLamports: fc.bigInt({ min: 1n, max: 50n * SOL }),
  maxTotalExposureLamports: fc.bigInt({ min: 1n, max: 200n * SOL }),
  minSolReserveLamports: fc.bigInt({ min: 0n, max: 5n * SOL }),
  riskBudgetPctPerTrade: fc.double({ min: 0.1, max: 5, noNaN: true }),
  maxNotionalPctPerPosition: fc.double({ min: 0.5, max: 50, noNaN: true }),
  dailyLossCapLamports: fc.bigInt({ min: 0n, max: 50n * SOL }),
});

const score = fc.double({ min: 0, max: 1, noNaN: true });

function configWith(over: {
  maxSimultaneousPositions: number;
  maxEntryLamports: bigint;
  maxTotalExposureLamports: bigint;
  minSolReserveLamports: bigint;
  riskBudgetPctPerTrade: number;
  maxNotionalPctPerPosition: number;
  dailyLossCapLamports: bigint;
}): AppConfig {
  return { ...base, risk: { ...base.risk, ...over } };
}

describe('a permitted size respects every cap simultaneously', () => {
  it('never exceeds any single limit, whichever one happens to bind', () => {
    fc.assert(
      fc.property(portfolio, riskOverride, score, (state, over, s) => {
        const config = configWith(over);
        const out = sizePosition(state, config, s);
        if (!out.allowed) return;

        const size = out.lamports;
        const risk = config.risk;

        expect(size).toBeGreaterThan(0n);
        expect(size).toBeLessThanOrEqual(risk.maxEntryLamports);
        expect(size).toBeLessThanOrEqual(risk.maxTotalExposureLamports - state.totalExposureLamports);
        expect(size).toBeLessThanOrEqual(state.freeLamports - risk.minSolReserveLamports);
        expect(size).toBeGreaterThanOrEqual(viableFloorLamports(config));

        const notionalCap =
          (state.navLamports * BigInt(Math.round(risk.maxNotionalPctPerPosition * 100))) / 10_000n;
        expect(size).toBeLessThanOrEqual(notionalCap);
      }),
    );
  });

  /**
   * The reserve exists to pay the exit fees of everything already held. A size
   * that eats into it turns an open position into an unsellable one, so this is
   * checked as its own claim rather than trusted to the combined property above.
   */
  it('leaves the SOL reserve intact', () => {
    fc.assert(
      fc.property(portfolio, riskOverride, score, (state, over, s) => {
        const config = configWith(over);
        const out = sizePosition(state, config, s);
        if (!out.allowed) return;
        expect(state.freeLamports - out.lamports).toBeGreaterThanOrEqual(config.risk.minSolReserveLamports);
      }),
    );
  });
});

describe('refusals are unconditional', () => {
  it('never opens a position when the slots are full', () => {
    fc.assert(
      fc.property(portfolio, riskOverride, score, (state, over, s) => {
        const config = configWith(over);
        const full = { ...state, openPositions: config.risk.maxSimultaneousPositions + state.openPositions };
        const out = sizePosition(full as PortfolioState, config, s);
        expect(out.allowed).toBe(false);
        expect(out.refusal).toBe('position_slots_full');
      }),
    );
  });

  it('never opens a position on a score below the configured threshold', () => {
    fc.assert(
      fc.property(portfolio, riskOverride, fc.double({ min: 0, max: 0.99, noNaN: true }), (state, over, frac) => {
        const config = configWith(over);
        const below = config.minOpportunityScore * frac * 0.999;
        fc.pre(below < config.minOpportunityScore);
        const out = sizePosition({ ...state, openPositions: 0 } as PortfolioState, config, below);
        expect(out.allowed).toBe(false);
      }),
    );
  });

  /**
   * A bad day cannot be traded back. The cap is checked before sizing so that
   * no combination of score and headroom can reopen risk once the day's loss
   * has been realised.
   */
  it('never opens a position once the daily loss cap is reached', () => {
    fc.assert(
      fc.property(
        portfolio,
        riskOverride,
        score,
        fc.bigInt({ min: 0n, max: 10n * SOL }),
        (state, over, s, excess) => {
          const config = configWith({ ...over, dailyLossCapLamports: over.dailyLossCapLamports + 1n });
          const lost = { ...state, openPositions: 0, realizedTodayLamports: -(config.risk.dailyLossCapLamports + excess) };
          const out = sizePosition(lost as PortfolioState, config, s);
          expect(out.allowed).toBe(false);
          expect(out.refusal).toBe('daily_loss_cap');
        },
      ),
    );
  });

  it('never returns a size below the viability floor', () => {
    fc.assert(
      fc.property(portfolio, riskOverride, score, (state, over, s) => {
        const config = configWith(over);
        const out = sizePosition(state, config, s);
        if (out.allowed) expect(out.lamports).toBeGreaterThanOrEqual(viableFloorLamports(config));
        else expect(out.lamports).toBe(0n);
      }),
    );
  });
});

describe('score scales size within the band, never beyond it', () => {
  it('a stronger signal never produces a smaller position', () => {
    fc.assert(
      fc.property(portfolio, riskOverride, score, score, (state, over, a, b) => {
        const config = configWith(over);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const low = sizePosition(state as PortfolioState, config, lo);
        const high = sizePosition(state as PortfolioState, config, hi);
        if (low.allowed && high.allowed) expect(high.lamports).toBeGreaterThanOrEqual(low.lamports);
      }),
    );
  });
});
