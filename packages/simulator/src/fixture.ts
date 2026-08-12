import { createHash } from 'node:crypto';
import type {
  SimulationResult,
  Simulator,
  SimulatorVersion,
  SnapshotAccount,
  StartOptions,
  TokenBalanceSpec,
} from './types.js';

/**
 * A simulator that does not simulate.
 *
 * It replays recorded outcomes keyed by transaction bytes. That is useful for
 * exactly two things — CI on a machine with no native binary, and replay
 * determinism — and useless for a third that it must never be mistaken for:
 * evidence.
 *
 * `isAuthoritative` is false, and `isConfirmatorySimulation()` reads that
 * field, so a row backed by this implementation cannot become confirmatory no
 * matter how many other gates it passes. The alternative — a comment asking
 * people to remember — is how every defect in this repository's history got in.
 *
 * An unrecorded transaction returns `SIMULATOR_UNAVAILABLE`, never a pass. A
 * fixture that invented a result for an input it had never seen would be the
 * most dangerous object in the tree.
 */

export interface FixtureOutcome {
  readonly verdict: 'SIMULATED_OK' | 'SIMULATION_FAILED';
  readonly unitsConsumed: number | null;
  readonly logs?: readonly string[];
  readonly error?: string | null;
  readonly lamportDeltas?: Readonly<Record<string, bigint>>;
  readonly tokenDeltas?: Readonly<Record<string, bigint>>;
  readonly createdAccounts?: readonly string[];
  readonly closedAccounts?: readonly string[];
}

export class DeterministicFixtureSimulator implements Simulator {
  private started = false;
  private readonly funded = new Map<string, bigint>();
  private readonly tokens = new Map<string, bigint>();
  private readonly accounts = new Map<string, SnapshotAccount>();
  private snapshotHash: string | null = null;

  constructor(
    private readonly outcomes: ReadonlyMap<string, FixtureOutcome>,
    private readonly fixtureSetVersion = 'fixture-v1',
  ) {}

  get version(): SimulatorVersion {
    return {
      kind: 'fixture',
      packageVersion: this.fixtureSetVersion,
      runtimeVersion: null,
      featureSet: null,
      binaryHash: createHash('sha256')
        .update([...this.outcomes.keys()].sort().join('|'))
        .digest('hex'),
      // The whole point. Nothing this returns is evidence of execution.
      isAuthoritative: false,
    };
  }

  async start(opts: StartOptions = {}): Promise<void> {
    this.started = true;
    this.snapshotHash = opts.snapshot?.manifestHash ?? null;
    for (const a of opts.snapshot?.accounts ?? []) this.accounts.set(a.pubkey, a);
    return Promise.resolve();
  }

  async fundSol(address: string, lamports: bigint): Promise<void> {
    this.funded.set(address, lamports);
    return Promise.resolve();
  }

  async setTokenBalance(spec: TokenBalanceSpec): Promise<void> {
    this.tokens.set(`${spec.owner}:${spec.mint}`, spec.amount);
    return Promise.resolve();
  }

  async setAccount(account: SnapshotAccount): Promise<void> {
    this.accounts.set(account.pubkey, account);
    return Promise.resolve();
  }

  async simulate(serializedTransactionBase64: string): Promise<SimulationResult> {
    if (!this.started) throw new Error('fixture simulator used before start()');
    const key = createHash('sha256').update(serializedTransactionBase64).digest('hex');
    const hit = this.outcomes.get(key) ?? this.outcomes.get(serializedTransactionBase64);

    if (hit === undefined) {
      return {
        verdict: 'SIMULATOR_UNAVAILABLE',
        unitsConsumed: null,
        logs: [],
        error: null,
        lamportDeltas: {},
        tokenDeltas: {},
        createdAccounts: [],
        closedAccounts: [],
        simulator: this.version,
        snapshotHash: this.snapshotHash,
        latencyMs: 0,
        detail:
          `no recorded outcome for this transaction (${key.slice(0, 16)}). A fixture never invents a ` +
          'result for an input it has not seen.',
      };
    }

    return {
      verdict: hit.verdict,
      unitsConsumed: hit.unitsConsumed,
      logs: hit.logs ?? [],
      error: hit.error ?? null,
      lamportDeltas: hit.lamportDeltas ?? {},
      tokenDeltas: hit.tokenDeltas ?? {},
      createdAccounts: hit.createdAccounts ?? [],
      closedAccounts: hit.closedAccounts ?? [],
      simulator: this.version,
      snapshotHash: this.snapshotHash,
      latencyMs: 0,
      detail: 'replayed from a recorded fixture; NOT an execution and never confirmatory',
    };
  }

  async capturePostState(pubkeys: readonly string[]): Promise<readonly SnapshotAccount[]> {
    return Promise.resolve(pubkeys.flatMap((p) => {
      const a = this.accounts.get(p);
      return a === undefined ? [] : [a];
    }));
  }

  async stop(): Promise<void> {
    this.started = false;
    return Promise.resolve();
  }
}

/** Key a fixture by the bytes it describes. */
export function fixtureKey(serializedTransactionBase64: string): string {
  return createHash('sha256').update(serializedTransactionBase64).digest('hex');
}
