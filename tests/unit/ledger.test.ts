import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import type { Db } from '../../packages/storage/src/db.js';
import { insertPosition, updatePosition } from '../../packages/storage/src/repo.js';
import { AppConfigSchema } from '../../packages/domain/src/config.js';
import type { AppConfig } from '../../packages/domain/src/config.js';
import {
  peakNav,
  realizedForDay,
  restoreLedger,
  rollDayIfNeeded,
  sumRealized,
  utcDayStart,
} from '../../apps/engine/src/ledger.js';
import type { Ledger } from '../../apps/engine/src/ledger.js';
import { sizePosition } from '../../packages/strategy/src/portfolio.js';

/**
 * The paper engine's cash accounting.
 *
 * Two defects motivate this file, and both were invisible for the whole first
 * measurement window:
 *
 *  1. `dayStartUtcMs` was written once at startup and read by nothing, so the
 *     "daily" loss cap never released. The engine sat halted on losses realised
 *     on a previous calendar day, with eligible candidates and no open
 *     positions, while reporting itself healthy.
 *  2. The realised total was `SUM(CAST(realized_lamports AS INTEGER))` read as
 *     a JS number, which defeats the reason the column is TEXT.
 *
 * Neither was reachable by a test while the code lived in `paper.ts`, which
 * calls `main()` at import. That is why `ledger.ts` exists.
 */

const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
const config: AppConfig = AppConfigSchema.parse(JSON.parse(readFileSync('config/paper.json', 'utf8')));

let db: Db;
let n = 0;

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS will get it */
  }
});

beforeEach(() => {
  db = openDb({ path: join(dir, `t${++n}.db`) });
});

const DAY = 86_400_000;
/** 2026-08-12T00:00:00Z — a fixed clock, so no test depends on when it runs. */
const TODAY = Date.UTC(2026, 7, 12);

/** Insert an already-closed position that realised `realized` at `closedUtcMs`. */
function closed(realized: bigint, closedUtcMs: number): void {
  const id = `p${++n}`;
  insertPosition(db, {
    positionId: id,
    mint: `mint${n}`,
    state: 'POSITION_OPEN',
    tokenAmount: 1_000n,
    costLamports: 50_000_000n,
    realizedLamports: 0n,
    openedUtcMs: closedUtcMs - 60_000,
    closedUtcMs: null,
    strategyVersion: config.strategyVersion,
    simulated: true,
  });
  updatePosition(db, id, {
    state: 'POSITION_CLOSED',
    realizedLamports: realized,
    closedUtcMs,
    exitReason: 'stop_loss',
  });
}

describe('sumRealized', () => {
  it('is zero on an empty corpus', () => {
    expect(sumRealized(db, null)).toBe(0n);
  });

  it('adds losses and gains as bigints', () => {
    closed(-7_073_668n, TODAY + 1000);
    closed(33_411_329n, TODAY + 2000);
    expect(sumRealized(db, null)).toBe(26_337_661n);
  });

  it('counts only positions closed at or after the cutoff', () => {
    closed(-10_000_000n, TODAY - 1); // yesterday, by one millisecond
    closed(-1_000_000n, TODAY); // exactly midnight counts as today
    expect(sumRealized(db, null)).toBe(-11_000_000n);
    expect(sumRealized(db, TODAY)).toBe(-1_000_000n);
  });

  it('ignores open positions, which have no realised value yet', () => {
    insertPosition(db, {
      positionId: 'open-1',
      mint: 'mintOpen',
      state: 'POSITION_OPEN',
      tokenAmount: 1_000n,
      costLamports: 50_000_000n,
      realizedLamports: 0n,
      openedUtcMs: TODAY,
      closedUtcMs: null,
      strategyVersion: config.strategyVersion,
      simulated: true,
    });
    expect(sumRealized(db, null)).toBe(0n);
  });

  it('keeps full precision above 2^53, which the old SUM(CAST(...)) could not', () => {
    // 9_007_199_254_740_993 = 2^53 + 1, the first integer a double cannot hold.
    // Split across two rows so the failure is in the SUM and not in one value.
    closed(9_007_199_254_740_000n, TODAY + 1000);
    closed(993n, TODAY + 2000);
    const total = sumRealized(db, null);
    expect(total).toBe(9_007_199_254_740_993n);
    // The old implementation's answer, spelled out: a double rounds to even.
    expect(Number(total)).toBe(9_007_199_254_740_992);
    expect(total).not.toBe(BigInt(Number(total)));
  });
});

describe('utcDayStart', () => {
  it('is idempotent — the start of a day is its own day start', () => {
    expect(utcDayStart(TODAY)).toBe(TODAY);
  });

  it('maps every instant in a day to the same midnight', () => {
    expect(utcDayStart(TODAY)).toBe(TODAY);
    expect(utcDayStart(TODAY + DAY - 1)).toBe(TODAY);
    expect(utcDayStart(TODAY + DAY)).toBe(TODAY + DAY);
  });

  it('is UTC, not local — the boundary does not move with the machine', () => {
    expect(new Date(utcDayStart(TODAY + 12 * 3_600_000)).toISOString()).toBe('2026-08-12T00:00:00.000Z');
  });
});

