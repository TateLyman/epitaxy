import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';

/**
 * `pnpm rate:budget` — P21. Whether 1 RPS is actually the constraint.
 *
 * The Developer plan is $25/month for 10 RPS. The question is not whether more
 * throughput would be nice; it is whether the rate limit is *currently*
 * reducing valid labels. Those are different questions and only the second
 * justifies spending money.
 *
 * The order matters and is the directive's:
 *
 *   1. eliminate duplicate calls
 *   2. enforce backlog admission
 *   3. THEN measure whether the limit binds
 *
 * Buying throughput before (1) and (2) buys a higher rate of the same waste.
 *
 * Read-only.
 */

const db = openDb({ path: loadSecrets().databasePath, readonly: true });
const WINDOW_MS = Number(process.env['RATE_WINDOW_MS'] ?? 3_600_000);
const since = Date.now() - WINDOW_MS;

const q = <T>(sql: string, params: unknown[] = []): T[] => {
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } catch {
    return [];
  }
};
const one = <T>(sql: string, params: unknown[] = []): T | null => q<T>(sql, params)[0] ?? null;

// ---- calls by purpose ---------------------------------------------------
const byPurpose = q<{ purpose: string; n: number }>(
  `SELECT COALESCE(purpose,'(none)') AS purpose, COUNT(*) AS n
   FROM execution_observations WHERE received_utc_ms > ? GROUP BY 1 ORDER BY n DESC`,
  [since],
);
const totalCalls = byPurpose.reduce((a, r) => a + r.n, 0);

/**
 * DUPLICATE calls: the same mint, side and purpose within one second.
 *
 * These are the first thing to remove, because they consume the budget and
 * return a fact the corpus already holds. Buying throughput to serve them
 * faster is buying a higher rate of the same waste.
 */
const duplicates = one<{ n: number }>(
  `SELECT COUNT(*) AS n FROM (
     SELECT mint, side, purpose, CAST(received_utc_ms/1000 AS INTEGER) AS sec, COUNT(*) AS c
     FROM execution_observations WHERE received_utc_ms > ?
     GROUP BY 1,2,3,4 HAVING c > 1
   )`,
  [since],
)?.n ?? 0;

// ---- mark lag -----------------------------------------------------------
const lags = q<{ gap: number }>(
  `SELECT observed_utc_ms - LAG(observed_utc_ms) OVER (PARTITION BY position_id ORDER BY seq) AS gap
   FROM position_marks WHERE observed_utc_ms > ?`,
  [since],
)
  .map((r) => r.gap)
  .filter((g): g is number => g !== null && Number.isFinite(g))
  .sort((a, b) => a - b);

const pct = (p: number): number | null =>
  lags.length === 0 ? null : (lags[Math.min(lags.length - 1, Math.floor(lags.length * p))] ?? null);

// ---- pressure signals ---------------------------------------------------
const health = (kind: string): number =>
  one<{ n: number }>('SELECT COUNT(*) AS n FROM health_events WHERE kind = ? AND utc_ms > ?', [kind, since])?.n ?? 0;

const rateLimited = health('source_fetch_error') + health('ratelimit_refused');
const backlog = health('shadow_mark_backlog');
const skipped = health('shadow_admission_refused');

// ---- what the budget is BUYING -----------------------------------------
const validLabels =
  one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM simulation_jobs
     WHERE requested_utc_ms > ? AND validity LIKE 'VALID_%' AND simulated_effect_ok = 1`,
    [since],
  )?.n ?? 0;

const hours = WINDOW_MS / 3_600_000;
const callsPerSecond = totalCalls / (WINDOW_MS / 1000);
const labelsPerDay = (validLabels / hours) * 24;

console.log(`rate budget over the last ${hours.toFixed(1)}h\n`);
console.log(`  observations           ${totalCalls}  (${callsPerSecond.toFixed(3)}/s)`);
console.log(`  duplicate call groups  ${duplicates}`);
console.log('\n  by purpose:');
for (const r of byPurpose.slice(0, 8)) console.log(`    ${r.purpose.padEnd(24)} ${r.n}`);

console.log('\n  mark lag ms:');
console.log(`    p50 ${pct(0.5) ?? 'n/a'}   p95 ${pct(0.95) ?? 'n/a'}   max ${lags[lags.length - 1] ?? 'n/a'}`);

console.log('\n  pressure:');
console.log(`    rate-limit events      ${rateLimited}`);
console.log(`    backlog warnings       ${backlog}`);
console.log(`    admissions refused     ${skipped}`);

console.log('\n  what the budget bought:');
console.log(`    effect-verified labels ${validLabels}  (${labelsPerDay.toFixed(1)}/day at this rate)`);

/**
 * The three conditions, all of which must hold.
 *
 * Stated as a machine check rather than a judgement, so the answer cannot drift
 * with how anyone feels about waiting.
 */
const generatorCorrect = validLabels > 0;
const limitBinds = rateLimited > 0 || backlog > 0;
const duplicatesEliminated = duplicates === 0;

console.log('\n  upgrade conditions:');
console.log(`    label generator produces valid labels   ${generatorCorrect ? 'YES' : 'NO'}`);
console.log(`    duplicates eliminated first             ${duplicatesEliminated ? 'YES' : `NO (${duplicates} groups)`}`);
console.log(`    1 RPS demonstrably binding              ${limitBinds ? 'YES' : 'NO'}`);

const justified = generatorCorrect && duplicatesEliminated && limitBinds;
console.log(`\n  Developer plan ($25/mo, 10 RPS)  ${justified ? 'JUSTIFIED' : 'NOT JUSTIFIED'}`);
if (!justified && !generatorCorrect) {
  console.log('    Buying throughput now buys a higher rate of measurements that are');
  console.log('    not yet known to measure anything.');
}
if (!justified && generatorCorrect && !duplicatesEliminated) {
  console.log('    Duplicate calls consume the budget and return facts the corpus already');
  console.log('    holds. Remove them before paying to serve them faster.');
}

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/rate-budget.json',
  `${JSON.stringify(
    {
      generatedUtcMs: Date.now(),
      windowMs: WINDOW_MS,
      totalCalls,
      callsPerSecond,
      duplicateGroups: duplicates,
      byPurpose,
      markLagMs: { p50: pct(0.5), p95: pct(0.95), max: lags[lags.length - 1] ?? null, samples: lags.length },
      rateLimitEvents: rateLimited,
      backlogWarnings: backlog,
      admissionsRefused: skipped,
      effectVerifiedLabels: validLabels,
      labelsPerDay,
      upgrade: { generatorCorrect, duplicatesEliminated, limitBinds, justified },
    },
    null,
    2,
  )}\n`,
);
console.log('\nwrote artifacts/rate-budget.json');
db.close();
