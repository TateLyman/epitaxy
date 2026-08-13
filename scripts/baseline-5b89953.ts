import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import {
  PROVENANCE_VERSION,
  PAPER_ENGINE_VERSION,
  QUOTE_ADAPTER_VERSION,
  COST_ACCOUNTING_VERSION,
  SIMULATOR_VERSION,
  EFFECT_VERIFICATION_VERSION,
  strategyConfigHash,
  riskPolicyHash,
  dataRegimeId,
} from '../packages/domain/src/provenance.js';
import { schemaVersion } from '../packages/storage/src/db.js';

/**
 * `pnpm baseline` — P0. What this machine actually held before anything changed.
 *
 * GitHub shows committed `master`. It does not show the live tree, the SQLite
 * and WAL files, the running daemon, or the exposure the corpus is carrying.
 * A repair that begins without recording those is a repair nobody can undo.
 *
 * Read-only.
 */

const secrets = loadSecrets();
const config = loadConfig();
const db = openDb({ path: secrets.databasePath, readonly: true });

const q = <T>(sql: string, params: unknown[] = []): T[] => {
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } catch (e) {
    return [{ error: (e as Error).message } as unknown as T];
  }
};
const one = <T>(sql: string): T | null => (q<T>(sql)[0] ?? null);

const sh = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch (e) {
    return `(failed: ${(e as Error).message.slice(0, 80)})`;
  }
};

