/**
 * A local SVM, behind an interface that does not know what implements it.
 *
 * This is the blocker the previous session ended on. Paper mode cannot book a
 * fill because no observation has ever been simulated, and no observation can
 * be simulated against mainnet: the paper taker holds no SOL, so a buy fails on
 * funding, and holds none of the hypothetical tokens, so a sell fails on
 * balance. Both failures describe the wallet, not the route.
 *
 * A local SVM removes exactly that obstacle and nothing else. It lets us give
 * the taker the balance the paper position assumes and then ask whether the
 * exact assembled bytes would execute. It does not make the route real, it does
 * not prove the transaction would land, and it is not evidence of edge.
 *
 * Two implementations, deliberately:
 *
 *   SurfpoolSimulator            a real SVM. Linux/macOS only — the prebuilt
 *                                binaries are darwin-x64, darwin-arm64 and
 *                                linux-x64-gnu, and there is no Windows build,
 *                                which is why this runs under WSL.
 *   DeterministicFixtureSimulator  replays recorded outcomes. Exists so CI and
 *                                replay never depend on mainnet availability or
 *                                on a native binary downloading. It is NOT a
 *                                simulator and may never produce a confirmatory
 *                                row; `isAuthoritative` is how the difference
 *                                is enforced rather than remembered.
 */

export type SimulatorKind = 'surfpool' | 'fixture';

export interface SimulatorVersion {
  readonly kind: SimulatorKind;
  /** npm package version, or the fixture-set version. */
  readonly packageVersion: string;
  /** Runtime the SVM reports about itself, e.g. solana-core. */
  readonly runtimeVersion: string | null;
  /** Feature set identifier, which changes what programs are allowed to do. */
  readonly featureSet: string | null;
  /** sha256 of the native binary, when there is one. */
  readonly binaryHash: string | null;
  /**
   * False for anything whose output is replayed rather than executed. A row
   * simulated by a non-authoritative implementation is development data,
   * whatever else is true of it.
   */
  readonly isAuthoritative: boolean;
}

/**
 * Frozen mainnet state a simulation runs against.
 *
 * Surfpool can fetch mainnet accounts just in time, which is useful for
 * development and is NOT reproducible on its own: the same transaction
 * simulated twice against a moving chain is two different experiments. A
 * confirmatory simulation runs against a snapshot whose contents are hashed and
 * stored, so the run can be repeated.
 */
export interface AccountSnapshot {
  /** sha256 over the sorted (pubkey, slot, lamports, owner, data) tuples. */
  readonly manifestHash: string;
  /** Slot the /build response was priced at. */
  readonly buildContextSlot: number | null;
  readonly accounts: readonly SnapshotAccount[];
  /** True when any account was read at a later slot than `buildContextSlot`. */
  readonly hasSlotDrift: boolean;
  readonly capturedUtcMs: number;
}

export interface SnapshotAccount {
  readonly pubkey: string;
  readonly owner: string;
  readonly lamports: bigint;
  readonly dataBase64: string;
  readonly executable: boolean;
  readonly rentEpoch: bigint | null;
  /** The slot this specific account was actually read at. */
  readonly slot: number;
}

export interface TokenBalanceSpec {
  readonly owner: string;
  readonly mint: string;
  readonly amount: bigint;
  /** Token or Token-2022. Getting this wrong makes a valid route look broken. */
  readonly tokenProgram: string | null;
}

export type SimulationVerdict =
  | 'SIMULATED_OK'
  | 'SIMULATION_FAILED'
  | 'SIMULATOR_UNAVAILABLE'
  | 'NOT_SIMULATED';

export interface SimulationResult {
  readonly verdict: SimulationVerdict;
  /** Compute units the transaction actually consumed. Null when it did not run. */
  readonly unitsConsumed: number | null;
  readonly logs: readonly string[];
  /** Program error, verbatim, when one occurred. */
  readonly error: string | null;
  /** Balance deltas keyed by pubkey, post minus pre. */
  readonly lamportDeltas: Readonly<Record<string, bigint>>;
  /** Token balance deltas keyed by `${owner}:${mint}`. */
  readonly tokenDeltas: Readonly<Record<string, bigint>>;
  readonly createdAccounts: readonly string[];
  readonly closedAccounts: readonly string[];
  readonly simulator: SimulatorVersion;
  readonly snapshotHash: string | null;
  readonly latencyMs: number;
  readonly detail: string;
}

export interface StartOptions {
  /**
   * When set, the SVM may fetch missing accounts from this endpoint on demand.
   * Development only: JIT state is not reproducible, and a confirmatory run
   * supplies a frozen snapshot instead.
   */
  readonly remoteRpcUrl?: string | null;
  readonly snapshot?: AccountSnapshot | null;
}

export interface Simulator {
  readonly version: SimulatorVersion;
  start(opts?: StartOptions): Promise<void>;
  fundSol(address: string, lamports: bigint): Promise<void>;
  setTokenBalance(spec: TokenBalanceSpec): Promise<void>;
  setAccount(account: SnapshotAccount): Promise<void>;
  /** The exact serialized transaction. Never a reassembled approximation. */
  simulate(serializedTransactionBase64: string): Promise<SimulationResult>;
  capturePostState(pubkeys: readonly string[]): Promise<readonly SnapshotAccount[]>;
  stop(): Promise<void>;
}

/**
 * Whether a verdict may back a confirmatory row.
 *
 * Only a real SVM saying the transaction executed. A fixture replaying a
 * recorded pass is development evidence, and the check is here rather than at
 * each call site because there will be more call sites than there are people
 * who remember this distinction.
 */
export function isConfirmatorySimulation(r: SimulationResult): boolean {
  return r.verdict === 'SIMULATED_OK' && r.simulator.isAuthoritative && r.snapshotHash !== null;
}
