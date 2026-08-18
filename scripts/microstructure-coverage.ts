/**
 * `pnpm microstructure:coverage` — how much of the pre-migration history we
 * actually hold, and which features it produced.
 *
 * The number that matters is not "how many mints have a feature row". It is
 * FIELD-LEVEL coverage: a row whose history stopped short carries nulls for
 * every creation-anchored total, and a policy requiring those fields is
 * NOT_EVALUABLE on it however many rows exist.
 *
 * Reporting rows rather than fields is how a feature layer looks finished while
 * the policies that depend on it still cannot decide.
 */
import { openDb } from '../packages/storage/src/db.js';
import {
  MICROSTRUCTURE_FEATURE_VERSION,
  microstructureFieldNames,
} from '../packages/intelligence/src/migration-microstructure.js';
import { writeArtifact, writeNotRun, researchContext } from './_artifact.js';

const SAMPLE_QUERY = `SELECT mint, coverage, features FROM migration_microstructure_features WHERE feature_version = ?`;

function main(): void {
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db' });
  try {
    let rows: { mint: string; coverage: string; features: string }[] = [];
    try {
      rows = db.prepare(SAMPLE_QUERY).all(MICROSTRUCTURE_FEATURE_VERSION) as typeof rows;
    } catch (e) {
      console.error(`migration_microstructure_features is unreadable: ${(e as Error).message}`);
    }

    const fields = microstructureFieldNames();

    if (rows.length === 0) {
      console.log(`no ${MICROSTRUCTURE_FEATURE_VERSION} feature rows exist yet.`);
      console.log('');
      console.log('NOT_RUN. Every field below has coverage UNKNOWN, which is not the same as 0%:');
      console.log(`  ${fields.length} fields defined, 0 mints characterised.`);
      const p = writeNotRun('microstructure-coverage.json', 'no feature rows for this feature version', {
        featureVersion: MICROSTRUCTURE_FEATURE_VERSION,
        fieldsDefined: fields.length,
        context: researchContext(db, SAMPLE_QUERY, { microstructure: MICROSTRUCTURE_FEATURE_VERSION }),
      });
      console.log(`-> ${p}`);
      return;
    }

    const complete = rows.filter((r) => r.coverage === 'COMPLETE').length;
    const perField: Record<string, number> = {};
    for (const f of fields) perField[f] = 0;
    for (const r of rows) {
      const parsed = JSON.parse(r.features) as Record<string, unknown>;
      for (const f of fields) if (parsed[f] !== null && parsed[f] !== undefined) perField[f] = (perField[f] ?? 0) + 1;
    }

    console.log(`migration microstructure — ${MICROSTRUCTURE_FEATURE_VERSION}\n`);
    console.log(`  mints characterised   ${rows.length}`);
    console.log(`  COMPLETE history      ${complete}  (${((complete / rows.length) * 100).toFixed(1)}%)`);
    console.log(`  INCOMPLETE history    ${rows.length - complete}`);
    console.log('');
    console.log('  field coverage (non-null / mints):');
    const sorted = Object.entries(perField).sort((a, b) => a[1] - b[1]);
    for (const [f, n] of sorted) {
      const pct = (n / rows.length) * 100;
      console.log(`    ${String(n).padStart(5)}/${rows.length}  ${pct.toFixed(0).padStart(3)}%  ${f}`);
    }

    const p = writeArtifact('microstructure-coverage.json', {
      status: 'MEASURED',
      featureVersion: MICROSTRUCTURE_FEATURE_VERSION,
      mints: rows.length,
      completeHistories: complete,
      fieldCoverage: perField,
      context: researchContext(db, SAMPLE_QUERY, { microstructure: MICROSTRUCTURE_FEATURE_VERSION }),
    });
    console.log(`\n-> ${p}`);
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes('microstructure-coverage')) main();
