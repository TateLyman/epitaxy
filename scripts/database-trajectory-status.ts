import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { sourceCommit } from '../packages/domain/src/provenance.js';
import { openDb } from '../packages/storage/src/db.js';

/**
 * P12 — `pnpm trajectory:status`, and NOTHING but database trajectory rows.
 *
 * F2 is the reason this file exists. The old status read
 * `artifacts/live-one-pass-trajectory.json`, called its immediate round trips
 * "completed trajectories", and reported zero `development_trajectories` rows
 * alongside them as an intentional distinction. A reader saw "20 completed" and
 * a footnote.
 *
 * A proof file is not the database. This command opens the database, counts
 * rows, and has no code path that can read an artifact — so no artifact can
 * ever inflate it. If the corpus is empty it says zero, which is the correct
 * and useful answer.
 */

const s = loadSecrets();
const db = openDb({ path: s.databasePath, readonly: true });

const one = <T>(sql: string, fallback: T): T => {
  try {
    return (db.prepare(sql).get() as Record<string, T>)['v'] ?? fallback;
  } catch {
    // A table that does not exist yet is zero rows, not a crash. It is also
    // NOT the same as a table with no rows, so the shape is reported below.
    return fallback;
  }
};

const rows = <T>(sql: string): T[] => {
  try {
    return db.prepare(sql).all() as T[];
  } catch {
    return [];
  }
};

const byState = rows<{ state: string; c: number }>(
  'SELECT state, COUNT(*) c FROM development_trajectories GROUP BY state',
);
const byStratum = rows<{ stratum: string; c: number }>(
  'SELECT stratum, COUNT(*) c FROM development_trajectories GROUP BY stratum',
);
const marksByOffset = rows<{ offset_ms: number; c: number; late: number }>(
  `SELECT offset_ms, COUNT(*) c, SUM(CASE WHEN lateness_ms > 120000 THEN 1 ELSE 0 END) late
     FROM trajectory_marks GROUP BY offset_ms ORDER BY offset_ms`,
);
const outcomesByPolicy = rows<{ exit_policy: string; c: number }>(
  'SELECT exit_policy, COUNT(*) c FROM trajectory_policy_outcomes GROUP BY exit_policy',
);

const settled = one<number>("SELECT COUNT(*) v FROM development_trajectories WHERE state='SETTLED'", 0);
const total = one<number>('SELECT COUNT(*) v FROM development_trajectories', 0);
const plans = one<number>('SELECT COUNT(*) v FROM leg_account_plans', 0);

/**
 * A path whose marks were all fetched in one burst is not five horizons.
 *
 * The first live window settled eight paths that way: five labels and one
 * instant. Lateness is per mark and it is reported here rather than averaged
 * away, because a "15-minute mark" taken 90 minutes after entry represents that
 * horizon in name only.
 */
const timelyPaths = one<number>(
  `SELECT COUNT(*) v FROM (
     SELECT trajectory_id FROM trajectory_marks
      GROUP BY trajectory_id
     HAVING MAX(lateness_ms) <= 120000 AND COUNT(*) >= 5
   )`,
  0,
);

const out = {
  generatedUtcMs: Date.now(),
  sourceCommit: sourceCommit(),
  database: s.databasePath,
  what: 'development trajectories as the DATABASE has them. No artifact is read.',

  trajectories: { total, settled, byState: Object.fromEntries(byState.map((r) => [r.state, r.c])) },
  byStratum: Object.fromEntries(byStratum.map((r) => [r.stratum, r.c])),
  marksByOffsetMs: marksByOffset.map((r) => ({ offsetMs: r.offset_ms, marks: r.c, backfilled: r.late })),
  policyOutcomes: Object.fromEntries(outcomesByPolicy.map((r) => [r.exit_policy, r.c])),
  frozenAccountPlans: plans,

  /** Paths with five horizons, none of them backfilled. The real sample. */
  timelyCompletePaths: timelyPaths,

  /**
   * F2 — the artifact is named so it can be recognised, and counted as zero.
   *
   * `artifacts/live-one-pass-trajectory.json` holds immediate round trips.
   * They are TRUE_IMMEDIATE_SEQUENTIAL_INSTRUMENT evidence about mechanics and
   * they are not development trajectories: no later mark path, no policy
   * evaluation, no database row.
   */
  proofArtifactsCounted: 0,
  proofArtifactNote:
    'live-one-pass-trajectory.json is instrument evidence, never a trajectory. ' +
    'This command cannot read it.',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/trajectory-status.json', JSON.stringify(out, null, 2));

console.log(`database trajectories : ${total} (${settled} settled)`);
for (const r of byState) console.log(`  ${r.state.padEnd(26)} ${r.c}`);
console.log(`frozen account plans  : ${plans}`);
console.log('marks by horizon:');
for (const r of marksByOffset) {
  console.log(`  ${String(r.offset_ms / 60_000).padStart(3)}m  ${String(r.c).padStart(4)}  backfilled ${r.late}`);
}
console.log('policy outcomes:');
for (const r of outcomesByPolicy) console.log(`  ${r.exit_policy.padEnd(34)} ${r.c}`);
console.log(`timely complete paths : ${timelyPaths}`);
console.log(`proof artifacts counted: 0 (they are not trajectories)`);
console.log('wrote artifacts/trajectory-status.json');
