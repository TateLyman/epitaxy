import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { BlobStore } from './blobstore.js';
import { canonicalJson as canonicalJsonOf } from '../../domain/src/evidence-identity.js';

/**
 * THE EVIDENCE GRAPH WRITER.
 *
 * Three defects from the 8f73cef audit are structural rather than incidental,
 * and all three are addressed here rather than at the call sites:
 *
 *  C-2  `simulation_jobs.job_id` is `job-<32 hex of the request hash>` and
 *       `open-trajectory.ts` minted `job-${randomUUID()}` for the trajectory
 *       row. The namespaces are disjoint BY CONSTRUCTION, so 0 of 292
 *       trajectories could ever be joined to the worker job that produced them.
 *       -> every identifier below is DERIVED FROM CONTENT. There is no path
 *          that mints a random id for something that already has a hash.
 *
 *  C-4  the worker's pre/post state lived in process memory and was reduced to
 *       aggregate columns before anything was persisted, so every economic
 *       amount was recorded exactly once and was unfalsifiable.
 *       -> `putDurable` writes the bytes, READS THEM BACK, re-hashes them, and
 *          only then marks the blob durable. A row may not reference a blob
 *          that has not survived that round trip.
 *
 *  L-1  five of seven append-only ambiguities were SILENTLY DISCARDED by bare
 *       `INSERT OR IGNORE`, so a lost write and a market fact were
 *       indistinguishable afterwards.
 *       -> `appendOnly` is the only sanctioned writer. Same key + identical
 *          content is idempotent; same key + different content THROWS.
 */

export class EvidenceConflict extends Error {
  constructor(
    readonly entity: string,
    readonly key: string,
    readonly existingHash: string,
    readonly offeredHash: string,
    detail: string,
  ) {
    super(
      `EvidenceConflict on ${entity} ${key}: a row already exists with different content ` +
        `(stored ${existingHash.slice(0, 12)}, offered ${offeredHash.slice(0, 12)}). ${detail}\n` +
        'A second different answer to the same question is refused, not discarded: the caller has to ' +
        'find out which one is wrong.',
    );
    this.name = 'EvidenceConflict';
  }
}

export class AffectedRowMismatch extends Error {
  constructor(
    readonly statement: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `${statement} changed ${actual} row(s), expected exactly ${expected}. ` +
        (actual === 0
          ? 'A zero-row update is a write that went nowhere and reported success.'
          : 'A multi-row update means the key did not identify one thing — the audit found one statement settling 64 open trajectories at once.'),
    );
    this.name = 'AffectedRowMismatch';
  }
}

export class BlobNotDurable extends Error {
  constructor(hash: string, reason: string) {
    super(`blob ${hash.slice(0, 16)} is not durable: ${reason}`);
    this.name = 'BlobNotDurable';
  }
}

// ---------------------------------------------------------------------------
// P2.2 — DETERMINISTIC, CONTENT-BOUND IDENTITIES
//
// The functions themselves live in `packages/domain/src/evidence-identity.ts`,
// because the pipeline must be able to compute an id BEFORE it has a database
// handle: P2.4 requires the observation and job ids to be persisted before the
// worker is invoked, so they cannot depend on a writer having run.
//
// Re-exported here so an evidence writer has one import.
// ---------------------------------------------------------------------------

export {
  canonicalJson,
  observationId,
  workerJobId,
  settlementIdFor,
  snapshotHashOf,
  capabilityFingerprintOf,
  isSha256Hex,
  assertIsHash,
  NotAHash,
} from '../../domain/src/evidence-identity.js';
export type { AccountManifestEntry, CapabilityFields } from '../../domain/src/evidence-identity.js';

// ---------------------------------------------------------------------------
// P3.1 — DURABLE, CONTENT-ADDRESSED BLOBS
// ---------------------------------------------------------------------------

export class EvidenceStore {
  private readonly blobs: BlobStore;

  constructor(
    private readonly db: Db,
    root = 'data/evidence-blobs',
  ) {
    this.blobs = new BlobStore(root);
  }

