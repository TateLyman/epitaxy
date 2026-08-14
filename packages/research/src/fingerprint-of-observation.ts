import type { Db } from '../../storage/src/db.js';
import type { BlobStore } from '../../storage/src/blobstore.js';
import type { ExactTransactionBlob } from '../../storage/src/blobstore.js';
import { fingerprintOf } from './capability.js';

/**
 * The capability fingerprint of ONE observation, derived the same way the
 * capability matrix derives it.
 *
 * P2 requires the request to bind a route identity, and `BUILD_CUSTOM` is not
 * one: it names the builder, not the pools the swap goes through. Two legs
 * routed through different programs are two different capability questions,
 * and a request hash that cannot tell them apart lets evidence about one be
 * read as evidence about the other.
 *
 * Returns a marked value rather than throwing. An unknown fingerprint is a
 * fact about the observation — no bytes were captured — and it is carried as
 * such instead of being silently replaced by a plausible one.
 */
const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

export const UNKNOWN_FINGERPRINT = 'unknown-no-exact-bytes';

export function fingerprintForObservation(db: Db, blobs: BlobStore, observationId: string): string {
  interface Row {
    route_labels: string | null;
    exact_transaction_blob: string | null;
    simulator_feature_set: string | null;
  }
  let row: Row | undefined;
  try {
    row = db
      .prepare(
        `SELECT route_labels, exact_transaction_blob, simulator_feature_set
         FROM execution_observations WHERE observation_id = ?`,
      )
      .get(observationId) as Row | undefined;
  } catch {
    return UNKNOWN_FINGERPRINT;
  }
  if (row === undefined) return UNKNOWN_FINGERPRINT;
  if (row.exact_transaction_blob === null) return UNKNOWN_FINGERPRINT;

  let blob: ExactTransactionBlob;
  try {
    blob = blobs.get<ExactTransactionBlob>(row.exact_transaction_blob);
  } catch {
    return UNKNOWN_FINGERPRINT;
  }

  const keys = [...blob.staticAccountKeys, ...blob.loadedAddresses];
  return fingerprintOf({
    routeLabels: row.route_labels ?? '',
    // The programs the transaction actually invokes, read from the captured
    // bytes rather than inferred from the per-trade account soup.
    programs: [...new Set(blob.instructions.map((i) => i.programId))],
    tokenPrograms: keys.filter((k) => TOKEN_PROGRAMS.has(k)),
    lookupTableCount: Object.keys(blob.lookupTables ?? {}).length,
    simulatorFeatureSet: row.simulator_feature_set,
  });
}
