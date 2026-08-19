import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';

/**
 * P0 — the exact local state, preserved before anything is edited.
 *
 * A GitHub audit can only see committed `master`. This machine may hold a newer
 * commit, an open position, a dirty tree, an un-checkpointed WAL, or a running
 * process, and every one of those changes what the audit is an audit OF.
 *
 * The backup is `VACUUM INTO`, not a file copy. With WAL active the main `.db`
 * file is not a complete database — recent transactions live in `-wal` until a
 * checkpoint folds them in — so copying it alone silently loses the most recent
 * and most relevant rows. `VACUUM INTO` takes a read transaction and writes a
 * consistent single-file snapshot of everything visible at that instant.
 *
 * The verification is a read-back: the snapshot is reopened, integrity-checked,
 * and its table counts compared against the live database. Because the engine
 * keeps writing while this runs, the live counts move; the assertion is
 * therefore `before <= backup <= after` per table, which is the correct bound
 * for an append-only corpus and is checkable rather than aspirational.
 */

const OUT_DIR = 'data/backups';
const secrets = loadSecrets();
const dbPath = secrets.databasePath;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${OUT_DIR}/baseline-${stamp}.db`;

mkdirSync(OUT_DIR, { recursive: true });

const TABLES = [
  'candidates',
  'decision_snapshots',
  'screenings',
  'quotes',
  'reject_tracking',
  'intents',
  'fills',
  'positions',
  'position_marks',
  'position_exits',
  'build_attempts',
  'run_contexts',
  'raw_payloads',
  'ledger_entries',
  'clock_checkpoints',
  'daily_accounting',
  'health_events',
  'source_health',
];

function counts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    try {
      out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    } catch {
      out[t] = -1; // table absent at this schema version
    }
  }
  return out;
}

/**
 * Hash a file of any size, in chunks.
 *
 * `readFileSync` throws `ERR_FS_FILE_TOO_LARGE` above Node's buffer limit, and
 * the thing this script exists to hash is the research corpus — 9.4 GB and
 * growing. So `pnpm audit:state` died on the one file whose integrity it was
 * written to record, after 218 seconds of doing the rest of the work correctly.
 *
 * Read in 64 MiB slices with an explicit position, which is bounded in memory
 * regardless of the file, and produces the same digest as the one-shot version
 * for every file small enough for the one-shot version to have worked.
 */
function sha256File(p: string): string {
  const CHUNK = 64 * 1024 * 1024;
  const h = createHash('sha256');
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let position = 0;
    for (;;) {
      const read = readSync(fd, buf, 0, CHUNK, position);
      if (read <= 0) break;
      h.update(buf.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unavailable';
  }
}

const live = new DatabaseSync(dbPath, { readOnly: true });

const integrity = (live.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[])[0]?.integrity_check;
const fkViolations = (live.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
const schema = (live.prepare('SELECT COALESCE(MAX(id),0) AS v FROM schema_migrations').get() as { v: number }).v;

const before = counts(live);

// Max identifiers and timestamps, so a later reader can tell exactly which rows
// existed at baseline without diffing whole tables.
const maxima = {
  screening_utc_ms: (live.prepare('SELECT MAX(evaluated_utc_ms) AS v FROM screenings').get() as { v: number | null }).v,
  quote_utc_ms: (live.prepare('SELECT MAX(requested_utc_ms) AS v FROM quotes').get() as { v: number | null }).v,
  mark_utc_ms: (live.prepare('SELECT MAX(observed_utc_ms) AS v FROM position_marks').get() as { v: number | null }).v,
  health_id: (live.prepare('SELECT MAX(id) AS v FROM health_events').get() as { v: number | null }).v,
  closed_utc_ms: (live.prepare('SELECT MAX(closed_utc_ms) AS v FROM positions').get() as { v: number | null }).v,
};

// Every position state, INCLUDING EXIT_BLOCKED — which `openPositions()`
// excludes, and which is therefore invisible to every other health surface in
// the tree. That exclusion is the §4.1 defect; this query does not depend on it.
const positionStates = live.prepare('SELECT state, COUNT(*) AS n FROM positions GROUP BY state').all() as {
  state: string;
  n: number;
}[];
const unmanaged = live
  .prepare(
    `SELECT position_id, mint, state, token_amount, cost_lamports, opened_utc_ms
     FROM positions
     WHERE closed_utc_ms IS NULL AND CAST(token_amount AS INTEGER) > 0`,
  )
  .all() as Record<string, unknown>[];

const contexts = live.prepare('SELECT * FROM run_contexts ORDER BY first_seen_utc_ms').all() as Record<string, unknown>[];

live.close();

// The snapshot. A second connection, because VACUUM INTO needs a write-capable
// handle even though it only reads the source.
const src = new DatabaseSync(dbPath);
src.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
const checkpoint = src.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as Record<string, number>;
src.close();

const after = new DatabaseSync(dbPath, { readOnly: true });
const liveAfter = counts(after);
after.close();

const snap = new DatabaseSync(backupPath, { readOnly: true });
const snapIntegrity = (snap.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[])[0]
  ?.integrity_check;
const snapCounts = counts(snap);
snap.close();

// before <= backup <= after, per table. The engine is still writing, so equality
// is the wrong assertion; this is the correct bound for an append-only corpus.
const bounds = TABLES.map((t) => {
  const b = before[t] ?? -1;
  const s = snapCounts[t] ?? -1;
  const a = liveAfter[t] ?? -1;
  return { table: t, before: b, backup: s, after: a, ok: b <= s && s <= a };
});
const violations = bounds.filter((x) => !x.ok);

const manifest = {
  generatedUtc: new Date().toISOString(),
  repo: {
    path: process.cwd(),
    remote: git(['remote', 'get-url', 'origin']),
    branch: git(['branch', '--show-current']),
    head: git(['rev-parse', 'HEAD']),
    auditedHead: '3155ea74795fd51279575803d17abeb293f20b08',
    headMatchesAudit: git(['rev-parse', 'HEAD']) === '3155ea74795fd51279575803d17abeb293f20b08',
    dirty: git(['status', '--porcelain']).split('\n').filter((l) => l.length > 0),
  },
  database: {
    path: dbPath,
    walPresent: existsSync(`${dbPath}-wal`),
    shmPresent: existsSync(`${dbPath}-shm`),
    sizeBytes: statSync(dbPath).size,
    schemaVersion: schema,
    integrityCheck: integrity,
    foreignKeyViolations: fkViolations,
    walCheckpoint: checkpoint,
  },
  backup: {
    path: backupPath,
    sha256: sha256File(backupPath),
    sizeBytes: statSync(backupPath).size,
    integrityCheck: snapIntegrity,
    method: 'VACUUM INTO (consistent snapshot with WAL active)',
  },
  counts: { before, backup: snapCounts, after: liveAfter },
  boundsCheck: { ok: violations.length === 0, violations },
  maxima,
  positionStates,
  unmanagedPositions: unmanaged,
  runContexts: contexts,
};

writeFileSync(`${OUT_DIR}/baseline-${stamp}.manifest.json`, JSON.stringify(manifest, null, 2));

// The digest of the main `.db` file AS IT SITS, to demonstrate why a file copy
// is not used: with WAL active it is a different, older artifact than the
// `VACUUM INTO` snapshot beside it.
//
// This used to materialise the copy — `writeFileSync(naive, readFileSync(dbPath))`
// — which threw ERR_FS_FILE_TOO_LARGE at 9.4 GB and killed the script after four
// minutes of otherwise correct work, having already written a 9.2 GB backup. It
// also cost a second 9.2 GB of disk and a full read per run to prove something a
// hash proves on its own: a copy of a file has the file's digest, so copying it
// first adds I/O and nothing else.
const naiveSha = sha256File(dbPath);

console.log(`baseline captured\n`);
console.log(`  repo HEAD          ${manifest.repo.head}`);
console.log(`  matches audit      ${manifest.repo.headMatchesAudit ? 'YES' : 'NO — local is ahead or diverged'}`);
console.log(`  dirty files        ${manifest.repo.dirty.length === 0 ? 'none' : manifest.repo.dirty.join(', ')}`);
console.log(`  schema version     ${schema}`);
console.log(`  integrity          ${integrity}, fk violations ${fkViolations}`);
console.log(`  wal present        ${manifest.database.walPresent}`);
console.log(`  backup             ${backupPath}`);
console.log(`  backup sha256      ${manifest.backup.sha256}`);
console.log(`  backup integrity   ${snapIntegrity}`);
console.log(`  main .db sha256    ${naiveSha}  <- differs from the backup; this is why VACUUM INTO is used`);
console.log(`  bounds check       ${violations.length === 0 ? 'PASS (before <= backup <= after on every table)' : 'FAIL'}`);
for (const v of violations) console.log(`    ${v.table}: ${v.before} / ${v.backup} / ${v.after}`);
console.log(`\n  position states    ${positionStates.map((p) => `${p.state}=${p.n}`).join(' ')}`);
console.log(`  unmanaged (token>0, not closed): ${unmanaged.length}`);
for (const u of unmanaged) console.log(`    ${JSON.stringify(u)}`);
console.log(`\n  manifest           ${OUT_DIR}/baseline-${stamp}.manifest.json`);

if (violations.length > 0) process.exitCode = 1;
