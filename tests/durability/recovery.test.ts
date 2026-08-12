import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import { openPositions, latestMark, nextMarkSeq } from '../../packages/storage/src/repo.js';
import {
  recordClockCheckpoint,
  markResyncDone,
  outstandingResync,
  recordDay,
  dayRecord,
} from '../../packages/storage/src/provenance-repo.js';
import { restoreLedger, rollDayIfNeeded, realizedForDay } from '../../apps/engine/src/ledger.js';
import { loadConfig } from '../../packages/domain/src/config.js';
import { utcDayStart } from '../../packages/domain/src/clock.js';

/**
 * P2a.1 §P3.3 and §P10.9/§P10.14 — recovery, proved rather than configured.
 *
 * Deliberately NOT under `tests/integration/`, which is excluded from the
 * default run because those tests reach the network and a provider outage must
 * never look like a failing build. This one touches nothing but the local
 * filesystem, runs in well under a second, and is exactly the kind of test that
 * has to run every time: it is the only evidence that a power loss is
 * survivable, and a recovery test that is opt-in is a recovery test nobody runs.
 *
 * "Power settings do not prove recovery." Neither does a PID restart: a process
 * that comes back up and reports healthy has demonstrated that it can start,
 * not that the database it started against is intact or that the position it
 * left behind is still accounted for exactly once.
 *
 * The child process here is killed with SIGKILL while WAL is active and its
 * connection is un-finalised. That is what a power loss looks like to SQLite —
 * no checkpoint, no exit handlers, no clean shutdown — and it cannot be
 * simulated in-process, because `process.exit()` still runs the machinery that
 * makes the data safe.
 */

const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
const dbPath = join(dir, 'research.db');
const POSITION = 'crash-position-0001';
const MINT = 'CrashTestMint1111111111111111111111111111111';
const MARKS = 12;

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS will get it */
  }
});

