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

  // `--as-version=` replays snapshots recorded under an OLDER strategy version
  // against today's code.
  //
  // Without it, a version bump makes replay silently verify nothing: every
  // stored snapshot is skipped, the run reports zero divergences, and the exit
  // code is the only thing distinguishing that from a real pass. That is
  // exactly backwards — a bump is the moment when the question "did anything
  // change that I did not intend to change?" most needs an answer.
  //
  // A pass here means the entry path is byte-identical for the old corpus, so
  // the bump is attributable to the parts that were meant to change. A failure
  // is a real finding and must be explained, not silenced by dropping the flag.
  const asVersionArg = process.argv.find((a) => a.startsWith('--as-version='));
  const asVersion = asVersionArg ? asVersionArg.slice('--as-version='.length) : null;

  const loaded = loadConfig(modeFromArgv());
  const config = asVersion === null ? loaded : { ...loaded, strategyVersion: asVersion };
  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath, readonly: true });

  const summary = replayAll(db, config, snapshotRows(db, limit));

  if (asVersion !== null) {
    console.log(`replaying snapshots stored as ${asVersion} against code version ${loaded.strategyVersion}`);
  }
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
