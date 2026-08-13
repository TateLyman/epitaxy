import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import type { BlobStore } from './blobstore.js';
import type { SnapshotBlob } from '../../simulator/src/protocol.js';

/**
 * P7 — persist the exact state a JIT run executed against.
 *
 * The simulator response already exports the accounts and program code. A
 * response is transient; the ledger is not, and an offline replay months from
 * now has to restore what the run actually SAW rather than what a later read of
 * the same accounts returns. Those are different states, and the difference is
 * the entire reason offline replay exists.
 *
 * Everything is content-addressed and read back. A blob nobody re-read is a
 * blob nobody knows is there, and discovering that at replay time is
 * discovering it after the state it described has gone.
 */

export interface SlotInterval {
  readonly executionSlot: number | null;
  readonly buildRequestedUtcMs: number | null;
  readonly buildReceivedUtcMs: number | null;
  /**
   * The slot range the accounts were captured across.
   *
   * An interval rather than a point, because Jupiter often omits `contextSlot`
   * and a JIT fetch reads accounts as the transaction executes. A later read is
   * never called "the state at the build slot": that would be a claim about a
   * moment nobody observed.
   */
  readonly captureSlotLow: number | null;
  readonly captureSlotHigh: number | null;
}

export interface StoredManifest {
  readonly manifestHash: string;
  readonly accountCount: number;
  readonly programCount: number;
  readonly readbackVerified: boolean;
  readonly omissions: readonly string[];
  readonly replayable: 'REPLAYABLE' | 'JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE';
}

const sha = (v: string): string => createHash('sha256').update(v).digest('hex');

/**
 * Store one JIT snapshot and say whether it can be replayed from.
 *
 * The verdict is derived from what was actually stored and read back, never
 * asserted by the caller. A run whose snapshot could not be persisted is
 * `JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE` — real evidence about the strategy, and
 * not offline evidence, which is a column rather than something a reader has to
 * infer from an absence.
 */
export function storeJitSnapshot(
  db: Db,
  blobs: BlobStore,
  jobId: string,
  accounts: readonly SnapshotBlob[],
  omissions: readonly string[],
  slots: SlotInterval,
  nowUtcMs: number,
): StoredManifest {
  const accountHashes: string[] = [];
  const programs: { pubkey: string; owner: string; elfHash: string | null }[] = [];
  const failures: string[] = [...omissions];

  for (const a of accounts) {
    try {
      const ref = blobs.put(a);
      accountHashes.push(ref.hash);
      if (a.executable === true) {
        programs.push({
          pubkey: a.pubkey,
          owner: a.owner,
          // The ELF is content-addressed separately: the same program appears
          // on every route through it, and storing it once per observation
          // would multiply megabytes by thousands.
          elfHash: a.programElfBase64 == null ? null : sha(a.programElfBase64),
        });
      }
    } catch (e) {
      failures.push(`${a.pubkey}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  // Read every blob back. Writing and hoping is how a corpus discovers at
  // replay time that it cannot replay.
  let verified = true;
  for (const hash of accountHashes) {
    try {
      blobs.get(hash);
    } catch {
      verified = false;
      failures.push(`${hash.slice(0, 12)}: could not be read back`);
    }
  }

  const manifestHash = sha(
    JSON.stringify({ jobId, accounts: [...accountHashes].sort(), programs: programs.map((p) => p.pubkey).sort() }),
  );

  // An executable account with no ELF cannot be redeployed, so a snapshot
  // containing one is not replayable however complete the rest of it is.
  const missingElf = programs.filter((p) => p.elfHash === null);
  for (const p of missingElf) failures.push(`${p.pubkey}: executable with no ELF captured`);

  const replayable: StoredManifest['replayable'] =
    verified && failures.length === 0 && accountHashes.length > 0
      ? 'REPLAYABLE'
      : 'JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE';

  try {
    db.prepare(
      `INSERT INTO snapshot_manifests
         (manifest_hash,job_id,created_utc_ms,account_count,account_blob_hashes,
          program_count,program_manifest,lookup_table_manifest,execution_slot,
          build_requested_utc_ms,build_received_utc_ms,capture_slot_low,capture_slot_high,
          max_observed_drift_slots,readback_verified,omissions)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(manifest_hash) DO NOTHING`,
    ).run(
      manifestHash,
      jobId,
      nowUtcMs,
      accountHashes.length,
      JSON.stringify(accountHashes),
      programs.length,
      JSON.stringify(programs),
      null,
      slots.executionSlot,
      slots.buildRequestedUtcMs,
      slots.buildReceivedUtcMs,
      slots.captureSlotLow,
      slots.captureSlotHigh,
      slots.captureSlotLow !== null && slots.captureSlotHigh !== null
        ? slots.captureSlotHigh - slots.captureSlotLow
        : null,
      verified ? 1 : 0,
      failures.length === 0 ? null : JSON.stringify(failures),
    );
    db.prepare('UPDATE simulation_jobs SET snapshot_manifest_hash = ?, replayable = ? WHERE job_id = ?').run(
      manifestHash,
      replayable,
      jobId,
    );
  } catch (e) {
    failures.push(`manifest not stored: ${(e as Error).message.slice(0, 80)}`);
    return {
      manifestHash,
      accountCount: accountHashes.length,
      programCount: programs.length,
      readbackVerified: false,
      omissions: failures,
      replayable: 'JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE',
    };
  }

  return {
    manifestHash,
    accountCount: accountHashes.length,
    programCount: programs.length,
    readbackVerified: verified,
    omissions: failures,
    replayable,
  };
}
