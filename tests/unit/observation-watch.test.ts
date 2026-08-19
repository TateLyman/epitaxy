import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import {
  NO_TRADE_INTERVAL_MS,
  OBSERVATION_CADENCE_MS,
  OBSERVATION_HORIZON_MS,
  OBSERVATION_OFFSETS_MS,
  POOL_DRAINED_LIQUIDITY_USD,
  POOL_DRAINED_QUOTE_LAMPORTS,
  auditWatches,
  classifyClosure,
  dueForObservation,
  nextDueAtUtcMs,
  terminalStateOf,
  type Watch,
} from '../../packages/pipeline/src/observation-watch.js';
import {
  closeWatch,
  noteTradeSeen,
  openWatches,
  recordObservation,
  watchCounts,
  watchOf,
} from '../../packages/storage/src/observation-watch-repo.js';

/**
 * Phase G §3 — death as an OBSERVED state.
 *
 * Phase F could not decide the pre-migration branch because 97.5% of censored mints
 * had no post-entry price at all. `maturingByCohort` selects on age, so a mint older
 * than the widest cohort band can never be selected again, and observation stopped at
 * an age that was a property of the queue rather than of the mint.
 *
 * The ways a fix like this goes wrong, each guarded below:
 *
 *   1. letting an ABSENT reading close a watch, which reintroduces exactly the defect
 *      it repairs — an unobserved mint recorded as a dead one;
 *   2. reopening a closed watch, which erases a finding;
 *   3. advancing the no-trade clock from the absence of a snapshot rather than from
 *      observed trading, which would make a collector outage look like a dead pool;
 *   4. letting the watch starve the cohort queue, or the queue starve the watch;
 *   5. reporting a terminal state with no attribution, so nobody can check it.
 */

const w = (over: Partial<Watch> = {}): Watch => ({
  mint: 'M',
  firstObservedUtcMs: 1_000_000,
  lastObservedUtcMs: 1_000_000,
  observations: 1,
  terminalState: null,
  ...over,
});

describe('the frozen thresholds', () => {
  it('are the ones MT094 recorded, and the no-trade interval cannot fire inside the observed hour', () => {
    expect(POOL_DRAINED_QUOTE_LAMPORTS).toBe(100_000_000n);
    expect(POOL_DRAINED_LIQUIDITY_USD).toBe(50);
    expect(NO_TRADE_INTERVAL_MS).toBe(7_200_000);
    expect(OBSERVATION_HORIZON_MS).toBe(86_400_000);
    // The longest mark offset is one hour and the no-trade interval is twice it, so a
    // quiet stretch inside the observed hour can never be read as death. The module's
    // comment first claimed four times, and this assertion is why that was caught.
    expect(NO_TRADE_INTERVAL_MS).toBe(2 * Math.max(...OBSERVATION_OFFSETS_MS));
    // Every mark offset and every Phase B exit window closes inside the horizon.
    expect(OBSERVATION_HORIZON_MS).toBeGreaterThan(20 * Math.max(...OBSERVATION_OFFSETS_MS));
  });
});

