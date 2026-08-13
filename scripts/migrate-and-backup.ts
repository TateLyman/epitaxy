import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { onlineBackup } from '../packages/storage/src/backup.js';

/**
 * Take a WAL-consistent backup, then apply any pending migrations.
 *
 * In that order. A migration is the one operation that can make the corpus
 * unreadable by the code that wrote it, and the corpus is research data that
 * is not reproducible: the tokens it observed no longer exist in the state it
 * observed them in.
 *
 * `onlineBackup` uses VACUUM INTO rather than copying the file, because
 * copying a live SQLite database without its -wal produces a file that opens
 * cleanly and is missing every transaction since the last checkpoint. That is
 * the worst failure mode available: a backup that looks fine.
 */

const path = loadSecrets().databasePath;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = `${path}.backup-${stamp}`;

// Opened read-only for the backup so nothing here can be the thing that
// corrupts what it is trying to preserve.
const ro = openDb({ path, readonly: true });
const result = onlineBackup(ro, dest, { witnessTable: 'execution_observations' });
ro.close();

console.log('backup');
console.log(`  path       ${result.path}`);
console.log(`  bytes      ${result.bytes}`);
console.log(`  sha256     ${result.sha256}`);
console.log(`  integrity  ${result.integrity}`);
console.log(
  `  witness    ${result.witnessTable}: ${result.witnessInBackup} rows in the backup, ` +
    `within [${result.witnessBefore}, ${result.witnessAfter}] on the source`,
);
console.log(`  fk         ${result.foreignKeyViolations} violation(s)`);
console.log(`  elapsed    ${result.elapsedMs} ms`);

if (result.integrity !== 'ok') {
  console.error('\nintegrity check did not return ok. Not migrating.');
  process.exit(1);
}

const before = openDb({ path, readonly: true });
const v0 = (before.prepare('SELECT COALESCE(MAX(id),0) AS v FROM schema_migrations').get() as { v: number }).v;
before.close();

// Writable open runs pending migrations.
const db = openDb({ path, skipBackup: true });
const v1 = (db.prepare('SELECT COALESCE(MAX(id),0) AS v FROM schema_migrations').get() as { v: number }).v;
console.log(`\nschema ${v0} -> ${v1}`);

// Jobs written between migration 16 and this run by a process that was still
// on pre-repair code. NULL is an unknown, and an unknown is not valid: label
// them for what they are rather than leaving a value nothing can interpret.
const orphaned = db
  .prepare("UPDATE simulation_jobs SET validity = 'INSTRUMENT_DEVELOPMENT' WHERE validity IS NULL")
  .run();
if (Number(orphaned.changes) > 0) {
  console.log(`
labelled ${orphaned.changes} job(s) that were written without a validity`);
}

for (const [label, sql] of [
  ['simulation jobs by validity', 'SELECT validity, COUNT(*) AS n FROM simulation_jobs GROUP BY 1'],
  ['observations by effect', 'SELECT simulation_effect, COUNT(*) AS n FROM execution_observations GROUP BY 1'],
  ['marks by source', 'SELECT mark_source, COUNT(*) AS n FROM position_marks GROUP BY 1'],
] as const) {
  console.log(`\n${label}`);
  for (const r of db.prepare(sql).all() as Record<string, unknown>[]) console.log(' ', JSON.stringify(r));
}
db.close();
