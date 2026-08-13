import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';

/**
 * `pnpm window:status` — what the repaired instrument has measured so far.
 *
 * Only `VALID_*` jobs are counted. The 108 `INSTRUMENT_DEVELOPMENT` jobs are
 * excluded by construction rather than by a filter someone has to remember to
 * apply, which is the difference between a label and a convention.
 */

const db = openDb({ path: loadSecrets().databasePath, readonly: true });

const bySide = db
  .prepare(
    `SELECT o.side, s.status, s.simulated_effect_ok AS effect, COUNT(*) AS n
     FROM simulation_jobs s
     JOIN execution_observations o ON o.observation_id = s.execution_observation_id
     WHERE s.validity LIKE 'VALID_%'
     GROUP BY 1,2,3 ORDER BY 1,2`,
  )
  .all() as { side: string; status: string; effect: number | null; n: number }[];

console.log('valid-window simulation jobs\n');
console.log('side  status              effectOk  n');
for (const r of bySide) {
  console.log(`${r.side.padEnd(5)} ${r.status.padEnd(19)} ${String(r.effect ?? 'null').padEnd(8)} ${r.n}`);
}

const totals = db
  .prepare(
    `SELECT validity, COUNT(*) AS n,
            SUM(CASE WHEN simulated_effect_ok = 1 THEN 1 ELSE 0 END) AS effect_ok
     FROM simulation_jobs GROUP BY 1`,
  )
  .all() as { validity: string | null; n: number; effect_ok: number }[];
console.log('\nby validity:');
for (const r of totals) {
  console.log(`  ${String(r.validity).padEnd(24)} ${String(r.n).padStart(4)}  effect-verified ${r.effect_ok}`);
}

const refusals = db
  .prepare(
    `SELECT effect_refusals, COUNT(*) AS n FROM simulation_jobs
     WHERE validity LIKE 'VALID_%' AND effect_refusals IS NOT NULL
     GROUP BY 1 ORDER BY n DESC LIMIT 6`,
  )
  .all() as { effect_refusals: string; n: number }[];
console.log('\nwhy the effect was refused:');
for (const r of refusals) console.log(`  ${String(r.n).padStart(3)}x  ${r.effect_refusals.slice(0, 120)}`);

const marks = db
  .prepare('SELECT mark_source, decision_bearing, COUNT(*) AS n FROM position_marks GROUP BY 1,2')
  .all() as { mark_source: string | null; decision_bearing: number | null; n: number }[];
console.log('\nmarks:');
for (const r of marks) {
  console.log(`  ${String(r.mark_source).padEnd(24)} decision-bearing=${r.decision_bearing}  ${r.n}`);
}

const ctx = db
  .prepare('SELECT source_commit, last_seen_utc_ms FROM run_contexts ORDER BY last_seen_utc_ms DESC LIMIT 3')
  .all() as { source_commit: string; last_seen_utc_ms: number }[];
console.log('\nrecent run contexts:');
for (const r of ctx) console.log(`  ${r.source_commit}  ${new Date(r.last_seen_utc_ms).toISOString()}`);

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/valid-window-status.json',
  `${JSON.stringify({ generatedUtcMs: Date.now(), bySide, totals, refusals, marks, contexts: ctx }, null, 2)}\n`,
);
console.log('\nwrote artifacts/valid-window-status.json');
db.close();