describe('terminalStateOf — absence never fires a terminal state', () => {
  const base = { firstObservedUtcMs: 0, nowUtcMs: 1000 };

  it('returns null when nothing is observable', () => {
    expect(
      terminalStateOf({ ...base, quoteReserveLamports: null, liquidityUsd: null, lastTradeUtcMs: null }),
    ).toBeNull();
  });

  it('never reads a null reserve or a null liquidity as a drained pool', () => {
    // The defect this repairs: an unobserved mint recorded as a dead one.
    expect(
      terminalStateOf({ ...base, quoteReserveLamports: null, liquidityUsd: null, lastTradeUtcMs: 0 }),
    ).toBeNull();
  });

  it('never reads a never-seen trade as a silent pool', () => {
    // lastTradeUtcMs null means "never observed trading", which is not the same as
    // "observed to have stopped".
    expect(
      terminalStateOf({
        quoteReserveLamports: null,
        liquidityUsd: 1_000,
        lastTradeUtcMs: null,
        firstObservedUtcMs: 0,
        nowUtcMs: OBSERVATION_HORIZON_MS,
      })?.state,
      // The horizon fires; NO_TRADE_INTERVAL does not, because nothing was ever seen
      // to stop — it was never seen to start.
    ).toBe('HORIZON_REACHED');
  });

  it('fires POOL_DRAINED from the on-chain reserve, attributed to it', () => {
    const v = terminalStateOf({
      ...base,
      quoteReserveLamports: POOL_DRAINED_QUOTE_LAMPORTS - 1n,
      liquidityUsd: 1_000_000,
      lastTradeUtcMs: 1000,
    });
    expect(v).toEqual({ state: 'POOL_DRAINED', source: 'ON_CHAIN_RESERVE' });
  });

  it('prefers the on-chain reserve over the provider when both are present', () => {
    const v = terminalStateOf({
      ...base,
      quoteReserveLamports: POOL_DRAINED_QUOTE_LAMPORTS * 100n,
      liquidityUsd: 1,
      lastTradeUtcMs: 1000,
    });
    // A healthy on-chain reserve is authoritative: the provider does not close it.
    expect(v).toBeNull();
  });

  it('falls back to provider liquidity only when no reserve was read', () => {
    const v = terminalStateOf({
      ...base,
      quoteReserveLamports: null,
      liquidityUsd: POOL_DRAINED_LIQUIDITY_USD - 1,
      lastTradeUtcMs: 1000,
    });
    expect(v).toEqual({ state: 'POOL_DRAINED', source: 'PROVIDER_LIQUIDITY' });
  });

  it('fires NO_TRADE_INTERVAL only on an observed sighting that has gone stale', () => {
    const v = terminalStateOf({
      quoteReserveLamports: null,
      liquidityUsd: 1_000_000,
      lastTradeUtcMs: 0,
      firstObservedUtcMs: 0,
      nowUtcMs: NO_TRADE_INTERVAL_MS,
    });
    expect(v).toEqual({ state: 'NO_TRADE_INTERVAL', source: 'OBSERVED_TRADES' });
  });

  it('fires HORIZON_REACHED from the clock alone', () => {
    const v = terminalStateOf({
      quoteReserveLamports: null,
      liquidityUsd: 1_000_000,
      lastTradeUtcMs: OBSERVATION_HORIZON_MS,
      firstObservedUtcMs: 0,
      nowUtcMs: OBSERVATION_HORIZON_MS,
    });
    expect(v).toEqual({ state: 'HORIZON_REACHED', source: 'CLOCK' });
  });
});

describe('the schedule', () => {
  it('walks the mark offsets and then continues at the cadence, so it never simply ends', () => {
    const first = 1_000_000;
    expect(nextDueAtUtcMs(w({ firstObservedUtcMs: first, lastObservedUtcMs: first }))).toBe(first + 60_000);
    expect(nextDueAtUtcMs(w({ firstObservedUtcMs: first, lastObservedUtcMs: first + 60_000 }))).toBe(first + 180_000);
    // Past the last offset the cadence takes over — Phase F's gap was everywhere
    // AFTER the queue lost interest, so the schedule must not stop at one hour.
    const past = first + 3_600_000;
    expect(nextDueAtUtcMs(w({ firstObservedUtcMs: first, lastObservedUtcMs: past }))).toBe(past + OBSERVATION_CADENCE_MS);
  });

  it('orders due watches most-overdue-first and never returns a closed one', () => {
    const late = w({ mint: 'LATE', firstObservedUtcMs: 0, lastObservedUtcMs: 0 });
    const recent = w({ mint: 'RECENT', firstObservedUtcMs: 500_000, lastObservedUtcMs: 500_000 });
    const closed = w({ mint: 'CLOSED', firstObservedUtcMs: 0, lastObservedUtcMs: 0, terminalState: 'POOL_DRAINED' });
    const due = dueForObservation([recent, closed, late], 10_000_000);
    expect(due.map((x) => x.mint)).toEqual(['LATE', 'RECENT']);
  });
});