describe('rollDayIfNeeded', () => {
  it('does nothing inside the same UTC day', () => {
    closed(-10_000_000n, TODAY + 1000);
    const ledger = restoreLedger(db, config, TODAY + 2000);
    expect(rollDayIfNeeded(db, ledger, TODAY + DAY - 1).rolled).toBe(false);
    expect(ledger.realizedTodayLamports).toBe(-10_000_000n);
    expect(ledger.dayStartUtcMs).toBe(TODAY);
  });

  it('releases the previous day’s losses at the boundary', () => {
    closed(-248_000_000n, TODAY + 1000);
    const ledger = restoreLedger(db, config, TODAY + 2000);
    expect(ledger.realizedTodayLamports).toBe(-248_000_000n);

    expect(rollDayIfNeeded(db, ledger, TODAY + DAY).rolled).toBe(true);
    expect(ledger.dayStartUtcMs).toBe(TODAY + DAY);
    expect(ledger.realizedTodayLamports).toBe(0n);
  });

  it('recomputes from the database rather than zeroing, so same-day losses survive a roll', () => {
    closed(-5_000_000n, TODAY + DAY + 1000); // already "tomorrow"
    const ledger = restoreLedger(db, config, TODAY);
    rollDayIfNeeded(db, ledger, TODAY + DAY + 2000);
    expect(ledger.realizedTodayLamports).toBe(-5_000_000n);
  });

  it('rolls only once for a given day', () => {
    const ledger = restoreLedger(db, config, TODAY);
    expect(rollDayIfNeeded(db, ledger, TODAY + DAY).rolled).toBe(true);
    expect(rollDayIfNeeded(db, ledger, TODAY + DAY + 3_600_000).rolled).toBe(false);
  });

  it('does not lose NAV across the roll — the cap resets, the money does not', () => {
    closed(-248_000_000n, TODAY + 1000);
    const ledger = restoreLedger(db, config, TODAY + 2000);
    const navBefore = ledger.navLamports;
    rollDayIfNeeded(db, ledger, TODAY + DAY);
    expect(ledger.navLamports).toBe(navBefore);
    expect(ledger.navLamports).toBe(config.paperStartLamports - 248_000_000n);
  });
});

describe('the halt this fixes', () => {
  /**
   * The end-to-end statement of the defect, in the terms the engine uses:
   * a loss big enough to trip `dailyLossCapLamports` must block entries on the
   * day it happened and must not block them the next day.
   */
  const tripped = -(config.risk.dailyLossCapLamports + 1n);

  function refusal(ledger: Ledger) {
    return sizePosition(
      {
        navLamports: ledger.navLamports,
        freeLamports: ledger.freeLamports,
        openPositions: 0,
        totalExposureLamports: 0n,
        realizedTodayLamports: ledger.realizedTodayLamports,
        peakNavLamports: ledger.peakNavLamports,
        realizedWeekLamports: 0n,
        plannedLossLamports: 0n,
        observedSevereLossBps: null,
      },
      config,
      1,
    );
  }

  it('blocks entries on the day the cap is breached', () => {
    closed(tripped, TODAY + 1000);
    const ledger = restoreLedger(db, config, TODAY + 2000);
    expect(refusal(ledger).refusal).toBe('daily_loss_cap');
  });

  it('and stops blocking them once the day has rolled', () => {
    closed(tripped, TODAY + 1000);
    const ledger = restoreLedger(db, config, TODAY + 2000);
    expect(refusal(ledger).refusal).toBe('daily_loss_cap');

    rollDayIfNeeded(db, ledger, TODAY + DAY);

    // Without the roll this is still `daily_loss_cap`, forever, and the only
    // cure is a restart of the process.
    expect(refusal(ledger).refusal).not.toBe('daily_loss_cap');
  });
});

describe('peakNav', () => {
  it('is the starting balance on an empty corpus', () => {
    expect(peakNav(db, 10_000_000_000n)).toBe(10_000_000_000n);
  });

  it('never decreases once reached', () => {
    closed(2_000_000_000n, TODAY + 1000); // up to 12 SOL
    closed(-3_000_000_000n, TODAY + 2000); // back down to 9
    expect(peakNav(db, 10_000_000_000n)).toBe(12_000_000_000n);
  });

  it('follows the close order, not the insert order', () => {
    closed(-1_000_000_000n, TODAY + 5000); // closed later, inserted first
    closed(2_000_000_000n, TODAY + 1000); // closed earlier
    // By close order: +2 (peak 12), then -1 (nav 11). Peak is 12.
    // By insert order it would be 10 -> 9 -> 11, and the peak would be 11.
    expect(peakNav(db, 10_000_000_000n)).toBe(12_000_000_000n);
  });

  it('is the starting balance for a strategy that only ever lost', () => {
    closed(-248_382_507n, TODAY + 1000);
    expect(peakNav(db, 10_000_000_000n)).toBe(10_000_000_000n);
  });

  it('is what restoreLedger reports', () => {
    closed(2_000_000_000n, TODAY + 1000);
    closed(-3_000_000_000n, TODAY + 2000);
    const ledger = restoreLedger(db, config, TODAY + 3000);
    expect(ledger.peakNavLamports).toBe(config.paperStartLamports + 2_000_000_000n);
    expect(ledger.navLamports).toBe(config.paperStartLamports - 1_000_000_000n);
  });
});

