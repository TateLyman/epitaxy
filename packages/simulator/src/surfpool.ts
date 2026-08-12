import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type {
  AccountSnapshot,
  SimulationResult,
  Simulator,
  SimulatorVersion,
  SnapshotAccount,
  StartOptions,
  TokenBalanceSpec,
} from './types.js';

/**
 * Surfpool, driven through its JSON-RPC endpoint.
 *
 * Verified against `@solana/surfpool@1.5.0` on WSL2 Ubuntu 24.04, 2026-08-12:
 *
 *   Surfnet.start()          boots in ~55ms
 *   getVersion               solana-core 4.1.2, feature-set 3345198602
 *   simulateTransaction      reachable over the instance's own RPC
 *   fundSol / setTokenBalance / setAccount   present and synchronous
 *   offline by default       a mainnet account reads back null
 *
 * That last property is the one that matters for evidence. The default instance
 * fetches nothing, so a simulation sees exactly the accounts we put in it —
 * which is what makes a run reproducible. `remoteRpcUrl` turns on just-in-time
 * mainnet fetching, which is convenient for development and is NOT reproducible,
 * because the same transaction run twice against a moving chain is two
 * different experiments. The flag is recorded on every result.
 *
 * The API is loaded through `createRequire` rather than a static import so that
 * this module can be imported on Windows, where the package has no native
 * binary, without taking the process down. `start()` is where it fails, loudly.
 */

const PACKAGE = '@solana/surfpool';

interface SurfnetInstance {
  readonly rpcUrl: string;
  readonly payer: string;
  readonly instanceId: string;
  stop(): void;
  fundSol(address: string, lamports: number): void;
  setTokenBalance(owner: string, mint: string, amount: number, tokenProgram?: string): void;
  setAccount(pubkey: string, update: Record<string, unknown>): void;
}

interface SurfnetModule {
  Surfnet: {
    start(): SurfnetInstance;
    startWithConfig(config: Record<string, unknown>): SurfnetInstance;
  };
}

export class SurfpoolUnavailable extends Error {
  constructor(reason: string) {
    super(
      `Surfpool is unavailable: ${reason}. Prebuilt binaries exist for darwin-x64, darwin-arm64 and ` +
        'linux-x64-gnu only; there is no Windows build, so this runs under WSL or Linux CI.',
    );
    this.name = 'SurfpoolUnavailable';
  }
}

export class SurfpoolSimulator implements Simulator {
  private net: SurfnetInstance | null = null;
  private snapshotHash: string | null = null;
  private jitEnabled = false;
  private cachedVersion: SimulatorVersion | null = null;

  get version(): SimulatorVersion {
    return (
      this.cachedVersion ?? {
        kind: 'surfpool',
        packageVersion: packageVersion() ?? 'unknown',
        runtimeVersion: null,
        featureSet: null,
        binaryHash: null,
        // True even before boot: this implementation EXECUTES. The fixture does
        // not, and that is the distinction the flag carries.
        isAuthoritative: true,
      }
    );
  }

  async start(opts: StartOptions = {}): Promise<void> {
    const mod = loadModule();
    this.jitEnabled = typeof opts.remoteRpcUrl === 'string' && opts.remoteRpcUrl.length > 0;

    this.net = this.jitEnabled
      ? mod.Surfnet.startWithConfig({ offline: false, remoteRpcUrl: opts.remoteRpcUrl })
      : mod.Surfnet.start();

    const version = (await this.rpc('getVersion', [])) as Record<string, unknown> | null;
    this.cachedVersion = {
      kind: 'surfpool',
      packageVersion: packageVersion() ?? 'unknown',
      runtimeVersion: typeof version?.['solana-core'] === 'string' ? (version['solana-core'] as string) : null,
      featureSet: version?.['feature-set'] === undefined ? null : String(version['feature-set']),
      binaryHash: null,
      isAuthoritative: true,
    };

    if (opts.snapshot != null) {
      for (const account of opts.snapshot.accounts) await this.setAccount(account);
      this.snapshotHash = opts.snapshot.manifestHash;
    } else {
      // No frozen snapshot means no reproducible run, and the result says so by
      // carrying a null hash rather than by being annotated later.
      this.snapshotHash = null;
    }
  }

  async fundSol(address: string, lamports: bigint): Promise<void> {
    this.instance().fundSol(address, Number(lamports));
    return Promise.resolve();
  }

  async setTokenBalance(spec: TokenBalanceSpec): Promise<void> {
    // The token program matters: passing the SPL default for a Token-2022 mint
    // creates an account the swap cannot use, and the route then looks broken
    // for a reason that is entirely ours.
    if (spec.tokenProgram === null) {
      this.instance().setTokenBalance(spec.owner, spec.mint, Number(spec.amount));
    } else {
      this.instance().setTokenBalance(spec.owner, spec.mint, Number(spec.amount), spec.tokenProgram);
    }
    return Promise.resolve();
  }

  async setAccount(account: SnapshotAccount): Promise<void> {
    this.instance().setAccount(account.pubkey, {
      lamports: Number(account.lamports),
      owner: account.owner,
      data: account.dataBase64,
      executable: account.executable,
    });
    return Promise.resolve();
  }