describe('classifyClosure and the audit', () => {
  it('separates a fact about the market from a fact about the collector', () => {
    const now = 100_000_000;
    expect(classifyClosure(w({ terminalState: 'HORIZON_REACHED' }), now)).toBe('HORIZON_REACHED');
    // Open, and long past due with no terminal state: the collector lost it.
    expect(classifyClosure(w({ firstObservedUtcMs: 0, lastObservedUtcMs: 0 }), now)).toBe('COLLECTION_FAILURE');
    // Merely late is not abandoned.
    expect(classifyClosure(w({ firstObservedUtcMs: 0, lastObservedUtcMs: 0 }), 60_000 + 1000)).toBeNull();
  });

  it('reports the observed share, which is the number this fix exists to move', () => {
    const now = 100_000_000;
    const a = auditWatches(
      [
        w({ mint: '1', terminalState: 'POOL_DRAINED' }),
        w({ mint: '2', terminalState: 'NO_TRADE_INTERVAL' }),
        w({ mint: '3', terminalState: 'HORIZON_REACHED' }),
        w({ mint: '4', firstObservedUtcMs: 0, lastObservedUtcMs: 0 }),
        w({ mint: '5', firstObservedUtcMs: now, lastObservedUtcMs: now }),
      ],
      now,
    );
    expect(a.byTerminalState).toEqual({ POOL_DRAINED: 1, NO_TRADE_INTERVAL: 1, HORIZON_REACHED: 1 });
    expect(a.collectionFailures).toBe(1);
    expect(a.open).toBe(1);
    expect(a.observedShare).toBeCloseTo(3 / 4, 12);
  });

  it('reports a null observed share rather than 1.0 when nothing has closed', () => {
    const a = auditWatches([w({ firstObservedUtcMs: 1000, lastObservedUtcMs: 1000 })], 1000);
    expect(a.observedShare).toBeNull();
  });
});

describe('the persisted watch', () => {
  const freshDb = (): ReturnType<typeof openDb> => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-'));
    return openDb({ path: join(dir, 'w.db') });
  };

  it('opens on first sight, advances on later ones, and counts observations', () => {
    const db = freshDb();
    recordObservation(db, 'M', 1000);
    recordObservation(db, 'M', 2000);
    recordObservation(db, 'M', 3000);
    const row = watchOf(db, 'M');
    expect(row?.firstObservedUtcMs).toBe(1000);
    expect(row?.lastObservedUtcMs).toBe(3000);
    expect(row?.observations).toBe(3);
    expect(watchCounts(db)).toEqual({ open: 1, closed: 0, byState: {} });
    db.close();
  });

  it('never reopens a closed watch, because a terminal state is a finding', () => {
    const db = freshDb();
    recordObservation(db, 'M', 1000);
    closeWatch(db, 'M', 'POOL_DRAINED', 'PROVIDER_LIQUIDITY', 2000, {
      quoteReserveLamports: null,
      liquidityUsd: 3,
      lastTradeUtcMs: 1500,
    });
    recordObservation(db, 'M', 9000);
    const row = watchOf(db, 'M');
    expect(row?.terminalState).toBe('POOL_DRAINED');
    expect(row?.lastObservedUtcMs).toBe(1000);
    expect(row?.observations).toBe(1);
    expect(openWatches(db)).toEqual([]);
    expect(watchCounts(db).byState).toEqual({ POOL_DRAINED: 1 });
    db.close();
  });

  it('advances the trade sighting only forward, and only when trading was seen', () => {
    const db = freshDb();
    recordObservation(db, 'M', 1000);
    expect(watchOf(db, 'M')?.lastTradeSeenUtcMs).toBeNull();
    noteTradeSeen(db, 'M', 5000);
    expect(watchOf(db, 'M')?.lastTradeSeenUtcMs).toBe(5000);
    // An older sighting cannot rewind the clock.
    noteTradeSeen(db, 'M', 2000);
    expect(watchOf(db, 'M')?.lastTradeSeenUtcMs).toBe(5000);
    db.close();
  });

  it('stores the reading that closed it, so the decision is auditable', () => {
    const db = freshDb();
    recordObservation(db, 'M', 1000);
    closeWatch(db, 'M', 'NO_TRADE_INTERVAL', 'OBSERVED_TRADES', 9_000_000, {
      quoteReserveLamports: 12_345n,
      liquidityUsd: 777.5,
      lastTradeUtcMs: 1_000,
    });
    const r = (db as unknown as DatabaseSync)
      .prepare('SELECT terminal_source AS src, terminal_quote_reserve AS q, terminal_liquidity_usd AS l FROM observation_watch WHERE mint = ?')
      .get('M') as { src: string; q: string; l: number };
    expect(r.src).toBe('OBSERVED_TRADES');
    expect(r.q).toBe('12345');
    expect(r.l).toBeCloseTo(777.5, 6);
    db.close();
  });

  it('refuses a terminal state outside the taxonomy', () => {
    const db = freshDb();
    recordObservation(db, 'M', 1000);
    expect(() =>
      (db as unknown as DatabaseSync)
        .prepare('UPDATE observation_watch SET terminal_state = ?, terminal_utc_ms = ? WHERE mint = ?')
        .run('VANISHED', 2000, 'M'),
    ).toThrow();
    db.close();
  });
});
