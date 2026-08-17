/**
 * `pnpm evidence:blob-check` — is every registered blob still what its key says?
 *
 * P3.1 requires that a blob be READ BACK before it is marked durable. That is
 * done at write time. This command re-asks the question later, because the
 * failure mode it guards against — silent corruption of a research corpus —
 * is one that would otherwise be discovered years afterwards and explain
 * nothing.
 *
 * Every blob is re-read and re-hashed against the key it is stored under. A
 * mismatch is not a warning: everything referencing that blob is unverifiable,
 * and so is every number derived from it.
 */
import { openDb } from '../packages/storage/src/db.js';
import { EvidenceStore } from '../packages/storage/src/evidence-repo.js';
import { writeArtifact } from './_artifact.js';

function main(): void {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg === undefined ? Number.MAX_SAFE_INTEGER : Number(limitArg.slice(8));
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db', skipBackup: true });

  try {
    const store = new EvidenceStore(db, 'data/evidence-blobs');
    const registered = Number(
      (db.prepare('SELECT COUNT(*) AS c FROM evidence_blobs').get() as { c: number | bigint }).c,
    );
    const unverified = Number(
      (
        db.prepare('SELECT COUNT(*) AS c FROM evidence_blobs WHERE readback_verified <> 1').get() as {
          c: number | bigint;
        }
      ).c,
    );

    const byKind = db
      .prepare('SELECT kind, COUNT(*) AS n, SUM(byte_length) AS bytes FROM evidence_blobs GROUP BY kind ORDER BY n DESC')
      .all() as { kind: string; n: number; bytes: number }[];

    console.log(`registered blobs   : ${registered}`);
    console.log(`never read back    : ${unverified}`);
    for (const k of byKind) {
      console.log(`  ${String(k.n).padStart(6)}  ${k.kind.padEnd(22)} ${(k.bytes ?? 0).toLocaleString()} bytes`);
    }

    if (registered === 0) {
      console.log('\nNo blob has been written. Nothing to verify, and nothing is proved by that.');
      writeArtifact('evidence-blob-check.json', {
        status: 'NOT_RUN',
        reason: 'no evidence blob has been written yet',
        registered: 0,
      });
      process.exit(1);
    }

    console.log('\nre-reading and re-hashing …');
    const result = store.verifyAll(limit);

    console.log(`checked            : ${result.checked}`);
    console.log(`missing from disk  : ${result.missing.length}`);
    console.log(`hash mismatch      : ${result.corrupt.length}`);
    for (const h of result.missing.slice(0, 10)) console.log(`  MISSING  ${h}`);
    for (const h of result.corrupt.slice(0, 10)) console.log(`  CORRUPT  ${h}`);

    const ok = result.missing.length === 0 && result.corrupt.length === 0 && unverified === 0;
    const artifact = writeArtifact('evidence-blob-check.json', {
      registered,
      neverReadBack: unverified,
      byKind,
      checked: result.checked,
      missing: result.missing,
      corrupt: result.corrupt,
      verdict: ok ? 'ALL_DURABLE' : 'NOT_DURABLE',
    });

    console.log(`\nverdict: ${ok ? 'ALL DURABLE' : 'NOT DURABLE'}`);
    console.log(`-> ${artifact}`);
    process.exit(ok ? 0 : 1);
  } finally {
    db.close();
  }
}

main();
