/**
 * P0 — the untouched baseline at 3bc708d.
 *
 * A verified WAL-consistent backup, taken through `VACUUM INTO` so the copy is
 * a single consistent file rather than a database plus a WAL that may or may
 * not have been checkpointed at the same instant.
 *
 * Every number here is read back from the COPY, not from the original. A
 * backup nobody read is a backup nobody has.
 */
import { createHash } from 'node:crypto';
import { createReadStream, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';

const secrets = loadSecrets();
const src = secrets.databasePath;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('data/backups', { recursive: true });
const dest = `data/backups/baseline-3bc708d-${stamp}.db`;

const sha256 = async (p: string): Promise<string> =>
  await new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });

const live = openDb({ path: src, readonly: false });

// PASSIVE: it does not block writers and does not wait for them. A TRUNCATE
// here could stall behind the engine if one were still running.
const checkpoint = live.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as Record<string, number>;
console.log('checkpoint', JSON.stringify(checkpoint));

const TABLES = [
  'execution_observations',
  'simulation_jobs',
  'positions',
  'shadow_positions',
  'screenings',
  'candidates',
  'direct_chain_events',
  'signal_episodes',
  'health_events',
];
const counts: Record<string, number> = {};
for (const t of TABLES) {
  try {
    counts[t] = (live.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  } catch {
    counts[t] = -1;
  }
}

/** The exposure witness. A backup taken while capital is open must say so. */
const holding = (
  live.prepare('SELECT COUNT(*) n FROM positions WHERE CAST(token_amount AS INTEGER) > 0').get() as { n: number }
).n;

console.log(`VACUUM INTO ${dest} ...`);
const t0 = Date.now();
live.prepare(`VACUUM INTO ?`).run(dest);
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
live.close();

// ---- read back from the COPY -------------------------------------------
const copy = openDb({ path: dest, readonly: true });
const integrity = (copy.prepare('PRAGMA integrity_check').get() as Record<string, string>)['integrity_check'];
const fk = copy.prepare('PRAGMA foreign_key_check').all().length;
const readback: Record<string, number> = {};
for (const t of TABLES) {
  try {
    readback[t] = (copy.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  } catch {
    readback[t] = -1;
  }
}
const maxIds = {
  observation: (copy.prepare('SELECT MAX(received_utc_ms) m FROM execution_observations').get() as { m: number }).m,
  simulation: (copy.prepare('SELECT MAX(requested_utc_ms) m FROM simulation_jobs').get() as { m: number }).m,
  health: (copy.prepare('SELECT MAX(utc_ms) m FROM health_events').get() as { m: number }).m,
};
copy.close();

const mismatched = TABLES.filter((t) => counts[t] !== readback[t]);

const baseline = {
  generatedUtcMs: Date.now(),
  sourceCommit: execSync('git rev-parse HEAD').toString().trim(),
  dirty: execSync('git status --porcelain').toString().trim().length > 0,
  source: { path: src, bytes: statSync(src).size },
  backup: { path: dest, bytes: statSync(dest).size, sha256: await sha256(dest) },
  walCheckpoint: checkpoint,
  integrity,
  foreignKeyViolations: fk,
  counts,
  readback,
  // Empty means the copy says exactly what the original said.
  mismatchedTables: mismatched,
  maxIds,
  exposureWitness: { positionsHoldingTokens: holding },
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/baseline-3bc708d.json', JSON.stringify(baseline, null, 2));

console.log(`sha256    ${baseline.backup.sha256}`);
console.log(`bytes     ${baseline.backup.bytes}`);
console.log(`integrity ${integrity}   fk ${fk}`);
console.log(`mismatch  ${mismatched.length === 0 ? 'none' : mismatched.join(', ')}`);
console.log(`holding   ${holding} position(s) with tokens`);
console.log('artifacts/baseline-3bc708d.json');
