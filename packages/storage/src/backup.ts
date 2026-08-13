import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './db.js';

/**
 * A real backup of a live WAL database.
 *
 * `copyFileSync` on the main `.db` file is not a backup while WAL is active.
 * Committed pages may live only in `-wal`, so the copy is silently older than
 * the database, or torn across a checkpoint. It is worse than having no backup,
 * because it looks like one.
 *
 * `VACUUM INTO` runs through SQLite, takes a read transaction, and writes a
 * consistent checkpointed snapshot without stopping the engine.
 *
 * Every backup here is verified by READING IT BACK. An unverified backup is a
 * hypothesis; this project has a corpus that is not reproducible and cannot
 * afford to discover at restore time that the hypothesis was wrong.
 */

export class BackupFailed extends Error {
  constructor(
    readonly stage: string,
    reason: string,
  ) {
    super(`database backup failed at ${stage}: ${reason}`);
    this.name = 'BackupFailed';
  }
}

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly integrity: string;
  readonly foreignKeyViolations: number;
  /** Row count of the witness table, and the bounds it had to fall within. */
  readonly witnessTable: string;
  readonly witnessBefore: number;
  readonly witnessInBackup: number;
  readonly witnessAfter: number;
  readonly elapsedMs: number;
}

/**
 * The table used to prove the backup is not stale.
 *
 * A monotonically growing table is the only cheap way to catch a snapshot that
 * silently predates the database. The count in the backup must land within the
 * counts taken immediately before and after — a backup holding FEWER rows than
 * existed before it started is stale, and one holding more than exist after it
 * finished is impossible.
 */
function witnessCount(db: Db | DatabaseSync, table: string): number {
  const r = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number } | undefined;
  return Number(r?.c ?? 0);
}

function tableExists(db: Db | DatabaseSync, name: string): boolean {
  const r = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
  return r !== undefined;
}

/**
 * sha256 of a file of any size.
 *
 * `readFileSync` cannot return more than 2 GiB, because a Node Buffer cannot be
 * larger than that. This backup used `createHash().update(readFileSync(path))`
 * and worked fine until the corpus passed the limit, at which point it threw
 *
 *     File size (2506678272) is greater than 2 GiB
 *
 * and — because a failed backup correctly blocks migration — the engine would
 * have refused to start at all. The protection behaved exactly as designed; the
 * thing it was protecting against was a defect in the protection.
 *
 * Read in fixed chunks instead. Synchronous on purpose: every caller is on a
 * startup path where the next thing that happens is a migration, and making
 * this async would let one begin before the backup finished.
 */
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

/**
 * Take a verified online backup. Throws rather than returning a partial result:
 * a caller that wants to proceed without a backup has to say so explicitly.
 *
 * Written to a temporary path and renamed into place, so an interrupted or
 * failed backup never destroys the previous good one. Overwriting the only
 * backup with a truncated file is the failure this ordering exists to prevent.
 */
export function onlineBackup(db: Db, destPath: string, opts: { witnessTable?: string } = {}): BackupResult {
  const started = Date.now();
  const dest = resolve(destPath);
  const tmp = `${dest}.partial`;
  mkdirSync(dirname(dest), { recursive: true });

  const witnessTable =
    opts.witnessTable !== undefined && tableExists(db, opts.witnessTable)
      ? opts.witnessTable
      : tableExists(db, 'schema_migrations')
        ? 'schema_migrations'
        : 'sqlite_master';

  const before = witnessCount(db, witnessTable);

  // VACUUM INTO refuses to overwrite. A leftover partial from a previous crash
  // is removed rather than allowed to fail every subsequent backup.
  try {
    if (existsSync(tmp)) rmSync(tmp);
  } catch (e) {
    throw new BackupFailed('clearing the previous partial', (e as Error).message);
  }

  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } catch (e) {
    throw new BackupFailed('VACUUM INTO', (e as Error).message);
  }

  const after = witnessCount(db, witnessTable);

  // Read it back. Everything below is about the FILE, not about what we hoped
  // we wrote.
  let bytes = 0;
  let integrity = 'unknown';
  let fkViolations = 0;
  let inBackup = 0;
  try {
    bytes = statSync(tmp).size;
    const check = new DatabaseSync(tmp, { readOnly: true });
    try {
      const rows = check.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      integrity = rows.map((r) => r.integrity_check).join('; ');
      fkViolations = (check.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
      inBackup = witnessCount(check, witnessTable);
    } finally {
      check.close();
    }
  } catch (e) {
    throw new BackupFailed('reading the backup back', (e as Error).message);
  }

  if (integrity !== 'ok') throw new BackupFailed('integrity_check', integrity);
  if (fkViolations > 0) throw new BackupFailed('foreign_key_check', `${fkViolations} violation(s)`);
  if (bytes === 0) throw new BackupFailed('size', 'the backup is empty');
  if (inBackup < before || inBackup > after) {
    throw new BackupFailed(
      'staleness bounds',
      `${witnessTable} held ${inBackup} rows in the backup, outside the [${before}, ${after}] the source ` +
        'had before and after. A snapshot outside those bounds is not a snapshot of this database.',
    );
  }

  let sha256: string;
  try {
    sha256 = hashFile(tmp);
    renameSync(tmp, dest);
  } catch (e) {
    throw new BackupFailed('finalising', (e as Error).message);
  }

  return {
    path: dest,
    bytes,
    sha256,
    integrity,
    foreignKeyViolations: fkViolations,
    witnessTable,
    witnessBefore: before,
    witnessInBackup: inBackup,
    witnessAfter: after,
    elapsedMs: Date.now() - started,
  };
}
