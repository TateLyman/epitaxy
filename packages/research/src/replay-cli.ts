import { loadConfig, loadSecrets, modeFromArgv } from '../../domain/src/config.js';
import { openDb } from '../../storage/src/db.js';
import { replayAll, snapshotRows } from './replay.js';

/**
 * The command-line face of replay. All of the judgement lives in replay.ts;
 * this file decides only what to print and what exit code to leave behind.
 */

function main(): void {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 2000;

  const config = loadConfig(modeFromArgv());
  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath, readonly: true });

  const summary = replayAll(db, config, snapshotRows(db, limit));

  console.log(`replay strategy ${config.strategyVersion}`);
  console.log(`  snapshots examined   ${summary.examined}`);
  console.log(`  replayed             ${summary.replayed}`);
  console.log(`  skipped (other ver)  ${summary.skippedOtherVersion}`);
  console.log(`  threw                ${summary.threw}`);
  console.log(`  divergent snapshots  ${summary.divergentSnapshots}`);

  if (summary.mismatches.length > 0) {
    const byField = new Map<string, number>();
    for (const m of summary.mismatches) byField.set(m.field, (byField.get(m.field) ?? 0) + 1);
    console.log('\n  divergence by field:');
    for (const [f, n] of [...byField].sort((a, b) => b[1] - a[1])) console.log(`    ${f.padEnd(20)} ${n}`);

    console.log('\n  first 10:');
    for (const m of summary.mismatches.slice(0, 10)) {
      console.log(`    ${m.mint.slice(0, 12)}… ${m.field}: stored=${m.stored} replayed=${m.replayed}`);
    }
    console.error('\nreplay FAILED: a stored decision could not be reproduced from its snapshot.');
    process.exitCode = 1;
  } else if (summary.replayed === 0) {
    console.log('\nno snapshots at the current strategy version; nothing was verified.');
    process.exitCode = 1;
  } else {
    console.log('\nreplay OK: every decision reproduced exactly from its snapshot.');
  }
}

main();
