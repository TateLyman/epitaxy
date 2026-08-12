import type { Db } from '../../../packages/storage/src/db.js';
import { openPositions } from '../../../packages/storage/src/repo.js';
import type { AppConfig } from '../../../packages/domain/src/config.js';

/**
 * The paper engine's cash accounting.
 *
 * Lives in its own module rather than inside `paper.ts` because `paper.ts`
 * calls `main()` at import time: anything defined there is, by construction,
 * untestable. The daily loss cap was broken for the entire first measurement
 * window (see `rollDayIfNeeded`) and no test could have caught it while the
 * only way to reach the code was to start the engine.
 */
export interface Ledger {
  navLamports: bigint;
  freeLamports: bigint;
  realizedTodayLamports: bigint;
  dayStartUtcMs: number;
  /** Highest NAV reached, for `drawdownHaltPct`. Never decreases. */
  peakNavLamports: bigint;
}

/** Midnight UTC of the day containing `utcMs`. */
export function utcDayStart(utcMs: number): number {
  return new Date(utcMs).setUTCHours(0, 0, 0, 0);
}

/**
 * Sum realised P&L in bigint, from the TEXT the values are stored in.
 *
 * The previous version was `SUM(CAST(realized_lamports AS INTEGER))` read back
 * as a JS number. `realized_lamports` is TEXT precisely because SQLite INTEGER
 * is 64-bit signed, and pulling the sum through a double reintroduces exactly
 * the representation this schema exists to avoid: above 2^53 the total silently
 * loses precision, and any non-integral result makes the subsequent `BigInt()`
 * throw. Paper NAV is small enough today that it has not bitten, which is what
 * makes it worth fixing now rather than after it does.
 */
export function sumRealized(db: Db, closedSinceUtcMs: number | null): bigint {
  const rows = (
    closedSinceUtcMs === null
      ? db.prepare('SELECT realized_lamports AS r FROM positions WHERE realized_lamports IS NOT NULL')
      : db.prepare(
          'SELECT realized_lamports AS r FROM positions WHERE realized_lamports IS NOT NULL AND closed_utc_ms >= ?',
        )
  ).all(...(closedSinceUtcMs === null ? [] : [closedSinceUtcMs])) as { r: string }[];
  let total = 0n;
  for (const row of rows) total += BigInt(row.r);
  return total;
}

/**
 * Highest NAV the experiment has ever reached, replayed from the close order.
 *
 * Derived rather than stored so it cannot drift from the position table, and
 * so a restart recovers the same peak the process had before it died. Realised
 * P&L only, which is what `navLamports` is also built from — marking open
 * positions into the peak would let an unrealised spike raise the bar that a
 * later drawdown is measured against.
 */
export function peakNav(db: Db, startLamports: bigint): bigint {
  const rows = db
    .prepare(
      'SELECT realized_lamports AS r FROM positions WHERE realized_lamports IS NOT NULL ORDER BY closed_utc_ms',
    )
    .all() as { r: string }[];
  let nav = startLamports;
  let peak = startLamports;
  for (const row of rows) {
    nav += BigInt(row.r);
    if (nav > peak) peak = nav;
  }
  return peak;
}

/**
 * Reconstructs NAV from persisted positions and fills so a restart does not
 * silently reset the experiment to a fresh, flattering starting balance.
 */
export function restoreLedger(db: Db, config: AppConfig, nowUtcMs: number): Ledger {
  const open = openPositions(db);
  const exposure = open.reduce((a, p) => a + BigInt(p.cost_lamports), 0n);
  const nav = config.paperStartLamports + sumRealized(db, null);
  const dayStart = utcDayStart(nowUtcMs);
  return {
    navLamports: nav,
    freeLamports: nav - exposure,
    realizedTodayLamports: sumRealized(db, dayStart),
    dayStartUtcMs: dayStart,
    peakNavLamports: peakNav(db, config.paperStartLamports),
  };
}

/** Milliseconds in seven days, for the trailing weekly loss halt. */
export const WEEK_MS = 7 * 86_400_000;

/**
 * Realised P&L over the trailing seven days.
 *
 * A rolling window rather than a calendar week: a Monday-reset would make the
 * halt weakest immediately after the reset, which is the opposite of what a
 * loss halt is for.
 */
export function realizedWeek(db: Db, nowUtcMs: number): bigint {
  return sumRealized(db, nowUtcMs - WEEK_MS);
}

/**
 * Advance the ledger's notion of "today" when the UTC day has rolled over.
 * Returns whether it rolled.
 *
 * `dayStartUtcMs` was set once at startup and then read by nothing, so
 * `dailyLossCapLamports` was not a daily cap at all: once tripped it halted
 * entries permanently, until somebody happened to restart the process. The
 * paper engine sat in exactly that state — blocked on `daily_loss_cap` against
 * losses realised on a previous day, with 145 eligible candidates and zero open
 * positions — while appearing healthy and continuing to screen tokens. A cap
 * that never releases is indistinguishable from a hang.
 *
 * The cap itself is unchanged. This makes it mean what it is named.
 */
export function rollDayIfNeeded(db: Db, ledger: Ledger, nowUtcMs: number): boolean {
  const today = utcDayStart(nowUtcMs);
  if (today === ledger.dayStartUtcMs) return false;
  ledger.dayStartUtcMs = today;
  // Recomputed from the database rather than zeroed, so a roll-over that
  // happens after a backwards clock correction cannot erase real losses.
  ledger.realizedTodayLamports = sumRealized(db, today);
  return true;
}
