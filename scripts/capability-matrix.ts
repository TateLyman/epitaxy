import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { buildCapabilityMatrix, type ProgramSource } from '../packages/research/src/capability.js';
import { BlobStore, type ExactTransactionBlob } from '../packages/storage/src/blobstore.js';

/**
 * `pnpm capability:matrix` — P5. What can actually be simulated, by route shape.
 *
 * Read-only.
 */

const db = openDb({ path: loadSecrets().databasePath, readonly: true });
const blobs = new BlobStore();

/**
 * The programs each observation's transaction actually invokes.
 *
 * Cached by blob hash: two observations built from identical bytes are one
 * read, and 26,000 rows would otherwise be 26,000 gunzips.
 */
const cache = new Map<string, readonly string[] | null>();
const source: ProgramSource = {
  programsFor(_observationId, blobHash) {
    if (blobHash === null) return null;
    const hit = cache.get(blobHash);
    if (hit !== undefined) return hit;
    let programs: readonly string[] | null = null;
    try {
      const blob = blobs.get<ExactTransactionBlob>(blobHash);
      programs = [...new Set(blob.instructions.map((i) => i.programId))].sort();
    } catch {
      // A blob that cannot be read is an unknown, not an empty program list.
      programs = null;
    }
    cache.set(blobHash, programs);
    return programs;
  },
};

const matrix = buildCapabilityMatrix(db, source);

console.log('capability strata by route fingerprint\n');
console.log('fingerprint       obs   jitOK jitF  offOK offF  effOK  class                 route');
for (const r of matrix.slice(0, 25)) {
  console.log(
    `${r.fingerprint}  ${String(r.observations).padStart(4)}  ${String(r.jitOk).padStart(5)} ${String(r.jitFailed).padStart(4)}  ` +
      `${String(r.offlineOk).padStart(5)} ${String(r.offlineFailed).padStart(4)}  ${String(r.effectOk).padStart(5)}  ` +
      `${r.supportedEvidenceClass.padEnd(20)}  ${r.routeLabels.slice(0, 34)}`,
  );
}

const byClass = new Map<string, number>();
for (const r of matrix) byClass.set(r.supportedEvidenceClass, (byClass.get(r.supportedEvidenceClass) ?? 0) + r.observations);
console.log('\nobservations by supported evidence class:');
for (const [k, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${n}`);

const pump = matrix.filter((r) => /pump/i.test(r.routeLabels));
console.log(`\nPump-family fingerprints: ${pump.length}`);
for (const r of pump.slice(0, 6)) {
  console.log(`  ${r.fingerprint}  ${r.supportedEvidenceClass}  ${r.failureReason ?? ''}`);
}
if (pump.length === 0) {
  console.log('  none — a Pump-first window cannot begin until Pump routes are observed');
}

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/capability-matrix.json',
  `${JSON.stringify({ generatedUtcMs: Date.now(), fingerprints: matrix }, null, 2)}\n`,
);
console.log('\nwrote artifacts/capability-matrix.json');
db.close();
