/**
 * `pnpm watchlist:load` — freeze the MT101 watchlist into the database.
 *
 * Reads the Q13 export, validates it against every condition MT101 froze, and
 * writes `flagged_wallets`. It does not fetch, rank, or choose anything: the
 * ranking is Dune's and the rule is the ledger's, and this step exists so that
 * what the collector follows is a stored, auditable list rather than a file
 * somebody could edit between runs.
 *
 * IT REFUSES TO LOAD TWICE. MT101 freezes the watchlist for the duration of the
 * experiment, and MT073 is why: top deciles vanish fastest, at 36.7 to 46.6
 * percent a month, so a wallet that goes quiet must produce NO SIGNAL and be
 * visible as such. A re-rank part-way through would make the population a
 * function of how the arm was doing, which is the one thing a frozen rule
 * exists to prevent. Replacing the list is a new experiment and needs a new
 * ledger row, so `--reset` is deliberately not a flag here.
 *
 * The provenance of the export is stored with every row — the Dune query id and
 * the exact execution id — because "these are the wallets we followed" is only
 * an auditable claim if the run that produced them can be named.
 */
import { readFileSync } from 'node:fs';
import { openDb } from '../packages/storage/src/db.js';
import { MT101, freezeWatchlist, type FlaggedWallet } from '../packages/intelligence/src/wallet-watchlist.js';

const EXPORT = 'ops/dune/results/q13-watchlist.json';

interface DuneRow {
  readonly address: string;
  readonly rank_position: number;
  readonly rank_stat: number;
  readonly fit_positions: number;
  readonly amm_entry_share: number;
  readonly holdout_positions: number;
  readonly wallets_qualifying: number;
}

const payload = JSON.parse(readFileSync(EXPORT, 'utf8')) as {
  execution_id: string;
  query_id: number;
  state: string;
  submitted_at: string;
  result: { rows: DuneRow[] };
};

if (payload.state !== 'QUERY_STATE_COMPLETED') {
  throw new Error(`${EXPORT} is in state ${payload.state}; a partial export is not a watchlist`);
}

const rows = payload.result.rows;
const flagged: FlaggedWallet[] = rows.map((r) => ({
  address: r.address,
  rankPosition: r.rank_position,
  rankStat: r.rank_stat,
  fitPositions: r.fit_positions,
}));

// Every MT101 condition is checked here, before a single row is written: the
// frozen size, the 20-position bar, rank uniqueness, address uniqueness, and
// the sweep budget the list implies. A list that fails any of them is a
// different experiment wearing the same name.
const watchlist = freezeWatchlist(flagged);

const db = openDb({ path: 'data/runtime.db' });

const existing = db.prepare('SELECT COUNT(*) AS n FROM flagged_wallets WHERE ledger_row = ?').get(MT101.ledgerRow) as {
  n: number;
};
if (existing.n > 0) {
  console.error(
    `REFUSING: ${existing.n} wallets are already frozen under ${MT101.ledgerRow}.\n` +
      'MT101 freezes the watchlist for the duration. Replacing it mid-experiment would make the\n' +
      'population a function of the outcome, which is what the freeze exists to prevent. A new\n' +
      'list is a new experiment and needs its own ledger row.',
  );
  process.exit(1);
}

const frozenAt = Date.parse(payload.submitted_at);
if (!Number.isFinite(frozenAt)) throw new Error(`unreadable submitted_at: ${payload.submitted_at}`);

const insert = db.prepare(
  `INSERT INTO flagged_wallets
     (address, rank_position, rank_stat, fit_positions, fit_window_start, fit_window_end,
      entry_project, cut, source_query_id, source_execution_id, ledger_row, frozen_utc_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

db.exec('BEGIN');
try {
  for (const w of watchlist.values()) {
    insert.run(
      w.address,
      w.rankPosition,
      w.rankStat,
      w.fitPositions,
      // The base block's own frozen window, per MT103.
      '2026-06-01',
      '2026-07-15',
      MT101.entryProject,
      MT101.cut,
      String(payload.query_id),
      payload.execution_id,
      MT101.ledgerRow,
      frozenAt,
    );
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const back = db
  .prepare('SELECT COUNT(*) AS n, MIN(rank_position) AS lo, MAX(rank_position) AS hi FROM flagged_wallets WHERE ledger_row = ?')
  .get(MT101.ledgerRow) as { n: number; lo: number; hi: number };

console.log(`froze ${back.n} wallets under ${MT101.ledgerRow}, ranks ${back.lo}..${back.hi}`);
console.log(`  source: Dune query ${payload.query_id}, execution ${payload.execution_id}`);
console.log(`  cut: ${MT101.cut} on the fit window 2026-06-01..2026-07-15 (MT103)`);
console.log(`  sweep: ${MT101.watchlistSize} wallets every ${MT101.sweepIntervalMs}ms (MT102)`);
