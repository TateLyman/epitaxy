import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';

/**
 * `pnpm shadow:status` / `pnpm cohort:status` / `pnpm reject:status`
 *
 * P10, P15, P16. One script, three artifacts, because they answer one question
 * from three angles: what does the corpus actually contain, and how much of it
 * is evidence about anything?
 *
 * Every count is broken out by EVIDENCE CLASS and the classes are never
 * aggregated. A structural shadow and an effect-verified one are not two of the
 * same thing, and adding them produces a number that describes neither.
 *
 * Read-only.
 */

const db = openDb({ path: loadSecrets().databasePath, readonly: true });
const which = process.argv[2] ?? 'all';

/**
 * The evidence class a shadow position qualifies for.
 *
 * Derived from the simulation jobs behind its own two legs, not asserted. A
 * shadow cannot be a better class than the runs that produced it.
 */
const SHADOW_CLASS_SQL = `
  SELECT s.book,
         CASE
           WHEN je.validity IS NULL OR je.validity = 'INSTRUMENT_DEVELOPMENT'
             OR jx.validity IS NULL OR jx.validity = 'INSTRUMENT_DEVELOPMENT'
             THEN 'STRUCTURAL_ONLY'
           WHEN je.simulated_effect_ok = 1 AND jx.simulated_effect_ok = 1
             AND je.mode = 'CONFIRMATORY_OFFLINE' AND jx.mode = 'CONFIRMATORY_OFFLINE'
             AND je.confirmatory = 1 AND jx.confirmatory = 1
             THEN 'CONFIRMATORY'
           WHEN je.simulated_effect_ok = 1 AND jx.simulated_effect_ok = 1
             AND je.mode = 'CONFIRMATORY_OFFLINE' AND jx.mode = 'CONFIRMATORY_OFFLINE'
             THEN 'OFFLINE_REPRODUCIBLE'
           WHEN je.simulated_effect_ok = 1 AND jx.simulated_effect_ok = 1
             THEN 'JIT_EFFECT_VALID'
           ELSE 'STRUCTURAL_ONLY'
         END AS evidence_class,
         COUNT(*) AS n,
         SUM(CASE WHEN s.closed_utc_ms IS NOT NULL THEN 1 ELSE 0 END) AS closed
  FROM shadow_positions s
  LEFT JOIN simulation_jobs je ON je.execution_observation_id = s.entry_observation_id
  LEFT JOIN simulation_jobs jx ON jx.execution_observation_id = s.entry_sell_observation_id
  GROUP BY 1, 2
  ORDER BY 1, 2
`;

interface ShadowRow {
  book: string;
  evidence_class: string;
  n: number;
  closed: number;
}

