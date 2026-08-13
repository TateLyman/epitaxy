import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BlobStore,
  BlobCorrupt,
  BlobMissing,
  EXACT_TRANSACTION_SCHEMA_VERSION,
  type ExactTransactionBlob,
} from '../../packages/storage/src/blobstore.js';

/**
 * §5 — the exact bytes, and the guarantee that what comes back is what went in.
 */

const tmp = (): string => mkdtempSync(join(tmpdir(), 'epitaxy-blob-'));

const exactTx = (over: Partial<ExactTransactionBlob> = {}): ExactTransactionBlob => ({
  schemaVersion: EXACT_TRANSACTION_SCHEMA_VERSION,
  rawBuildResponse: '{"outAmount":"1500000"}',
  instructions: [{ programId: 'Prog1', accounts: [{ pubkey: 'A', isSigner: true, isWritable: true }], data: 'AA==' }],
  lookupTables: { Table1: ['A1', 'A2'] },
  transactionBase64: 'AQID',
  messageBase64: 'AgM=',
  messageHash: 'mh',
  transactionHash: 'th',
  blockhash: 'BH',
  lastValidBlockHeight: 400,
  contextSlot: 438_000_000,
  packetBytes: 1014,
  feePayer: 'Payer',
  requiredSignatures: 1,
  staticAccountKeys: ['Payer', 'Prog1'],
  loadedAddresses: ['A1', 'A2'],
  writableAccounts: ['Payer', 'A1'],
  readonlyAccounts: ['Prog1', 'A2'],
  capturedUtcMs: 1,
  ...over,
});

describe('BlobStore', () => {
  it('round-trips a value through compression', () => {
    const dir = tmp();
    try {
      const store = new BlobStore(dir);
      const ref = store.put(exactTx());
      expect(store.get<ExactTransactionBlob>(ref.hash).transactionBase64).toBe('AQID');
      // These compress: JSON and base64 are highly redundant.
      expect(ref.compressedBytes).toBeLessThan(ref.bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is content-addressed, so identical content is one file and one key', () => {
    const dir = tmp();
    try {
      const store = new BlobStore(dir);
      const a = store.put(exactTx());
      const b = store.put(exactTx());
      expect(b.hash).toBe(a.hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives different bytes different keys', () => {
    const dir = tmp();
    try {
      const store = new BlobStore(dir);
      // One byte of difference in the transaction is a different transaction.
      const a = store.put(exactTx({ transactionBase64: 'AQID' }));
      const b = store.put(exactTx({ transactionBase64: 'AQIE' }));
      expect(b.hash).not.toBe(a.hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws rather than returning altered content', () => {
    const dir = tmp();
    try {
      const store = new BlobStore(dir);
      const ref = store.put(exactTx());
      // Overwrite with well-formed, correctly-compressed, WRONG content. This
      // is the case that matters: it decompresses and parses cleanly, so
      // nothing but the hash check can catch it.
      writeFileSync(store.pathFor(ref.hash), gzipSync(Buffer.from(JSON.stringify(exactTx({ packetBytes: 9999 })))));
      expect(() => store.get(ref.hash)).toThrow(BlobCorrupt);
      expect(store.verify(ref.hash)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes missing from corrupt', () => {
    const dir = tmp();
    try {
      const store = new BlobStore(dir);
      // A referenced blob that was never written and one that was damaged are
      // different operational problems with different fixes.
      expect(() => store.get('0'.repeat(64))).toThrow(BlobMissing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shards so no directory grows without bound', () => {
    const dir = tmp();
    try {
      const store = new BlobStore(dir);
      const ref = store.put(exactTx());
      expect(store.pathFor(ref.hash)).toContain(join(ref.hash.slice(0, 2), ref.hash.slice(2, 4)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no partial file behind on success', () => {
    const dir = tmp();
    try {
      const store = new BlobStore(dir);
      const ref = store.put(exactTx());
      // The rename is what makes a crash mid-write unable to leave truncated
      // content at a hash that claims to describe a complete blob.
      expect(existsSync(`${store.pathFor(ref.hash)}.partial`)).toBe(false);
      expect(readFileSync(store.pathFor(ref.hash)).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the lookup tables CONTENTS, not just their addresses', () => {
    const dir = tmp();
    try {
      const store = new BlobStore(dir);
      const ref = store.put(exactTx());
      const back = store.get<ExactTransactionBlob>(ref.hash);
      // §4.3 — a hash of the table proves it did not change; the contents are
      // what let a replay resolve the accounts at all.
      expect(back.lookupTables['Table1']).toEqual(['A1', 'A2']);
      expect(back.loadedAddresses).toEqual(['A1', 'A2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
