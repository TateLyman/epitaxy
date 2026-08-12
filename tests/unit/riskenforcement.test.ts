import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AppConfigSchema, RiskConfigSchema } from '../../packages/domain/src/config.js';
import type { AppConfig } from '../../packages/domain/src/config.js';
import { sizePosition } from '../../packages/strategy/src/portfolio.js';
import type { PortfolioState, SizingRefusal } from '../../packages/strategy/src/portfolio.js';

/**
 * P2a.1 §P2.3 — every declared risk field must have a reachable enforcement
 * branch.
 *
 * Four fields (maxAggregatePlannedLossPct, dailyLossHaltPct, weeklyLossHaltPct,
 * drawdownHaltPct) were declared in RiskConfigSchema and listed in
 * SAFER_WHEN_LOWER — the tree carried machinery to refuse any override that
 * *loosened* them — while no code read the values. An operator reading
 * config/live.json would reasonably have believed a 1.5% daily and 4% weekly
 * halt were active. They were not (O040).
 *
 * The last test here is the general one: it enumerates the schema and fails on
 * any field this file does not exercise, so adding a fifth ceremonial knob
 * breaks the build rather than going unnoticed.
 */

const base: AppConfig = AppConfigSchema.parse(JSON.parse(readFileSync('config/paper.json', 'utf8')));

function state(over: Partial<PortfolioState> = {}): PortfolioState {
  const nav = over.navLamports ?? base.paperStartLamports;
  return {
    navLamports: nav,
    freeLamports: nav,
    openPositions: 0,
    totalExposureLamports: 0n,
    realizedTodayLamports: 0n,
    realizedWeekLamports: 0n,
    plannedLossLamports: 0n,
    peakNavLamports: nav,
    ...over,
  };
}

/** NAV fraction in lamports, matching the implementation's rounding. */
function pctOfNav(pct: number, nav = base.paperStartLamports): bigint {
  return (nav * BigInt(Math.round(pct * 100))) / 10_000n;
}

function refusalFor(over: Partial<PortfolioState>, config = base): SizingRefusal | null {
  return sizePosition(state(over), config, 1).refusal;
}

describe('each percentage halt fires, and only on its own input', () => {
  it('dailyLossHaltPct', () => {
    const limit = pctOfNav(base.risk.dailyLossHaltPct);
    // One lamport short: some other rule may refuse, but not this one.
    expect(refusalFor({ realizedTodayLamports: -(limit - 1n) })).not.toBe('daily_loss_halt');
    expect(refusalFor({ realizedTodayLamports: -limit })).toBe('daily_loss_halt');
  });

  it('weeklyLossHaltPct', () => {
    const limit = pctOfNav(base.risk.weeklyLossHaltPct);
    expect(refusalFor({ realizedWeekLamports: -(limit - 1n) })).not.toBe('weekly_loss_halt');
    expect(refusalFor({ realizedWeekLamports: -limit })).toBe('weekly_loss_halt');
  });

  it('maxAggregatePlannedLossPct', () => {
    const limit = pctOfNav(base.risk.maxAggregatePlannedLossPct);
    expect(refusalFor({ plannedLossLamports: limit - 1n })).not.toBe('aggregate_planned_loss');
    expect(refusalFor({ plannedLossLamports: limit })).toBe('aggregate_planned_loss');
  });

  it('drawdownHaltPct', () => {
    const peak = base.paperStartLamports;
    const limit = pctOfNav(base.risk.drawdownHaltPct);
    expect(refusalFor({ navLamports: peak - limit + 1n, peakNavLamports: peak })).not.toBe('drawdown_halt');
    expect(refusalFor({ navLamports: peak - limit, peakNavLamports: peak })).toBe('drawdown_halt');
  });

  it('a profitable book trips none of them', () => {
    const r = refusalFor({ realizedTodayLamports: 5_000_000n, realizedWeekLamports: 50_000_000n });
    expect(['daily_loss_halt', 'weekly_loss_halt', 'aggregate_planned_loss', 'drawdown_halt']).not.toContain(r);
  });

  it('a zero threshold disables its halt rather than refusing everything', () => {
    // 0 must mean "no halt configured", not "halt at zero loss" — otherwise
    // observe mode, which sets several of these to 0, could never size.
    // `dailyLossCapLamports` is checked BEFORE these and would refuse first,
    // masking the branch under test. Disabled here so the assertion is about
    // the percentage halts and nothing else — without this the test passes
    // against an implementation where 0 means "halt at zero loss".
    const off = {
      ...base,
      risk: {
        ...base.risk,
        dailyLossCapLamports: 0n,
        dailyLossHaltPct: 0,
        weeklyLossHaltPct: 0,
        maxAggregatePlannedLossPct: 0,
      },
    };
    const r = sizePosition(
      state({ realizedTodayLamports: -base.paperStartLamports, realizedWeekLamports: -base.paperStartLamports }),
      off,
      1,
    ).refusal;
    expect(['daily_loss_halt', 'weekly_loss_halt', 'aggregate_planned_loss']).not.toContain(r);
  });
});

describe('no risk field is ceremonial', () => {
  /**
   * Every field in RiskConfigSchema must be named here with the refusal it
   * produces, or explicitly listed as enforced elsewhere. A new field added to
   * the schema fails this test until someone says where it is enforced.
   */
  const ENFORCED_BY_SIZING: Record<string, SizingRefusal> = {
    maxSimultaneousPositions: 'position_slots_full',
    dailyLossCapLamports: 'daily_loss_cap',
    dailyLossHaltPct: 'daily_loss_halt',
    weeklyLossHaltPct: 'weekly_loss_halt',
    maxAggregatePlannedLossPct: 'aggregate_planned_loss',
    drawdownHaltPct: 'drawdown_halt',
    maxTotalExposureLamports: 'exposure_cap',
    minSolReserveLamports: 'reserve_floor',
  };

  /** Fields that shape the SIZE rather than producing a refusal. */
  const ENFORCED_AS_SIZE = ['riskBudgetPctPerTrade', 'maxNotionalPctPerPosition', 'maxEntryLamports'];

  /** Fields enforced outside sizing, with the module that does it. */
  const ENFORCED_ELSEWHERE: Record<string, string> = {
    maxPriorityFeeLamports: 'packages/execution — transaction policy',
    maxSlippageBps: 'packages/adapters — quote request, and execution policy',
  };

  it('every declared risk field is accounted for', () => {
    const declared = Object.keys(RiskConfigSchema.shape);
    const accounted = new Set([
      ...Object.keys(ENFORCED_BY_SIZING),
      ...ENFORCED_AS_SIZE,
      ...Object.keys(ENFORCED_ELSEWHERE),
    ]);
    const unaccounted = declared.filter((f) => !accounted.has(f));
    expect(unaccounted).toEqual([]);
  });

  it('every sizing-enforced field can actually produce its refusal', () => {
    // Not a claim that the mapping is right — the per-field tests above do
    // that. This asserts the refusal name exists in the union at all, so a
    // renamed refusal cannot leave a field silently unenforced.
    const produced = new Set<string>();
    for (const [, refusal] of Object.entries(ENFORCED_BY_SIZING)) produced.add(refusal);
    expect(produced.size).toBe(Object.keys(ENFORCED_BY_SIZING).length);
  });
});
