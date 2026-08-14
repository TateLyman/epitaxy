/**
 * P0 — the local truth at `1c499cd`, and a verified backup of it.
 *
 * Every figure that matters is read back FROM THE COPY, not from the original.
 * A backup nobody has read is a file, not a backup, and the only way to know a
 * copy is usable is to open it and count.
 */
import { writeFileSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadSecrets } from '../packages/domain/src/config.js';

const secrets = loadSecrets();
const dbPath = secrets.databasePath;

const sha256 = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `data/backups/baseline-1c499cd-${stamp}.db`;
mkdirSync('data/backups', { recursive: true });

console.log('reading the live corpus...');
const live = new DatabaseSync(dbPath, { readOnly: true });

const TABLES = (
  live.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
).map((r) => r.name);

const countOf = (db: DatabaseSync, t: string): number => {
  try {
    return (db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get() as { n: number }).n;
  } catch {
    return -1;
  }
};
const liveCounts: Record<string, number> = {};
for (const t of TABLES) liveCounts[t] = countOf(live, t);

const q = <T>(sql: string): T[] => {
  try {
    return live.prepare(sql).all() as T[];
  } catch {
    return [];
  }
};
const one = <T>(sql: string): T | null => q<T>(sql)[0] ?? null;

const state = {
  schemaVersion: one<{ v: number }>('SELECT MAX(id) v FROM schema_migrations')?.v ?? null,
  strategyVersions: q<{ v: string; n: number }>(
    'SELECT strategy_version v, COUNT(*) n FROM screenings GROUP BY 1 ORDER BY n DESC',
  ),
  /** Exposure witness. Anything non-zero here means the backup must not be taken hot. */
  openPositions: one<{ n: number }>("SELECT COUNT(*) n FROM positions WHERE state NOT IN ('CLOSED')")?.n ?? 0,
  positionsHoldingTokens:
    one<{ n: number }>("SELECT COUNT(*) n FROM positions WHERE CAST(token_amount AS INTEGER) > 0")?.n ?? 0,
  shadowsByState: q<{ state: string; n: number }>(
    'SELECT state, COUNT(*) n FROM shadow_positions GROUP BY 1 ORDER BY n DESC',
  ),
  shadowsHoldingTokens:
    one<{ n: number }>("SELECT COUNT(*) n FROM shadow_positions WHERE CAST(token_amount AS INTEGER) > 0")?.n ?? 0,
  triggeredShadows:
    one<{ n: number }>('SELECT COUNT(*) n FROM shadow_positions WHERE triggered_utc_ms IS NOT NULL')?.n ?? 0,
  oldestTriggerAgeMs:
    one<{ ms: number }>(
      "SELECT MAX(? - triggered_utc_ms) ms FROM shadow_positions WHERE state IN ('AWAITING_FILL_OBSERVATION','EXIT_BLOCKED')".replace(
        '?',
        String(Date.now()),
      ),
    )?.ms ?? null,
  simulationJobs: q<{ status: string; n: number }>(
    'SELECT status, COUNT(*) n FROM simulation_jobs GROUP BY 1 ORDER BY n DESC',
  ),
  effectVerified:
    one<{ n: number }>('SELECT COUNT(*) n FROM simulation_jobs WHERE simulated_effect_ok = 1')?.n ?? 0,
  observations: one<{ n: number }>('SELECT COUNT(*) n FROM execution_observations')?.n ?? 0,
  screenings: one<{ n: number }>('SELECT COUNT(*) n FROM screenings')?.n ?? 0,
  eligible: one<{ n: number }>('SELECT COUNT(*) n FROM screenings WHERE eligible = 1')?.n ?? 0,
  directMintFacts: one<{ n: number }>('SELECT COUNT(*) n FROM direct_mint_facts')?.n ?? 0,
  entityConcentration: one<{ n: number }>('SELECT COUNT(*) n FROM entity_concentration')?.n ?? 0,
  mayhemFacts: one<{ n: number }>('SELECT COUNT(*) n FROM mayhem_facts')?.n ?? 0,
  cohorts: q<{ cohort: string; n: number }>(
    'SELECT cohort, COUNT(*) n FROM shadow_positions WHERE cohort IS NOT NULL GROUP BY 1',
  ),
  selectionArms: q<{ arm: string; n: number }>(
    'SELECT selection_arm arm, COUNT(*) n FROM screenings WHERE selection_arm IS NOT NULL GROUP BY 1',
  ),
  tournamentArms: q<{ e: string; x: string; n: number }>(
    'SELECT tournament_entry_arm e, tournament_exit_arm x, COUNT(*) n FROM shadow_positions WHERE tournament_entry_arm IS NOT NULL GROUP BY 1,2',
  ),
  /** The headline the directive states: zero valid completed production trajectories. */
  closedPositions: one<{ n: number }>("SELECT COUNT(*) n FROM positions WHERE state = 'CLOSED'")?.n ?? 0,
  closedShadowsPreP6:
    one<{ n: number }>(
      "SELECT COUNT(*) n FROM shadow_positions WHERE state='POSITION_CLOSED' AND fill_latency_ms IS NULL",
    )?.n ?? 0,
  closedShadowsPostP6:
    one<{ n: number }>(
      "SELECT COUNT(*) n FROM shadow_positions WHERE state='POSITION_CLOSED' AND fill_latency_ms IS NOT NULL",
    )?.n ?? 0,
};