  async simulate(serializedTransactionBase64: string): Promise<SimulationResult> {
    const started = Date.now();
    const raw = (await this.rpc('simulateTransaction', [
      serializedTransactionBase64,
      {
        encoding: 'base64',
        // The transaction is unsigned in paper mode; nothing here is ever
        // signed, so signature verification is not the question being asked.
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'processed',
      },
    ])) as Record<string, unknown> | null;

    const value = (raw?.['value'] ?? null) as Record<string, unknown> | null;
    const err = value?.['err'] ?? null;
    const logs = Array.isArray(value?.['logs']) ? (value?.['logs'] as string[]) : [];
    const units = typeof value?.['unitsConsumed'] === 'number' ? (value['unitsConsumed'] as number) : null;

    return {
      verdict: value === null ? 'SIMULATION_FAILED' : err === null ? 'SIMULATED_OK' : 'SIMULATION_FAILED',
      unitsConsumed: units,
      logs,
      error: err === null ? null : JSON.stringify(err),
      // Deltas need pre/post capture around the call; the caller supplies the
      // account list because only it knows which accounts the intent touches.
      lamportDeltas: {},
      tokenDeltas: {},
      createdAccounts: [],
      closedAccounts: [],
      simulator: this.version,
      snapshotHash: this.snapshotHash,
      latencyMs: Date.now() - started,
      detail: this.jitEnabled
        ? 'just-in-time mainnet fetch enabled; this run is NOT reproducible and is development data'
        : 'offline instance; the simulation saw only the accounts supplied to it',
    };
  }

  async capturePostState(pubkeys: readonly string[]): Promise<readonly SnapshotAccount[]> {
    const out: SnapshotAccount[] = [];
    for (const pubkey of pubkeys) {
      const res = (await this.rpc('getAccountInfo', [pubkey, { encoding: 'base64' }])) as Record<string, unknown> | null;
      const value = (res?.['value'] ?? null) as Record<string, unknown> | null;
      const context = (res?.['context'] ?? null) as Record<string, unknown> | null;
      if (value === null) continue;
      const data = value['data'];
      out.push({
        pubkey,
        owner: String(value['owner']),
        lamports: BigInt(Number(value['lamports'] ?? 0)),
        dataBase64: Array.isArray(data) ? String(data[0]) : '',
        executable: value['executable'] === true,
        rentEpoch: null,
        slot: typeof context?.['slot'] === 'number' ? (context['slot'] as number) : -1,
      });
    }
    return out;
  }

  async stop(): Promise<void> {
    try {
      this.net?.stop();
    } finally {
      this.net = null;
    }
    return Promise.resolve();
  }

  private instance(): SurfnetInstance {
    if (this.net === null) throw new SurfpoolUnavailable('start() has not been called');
    return this.net;
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.instance().rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (body['error'] !== undefined) {
      const e = body['error'] as Record<string, unknown>;
      throw new Error(`${method} failed: ${String(e['code'])} ${String(e['message']).slice(0, 200)}`);
    }
    return body['result'] ?? null;
  }
}

function loadModule(): SurfnetModule {
  if (process.platform === 'win32') {
    throw new SurfpoolUnavailable('running on win32');
  }
  try {
    const require = createRequire(import.meta.url);
    return require(PACKAGE) as SurfnetModule;
  } catch (e) {
    throw new SurfpoolUnavailable((e as Error).message);
  }
}

export function packageVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(`${PACKAGE}/package.json`) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Is a real SVM available in this process? Answers without starting one. */
export function surfpoolAvailable(): { available: boolean; reason: string } {
  if (process.platform === 'win32') {
    return {
      available: false,
      reason: 'win32 has no prebuilt Surfpool binary; use WSL (Ubuntu) or Linux CI',
    };
  }
  const version = packageVersion();
  return version === null
    ? { available: false, reason: `${PACKAGE} is not installed in this checkout` }
    : { available: true, reason: `${PACKAGE}@${version}` };
}

/**
 * Hash a set of accounts into a snapshot manifest.
 *
 * Sorted by pubkey so the same state hashes the same however it was gathered,
 * and inclusive of slot, because the same account at two slots is two different
 * pieces of evidence.
 */
export function snapshotManifestHash(accounts: readonly SnapshotAccount[]): string {
  const rows = [...accounts]
    .sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0))
    .map((a) => [a.pubkey, a.slot, a.owner, a.lamports.toString(), a.executable ? 1 : 0, a.dataBase64]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function buildSnapshot(
  accounts: readonly SnapshotAccount[],
  buildContextSlot: number | null,
  capturedUtcMs: number,
): AccountSnapshot {
  const hasSlotDrift =
    buildContextSlot !== null && accounts.some((a) => a.slot >= 0 && a.slot !== buildContextSlot);
  return {
    manifestHash: snapshotManifestHash(accounts),
    buildContextSlot,
    accounts,
    hasSlotDrift,
    capturedUtcMs,
  };
}
