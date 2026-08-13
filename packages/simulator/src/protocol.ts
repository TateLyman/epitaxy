import { createHash } from 'node:crypto';

/**
 * The contract between the Windows engine and the WSL simulation daemon.
 *
 * Shared by both sides so the wire format has exactly one definition. Two
 * hand-kept copies of a protocol is how a field silently means different things
 * at each end, and this one carries money-adjacent economics.
 *
 * The architecture is deliberate and narrow:
 *
 *   - Windows keeps the engine, `data/runtime.db`, and sole write access to it.
 *     The daemon never opens, copies or learns the path of that database.
 *   - The daemon lives entirely in the Linux filesystem under /home. Nothing it
 *     needs — source, node_modules, the Surfpool native binary, caches — sits
 *     under /mnt/c, because a WAL-mode SQLite database on a 9p mount has
 *     different locking semantics and this project's corpus is not reproducible.
 *   - It binds 127.0.0.1 only. Never 0.0.0.0, never the LAN.
 *   - It exposes four endpoints and no cheatcodes, no shell, no signing, no
 *     submission. It holds no key and has no method that could acquire one.
 *
 * A simulator that could sign or send would be a trading system with a network
 * listener, which is not what this is.
 */

/**
 * Bumped whenever a field changes meaning.
 *
 * The engine refuses a daemon whose protocol version differs, because a
 * response it cannot fully interpret is not evidence. Mismatch is
 * SIMULATOR_UNAVAILABLE — a fact about our infrastructure — and never a fact
 * about the token being simulated.
 */
export const SIMULATION_PROTOCOL_VERSION = 2;

/** Schema of the frozen account snapshot. Changing it changes what a run means. */
export const ACCOUNT_SNAPSHOT_SCHEMA_VERSION = 2;

export type SimulationMode =
  /** Offline, from a frozen snapshot. The only mode that can be confirmatory. */
  | 'CONFIRMATORY_OFFLINE'
  /**
   * Just-in-time mainnet fetch. Convenient and NOT reproducible: the same
   * transaction against a moving chain is two experiments. Every account it
   * fetches must be returned and frozen before the observation could ever be
   * replayed.
   */
  | 'DEVELOPMENT_JIT';

export interface SimulatorIdentity {
  readonly protocolVersion: number;
  /** git SHA of the daemon source, `+dirty` when the tree does not match. */
  readonly sourceSha: string;
  readonly lockfileHash: string;
  readonly surfpoolPackageVersion: string;
  /** sha256 of the native binary actually loaded. */
  readonly surfpoolBinaryHash: string | null;
  readonly nodeVersion: string;
  /** Runtime and feature set the SVM reports about itself. */
  readonly runtimeVersion: string | null;
  readonly featureSet: string | null;
  readonly accountSnapshotSchemaVersion: number;
  readonly platform: string;
}

export interface SnapshotBlob {
  readonly pubkey: string;
  readonly owner: string;
  readonly lamports: string;
  readonly dataBase64: string;
  readonly executable: boolean;
  readonly slot: number;
  /**
   * The program's ELF, required when this account is executable.
   *
   * Measured against @solana/surfpool 1.5.0: setAccount(address, lamports,
   * data, owner) has no executable parameter, so a program restored through it
   * comes back non-executable and every route through it fails with an
   * invalid-program error -- an error that looks like a fact about the token
   * and is a fact about us. Programs go through deploy(), which needs the ELF,
   * and a snapshot naming an executable account without one is refused.
   *
   * Note this is the ELF, not the account data: for a loader-v3 program the
   * account at this address holds a pointer to its programdata, not the code.
   */
  readonly programElfBase64?: string | null;
}

export interface BalanceMutation {
  readonly kind: 'sol' | 'token';
  readonly owner: string;
  /** Token only. */
  readonly mint?: string;
  readonly amount: string;
  /** Token only. Token vs Token-2022 changes whether the account is usable. */
  readonly tokenProgram?: string | null;
}

/** What the caller asserts the transaction should do. Checked, not trusted. */
export interface EconomicBounds {
  readonly feePayer: string;
  readonly maxLamportsSpent: string;
  readonly minTokenDelta?: string;
  readonly maxTokenDelta?: string;
  readonly mint?: string;
}

export interface SimulationRequest {
  readonly protocolVersion: number;
  readonly jobId: string;
  /** sha256 over every immutable field. The idempotency key. */
  readonly requestHash: string;
  readonly executionObservationId: string;
  readonly mode: SimulationMode;

  /** The EXACT unsigned bytes the policy validated. Never reassembled here. */
  readonly transactionBase64: string;
  /** Hashes of the original, so any transformation is provable. */
  readonly originalTransactionHash: string;
  readonly originalMessageHash: string;
  readonly originalBlockhash: string;
  readonly originalLastValidBlockHeight: number | null;

