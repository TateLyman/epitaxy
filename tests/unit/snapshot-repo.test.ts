import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import { BlobStore } from '../../packages/storage/src/blobstore.js';
import { storeJitSnapshot } from '../../packages/storage/src/snapshot-repo.js';
import type { SnapshotBlob } from '../../packages/simulator/src/protocol.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * P7 — a JIT run's state, persisted durably.
 *
 * The response carries it and a response is transient. An offline replay months
 * from now has to restore what the run SAW, not what a later read of the same
 * accounts returns.
 *
 * The verdict is DERIVED from what was stored and read back, never asserted by
 * the caller. `JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE` is a column rather than
 * something a reader has to infer from an absence.
 */

let dir: string;
let db: DatabaseSync;
let blobs: BlobStore;

const account = (over: Partial<SnapshotBlob> = {}): SnapshotBlob =>
  ({
    pubkey: 'Acc1',
    lamports: '1000',
    owner: '11111111111111111111111111111111',
    dataBase64: 'AQID',
    executable: false,
    ...over,
  }) as SnapshotBlob;

const slots = {
  executionSlot: 439_000_000,
  buildRequestedUtcMs: null,
  buildReceivedUtcMs: null,
  captureSlotLow: 439_000_000,
  captureSlotHigh: 439_000_002,
};

function seedJob(): void {
  db.prepare(
    `INSERT INTO simulation_jobs (job_id,request_hash,mode,status,requested_utc_ms)
     VALUES ('job-1','rh','DEVELOPMENT_JIT','SIMULATED_OK',1)`,
  ).run();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snap-'));
  db = openDb({ path: join(dir, 's.db'), skipBackup: true });
  blobs = new BlobStore(join(dir, 'blobs'));
  seedJob();
});

afterEach(() => {
  try {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows holds -wal briefly */
  }
});

const jobReplayable = (): string | null =>
  (db.prepare("SELECT replayable FROM simulation_jobs WHERE job_id='job-1'").get() as { replayable: string | null })
    .replayable;

describe('P7 — a complete snapshot is replayable', () => {
  it('stores the accounts, reads them back, and says REPLAYABLE', () => {
    const r = storeJitSnapshot(db, blobs, 'job-1', [account(), account({ pubkey: 'Acc2' })], [], slots, 1);
    expect(r.accountCount).toBe(2);
    expect(r.readbackVerified).toBe(true);
    expect(r.omissions).toEqual([]);
    expect(r.replayable).toBe('REPLAYABLE');
    expect(jobReplayable()).toBe('REPLAYABLE');
  });

  it('records the manifest hash on the job, so the two cannot drift apart', () => {
    const r = storeJitSnapshot(db, blobs, 'job-1', [account()], [], slots, 1);
    const row = db
      .prepare("SELECT snapshot_manifest_hash AS h FROM simulation_jobs WHERE job_id='job-1'")
      .get() as { h: string };
    expect(row.h).toBe(r.manifestHash);
  });

  it('stores the capture interval and its drift, not a single slot', () => {
    // Jupiter often omits contextSlot and a JIT fetch reads accounts AS the
    // transaction executes. Naming a point would claim a moment nobody
    // observed.
    storeJitSnapshot(db, blobs, 'job-1', [account()], [], slots, 1);
    const m = db
      .prepare('SELECT capture_slot_low AS lo, capture_slot_high AS hi, max_observed_drift_slots AS drift FROM snapshot_manifests')
      .get() as { lo: number; hi: number; drift: number };
    expect(m.lo).toBe(439_000_000);
    expect(m.hi).toBe(439_000_002);
    expect(m.drift).toBe(2);
  });
});

describe('P7 — an incomplete snapshot is not offline evidence', () => {
  it('an executable account with no ELF cannot be redeployed', () => {
    // However complete the rest of it is: a program that cannot be restored is
    // a replay that cannot run.
    const r = storeJitSnapshot(
      db,
      blobs,
      'job-1',
      [account({ pubkey: 'Prog1', executable: true, programElfBase64: null })],
      [],
      slots,
      1,
    );
    expect(r.replayable).toBe('JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE');
    expect(r.omissions.join(' ')).toMatch(/executable with no ELF/);
    expect(jobReplayable()).toBe('JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE');
  });

  it('an export omission from the daemon carries through', () => {
    const r = storeJitSnapshot(db, blobs, 'job-1', [account()], ['Pool1: could not be captured'], slots, 1);
    expect(r.replayable).toBe('JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE');
    expect(r.omissions).toContain('Pool1: could not be captured');
  });

  it('an empty snapshot is not replayable, because there is nothing to restore', () => {
    const r = storeJitSnapshot(db, blobs, 'job-1', [], [], slots, 1);
    expect(r.replayable).toBe('JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE');
  });

  it('an executable account WITH its ELF is fine', () => {
    const r = storeJitSnapshot(
      db,
      blobs,
      'job-1',
      [account({ pubkey: 'Prog1', executable: true, programElfBase64: 'AQIDBA==' })],
      [],
      slots,
      1,
    );
    expect(r.programCount).toBe(1);
    expect(r.replayable).toBe('REPLAYABLE');
  });
});

describe('P7 — the same snapshot stores once', () => {
  it('is idempotent on the manifest hash', () => {
    const a = storeJitSnapshot(db, blobs, 'job-1', [account()], [], slots, 1);
    const b = storeJitSnapshot(db, blobs, 'job-1', [account()], [], slots, 2);
    expect(b.manifestHash).toBe(a.manifestHash);
    const n = db.prepare('SELECT COUNT(*) AS n FROM snapshot_manifests').get() as { n: number };
    expect(n.n).toBe(1);
  });
});
