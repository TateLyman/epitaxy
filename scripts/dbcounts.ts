import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';

/**
 * Regenerates the row counts quoted in docs/DATA_DICTIONARY.md.
 *
 * Read-only, and deliberately does NOT take the process lock: it is safe to run
 * against a live engine, and the counts it prints are expected to be moving
 * while it prints them. A count taken here is evidence of shape, not a value to
 * be asserted against.
 */

const db = openDb({ path: loadSecrets().databasePath, readonly: true });

const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
  .all() as { name: string }[];

const takenAt = new Date().toISOString();
console.log(`read-only snapshot at ${takenAt}\n`);

for (const { name } of tables) {
  const { c } = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number };
  console.log(String(c).padStart(9) + '  ' + name);
}

const breakdowns: [string, string][] = [
  ['screenings eligible', `SELECT COUNT(*) AS c FROM screenings WHERE eligible = 1`],
  ['quotes buildable', `SELECT COUNT(*) AS c FROM quotes WHERE transaction_buildable = 1`],
  ['reject_tracking horizon > 60s', `SELECT COUNT(*) AS c FROM reject_tracking WHERE horizon_ms > 60000`],
  ['distinct snapshotted mints', `SELECT COUNT(DISTINCT mint) AS c FROM decision_snapshots`],
  ['positions simulated', `SELECT COUNT(*) AS c FROM positions WHERE simulated = 1`],
];

console.log('');
for (const [label, sql] of breakdowns) {
  const { c } = db.prepare(sql).get() as { c: number };
  console.log(String(c).padStart(9) + '  ' + label);
}

const exits = db
  .prepare(`SELECT exit_reason, COUNT(*) AS c FROM positions GROUP BY exit_reason ORDER BY c DESC`)
  .all() as { exit_reason: string | null; c: number }[];

if (exits.length > 0) {
  console.log('\nclosed positions by exit reason:');
  for (const e of exits) console.log(String(e.c).padStart(9) + '  ' + (e.exit_reason ?? '(open)'));
}
