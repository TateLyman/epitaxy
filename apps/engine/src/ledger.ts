import type { Db } from '../../../packages/storage/src/db.js';
import { summariseExposure } from '../../../packages/storage/src/exposure.js';
import { recordDay, dayRecord } from '../../../packages/storage/src/provenance-repo.js';
import type { AppConfig } from '../../../packages/domain/src/config.js';
import { utcDayStart, utcDateKey, utcDaysBetween } from '../../../packages/domain/src/clock.js';

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
  /** `YYYY-MM-DD`, persisted, so a rollover is idempotent. */
  utcDate: string;
  /** Highest NAV reached, for `drawdownHaltPct`. Never decreases. */
  peakNavLamports: bigint;
  /**
   * ATA rent held against open positions.
   *
   * Not a cost and not available: it is capital locked in token accounts that
   * cannot be spent until those accounts are closed. Reported separately so
   * that "we have 2 SOL free" never quietly includes rent that is sitting in
   * accounts we may not be able to close. See packages/domain/src/ata.ts.
   */
  lockedRentLamports: bigint;
}

export { utcDayStart };

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

/** Realised P&L and count for one UTC day, derived from immutable rows. */
export function realizedForDay(db: Db, dayStartUtcMs: number): { realized: bigint; closed: number } {
  const rows = db
    .prepare(
      `SELECT realized_lamports AS r FROM positions
       WHERE realized_lamports IS NOT NULL AND closed_utc_ms >= ? AND closed_utc_ms < ?`,
    )
    .all(dayStartUtcMs, dayStartUtcMs + 86_400_000) as { r: string }[];
  let realized = 0n;
  for (const row of rows) realized += BigInt(row.r);
  return { realized, closed: rows.length };
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
  // Exposure is reconstructed from what is HELD, not from a list of states we
  // remembered to name. `openPositions()` asks for POSITION_OPEN and
  // EXIT_INTENT, which silently omitted EXIT_BLOCKED and RECONCILING -- and a
  // position whose exit could not be built is precisely the one most likely to
  // still be holding something. Omitted, its cost was not exposure and its rent
  // was not locked, so the capital behind a position we could not sell was
  // reported as free and available to open another.
  const exposure = summariseExposure(db);
  const nav = config.paperStartLamports + sumRealized(db, null);
  const dayStart = utcDayStart(nowUtcMs);
  return {
    navLamports: nav,
    freeLamports: nav - exposure.totalCostLamports,
    realizedTodayLamports: realizedForDay(db, dayStart).realized,
    dayStartUtcMs: dayStart,
    utcDate: utcDateKey(nowUtcMs),
    peakNavLamports: peakNav(db, config.paperStartLamports),
    // One ATA per held position. Paper does not observe whether the account
    // already existed, so this is the upper bound, which is the conservative
    // direction for a number that reduces free capital.
    lockedRentLamports: BigInt(exposure.ataCount) * config.assumedAtaRentLamports,
  };
}

/**
 * The startup invariant: every nonzero, nonclosed position is accounted for.
 *
 * Returns the reason entries must be blocked, or null. A position held in a
 * state this build cannot manage is not a warning to log and move past -- we do
 * not know how it exits, so we must not open anything else.
 */
export function exposureBlockingEntries(db: Db): string | null {
  return summariseExposure(db).reason;
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

export interface DayRoll {
  readonly rolled: boolean;
  readonly daysSkipped: number;
  /** True when wall time moved BACKWARD across a day boundary. */
  readonly wentBackward: boolean;
}

/**
 * Advance the ledger's notion of "today" when the UTC day has rolled over.
 *
 * `dayStartUtcMs` was set once at startup and then read by nothing, so
 * `dailyLossCapLamports` was not a daily cap at all: once tripped it halted
 * entries permanently, until somebody happened to restart the process. The
 * paper engine sat in exactly that state — blocked on `daily_loss_cap` against
 * losses realised on a previous day, with 145 eligible candidates and zero open
 * positions — while appearing healthy and continuing to screen tokens. A cap
 * that never releases is indistinguishable from a hang.
 *
 * P2a.1 §P3.2 adds the properties that make this safe against a clock that
 * moves:
 *
 *  - the day's total is DERIVED from immutable closed positions, never
 *    accumulated, so there is no counter a rollback could zero;
 *  - the closing day is persisted under its UTC date key before the new day
 *    begins, so a skipped day leaves a record rather than a gap;
 *  - multiple missed days are handled — a machine asleep over a weekend rolls
 *    once and reports how many days it crossed;
 *  - a BACKWARD move is reported rather than obeyed silently, because
 *    recomputing an earlier day is harmless but doing it without saying so
 *    hides a clock problem;
 *  - running it twice writes the same numbers, so a restart at midnight is
 *    idempotent.
 *
 * The cap itself is unchanged. This makes it mean what it is named.
 */
export function rollDayIfNeeded(db: Db, ledger: Ledger, nowUtcMs: number, contextHash: string | null = null): DayRoll {
  const today = utcDayStart(nowUtcMs);
  if (today === ledger.dayStartUtcMs) return { rolled: false, daysSkipped: 0, wentBackward: false };

  const skipped = utcDaysBetween(ledger.dayStartUtcMs, today);

  // Seal the day that is ending, keyed by its own date. Recomputed from
  // immutable rows, so writing it twice writes the same value.
  const closing = realizedForDay(db, ledger.dayStartUtcMs);
  recordDay(
    db,
    {
      utcDate: utcDateKey(ledger.dayStartUtcMs),
      dayStartUtcMs: ledger.dayStartUtcMs,
      realizedLamports: closing.realized,
      positionsClosed: closing.closed,
      rolledUtcMs: nowUtcMs,
    },
    contextHash,
  );

  ledger.dayStartUtcMs = today;
  ledger.utcDate = utcDateKey(nowUtcMs);
  ledger.realizedTodayLamports = realizedForDay(db, today).realized;
  return { rolled: true, daysSkipped: skipped, wentBackward: skipped < 0 };
}

/** The sealed record for a day, if one was written. Read by the report. */
export function sealedDay(db: Db, utcMs: number): ReturnType<typeof dayRecord> {
  return dayRecord(db, utcDateKey(utcMs));
}
