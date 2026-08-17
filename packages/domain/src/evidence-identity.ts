import { createHash } from 'node:crypto';

/**
 * P2.2 — DETERMINISTIC, CONTENT-BOUND IDENTITIES.
 *
 * The 8f73cef audit's third-most-expensive finding (C-2):
 *
 *     0 / 292  entry_observation_id values resolve
 *     0 / 292  entry_simulation_job_id values resolve
 *
 * and they never could. `simulation_jobs.job_id` is `job-<32 hex of the request
 * hash>`; `open-trajectory.ts` minted `job-${randomUUID()}` at line 1053 and
 * wrote it to no other table. The two namespaces are DISJOINT BY CONSTRUCTION,
 * so no trajectory has ever been joined to the worker job that produced it and
 * none could be.
 *
 * A random id is a promise that some writer will later insert a row under it.
 * A content-bound id is not a promise — it is derivable by anyone holding the
 * same content, which means a reader can check the link rather than trust it.
 *
 * These live in `domain` because they are pure functions over content and the
 * pipeline must be able to compute an id BEFORE it has a database handle. P2.4
 * requires the ids be persisted before the worker is invoked, so they cannot
 * depend on a writer having run.
 */

function sha256(...parts: (string | number | null | undefined)[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(`${p ?? ''} `);
  return h.digest('hex');
}

/** Canonical JSON: object keys sorted recursively, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = walk(o[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function observationId(opts: {
  readonly trajectoryId: string;
  readonly leg: string;
  readonly purpose: string;
  readonly transactionHash: string;
  readonly snapshotHash: string;
}): string {
  return `obs-${sha256(opts.trajectoryId, opts.leg, opts.purpose, opts.transactionHash, opts.snapshotHash)}`;
}

/**
 * The worker job id IS the hash of the canonical request.
 *
 * `simulation_jobs.job_id` already used `job-<32 hex of the request hash>`, so
 * this reproduces that shape exactly rather than inventing a third convention.
 * The value passed to the worker is the value inserted; there is no second
 * namespace to keep in sync.
 */
export function workerJobId(canonicalRequest: unknown): string {
  const json = typeof canonicalRequest === 'string' ? canonicalRequest : canonicalJson(canonicalRequest);
  return `job-${createHash('sha256').update(json).digest('hex').slice(0, 32)}`;
}

export function settlementIdFor(opts: {
  readonly observationId: string;
  readonly jobId: string;
  readonly stepIndex: number;
  readonly settlementVersion: string;
}): string {
  return `set-${sha256(opts.observationId, opts.jobId, opts.stepIndex, opts.settlementVersion)}`;
}

/**
 * P3.3 — the snapshot hash, over the MANIFEST rather than over the slot.
 *
 * `open-trajectory.ts:1048` wrote `snapshotHash: ${snapshot.slot}` and
 * discarded `coherent.snapshotHash`, which the capture had already computed.
 * 292 of 292 stored values were the decimal slot number, 292 of 292 capability
 * fingerprints were IDENTICAL to it, and only 290 distinct values existed
 * across 292 rows — so two trajectories were already indistinguishable in the
 * one column meant to identify their inputs.
 *
 * A slot number commits to no byte of the pool, the vaults, the mint or the fee
 * config. A replay comparing against it cannot detect that the state it
 * re-fetched is different, which is the entire purpose of the column.
 */
export interface AccountManifestEntry {
  readonly address: string;
  readonly owner: string | null;
  readonly lamports: string;
  readonly executable: boolean;
  readonly rentEpoch: string;
  readonly dataSha256: string | null;
  readonly present: boolean;
}

export function snapshotHashOf(manifest: readonly AccountManifestEntry[], slot: number): string {
  const ordered = [...manifest].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const h = createHash('sha256');
  h.update(`slot:${slot}\n`);
  for (const e of ordered) {
    h.update(
      `${e.address}|${e.owner ?? 'ABSENT'}|${e.lamports}|${e.executable ? 1 : 0}|${e.rentEpoch}|` +
        `${e.dataSha256 ?? 'ABSENT'}|${e.present ? 1 : 0}\n`,
    );
  }
  return h.digest('hex');
}

/**
 * P3.3 — the capability fingerprint, over NAMED CAPABILITY FIELDS.
 *
 * It must move when the fee config, the programdata, the token program or the
 * cashback flag moves, and it must never equal the snapshot hash: they answer
 * different questions, and in the pre-repair corpus they were the same value on
 * every row.
 */
export interface CapabilityFields {
  readonly venue: string;
  readonly programId: string;
  readonly programDataHash: string | null;
  readonly tokenProgram: string;
  readonly feeConfigHash: string | null;
  readonly selectedTier: string | null;
  readonly cashbackEnabled: boolean;
  readonly workerBinaryHash: string | null;
  readonly sdkVersions: Readonly<Record<string, string>>;
  readonly protocolVersion: number;
}

export function capabilityFingerprintOf(f: CapabilityFields): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        venue: f.venue,
        programId: f.programId,
        programDataHash: f.programDataHash,
        tokenProgram: f.tokenProgram,
        feeConfigHash: f.feeConfigHash,
        selectedTier: f.selectedTier,
        cashbackEnabled: f.cashbackEnabled,
        workerBinaryHash: f.workerBinaryHash,
        sdkVersions: f.sdkVersions,
        protocolVersion: f.protocolVersion,
      }),
    )
    .digest('hex');
}

/** A sha256 hex digest, and nothing that merely looks like one. */
export function isSha256Hex(v: string): boolean {
  return /^[0-9a-f]{64}$/.test(v);
}

/**
 * Refuse a value that is a slot number wearing a hash's name.
 *
 * The database has a trigger for this too. Both exist because the defect was
 * not caught for 292 rows by anything at all, and a check in one layer is a
 * check that can be bypassed by writing through another.
 */
export class NotAHash extends Error {
  constructor(field: string, value: string) {
    super(
      `${field} must be a sha256 hex digest; got ${JSON.stringify(value.slice(0, 32))}. ` +
        'A slot number is metadata and commits to no byte of the captured state.',
    );
    this.name = 'NotAHash';
  }
}

export function assertIsHash(field: string, value: string): string {
  if (!isSha256Hex(value)) throw new NotAHash(field, value);
  return value;
}
