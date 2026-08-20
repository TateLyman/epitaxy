/**
 * `pnpm watchlist:load-deciles` — freeze the MT104 treatment and control arms.
 *
 * Same discipline as `load-watchlist.ts` and the same refusal to load twice: a
 * watchlist re-ranked part-way through an experiment makes the population a
 * function of the outcome. What differs is that this one carries a decile, and
 * the decile is the whole point — MT104 is a controlled comparison of H1's top
 * fit decile against its bottom one, and a load that quietly produced a single
 * arm would leave a one-armed experiment wearing a controlled experiment's name.
 * `freezeDecileWatchlist` refuses that case explicitly.
 *
 * `rank_position` is a GLOBAL sequence here, not the within-decile rank, because
 * the unique index is on (ledger_row, rank_position) and two deciles both have a
 * rank 1. The within-decile ordering is not lost: it is recoverable from
 * `rank_stat` within each `fit_decile`, which is the quantity it was ordered on.
 */
import { readFileSync } from 'node:fs';
import { openDb } from '../packages/storage/src/db.js';
import {
  MT101,
  MT104,
  freezeDecileWatchlist,
  type DecileFlaggedWallet,
} from '../packages/intelligence/src/wallet-watchlist.js';

const EXPORT = 'ops/dune/results/q14-decile-watchlist.json';

interface Q14Row {
  readonly address: string;
  readonly fit_decile_median_cut: number;
  readonly rank_in_decile: number;
  readonly rank_stat: number;
  readonly fit_positions: number;
  readonly amm_entry_share: number;
  readonly holdout_positions: number;
}

const payload = JSON.parse(readFileSync(EXPORT, 'utf8')) as {
  query_id: number;
  execution_id: string;
  state: string;
  rows: Q14Row[];
};
if (payload.state !== 'QUERY_STATE_COMPLETED') {
  throw new Error(`${EXPORT} is in state ${payload.state}; a partial export is not a watchlist`);
}

const rows: DecileFlaggedWallet[] = payload.rows.map((r) => ({
  address: r.address,
  // Filled below with the global sequence; the within-decile rank is recoverable
  // from rank_stat and is not the ordering the unique index needs.
  rankPosition: 0,
  rankStat: r.rank_stat,
  fitPositions: r.fit_positions,
  fitDecile: r.fit_decile_median_cut,
  ammEntryShare: r.amm_entry_share,
  holdoutPositions: r.holdout_positions,
}));

const frozen = freezeDecileWatchlist(rows);

const db = openDb({ path: 'data/runtime.db' });
const existing = db.prepare('SELECT COUNT(*) AS n FROM flagged_wallets WHERE ledger_row = ?').get(MT104.ledgerRow) as {
  n: number;
};
if (existing.n > 0) {
  console.error(
    `REFUSING: ${existing.n} wallets are already frozen under ${MT104.ledgerRow}.\n` +
      'MT104 freezes both arms for the duration. Replacing either one mid-experiment would make\n' +
      'the population a function of the outcome. A new list is a new experiment and needs its\n' +
      'own ledger row.',
  );
  process.exit(1);
}

const insert = db.prepare(
  `INSERT INTO flagged_wallets
     (address, rank_position, rank_stat, fit_positions, fit_window_start, fit_window_end,
      entry_project, cut, source_query_id, source_execution_id, ledger_row, frozen_utc_ms, fit_decile)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const frozenAt = Date.now();
const ordered = [...frozen.byAddress.values()].sort(
  (a, b) => a.fitDecile - b.fitDecile || b.rankStat - a.rankStat || a.address.localeCompare(b.address),
);

db.exec('BEGIN');
try {
  let seq = 0;
  for (const w of ordered) {
    seq += 1;
    insert.run(
      w.address,
      seq,
      w.rankStat,
      w.fitPositions,
      '2026-06-01',
      '2026-07-15',
      MT101.entryProject,
      MT101.cut,
      String(payload.query_id),
      payload.execution_id,
      MT104.ledgerRow,
      frozenAt,
      w.fitDecile,
    );
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const back = db
  .prepare('SELECT fit_decile AS d, COUNT(*) AS n FROM flagged_wallets WHERE ledger_row = ? GROUP BY 1 ORDER BY 1')
  .all(MT104.ledgerRow) as { d: number; n: number }[];

console.log(`froze ${ordered.length} wallets under ${MT104.ledgerRow}`);
for (const r of back) {
  const arm = r.d === MT104.treatmentDecile ? MT104.treatmentArm : MT104.controlArm;
  console.log(`  decile ${String(r.d).padStart(2)}  ${String(r.n).padStart(6)} wallets  ${arm}`);
}
console.log(`  source: Dune query ${payload.query_id}, execution ${payload.execution_id}`);
console.log(`  cut: ${MT101.cut} on the fit window 2026-06-01..2026-07-15`);
console.log(`  source kind: ${MT104.source} — matched locally, so watchlist size costs nothing`);