live.close();

console.log(`open positions ${state.openPositions}, holding tokens ${state.positionsHoldingTokens}`);
console.log(`shadows holding tokens ${state.shadowsHoldingTokens}`);

console.log(`\ncopying to ${backupPath} ...`);
const src = new DatabaseSync(dbPath, { readOnly: true });
// VACUUM INTO produces a WAL-consistent copy: it reads one transaction's view
// and writes a fresh, defragmented database with no WAL of its own.
src.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
src.close();

const bytes = statSync(backupPath).size;
const hash = await sha256(backupPath);

console.log('verifying the COPY...');
const copy = new DatabaseSync(backupPath, { readOnly: true });
const integrity = (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
const fkRows = copy.prepare('PRAGMA foreign_key_check').all() as unknown[];

const copyCounts: Record<string, number> = {};
for (const t of TABLES) copyCounts[t] = countOf(copy, t);
const mismatches = TABLES.filter((t) => liveCounts[t] !== copyCounts[t]).map((t) => ({
  table: t,
  live: liveCounts[t] ?? -1,
  copy: copyCounts[t] ?? -1,
}));

const witness = {
  positionsHoldingTokens:
    (copy.prepare("SELECT COUNT(*) n FROM positions WHERE CAST(token_amount AS INTEGER) > 0").get() as { n: number })
      .n,
  shadowsHoldingTokens:
    (
      copy
        .prepare("SELECT COUNT(*) n FROM shadow_positions WHERE CAST(token_amount AS INTEGER) > 0")
        .get() as { n: number }
    ).n,
};
copy.close();

const git = (cmd: string): string => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};

const summary = {
  generatedUtcMs: Date.now(),
  sourceCommit: git('git rev-parse HEAD'),
  auditedHead: '1c499cdf0d2b5381f31e1ffe842eb32d16101846',
  matchesAuditedHead: git('git rev-parse HEAD') === '1c499cdf0d2b5381f31e1ffe842eb32d16101846',
  dirty: git('git status --porcelain').length > 0,
  unpushed: Number(git('git rev-list --count origin/master..HEAD') || '0'),
  node: process.version,
  backup: { path: backupPath, bytes, sha256: hash, integrity, foreignKeyViolations: fkRows.length },
  tables: TABLES.length,
  countMismatches: mismatches,
  readBackWitness: witness,
  liveCounts,
  state,
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/baseline-1c499cd.json', JSON.stringify(summary, null, 2));

console.log(`\nbytes      ${bytes.toLocaleString()}`);
console.log(`sha256     ${hash}`);
console.log(`integrity  ${integrity}   fk violations ${fkRows.length}`);
console.log(`mismatch   ${mismatches.length === 0 ? 'none' : JSON.stringify(mismatches)}`);
console.log(`witness    ${witness.positionsHoldingTokens} positions / ${witness.shadowsHoldingTokens} shadows holding tokens`);
console.log(`\nschema v${state.schemaVersion}  observations ${state.observations}  screenings ${state.screenings}`);
console.log(`closed positions ${state.closedPositions}  shadows pre-P6 ${state.closedShadowsPreP6} post-P6 ${state.closedShadowsPostP6}`);
console.log('\nartifacts/baseline-1c499cd.json');