const baseline = {
  takenAtUtcMs: Date.now(),
  repoPath: process.cwd(),
  head: sh('git rev-parse HEAD'),
  auditedHead: '5b89953e48f26c1f6eef35c990ae70100a0b68a7',
  headMatchesAudited: sh('git rev-parse HEAD') === '5b89953e48f26c1f6eef35c990ae70100a0b68a7',
  branch: sh('git branch --show-current'),
  dirty: sh('git status --porcelain').split('\n').filter((l) => l.trim() !== ''),
  node: process.version,

  versions: {
    PROVENANCE_VERSION,
    PAPER_ENGINE_VERSION,
    QUOTE_ADAPTER_VERSION,
    COST_ACCOUNTING_VERSION,
    SIMULATOR_VERSION,
    EFFECT_VERIFICATION_VERSION,
    schemaVersion: schemaVersion(db),
  },
  hashes: {
    strategyConfigHash: strategyConfigHash(config),
    riskPolicyHash: riskPolicyHash(config),
    dataRegimeId: dataRegimeId(config, schemaVersion(db)),
  },

  storage: {
    databasePath: secrets.databasePath,
    bytes: (() => {
      try {
        return statSync(secrets.databasePath).size;
      } catch {
        return null;
      }
    })(),
    walBytes: (() => {
      try {
        return statSync(`${secrets.databasePath}-wal`).size;
      } catch {
        return null;
      }
    })(),
  },

  // ---- the corpus, by every axis the directive names -------------------
  simulationJobs: q(
    `SELECT s.validity, o.side, o.purpose, s.status,
            CASE WHEN s.simulated_effect_ok = 1 THEN 'EFFECT_OK'
                 WHEN s.simulated_effect_ok = 0 THEN 'EFFECT_REFUSED'
                 ELSE 'NOT_CHECKED' END AS effect,
            COUNT(*) AS n
     FROM simulation_jobs s
     LEFT JOIN execution_observations o ON o.observation_id = s.execution_observation_id
     GROUP BY 1,2,3,4,5 ORDER BY n DESC`,
  ),
  observationsByEffect: q('SELECT simulation_effect, COUNT(*) AS n FROM execution_observations GROUP BY 1'),
  shadowsByClass: q('SELECT book, evidence_class, state, COUNT(*) AS n FROM shadow_positions GROUP BY 1,2,3'),
  marksBySource: q('SELECT mark_source, decision_bearing, COUNT(*) AS n FROM position_marks GROUP BY 1,2'),
  cohorts: q('SELECT cohort, cohort_source, COUNT(*) AS n FROM shadow_positions GROUP BY 1,2'),
  rejects: q('SELECT outcome, COUNT(*) AS n FROM reject_tracking GROUP BY 1'),

  // ---- EXPOSURE. The one thing that must not be lost -------------------
  openPositionsWithTokens: q(
    `SELECT position_id, mint, state, token_amount, cost_lamports, opened_utc_ms, exit_blocked_since_utc_ms
     FROM positions
     WHERE closed_utc_ms IS NULL AND CAST(token_amount AS INTEGER) > 0`,
  ),
  openOrBlockedShadows: q(
    `SELECT book, state, COUNT(*) AS n FROM shadow_positions
     WHERE closed_utc_ms IS NULL OR state = 'EXIT_BLOCKED' GROUP BY 1,2`,
  ),

  latest: {
    observation: one('SELECT observation_id, mint, side, received_utc_ms FROM execution_observations ORDER BY received_utc_ms DESC LIMIT 1'),
    simulationJob: one('SELECT job_id, status, validity, requested_utc_ms FROM simulation_jobs ORDER BY requested_utc_ms DESC LIMIT 1'),
    mark: one('SELECT mark_id, mint, mark_source, observed_utc_ms FROM position_marks ORDER BY observed_utc_ms DESC LIMIT 1'),
    healthEvent: one('SELECT kind, severity, utc_ms FROM health_events ORDER BY utc_ms DESC LIMIT 1'),
    runContext: one('SELECT context_hash, source_commit, last_seen_utc_ms FROM run_contexts ORDER BY last_seen_utc_ms DESC LIMIT 1'),
  },

  tableCounts: Object.fromEntries(
    (q<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((t) => [
      t.name,
      (one<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t.name}"`))?.n ?? null,
    ]),
  ),

  integrity: {
    integrityCheck: one<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check ?? 'unknown',
    foreignKeyViolations: q('PRAGMA foreign_key_check').length,
  },
};

console.log(`HEAD ${baseline.head}`);
console.log(`matches audited 5b89953: ${baseline.headMatchesAudited ? 'YES' : 'NO'}`);
console.log(`dirty: ${baseline.dirty.length === 0 ? 'clean' : baseline.dirty.join(', ')}`);
console.log(`schema ${baseline.versions.schemaVersion}   regime ${baseline.hashes.dataRegimeId}`);
console.log(
  `db ${((baseline.storage.bytes ?? 0) / 1024 / 1024 / 1024).toFixed(2)} GB   ` +
    `wal ${((baseline.storage.walBytes ?? 0) / 1024 / 1024).toFixed(1)} MB`,
);
console.log(`integrity ${baseline.integrity.integrityCheck}   fk violations ${baseline.integrity.foreignKeyViolations}`);

console.log('\nEXPOSURE');
console.log(`  portfolio positions holding tokens: ${baseline.openPositionsWithTokens.length}`);
for (const p of baseline.openPositionsWithTokens as Record<string, unknown>[]) {
  console.log(`    ${String(p['mint']).slice(0, 12)} ${p['state']} tokens=${p['token_amount']} cost=${p['cost_lamports']}`);
}
console.log('  open/blocked shadows:');
for (const r of baseline.openOrBlockedShadows as Record<string, unknown>[]) {
  console.log(`    ${r['book']} ${r['state']} ${r['n']}`);
}

console.log('\nSIMULATION JOBS');
for (const r of baseline.simulationJobs as Record<string, unknown>[]) {
  console.log(
    `  ${String(r['validity'] ?? 'null').padEnd(24)} ${String(r['side'] ?? '?').padEnd(5)} ` +
      `${String(r['status']).padEnd(20)} ${String(r['effect']).padEnd(14)} ${r['n']}`,
  );
}

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/baseline-5b89953.json', `${JSON.stringify(baseline, null, 2)}\n`);
console.log('\nwrote artifacts/baseline-5b89953.json');
db.close();