function shadows(): unknown {
  const rows = db.prepare(SHADOW_CLASS_SQL).all() as unknown as ShadowRow[];
  console.log('shadow positions by book and evidence class\n');
  console.log('book            class                 total  closed');
  for (const r of rows) {
    console.log(
      `${r.book.padEnd(15)} ${r.evidence_class.padEnd(21)} ${String(r.n).padStart(5)}  ${String(r.closed).padStart(6)}`,
    );
  }

  const marks = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN route_available = 1 THEN 1 ELSE 0 END) AS routed,
              SUM(CASE WHEN executable_value_lamports IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM shadow_marks`,
    )
    .get() as { n: number; routed: number; unpriced: number };
  console.log(`\nshadow marks: ${marks.n} total, ${marks.routed} with a route, ${marks.unpriced} unpriced`);

  const blocked = db
    .prepare("SELECT COUNT(*) AS n FROM shadow_positions WHERE state = 'EXIT_BLOCKED'")
    .get() as { n: number };
  console.log(`exit-blocked shadows: ${blocked.n}`);

  const refusal = db
    .prepare(
      `SELECT COALESCE(portfolio_refusal, '(portfolio accepted)') AS reason, COUNT(*) AS n
       FROM shadow_positions GROUP BY 1 ORDER BY n DESC LIMIT 8`,
    )
    .all() as { reason: string; n: number }[];
  console.log('\nwhy the realizable portfolio did not take the signal:');
  for (const r of refusal) console.log(`  ${String(r.n).padStart(5)}  ${r.reason.slice(0, 80)}`);

  return { byClass: rows, marks, blockedShadows: blocked.n, portfolioRefusals: refusal };
}

function cohorts(): unknown {
  const rows = db
    .prepare(
      `SELECT COALESCE(cohort, '(unassigned)') AS cohort,
              COUNT(*) AS n,
              SUM(CASE WHEN closed_utc_ms IS NOT NULL THEN 1 ELSE 0 END) AS closed,
              MIN(token_age_ms_at_open) AS min_age_ms,
              MAX(token_age_ms_at_open) AS max_age_ms
       FROM shadow_positions GROUP BY 1 ORDER BY n DESC`,
    )
    .all() as { cohort: string; n: number; closed: number; min_age_ms: number | null; max_age_ms: number | null }[];

  console.log('\nage cohorts (shadow positions)\n');
  console.log('cohort            total  closed   age range at open');
  for (const r of rows) {
    const range =
      r.min_age_ms === null || r.max_age_ms === null
        ? 'unknown'
        : `${Math.round(r.min_age_ms / 60_000)}-${Math.round(r.max_age_ms / 60_000)} min`;
    console.log(`${r.cohort.padEnd(17)} ${String(r.n).padStart(5)}  ${String(r.closed).padStart(6)}   ${range}`);
  }

  const unassigned = rows.find((r) => r.cohort === '(unassigned)')?.n ?? 0;
  if (unassigned > 0) {
    console.log(
      `\n  ${unassigned} position(s) carry no cohort. Unassigned is NOT a cohort: a row that\n` +
        '  cannot say which arm it belongs to cannot be compared against the others.',
    );
  }
  return rows;
}

function rejects(): unknown {
  const rows = db
    .prepare(
      `SELECT COALESCE(outcome, '(unclassified)') AS outcome, COUNT(*) AS n
       FROM reject_tracking GROUP BY 1 ORDER BY n DESC`,
    )
    .all() as { outcome: string; n: number }[];

  console.log('\nreject outcomes\n');
  const total = rows.reduce((a, r) => a + r.n, 0);
  for (const r of rows) {
    const pct = total === 0 ? 0 : (r.n / total) * 100;
    console.log(`  ${r.outcome.padEnd(24)} ${String(r.n).padStart(7)}  ${pct.toFixed(1)}%`);
  }

  const byReason = db
    .prepare(
      `SELECT primary_reason, COUNT(*) AS n,
              SUM(CASE WHEN outcome = 'EXECUTABLE_VALUE' THEN 1 ELSE 0 END) AS still_tradeable
       FROM reject_tracking GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    )
    .all() as { primary_reason: string; n: number; still_tradeable: number }[];
  console.log('\ntop rejection reasons, and how often the token was still tradeable after:');
  for (const r of byReason) {
    console.log(
      `  ${r.primary_reason.padEnd(30)} ${String(r.n).padStart(7)}  still tradeable ${r.still_tradeable}`,
    );
  }

  const unclassified = rows.find((r) => r.outcome === '(unclassified)')?.n ?? 0;
  if (unclassified > 0) {
    console.log(
      `\n  ${unclassified} row(s) predate the classifier. NULL is not 'UNKNOWN': one says nobody\n` +
        '  has looked, the other says somebody looked and could not tell.',
    );
  }
  return { byOutcome: rows, byReason };
}

mkdirSync('artifacts', { recursive: true });
const stamp = Date.now();

if (which === 'shadow' || which === 'all') {
  writeFileSync('artifacts/shadow-status.json', `${JSON.stringify({ generatedUtcMs: stamp, shadows: shadows() }, null, 2)}\n`);
  console.log('\nwrote artifacts/shadow-status.json');
}
if (which === 'cohort' || which === 'all') {
  writeFileSync('artifacts/cohort-status.json', `${JSON.stringify({ generatedUtcMs: stamp, cohorts: cohorts() }, null, 2)}\n`);
  console.log('wrote artifacts/cohort-status.json');
}
if (which === 'reject' || which === 'all') {
  writeFileSync('artifacts/reject-status.json', `${JSON.stringify({ generatedUtcMs: stamp, rejects: rejects() }, null, 2)}\n`);
  console.log('wrote artifacts/reject-status.json');
}

db.close();