describe('the drawdown halt', () => {
  const pct = config.risk.drawdownHaltPct;

  function sized(nav: bigint, peak: bigint) {
    return sizePosition(
      {
        navLamports: nav,
        freeLamports: nav,
        openPositions: 0,
        totalExposureLamports: 0n,
        realizedTodayLamports: 0n,
        peakNavLamports: peak,
        realizedWeekLamports: 0n,
        plannedLossLamports: 0n,
        observedSevereLossBps: null,
      },
      config,
      1,
    );
  }

  it('permits entry at the peak', () => {
    expect(sized(config.paperStartLamports, config.paperStartLamports).refusal).not.toBe('drawdown_halt');
  });

  it('halts once NAV falls the configured fraction below peak', () => {
    const peak = config.paperStartLamports;
    const limit = (peak * BigInt(Math.round(pct * 100))) / 10_000n;
    expect(sized(peak - limit + 1n, peak).refusal).not.toBe('drawdown_halt');
    expect(sized(peak - limit, peak).refusal).toBe('drawdown_halt');
    expect(sized(peak - limit - 1n, peak).refusal).toBe('drawdown_halt');
  });

  it('measures against the peak, not the starting balance', () => {
    // Same NAV, different history: one strategy is up overall but has given
    // back more than the limit, the other has never been above water.
    const peak = config.paperStartLamports * 2n;
    const limit = (peak * BigInt(Math.round(pct * 100))) / 10_000n;
    const nav = peak - limit;
    expect(sized(nav, peak).refusal).toBe('drawdown_halt');
    expect(sized(nav, nav).refusal).not.toBe('drawdown_halt');
  });

  it('is checked before the score gate, so a halted engine refuses for the real reason', () => {
    const peak = config.paperStartLamports;
    const limit = (peak * BigInt(Math.round(pct * 100))) / 10_000n;
    const d = sizePosition(
      {
        navLamports: peak - limit,
        freeLamports: peak - limit,
        openPositions: 0,
        totalExposureLamports: 0n,
        realizedTodayLamports: 0n,
        peakNavLamports: peak,
        realizedWeekLamports: 0n,
        plannedLossLamports: 0n,
        observedSevereLossBps: null,
      },
      config,
      0, // also below minOpportunityScore
    );
    expect(d.refusal).toBe('drawdown_halt');
  });
});

describe('a UTC day is bounded at both ends', () => {
  /**
   * The lower bound had a test; the upper bound did not, and a mutation that
   * removed it survived the suite. A day total that runs off the end of the day
   * makes the daily loss cap tighten permanently as the corpus grows: every
   * later loss counts against today, and the cap that was supposed to release
   * at midnight instead becomes stricter every day. That is the O037 failure
   * again by a different route, so it gets its own test.
   */
  it('counts only positions closed inside the day, not after it', () => {
    closed(-10_000_000n, TODAY + 3_600_000);
    closed(-20_000_000n, TODAY + DAY + 3_600_000);
    closed(-40_000_000n, TODAY + 5 * DAY);

    expect(realizedForDay(db, TODAY).realized).toBe(-10_000_000n);
    expect(realizedForDay(db, TODAY).closed).toBe(1);
    expect(realizedForDay(db, TODAY + DAY).realized).toBe(-20_000_000n);
    expect(realizedForDay(db, TODAY + 5 * DAY).realized).toBe(-40_000_000n);
  });

  it('includes a position closed at the first instant and excludes one at the last', () => {
    closed(-1n, TODAY);
    closed(-2n, TODAY + DAY - 1);
    closed(-4n, TODAY + DAY);

    // Midnight belongs to the day that is starting, not the one that ended.
    expect(realizedForDay(db, TODAY).realized).toBe(-3n);
    expect(realizedForDay(db, TODAY + DAY).realized).toBe(-4n);
  });

  it('an empty day is zero rather than the running total', () => {
    closed(-99_000_000n, TODAY);
    expect(realizedForDay(db, TODAY + 2 * DAY).realized).toBe(0n);
    expect(realizedForDay(db, TODAY + 2 * DAY).closed).toBe(0);
  });
});