  readonly routeFamily: string;
  readonly requestedAmount: string;

  readonly snapshotManifestHash: string;
  readonly snapshotAccounts: readonly SnapshotBlob[];
  readonly balanceMutations: readonly BalanceMutation[];
  readonly bounds: EconomicBounds;
  readonly contextHash: string | null;
}

export type SimulationStatus =
  | 'SIMULATED_OK'
  | 'SIMULATION_FAILED'
  | 'SIMULATOR_UNAVAILABLE'
  | 'SIMULATION_UNKNOWN';

export interface SimulationResponse {
  readonly protocolVersion: number;
  readonly jobId: string;
  readonly requestHash: string;
  readonly identity: SimulatorIdentity;
  readonly snapshotManifestHash: string;
  readonly status: SimulationStatus;
  readonly transactionError: string | null;
  readonly logs: readonly string[];
  readonly unitsConsumed: number | null;

  readonly preSolBalances: Readonly<Record<string, string>>;
  readonly postSolBalances: Readonly<Record<string, string>>;
  readonly preTokenBalances: Readonly<Record<string, string>>;
  readonly postTokenBalances: Readonly<Record<string, string>>;

  readonly baseFeeLamports: string | null;
  readonly priorityFeeLamports: string | null;
  readonly rentCreatedLamports: string | null;
  readonly rentRecoveredLamports: string | null;
  readonly transferFeeLamports: string | null;
  readonly withheldFeeLamports: string | null;

  readonly createdAccounts: readonly string[];
  readonly closedAccounts: readonly string[];
  /**
   * Where the run disagreed with what the caller asserted it would do.
   *
   * The caller sends bounds; the daemon CHECKS them. A bound that is carried
   * and never tested is a comment with a schema, and this project has found
   * that defect often enough to stop writing it. Non-empty means the
   * simulation ran and did something other than what was claimed, which is not
   * evidence for the claim.
   */
  readonly boundsViolations: readonly string[];
  /** pubkey -> sha256 of post-state, for every account the run touched. */
  readonly mutatedAccountHashes: Readonly<Record<string, string>>;

  /**
   * Non-null when the recent blockhash had to be replaced.
   *
   * A simulator will not accept a blockhash the local SVM has never produced,
   * so the substitution is real and must be provable rather than silent. The
   * daemon operates on a DERIVED copy and proves that nothing except the
   * blockhash changed; `instructionsUnchanged` is that proof.
   */
  readonly blockhashReplacement: {
    readonly from: string;
    readonly to: string;
    readonly instructionsUnchanged: boolean;
    readonly accountsUnchanged: boolean;
    readonly headerUnchanged: boolean;
  } | null;

  /** Digest of the runtime event stream, so two runs can be compared cheaply. */
  readonly runtimeEventDigest: string | null;
  /** Accounts the JIT fetch pulled in. Must be frozen before any replay. */
  readonly jitFetchedAccounts: readonly SnapshotBlob[];

  readonly queueWaitMs: number;
  readonly startupMs: number;
  readonly simulateMs: number;
  readonly totalMs: number;
  readonly detail: string;
}

/**
 * A transaction the chain has already settled, and what it settled at.
 *
 * §15 -- a simulator that agrees with nothing external is an expensive way to
 * restate your own assumptions. Parity is checked against outcomes we did not
 * produce and cannot influence.
 */
export interface ParityCase {
  readonly signature: string;
  readonly transactionBase64: string;
  /** What the chain actually charged. */
  readonly observedFeeLamports: string;
  /** What the chain actually consumed, when it reported it. */
  readonly observedComputeUnits: number | null;
  readonly observedErr: unknown;
}

export interface ParityRequest {
  readonly protocolVersion: number;
  readonly cases: readonly ParityCase[];
}

/**
 * Execution parity is deliberately NOT claimed.
 *
 * Replaying a settled transaction requires the accounts as they stood at its
 * slot. That needs an archival node this project does not have, and running it
 * against today's pools would be a different experiment wearing the same
 * signature. Saying so is the point: an unestablished result reported as
 * established is exactly how a simulator starts laundering assumptions.
 */
export type ExecutionParityVerdict = 'NOT_ESTABLISHABLE_WITHOUT_ARCHIVAL_STATE';

export interface ParityCaseResult {
  readonly signature: string;
  readonly numRequiredSignatures: number;
  readonly unitLimit: number | null;
  readonly unitPriceMicroLamports: string | null;
  readonly observedFeeLamports: string;
  readonly modelBaseFeeLamports: string;
  readonly modelPriorityFeeLamports: string;
  readonly modelTotalFeeLamports: string;
  readonly feeParity: boolean;
  readonly executionParity: ExecutionParityVerdict;
  readonly detail: string;
}

