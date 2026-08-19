/**
 * Phase G §3 — the observation watch, persisted.
 *
 * The watch is what makes a mint's disappearance either a fact about the market or a
 * counted collection failure. It is deliberately independent of the cohort queue: the
 * queue decides what is INTERESTING this cycle, and the watch decides what is still
 * being OBSERVED. Phase F's gap was the second question never being asked.
 */
import type { Db } from './db.js';
import type { TerminalSource, TerminalState, Watch } from '../../pipeline/src/observation-watch.js';

/**
 * Record an observation.
 *
 * Opens the watch on first sight and advances it afterwards. A watch that has already
 * closed is left alone: a terminal state is a finding and reopening it would erase
 * one. `observations` counts how many times the mint was actually looked at, which is
 * the denominator for any later claim about how well it was followed.
 */
export function recordObservation(db: Db, mint: string, atUtcMs: number): void {
  db.prepare(
    `INSERT INTO observation_watch (mint, first_observed_utc_ms, last_observed_utc_ms, observations)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(mint) DO UPDATE SET
       last_observed_utc_ms = excluded.last_observed_utc_ms,
       observations = observation_watch.observations + 1
     WHERE observation_watch.terminal_state IS NULL`,
  ).run(mint, atUtcMs, atUtcMs);
}

/**
 * Close a watch because a terminal state was OBSERVED, recording what was read.
 *
 * The reading is stored so the decision is auditable after the fact: a watch closed as
 * POOL_DRAINED with a quote reserve nobody can see is not a measurement.
 */
export function closeWatch(
  db: Db,
  mint: string,
  state: TerminalState,
  source: TerminalSource,
  atUtcMs: number,
  reading: { quoteReserveLamports: bigint | null; liquidityUsd: number | null; lastTradeUtcMs: number | null },
): void {
  db.prepare(
    `UPDATE observation_watch
        SET terminal_state = ?, terminal_utc_ms = ?, terminal_source = ?,
            terminal_quote_reserve = ?, terminal_liquidity_usd = ?, terminal_last_trade_ms = ?
      WHERE mint = ? AND terminal_state IS NULL`,
  ).run(
    state,
    atUtcMs,
    source,
    reading.quoteReserveLamports === null ? null : reading.quoteReserveLamports.toString(),
    reading.liquidityUsd,
    reading.lastTradeUtcMs,
    mint,
  );
}

/**
 * Advance the last time this mint was OBSERVED trading.
 *
 * Called only when an observation actually showed trades, so the no-trade interval is
 * measured against evidence of trading rather than against the absence of a snapshot.
 */
export function noteTradeSeen(db: Db, mint: string, atUtcMs: number): void {
  db.prepare(
    `UPDATE observation_watch SET last_trade_seen_utc_ms = ?
      WHERE mint = ? AND terminal_state IS NULL
        AND (last_trade_seen_utc_ms IS NULL OR last_trade_seen_utc_ms < ?)`,
  ).run(atUtcMs, mint, atUtcMs);
}

export interface WatchRow extends Watch {
  readonly lastTradeSeenUtcMs: number | null;
}

/** One watch, with the trade sighting the terminal rule needs. */
export function watchOf(db: Db, mint: string): WatchRow | null {
  const r = db
    .prepare(
      `SELECT mint, first_observed_utc_ms AS first, last_observed_utc_ms AS last, observations,
              last_trade_seen_utc_ms AS lastTrade, terminal_state AS terminal
         FROM observation_watch WHERE mint = ?`,
    )
    .get(mint) as
    | { mint: string; first: number; last: number; observations: number; lastTrade: number | null; terminal: TerminalState | null }
    | undefined;
  if (r === undefined) return null;
  return {
    mint: r.mint,
    firstObservedUtcMs: r.first,
    lastObservedUtcMs: r.last,
    observations: r.observations,
    terminalState: r.terminal,
    lastTradeSeenUtcMs: r.lastTrade,
  };
}

/** Every open watch, for the scheduler to order by lateness. */
export function openWatches(db: Db, limit = 500): Watch[] {
  return (
    db
      .prepare(
        `SELECT mint, first_observed_utc_ms AS first, last_observed_utc_ms AS last, observations
           FROM observation_watch
          WHERE terminal_state IS NULL
          ORDER BY last_observed_utc_ms ASC
          LIMIT ?`,
      )
      .all(limit) as { mint: string; first: number; last: number; observations: number }[]
  ).map((r) => ({
    mint: r.mint,
    firstObservedUtcMs: r.first,
    lastObservedUtcMs: r.last,
    observations: r.observations,
    terminalState: null,
  }));
}

/** Every watch, open or closed, for the audit. */
export function allWatches(db: Db): Watch[] {
  return (
    db
      .prepare(
        `SELECT mint, first_observed_utc_ms AS first, last_observed_utc_ms AS last,
                observations, terminal_state AS terminal
           FROM observation_watch`,
      )
      .all() as {
      mint: string;
      first: number;
      last: number;
      observations: number;
      terminal: TerminalState | null;
    }[]
  ).map((r) => ({
    mint: r.mint,
    firstObservedUtcMs: r.first,
    lastObservedUtcMs: r.last,
    observations: r.observations,
    terminalState: r.terminal,
  }));
}

export interface WatchCounts {
  readonly open: number;
  readonly closed: number;
  readonly byState: Readonly<Record<string, number>>;
}

export function watchCounts(db: Db): WatchCounts {
  const rows = db
    .prepare(
      `SELECT COALESCE(terminal_state, 'OPEN') AS state, COUNT(*) AS n
         FROM observation_watch GROUP BY 1`,
    )
    .all() as { state: string; n: number }[];
  const byState: Record<string, number> = {};
  let open = 0;
  let closed = 0;
  for (const r of rows) {
    if (r.state === 'OPEN') open = r.n;
    else {
      byState[r.state] = r.n;
      closed += r.n;
    }
  }
  return { open, closed, byState };
}