describe('a process killed mid-write leaves a recoverable database', () => {
  it('crashes hard, then reopens with the position and every mark intact', () => {
    // Create the schema, then close cleanly. The child only writes rows.
    const setup = openDb({ path: dbPath, skipBackup: true });
    setup.close();

    const child = spawnSync(
      process.execPath,
      ['tests/fixtures/crash-child.mjs', dbPath, POSITION, MINT, String(MARKS)],
      { encoding: 'utf8' },
    );

    // The child reached the kill. On POSIX that shows up as a signal; on
    // Windows there are no signals and `process.kill(pid, 'SIGKILL')` becomes
    // TerminateProcess, which reports an exit code instead. Both are abrupt in
    // the way that matters — no exit handlers, no flush, no db.close() — so the
    // assertion accepts either and rejects a clean exit, which would mean the
    // test proved nothing.
    expect(child.stdout).toContain('WROTE');
    expect(child.signal !== null || child.status !== 0).toBe(true);

    // The evidence that the shutdown really was unclean: the write-ahead log is
    // still sitting there un-checkpointed. A clean close would have folded it
    // into the main database and removed it, and this test would then be
    // measuring an ordinary restart.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const db = openDb({ path: dbPath, skipBackup: true });

    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    expect(integrity[0]?.integrity_check).toBe('ok');
    expect((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length).toBe(0);

    // Exactly one position, still open, not duplicated by the reopen.
    const open = openPositions(db);
    expect(open).toHaveLength(1);
    expect(open[0]?.position_id).toBe(POSITION);

    // Every mark survived, and the sequence is unbroken — a recovery that
    // silently lost the last few marks would still pass an integrity check.
    const count = db.prepare('SELECT COUNT(*) AS n FROM position_marks WHERE position_id = ?').get(POSITION) as {
      n: number;
    };
    expect(count.n).toBe(MARKS);
    expect(latestMark(db, POSITION)?.seq).toBe(MARKS - 1);

    // And the next mark continues the sequence rather than restarting it,
    // which is what makes accounting exactly-once rather than at-least-once.
    expect(nextMarkSeq(db, POSITION)).toBe(MARKS);

    db.close();
  });

  it('restarting does not duplicate the position or reset the day', () => {
    const config = loadConfig('paper');
    const db = openDb({ path: dbPath, skipBackup: true });

    const first = restoreLedger(db, config, Date.now());
    const second = restoreLedger(db, config, Date.now());

    // Restoring twice is the restart case. It must be a pure read.
    expect(second.navLamports).toBe(first.navLamports);
    expect(second.freeLamports).toBe(first.freeLamports);
    expect(second.realizedTodayLamports).toBe(first.realizedTodayLamports);
    expect(openPositions(db)).toHaveLength(1);

    // The open position's cost is held against free capital both times, rather
    // than being double-counted or forgotten.
    expect(first.navLamports - first.freeLamports).toBe(50_000_000n);
    db.close();
  });
});

describe('the UTC day survives a clock that moves', () => {
  it('rolls once, seals the closing day, and is idempotent', () => {
    const config = loadConfig('paper');
    const db = openDb({ path: dbPath, skipBackup: true });
    const day = 86_400_000;
    const t0 = Date.UTC(2026, 7, 12, 12, 0, 0);

    const ledger = restoreLedger(db, config, t0);
    expect(rollDayIfNeeded(db, ledger, t0 + 3_600_000).rolled).toBe(false);

    const roll = rollDayIfNeeded(db, ledger, t0 + day);
    expect(roll.rolled).toBe(true);
    expect(roll.daysSkipped).toBe(1);
    expect(dayRecord(db, '2026-08-12')).not.toBeNull();

    // Twice in the same day is a no-op, which is what makes a restart at
    // midnight safe.
    expect(rollDayIfNeeded(db, ledger, t0 + day + 60_000).rolled).toBe(false);
    db.close();
  });

  it('a backward clock step is reported and resets no counter', () => {
    const config = loadConfig('paper');
    const db = openDb({ path: dbPath, skipBackup: true });
    const day = 86_400_000;
    const t0 = Date.UTC(2026, 7, 20, 12, 0, 0);

    const ledger = restoreLedger(db, config, t0);
    const back = rollDayIfNeeded(db, ledger, t0 - day);
    expect(back.rolled).toBe(true);
    expect(back.wentBackward).toBe(true);

    // The day's total is DERIVED from immutable closed positions, so moving the
    // clock cannot manufacture a fresh loss budget: it recomputes the same
    // number the earlier day always had.
    const recomputed = realizedForDay(db, utcDayStart(t0 - day)).realized;
    expect(ledger.realizedTodayLamports).toBe(recomputed);
    db.close();
  });

  it('skipping several days rolls once and says how many were crossed', () => {
    const config = loadConfig('paper');
    const db = openDb({ path: dbPath, skipBackup: true });
    const t0 = Date.UTC(2026, 8, 1, 12, 0, 0);
    const ledger = restoreLedger(db, config, t0);
    expect(rollDayIfNeeded(db, ledger, t0 + 3 * 86_400_000).daysSkipped).toBe(3);
    db.close();
  });
});

describe('a clock discontinuity outlives the process that saw it', () => {
  /**
   * §P10.9. The gate itself lives in the engine loop, which calls `main()` at
   * import and cannot be exercised from a test. What IS testable — and what the
   * gate reads — is that an unresolved discontinuity survives a restart, so a
   * replacement process cannot assume the world stopped moving while the old
   * one was gone.
   */
  it('an unresolved resync is still outstanding for the next process', () => {
    const db = openDb({ path: dbPath, skipBackup: true });
    expect(outstandingResync(db)).toBeNull();

    const id = recordClockCheckpoint(
      db,
      { monotonicMs: 1_000, wallUtcMs: Date.UTC(2026, 7, 12, 1, 0, 0) },
      {
        discontinuity: 'WALL_JUMPED_FORWARD',
        wallDeltaMs: 7_200_000,
        monotonicDeltaMs: 120,
        skewMs: 7_199_880,
        detail: 'suspend/resume',
      },
      true,
    );
    db.close();

    // A different connection is the restart.
    const reopened = openDb({ path: dbPath, skipBackup: true });
    const pending = outstandingResync(reopened);
    expect(pending).not.toBeNull();
    expect(pending?.checkpointId).toBe(id);

    markResyncDone(reopened, id, Date.now());
    expect(outstandingResync(reopened)).toBeNull();
    reopened.close();
  });

  it('a clean checkpoint never asks for a resync', () => {
    const db = openDb({ path: dbPath, skipBackup: true });
    recordClockCheckpoint(db, { monotonicMs: 5_000, wallUtcMs: Date.now() }, null, false);
    expect(outstandingResync(db)).toBeNull();
    db.close();
  });
});

describe('the sealed day is a record, not a running total', () => {
  it('writing the same day twice writes the same numbers', () => {
    const db = openDb({ path: dbPath, skipBackup: true });
    const rec = {
      utcDate: '2026-01-01',
      dayStartUtcMs: Date.UTC(2026, 0, 1),
      realizedLamports: -12_345_678n,
      positionsClosed: 3,
      rolledUtcMs: Date.UTC(2026, 0, 2),
    };
    recordDay(db, rec, 'ctx');
    recordDay(db, rec, 'ctx');
    const back = dayRecord(db, '2026-01-01');
    expect(back?.realizedLamports).toBe(-12_345_678n);
    expect(back?.positionsClosed).toBe(3);
    db.close();
  });

  it('a realized total beyond the safe integer round-trips exactly', () => {
    const db = openDb({ path: dbPath, skipBackup: true });
    const huge = 9_007_199_254_740_993n;
    recordDay(
      db,
      {
        utcDate: '2026-01-02',
        dayStartUtcMs: Date.UTC(2026, 0, 2),
        realizedLamports: huge,
        positionsClosed: 1,
        rolledUtcMs: Date.UTC(2026, 0, 3),
      },
      null,
    );
    expect(dayRecord(db, '2026-01-02')?.realizedLamports).toBe(huge);
    db.close();
  });
});
