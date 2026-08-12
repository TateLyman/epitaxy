import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadSecrets } from '../packages/domain/src/config.js';

/**
 * P2a.1 §0 — preserve the runtime database correctly while WAL is active.
 *
 * A plain file copy of the main `.db` while another process holds it open in
 * WAL mode is not a backup: the committed pages may live only in `-wal`, so the
 * copy can be silently older than the database, or torn. `VACUUM INTO` runs
 * through SQLite itself and produces a consistent, checkpointed snapshot of the
 * live database without stopping the engine.
 *
 * Nothing here writes to the source database beyond what `VACUUM INTO` and the
 * read-only pragmas require. The engine keeps running.
 */

const src = loadSecrets().databasePath;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = resolve('data/backups');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const dest = resolve(dir, `epitaxy-${stamp}.db`);

console.log(`source      ${src}`);
for (const suffix of ['', '-wal', '-shm']) {
  const p = src + suffix;
  if (existsSync(p)) {
    const st = statSync(p);
    console.log(`  ${(src.split(/[\\/]/).pop() ?? '') + suffix}  ${st.size} bytes  mtime ${st.mtime.toISOString()}`);
  } else {
    console.log(`  ${(src.split(/[\\/]/).pop() ?? '') + suffix}  (absent)`);
  }
}

const db = new DatabaseSync(src);

// Read-only integrity checks first, so the backup is taken from a database we
// have already inspected rather than from one we hope is sound.
const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
console.log(`\nPRAGMA integrity_check      ${integrity.map((r) => r.integrity_check).join('; ')}`);

const fk = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
console.log(`PRAGMA foreign_key_check    ${fk.length === 0 ? 'ok (0 violations)' : `${fk.length} VIOLATIONS`}`);
if (fk.length > 0) console.log(JSON.stringify(fk.slice(0, 10), null, 2));

const wal = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all() as Record<string, number>[];
console.log(`PRAGMA wal_checkpoint       ${JSON.stringify(wal)}`);

const TABLES = [
  'candidates',
  'decision_snapshots',
  'screenings',
  'quotes',
  'positions',
  'fills',
  'position_marks',
  'position_exits',
  'reject_observations',
  'health_events',
];

function counts(handle: DatabaseSync): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const t of TABLES) {
    try {
      const r = handle.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      out[t] = r.n;
    } catch {
      out[t] = 'absent';
    }
  }
  return out;
}

// Counted BEFORE the vacuum as well as after. The engine is live and appends
// continuously, so a straight equality check between source and backup fails
// for a HEALTHY database and would be indistinguishable from a torn snapshot.
// What must hold for an append-only corpus is the sandwich:
//     count_before <= count_in_backup <= count_after
// VACUUM INTO takes a transactionally consistent snapshot somewhere inside
// that interval, so a backup outside the bounds is a real defect.
const srcBefore = counts(db);

db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
console.log(`\nVACUUM INTO                 ${dest}`);

// Row counts from the SOURCE, then the same counts from the BACKUP. Equality is
// the check that the snapshot is usable, not merely that a file appeared.
const srcAfter = counts(db);
db.close();

const verify = new DatabaseSync(dest, { readOnly: true });
const dstCounts = counts(verify);
const vIntegrity = verify.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
verify.close();

console.log('\ntable                   before   backup    after   in-bounds');
let allMatch = true;
for (const t of TABLES) {
  const before = srcBefore[t];
  const b = dstCounts[t];
  const after = srcAfter[t];
  const ok =
    typeof before === 'number' && typeof b === 'number' && typeof after === 'number'
      ? before <= b && b <= after
      : String(before) === String(b) && String(b) === String(after);
  if (!ok) allMatch = false;
  console.log(
    `  ${t.padEnd(20)} ${String(before).padStart(8)} ${String(b).padStart(8)} ${String(after).padStart(8)}   ${ok ? 'yes' : 'NO'}`,
  );
}

const bytes = readFileSync(dest);
const sha = createHash('sha256').update(bytes).digest('hex');
const st = statSync(dest);

console.log(`\nbackup verified read-only   ${vIntegrity.map((r) => r.integrity_check).join('; ')}`);
console.log(`backup size                 ${st.size} bytes`);
console.log(`backup sha256               ${sha}`);
console.log(`snapshot within live bounds ${allMatch ? 'yes' : 'NO'}`);

if (!allMatch || vIntegrity[0]?.integrity_check !== 'ok') {
  console.error('\nBACKUP NOT USABLE — refusing to report success');
  process.exitCode = 1;
}