export interface ParityResponse {
  readonly protocolVersion: number;
  readonly identity: SimulatorIdentity;
  readonly cases: readonly ParityCaseResult[];
  readonly allFeesAgree: boolean;
  readonly detail: string;
}

/**
 * The idempotency key.
 *
 * Covers every field that changes what the simulation MEANS and nothing that
 * does not — timings and the job id itself are excluded, so a retry of the same
 * work hashes identically. Two requests with one job id and different hashes
 * are a bug in the caller and are refused rather than reconciled.
 */
export function computeRequestHash(
  r: Omit<SimulationRequest, 'requestHash' | 'jobId'>,
): string {
  const canonical = {
    protocolVersion: r.protocolVersion,
    executionObservationId: r.executionObservationId,
    mode: r.mode,
    transactionBase64: r.transactionBase64,
    originalTransactionHash: r.originalTransactionHash,
    originalMessageHash: r.originalMessageHash,
    originalBlockhash: r.originalBlockhash,
    originalLastValidBlockHeight: r.originalLastValidBlockHeight,
    routeFamily: r.routeFamily,
    requestedAmount: r.requestedAmount,
    snapshotManifestHash: r.snapshotManifestHash,
    accounts: [...r.snapshotAccounts]
      .sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1))
      .map((a) => [
        a.pubkey,
        a.slot,
        a.owner,
        a.lamports,
        a.executable ? 1 : 0,
        a.dataBase64,
        // Two runs against different program code are two experiments, so the
        // ELF is part of what the request MEANS and belongs in the key.
        a.programElfBase64 ?? null,
      ]),
    mutations: [...r.balanceMutations]
      .map((m) => [m.kind, m.owner, m.mint ?? null, m.amount, m.tokenProgram ?? null])
      .sort(),
    bounds: r.bounds,
    contextHash: r.contextHash,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export class IdentityMismatch extends Error {
  constructor(
    readonly field: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `simulator identity mismatch on ${field}: expected ${expected}, got ${actual}. ` +
        'A response this engine cannot fully interpret is not evidence, so this is ' +
        'SIMULATOR_UNAVAILABLE — a fact about our infrastructure, never about the token.',
    );
    this.name = 'IdentityMismatch';
  }
}

/**
 * Verify a daemon is the one this engine was pinned to.
 *
 * Fails closed on every difference. `expected` being null means the engine has
 * not pinned an identity yet, which is permitted for development collection and
 * is NOT permitted for a confirmatory row — `requirePinned` is how the caller
 * says which it is.
 */
export function verifyIdentity(
  actual: SimulatorIdentity,
  expected: Partial<SimulatorIdentity> | null,
  requirePinned: boolean,
): void {
  if (actual.protocolVersion !== SIMULATION_PROTOCOL_VERSION) {
    throw new IdentityMismatch('protocolVersion', String(SIMULATION_PROTOCOL_VERSION), String(actual.protocolVersion));
  }
  if (actual.accountSnapshotSchemaVersion !== ACCOUNT_SNAPSHOT_SCHEMA_VERSION) {
    throw new IdentityMismatch(
      'accountSnapshotSchemaVersion',
      String(ACCOUNT_SNAPSHOT_SCHEMA_VERSION),
      String(actual.accountSnapshotSchemaVersion),
    );
  }
  if (expected === null) {
    if (requirePinned) {
      throw new IdentityMismatch('pinnedIdentity', 'a pinned identity', 'none recorded');
    }
    return;
  }
  const fields: (keyof SimulatorIdentity)[] = [
    'sourceSha',
    'lockfileHash',
    'surfpoolPackageVersion',
    'surfpoolBinaryHash',
    'nodeVersion',
    'runtimeVersion',
    'featureSet',
  ];
  for (const f of fields) {
    const want = expected[f];
    if (want === undefined || want === null) continue;
    if (actual[f] !== want) throw new IdentityMismatch(String(f), String(want), String(actual[f]));
  }
}

/** A dirty daemon can never back a confirmatory row. */
export function identityIsConfirmatoryGrade(id: SimulatorIdentity): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (id.sourceSha.endsWith('+dirty')) reasons.push('daemon source tree does not match its commit');
  if (id.surfpoolBinaryHash === null) reasons.push('native binary could not be hashed');
  if (id.runtimeVersion === null) reasons.push('runtime did not report a version');
  if (id.featureSet === null) reasons.push('runtime did not report a feature set');
  return { ok: reasons.length === 0, reasons };
}
