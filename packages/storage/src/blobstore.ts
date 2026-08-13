import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Content-addressed storage for things too large to belong in a row.
 *
 * §5 — "no PnL-eligible leg may be reconstructed later from fields that should
 * produce the same transaction. It references the exact bytes."
 *
 * The distinction is the whole point. A row holding an instruction set hash, a
 * blockhash and an account list describes a transaction; it is not one. Rebuild
 * from those fields six months later, against a different encoder, and you get
 * bytes that are probably identical and provably nothing. A simulation of
 * probably-identical bytes is not evidence about the leg that was checked.
 *
 * Design:
 *
 *   - The key IS the sha256 of the uncompressed content. Two identical blobs
 *     are one file, and a blob cannot be silently swapped for a different one.
 *   - Sharded two levels deep, because a flat directory with a million entries
 *     is slow on every filesystem this will ever run on.
 *   - Gzipped. These are JSON and base64, which compress well.
 *   - Written to a temp path and renamed, so a crash mid-write cannot leave a
 *     truncated file at a hash that claims to describe complete content.
 *   - VERIFIED on read: the content is hashed again and compared to the key it
 *     was fetched by. Silent corruption of a research corpus is the failure
 *     that would be discovered years later and explain nothing.
 *
 * It lives OUTSIDE SQLite. Multi-megabyte blobs in a WAL database make every
 * checkpoint expensive and every backup slower, and this database is already
 * 1.6 GB.
 */

export class BlobCorrupt extends Error {
  constructor(hash: string, actual: string) {
    super(
      `blob ${hash.slice(0, 16)} hashes to ${actual.slice(0, 16)} on read-back. The stored content is not what ` +
        'its key says it is, so nothing referencing it can be trusted.',
    );
    this.name = 'BlobCorrupt';
  }
}

export class BlobMissing extends Error {
  constructor(hash: string) {
    super(`blob ${hash.slice(0, 16)} is referenced but not present in the store`);
    this.name = 'BlobMissing';
  }
}

export interface BlobRef {
  readonly hash: string;
  readonly bytes: number;
  readonly compressedBytes: number;
}

export class BlobStore {
  private readonly root: string;

  constructor(root = 'data/blobs') {
    this.root = resolve(root);
  }

  /** Path for a hash, sharded aa/bb/aabb… so no directory grows unbounded. */
  pathFor(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), `${hash}.json.gz`);
  }

  has(hash: string): boolean {
    return existsSync(this.pathFor(hash));
  }

  /**
   * Store a value and return its hash. Idempotent: storing identical content
   * twice writes once and returns the same key.
   */
  put(value: unknown): BlobRef {
    const json = Buffer.from(JSON.stringify(value), 'utf8');
    const hash = createHash('sha256').update(json).digest('hex');
    const path = this.pathFor(hash);

    if (existsSync(path)) {
      return { hash, bytes: json.length, compressedBytes: statSync(path).size };
    }

    const compressed = gzipSync(json, { level: 9 });
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.partial`;
    try {
      writeFileSync(tmp, compressed);
      renameSync(tmp, path);
    } catch (e) {
      try {
        if (existsSync(tmp)) rmSync(tmp);
      } catch {
        /* the partial is already the problem; do not add another */
      }
      throw e;
    }
    return { hash, bytes: json.length, compressedBytes: compressed.length };
  }

  /**
   * Read a blob back, verifying it is what its key claims.
   *
   * The verification is not optional and not a debug flag. A corpus that
   * silently returns altered bytes is worse than one that throws, because every
   * conclusion drawn from it looks sound.
   */
  get<T = unknown>(hash: string): T {
    const path = this.pathFor(hash);
    if (!existsSync(path)) throw new BlobMissing(hash);
    const json = gunzipSync(readFileSync(path));
    const actual = createHash('sha256').update(json).digest('hex');
    if (actual !== hash) throw new BlobCorrupt(hash, actual);
    return JSON.parse(json.toString('utf8')) as T;
  }

  /** Verify without deserialising. For sweeps over the whole store. */
  verify(hash: string): boolean {
    try {
      this.get(hash);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Everything needed to re-run the EXACT transaction a leg was checked against.
 *
 * Not "everything needed to rebuild an equivalent one". The bytes are here.
 */
export interface ExactTransactionBlob {
  readonly schemaVersion: number;
  /** The raw provider response, exactly as received. */
  readonly rawBuildResponse: string;
  /** Instructions in execution order, as the provider gave them. */
  readonly instructions: readonly {
    programId: string;
    accounts: readonly { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: string;
  }[];
  /** Table address -> its resolved contents. Not just a hash of them. */
  readonly lookupTables: Readonly<Record<string, readonly string[]>>;
  readonly transactionBase64: string;
  readonly messageBase64: string;
  readonly messageHash: string;
  readonly transactionHash: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number | null;
  readonly contextSlot: number | null;
  readonly packetBytes: number;
  readonly feePayer: string;
  readonly requiredSignatures: number;
  readonly staticAccountKeys: readonly string[];
  /** Resolved from the tables, in runtime order. */
  readonly loadedAddresses: readonly string[];
  readonly writableAccounts: readonly string[];
  readonly readonlyAccounts: readonly string[];
  readonly capturedUtcMs: number;
}

export const EXACT_TRANSACTION_SCHEMA_VERSION = 1;
