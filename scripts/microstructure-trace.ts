/**
 * `pnpm microstructure:trace -- --mint=<mint>` — one mint, end to end.
 *
 * Every other command in this phase aggregates. This one refuses to: it shows
 * the coverage record, the source-signature hash, and every field with its
 * value or its null, for a single token.
 *
 * That matters because aggregate coverage hides the shape of the failure. "68%
 * field coverage" is consistent with two very different worlds — most mints
 * mostly covered, or a third of mints fully covered and the rest empty — and
 * only the second explains why a policy still cannot decide.
 */
import { openDb } from '../packages/storage/src/db.js';
import { MICROSTRUCTURE_FEATURE_VERSION } from '../packages/intelligence/src/migration-microstructure.js';

function main(): void {
  const mint = (process.argv.find((a) => a.startsWith('--mint=')) ?? '').slice(7);
  if (mint === '') {
    console.error('usage: pnpm microstructure:trace -- --mint=<mint>');
    process.exit(2);
  }

  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db' });
  try {
    const cov = db
      .prepare(
        `SELECT * FROM migration_history_coverage WHERE mint = ? AND feature_version = ?`,
      )
      .get(mint, MICROSTRUCTURE_FEATURE_VERSION) as Record<string, unknown> | undefined;
    const feat = db
      .prepare(`SELECT * FROM migration_microstructure_features WHERE mint = ? AND feature_version = ?`)
      .get(mint, MICROSTRUCTURE_FEATURE_VERSION) as Record<string, unknown> | undefined;

    console.log(`microstructure trace — ${mint}`);
    console.log(`feature version      ${MICROSTRUCTURE_FEATURE_VERSION}\n`);

    if (cov === undefined && feat === undefined) {
      console.log('NO ROW. This mint has never had its pre-migration history fetched.');
      console.log('');
      console.log('That is a fact about the collector, not about the token: every smart-policy');
      console.log('input for it is null and every policy requiring one is NOT_EVALUABLE.');
      process.exit(1);
    }

    if (cov !== undefined) {
      console.log('history coverage');
      console.log(`  bonding curve       ${String(cov['bonding_curve'])}`);
      console.log(`  migration signature ${String(cov['migration_signature'])}`);
      console.log(`  migration slot      ${String(cov['migration_slot'])}`);
      console.log(`  reached creation    ${cov['reached_creation'] === 1 ? 'YES' : 'NO'}`);
      console.log(`  pages               ${String(cov['pages'])}`);
      console.log(`  transactions        ${String(cov['transactions_fetched'])} fetched, ${String(cov['transactions_failed'])} failed, ${String(cov['transactions_pruned'])} PRUNED`);
      console.log(`  coverage            ${String(cov['coverage'])}`);
      if (cov['coverage_reason'] !== null) console.log(`  reason              ${String(cov['coverage_reason'])}`);
      console.log(`  source sig hash     ${String(cov['source_signatures_hash']).slice(0, 24)}`);
      console.log('');
    }

    if (feat !== undefined) {
      const features = JSON.parse(String(feat['features'])) as Record<string, unknown>;
      const known = Object.entries(features).filter(([, v]) => v !== null);
      const unknown = Object.entries(features).filter(([, v]) => v === null);
      console.log(`features            ${known.length} known, ${unknown.length} unknown`);
      console.log(`features hash       ${String(feat['features_hash']).slice(0, 24)}`);
      console.log('');
      console.log('  KNOWN:');
      for (const [k, v] of known) console.log(`    ${k.padEnd(38)} ${String(v)}`);
      console.log('');
      console.log('  UNKNOWN (null, never zero):');
      for (const [k] of unknown) console.log(`    ${k}`);
    }
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes('microstructure-trace')) main();
