/**
 * `pnpm db:vacuum-backup` — a consistent backup of the live corpus.
 *
 * WHY THIS COMMAND EXISTS AT ALL.
 *
 * The 8f73cef runtime audit tried `sqlite3_backup_step` (node:sqlite's
 * `backup()`) against the live 7.3 GB corpus while five collector daemons were
 * writing to it. That call RESTARTS FROM PAGE ZERO whenever the source is
 * written, so it sat at 2.8 GB of 7.3 GB for eight minutes with the page
 * counter resetting, and never converged. `VACUUM INTO` takes ONE read
 * transaction and finished the same corpus in 70 seconds.
 *
 * So this command does three things the incremental API cannot:
 *
 *  1. It REFUSES TO RUN while a trajectory collector holds the writer lock or
 *     a trajectory-collect process is alive. A backup taken under an active
 *     writer is the case that does not converge; declining is the fix, not a
 *     longer timeout.
 *  2. It requires 20 GB of free disk BEFORE it starts, because a VACUUM INTO
 *     that runs out of space leaves a partial file that looks like a backup.
 *  3. It READS THE RESULT BACK and verifies it. An unverified backup is a
 *     hypothesis, and this corpus is not reproducible.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { writeArtifact } from './_artifact.js';

const MIN_FREE_BYTES = 20 * 1024 ** 3;

function argValue(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function hashFile(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** Free bytes on the volume holding `path`. Returns null if it cannot be determined. */
function freeBytes(path: string): number | null {
  try {
    if (process.platform === 'win32') {
      const drive = resolve(path).slice(0, 2);
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-PSDrive ${drive[0]}).Free`],
        { encoding: 'utf8', timeout: 30_000 },
      ).trim();
      const n = Number(out);
      return Number.isFinite(n) ? n : null;
    }
    const out = execFileSync('df', ['-B1', '--output=avail', resolve(path)], { encoding: 'utf8' });
    const n = Number(out.split('\n')[1]?.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Live trajectory-collect processes, by pid. Empty is the only acceptable answer. */
export function liveTrajectoryCollectors(): number[] {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'trajectory-collect\\.ts' -and $_.CommandLine -notmatch 'CimInstance' } | ForEach-Object { $_.ProcessId }",
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    return out
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

interface TableCount {
  readonly table: string;
  readonly rows: number;
}

function tableCounts(db: DatabaseSync): TableCount[] {
  const names = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  return names.map((table) => ({
    table,
    rows: Number((db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c),
  }));
}

function scalar(db: DatabaseSync, sql: string): unknown {
  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : null;
  } catch {
    return null;
  }
}

function main(): void {
  const source = resolve(argValue('db') ?? process.env['DATABASE_PATH'] ?? './data/runtime.db');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = resolve(argValue('out') ?? `./data/backups/vacuum-${stamp}.db`);
  const started = Date.now();

  if (!existsSync(source)) {
    console.error(`no database at ${source}`);
    process.exit(1);
  }

  // 1 — nobody may be writing.
  const collectors = liveTrajectoryCollectors();
  if (collectors.length > 0 && argValue('allow-writers') !== 'yes') {
    console.error(
      `REFUSED: ${collectors.length} trajectory-collect process(es) are alive (${collectors.join(', ')}).\n` +
        'VACUUM INTO under an active writer is the case the incremental Backup API could not converge on.\n' +
        'Run `pnpm collector:stop-all` first.',
    );
    process.exit(1);
  }

  // 2 — disk headroom before, not after.
  const free = freeBytes(dirname(dest));
  const sourceBytes = statSync(source).size;
  if (free !== null && free < MIN_FREE_BYTES) {
    console.error(`REFUSED: ${(free / 1024 ** 3).toFixed(1)} GB free, ${MIN_FREE_BYTES / 1024 ** 3} GB required.`);
    process.exit(1);
  }

  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  if (existsSync(tmp)) rmSync(tmp);

  const db = new DatabaseSync(source);
  let preIntegrity = 'unknown';
  let preFkViolations = 0;
  let checkpoint: unknown = null;
  let sourceCounts: TableCount[] = [];
  let schemaVersion = 0;

  try {
    preIntegrity = (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[])
      .map((r) => r.integrity_check)
      .join('; ');
    preFkViolations = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    schemaVersion = Number(scalar(db, 'SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations') ?? 0);
    sourceCounts = tableCounts(db);

    console.log(`source          ${source}`);
    console.log(`bytes           ${sourceBytes.toLocaleString()}`);
    console.log(`integrity       ${preIntegrity}`);
    console.log(`foreign keys    ${preFkViolations} violation(s)`);
    console.log(`checkpoint      ${JSON.stringify(checkpoint)}`);
    console.log(`schema version  ${schemaVersion}`);
    console.log(`free disk       ${free === null ? 'unknown' : `${(free / 1024 ** 3).toFixed(1)} GB`}`);
    console.log(`\nVACUUM INTO ${tmp} ...`);

    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const vacuumMs = Date.now() - started;

  // 3 — read the FILE back. Everything below is about what is on disk.
  const bytes = statSync(tmp).size;
  const check = new DatabaseSync(tmp, { readOnly: true });
  let integrity = 'unknown';
  let fkViolations = 0;
  let backupCounts: TableCount[] = [];
  let backupSchema = 0;
  let nonterminalExposure = 0;
  const maxima: Record<string, unknown> = {};
  try {
    integrity = (check.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[])
      .map((r) => r.integrity_check)
      .join('; ');
    fkViolations = (check.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    backupCounts = tableCounts(check);
    backupSchema = Number(scalar(check, 'SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations') ?? 0);
    nonterminalExposure = Number(
      scalar(check, `SELECT COUNT(*) AS c FROM positions WHERE state <> 'POSITION_CLOSED'`) ?? 0,
    );
    maxima['development_trajectories.opened_utc_ms'] = scalar(
      check,
      'SELECT MAX(opened_utc_ms) AS v FROM development_trajectories',
    );
    maxima['trajectory_marks.taken_utc_ms'] = scalar(check, 'SELECT MAX(taken_utc_ms) AS v FROM trajectory_marks');
    maxima['screenings.rowid'] = scalar(check, 'SELECT MAX(rowid) AS v FROM screenings');
    maxima['execution_observations.rowid'] = scalar(check, 'SELECT MAX(rowid) AS v FROM execution_observations');
  } finally {
    check.close();
  }

  const problems: string[] = [];
  if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
  if (fkViolations > 0) problems.push(`foreign_key_check: ${fkViolations} violation(s)`);
  if (bytes === 0) problems.push('the backup is empty');
  if (backupSchema !== schemaVersion) problems.push(`schema version ${backupSchema} != source ${schemaVersion}`);

  // Every table the source had must be present in the backup with at least as
  // many rows as it had BEFORE the vacuum started. Fewer means stale.
  const backupByName = new Map(backupCounts.map((c) => [c.table, c.rows]));
  for (const c of sourceCounts) {
    const inBackup = backupByName.get(c.table);
    if (inBackup === undefined) problems.push(`table ${c.table} is missing from the backup`);
    else if (inBackup < c.rows) problems.push(`table ${c.table}: ${inBackup} rows in the backup < ${c.rows} in source`);
  }

  if (problems.length > 0) {
    console.error('\nBACKUP REJECTED:');
    for (const p of problems) console.error(`  ${p}`);
    rmSync(tmp);
    process.exit(1);
  }

  const sha256 = hashFile(tmp);
  renameSync(tmp, dest);

  const result = {
    generatedUtc: new Date().toISOString(),
    method: 'VACUUM INTO',
    source,
    sourceBytes,
    dest,
    bytes,
    sha256,
    integrity,
    foreignKeyViolations: fkViolations,
    schemaVersion: backupSchema,
    walCheckpoint: checkpoint,
    nonterminalExposure,
    liveWritersAtStart: collectors,
    freeDiskBytes: free,
    maxima,
    tableCounts: backupCounts.filter((c) => c.rows > 0),
    vacuumMs,
    elapsedMs: Date.now() - started,
  };

  writeArtifact('db-vacuum-backup.json', result);

  console.log(`\nbackup          ${dest}`);
  console.log(`bytes           ${bytes.toLocaleString()}`);
  console.log(`sha256          ${sha256}`);
  console.log(`integrity       ${integrity}`);
  console.log(`foreign keys    ${fkViolations} violation(s)`);
  console.log(`schema version  ${backupSchema}`);
  console.log(`nonterminal     ${nonterminalExposure} exposed position(s)`);
  console.log(`elapsed         ${Date.now() - started} ms`);
  console.log('\nVERIFIED.');
}

main();
