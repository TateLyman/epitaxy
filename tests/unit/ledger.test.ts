import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import type { Db } from '../../packages/storage/src/db.js';
import { insertPosition, updatePosition } from '../../packages/storage/src/repo.js';
import { AppConfigSchema } from '../../packages/domain/src/config.js';
import type { AppConfig } from '../../packages/domain/src/config.js';
import { restoreLedger, rollDayIfNeeded, sumRealized, utcDayStart } from '../../apps/engine/src/ledger.js';
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
    expect(rollDayIfNeeded(db, ledger, TODAY + DAY - 1)).toBe(false);
    expect(ledger.realizedTodayLamports).toBe(-10_000_000n);
    expect(ledger.dayStartUtcMs).toBe(TODAY);
  });

  it('releases the previous day’s losses at the boundary', () => {
    closed(-248_000_000n, TODAY + 1000);
    const ledger = restoreLedger(db, config, TODAY + 2000);
    expect(ledger.realizedTodayLamports).toBe(-248_000_000n);

    expect(rollDayIfNeeded(db, ledger, TODAY + DAY)).toBe(true);
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
    expect(rollDayIfNeeded(db, ledger, TODAY + DAY)).toBe(true);
    expect(rollDayIfNeeded(db, ledger, TODAY + DAY + 3_600_000)).toBe(false);
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

  function refusal(ledger: { navLamports: bigint; freeLamports: bigint; realizedTodayLamports: bigint }) {
    return sizePosition(
      {
        navLamports: ledger.navLamports,
        freeLamports: ledger.freeLamports,
        openPositions: 0,
        totalExposureLamports: 0n,
        realizedTodayLamports: ledger.realizedTodayLamports,
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
