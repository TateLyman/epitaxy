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
export const SIMULATION_PROTOCOL_VERSION = 4;

/**
 * Has this build been shown to reproduce the EXECUTION of transactions the
 * chain already settled?
 *
 * No, and §15 makes that ordering binding: parity comes before SIMULATED_OK can
 * count as evidence. Fee parity is established -- three settled Jupiter swaps
 * reproduce to the lamport -- but execution parity is not, because replaying a
 * settled transaction needs the account state at its slot and that needs an
 * archival node this project does not have.
 *
 * This is a constant rather than a comment because the alternative is a gate
 * that opens by accident. Without it, the first route observation that arrived
 * with a frozen snapshot would be graded confirmatory on the strength of a
 * simulator whose execution had never been checked against anything. Flipping it
 * is a deliberate act that requires the parity corpus in docs/SIMULATOR_PARITY.md
 * to actually pass end to end.
 */
export const EXECUTION_PARITY_ESTABLISHED = false;

/** Schema of the frozen account snapshot. Changing it changes what a run means. */
export const ACCOUNT_SNAPSHOT_SCHEMA_VERSION = 4;

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
  /**
   * §3.5 — the rest of what makes a run reproducible.
   *
   * The kernel matters because the SVM is a native binary and this one runs on
   * WSL2, whose kernel is neither the host's nor a stock Linux; a run under a
   * different kernel is a different environment even with identical bytes.
   *
   * The encoder version matters because the transaction the daemon executes was
   * assembled by THIS repository. A change to how bytes are laid out changes
   * what was simulated, and the daemon has no other way to notice.
   *
   * The program-capture schema matters because a snapshot's program entries
   * mean something specific — ELF extracted from a loader-v3 ProgramData
   * account behind a 45-byte header — and a change there changes what a frozen
   * program IS.
   */
  readonly kernel: string | null;
  readonly distro: string | null;
  readonly transactionEncoderVersion: string;
  readonly programCaptureSchemaVersion: number;
}

/** Bumped whenever the assembled bytes could differ for identical inputs. */
export const TRANSACTION_ENCODER_VERSION = 'v0-encoder-v2-table-ordered';
/** Bumped whenever a captured program means something different. */
export const PROGRAM_CAPTURE_SCHEMA_VERSION = 1;

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

/**
 * One token account, as the runtime described it.
 *
 * P2 — this replaces two `Record<string, string>` maps whose keys meant
 * different things at each end. The daemon keyed them by TOKEN-ACCOUNT PUBKEY;
 * the effect verifier looked them up by `owner:mint`. The lookup could never
 * match, so every token delta read as unobserved and every buy that credited
 * its ATA correctly was refused for "output delta is missing".
 *
 * A map key is a place for that mistake to hide. A record with named fields is
 * not: the identity is the token account, and the owner, mint and program are
 * carried beside it rather than encoded into a string somebody has to parse the
 * same way at both ends.
 */
export interface ObservedTokenBalance {
  /** The account address. THE identity. Two accounts are never one row. */
  readonly tokenAccount: string;
  readonly owner: string;
  readonly mint: string;
  /** Legacy Token and Token-2022 are different programs and never collapse. */
  readonly tokenProgram: string;
  /** Raw atoms, decimal string. Never a number. */
  readonly amount: string;
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

  /**
   * The slot the frozen state came from, so an offline replay can stand at the
   * same point in time rather than at slot 33 of a fresh chain.
   *
   * This is not cosmetic. Address lookup tables record the slot they were
   * extended at, and the runtime refuses to resolve entries that were added at
   * a slot in its own future -- "Address lookup ... contains an invalid index".
   * A snapshot restored onto a fresh instance is exactly that case: perfect
   * account state, wrong clock, and every table-loaded pool unreachable.
   *
   * Null means the caller did not record one, and the replay runs at whatever
   * slot the instance starts at. That is permitted and is not confirmatory.
   */
  readonly targetSlot: number | null;
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
  /**
   * Legacy maps, keyed by token-account pubkey. Retained for the debugging
   * value of the raw view and for reading rows written before P2.
   *
   * NOTHING may compute an economic verdict from these. Use the structured
   * arrays below, which say what each balance belongs to.
   */
  readonly preTokenBalances: Readonly<Record<string, string>>;
  readonly postTokenBalances: Readonly<Record<string, string>>;

  /**
   * P2 — every token account the run observed, before and after.
   *
   * An account ABSENT from `preTokenAccounts` and present in
   * `postTokenAccounts` was created by this transaction. Present in pre and
   * absent from post means it was closed. Those are different facts from a
   * zero balance, and the arrays keep them different.
   */
  readonly preTokenAccounts: readonly ObservedTokenBalance[];
  readonly postTokenAccounts: readonly ObservedTokenBalance[];

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
  /** The slot this run actually executed at. Feed it back to replay offline. */
  readonly contextSlot: number | null;
  readonly runtimeEventDigest: string | null;
  /**
   * §7.1 — the PRE-TRANSACTION state of every account the run touched.
   *
   * Read after the simulation, which sounds wrong and is not: a simulation does
   * not commit, so the accounts still hold exactly what they held before it. A
   * JIT run fetches lazily as the transaction executes, so reading afterwards
   * is also the only way to see everything it needed. The two facts combine
   * into one cheap, exact capture.
   *
   * Executable entries carry their ELF, extracted from the ProgramData account
   * the program points at, because `setAccount` cannot make an account
   * executable and a program must be redeployed from real code.
   *
   * Feed this back as `snapshotAccounts` in CONFIRMATORY_OFFLINE and the run is
   * reproducible.
   */
  readonly exportedSnapshot: readonly SnapshotBlob[];
  /** How the export went, per account, when something could not be captured. */
  readonly exportOmissions: readonly string[];
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
    targetSlot: r.targetSlot,
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
    'kernel',
    'transactionEncoderVersion',
    'programCaptureSchemaVersion',
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
  if (id.kernel === null) reasons.push('kernel could not be read');
  if (id.transactionEncoderVersion !== TRANSACTION_ENCODER_VERSION) {
    reasons.push(`daemon assembled bytes with encoder ${id.transactionEncoderVersion}, this engine expects ${TRANSACTION_ENCODER_VERSION}`);
  }
  if (id.programCaptureSchemaVersion !== PROGRAM_CAPTURE_SCHEMA_VERSION) {
    reasons.push('program capture schema differs, so a frozen program means something else');
  }
  return { ok: reasons.length === 0, reasons };
}