  /**
   * Write a blob, register it, READ IT BACK, and only then mark it durable.
   *
   * The read-back is the point. A blob whose bytes are on disk but have never
   * been retrieved is a hypothesis about the filesystem, and the settlement
   * eligibility rule (`rawStateDurable`) reads this flag rather than trusting
   * that the write returned.
   */
  putDurable(kind: string, value: unknown, nowMs: number): string {
    const ref = this.blobs.put(value);
    const relative = this.blobs.pathFor(ref.hash);

    const existing = this.db
      .prepare('SELECT blob_sha256, byte_length, readback_verified FROM evidence_blobs WHERE blob_sha256 = ?')
      .get(ref.hash) as { blob_sha256: string; byte_length: number; readback_verified: number } | undefined;

    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO evidence_blobs
             (blob_sha256, kind, byte_length, stored_length, compression, relative_path,
              readback_verified, readback_utc_ms, written_utc_ms)
           VALUES (?, ?, ?, ?, 'gzip', ?, 0, NULL, ?)`,
        )
        .run(ref.hash, kind, ref.bytes, ref.compressedBytes, relative, nowMs);
    }

    // Read back through the store, which re-hashes and throws BlobCorrupt on a
    // mismatch. If this returns, the bytes on disk are the bytes we named.
    this.blobs.get(ref.hash);

    const r = this.db
      .prepare('UPDATE evidence_blobs SET readback_verified = 1, readback_utc_ms = ? WHERE blob_sha256 = ?')
      .run(nowMs, ref.hash);
    if (Number(r.changes) !== 1) throw new AffectedRowMismatch('marking a blob durable', 1, Number(r.changes));

    return ref.hash;
  }

  get<T = unknown>(hash: string): T {
    const row = this.db
      .prepare('SELECT readback_verified FROM evidence_blobs WHERE blob_sha256 = ?')
      .get(hash) as { readback_verified: number } | undefined;
    if (row === undefined) throw new BlobNotDurable(hash, 'it is not registered in evidence_blobs');
    if (Number(row.readback_verified) !== 1) throw new BlobNotDurable(hash, 'it never passed read-back verification');
    return this.blobs.get<T>(hash);
  }

  isDurable(hash: string | null | undefined): boolean {
    if (hash === null || hash === undefined) return false;
    try {
      this.get(hash);
      return true;
    } catch {
      return false;
    }
  }

  /** Every registered blob, re-verified against the filesystem. */
  verifyAll(limit = Number.MAX_SAFE_INTEGER): { checked: number; corrupt: string[]; missing: string[] } {
    const rows = this.db
      .prepare('SELECT blob_sha256 FROM evidence_blobs ORDER BY written_utc_ms DESC LIMIT ?')
      .all(limit) as { blob_sha256: string }[];
    const corrupt: string[] = [];
    const missing: string[] = [];
    for (const r of rows) {
      if (!this.blobs.has(r.blob_sha256)) {
        missing.push(r.blob_sha256);
        continue;
      }
      if (!this.blobs.verify(r.blob_sha256)) corrupt.push(r.blob_sha256);
    }
    return { checked: rows.length, corrupt, missing };
  }
}

// ---------------------------------------------------------------------------
// P5 — APPEND-ONLY MEANS LOUD CONFLICTS
// ---------------------------------------------------------------------------

/** Hash of the economically meaningful content of a row, for conflict detection. */
export function contentHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJsonOf(value)).digest('hex');
}

/**
 * The ONLY sanctioned evidence writer.
 *
 *   same key + byte-identical content  -> idempotent success
 *   same key + different content       -> EvidenceConflict, recorded and thrown
 *   zero rows affected where one was expected -> throw
 *   more than one row affected                -> throw
 *
 * `INSERT OR IGNORE` is not available here, deliberately. With five daemons
 * racing the same open trajectories, a discarded write and a market fact were
 * indistinguishable after the fact; that is the property being removed.
 */
export function appendOnly(
  db: Db,
  opts: {
    readonly entity: string;
    readonly key: string;
    readonly content: Record<string, unknown>;
    readonly nowMs: number;
    /** Reads the stored row's comparable content, or null when absent. */
    readonly readExisting: () => Record<string, unknown> | null;
    /** Performs the insert. Must return the number of affected rows. */
    readonly insert: () => number;
  },
): { written: boolean } {
  const offered = contentHash(opts.content);
  const existing = opts.readExisting();

  if (existing !== null) {
    const stored = contentHash(existing);
    if (stored === offered) return { written: false };

    db.prepare(
      `INSERT INTO evidence_conflicts
         (conflict_id, entity, entity_key, existing_hash, offered_hash, detail, recorded_utc_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `cfl-${randomUUID()}`,
      opts.entity,
      opts.key,
      stored,
      offered,
      JSON.stringify({ stored: existing, offered: opts.content }).slice(0, 4000),
      opts.nowMs,
    );
    throw new EvidenceConflict(opts.entity, opts.key, stored, offered, `stored=${JSON.stringify(existing).slice(0, 300)}`);
  }

  const changes = opts.insert();
  if (changes !== 1) throw new AffectedRowMismatch(`inserting ${opts.entity} ${opts.key}`, 1, changes);

  db.prepare(
    `INSERT INTO evidence_transitions
       (transition_id, entity, entity_key, from_state, to_state, content_hash, recorded_utc_ms, detail)
     VALUES (?, ?, ?, NULL, 'WRITTEN', ?, ?, NULL)`,
  ).run(`trn-${randomUUID()}`, opts.entity, opts.key, offered, opts.nowMs);

  return { written: true };
}

/** Run a statement and assert it changed exactly `expected` rows. */
export function expectRows(statement: string, expected: number, changes: number | bigint): void {
  const n = Number(changes);
  if (n !== expected) throw new AffectedRowMismatch(statement, expected, n);
}

/** Record a state transition without overwriting economic history. */
export function recordTransition(
  db: Db,
  opts: {
    readonly entity: string;
    readonly key: string;
    readonly from: string | null;
    readonly to: string;
    readonly content: Record<string, unknown>;
    readonly nowMs: number;
    readonly detail?: string;
  },
): void {
  db.prepare(
    `INSERT INTO evidence_transitions
       (transition_id, entity, entity_key, from_state, to_state, content_hash, recorded_utc_ms, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `trn-${randomUUID()}`,
    opts.entity,
    opts.key,
    opts.from,
    opts.to,
    contentHash(opts.content),
    opts.nowMs,
    opts.detail ?? null,
  );
}
