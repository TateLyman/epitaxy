import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * P2 — one local market state that a sequence of transactions mutates.
 *
 * The property nothing else here provides:
 *
 *   the sell executes against the exact state the buy committed
 *
 * A pair of fresh JIT requests cannot give it. Each one re-fetches mainnet, so
 * the second sees a pool the first never touched — and worse, the second
 * transaction's ROUTE was chosen against that untouched pool. What that
 * measures is two independent markets sharing a wallet.
 *
 * The runtime is the Rust/LiteSVM worker, driven as one process per job:
 * immutable job file in, immutable result file out. `send_transaction` commits,
 * so pool reserves, vaults, the volume accumulator and fee state carry forward
 * because they are the same accounts rather than re-read copies.
 */

export interface FrozenAccount {
  readonly pubkey: string;
  readonly dataBase64: string;
  readonly owner: string;
  readonly lamports: bigint;
  readonly executable?: boolean;
  readonly rentEpoch?: bigint;
}

export interface LoadedProgram {
  readonly programId: string;
  /** The ACTUAL ELF, from ProgramData. Not the upgradeable program account. */
  readonly elfBase64: string;
}

export interface SequentialStep {
  readonly label: string;
  readonly transactionBase64: string;
  /** Accounts to read before and after this step. */
  readonly observe: readonly string[];
}

export interface FrozenRuntimeSnapshot {
  readonly programs: readonly LoadedProgram[];
  readonly accounts: readonly FrozenAccount[];
  /** The slot and wall time the snapshot was taken at. */
  readonly slot: number | null;
  readonly unixTimestamp: number | null;
}

export interface ObservedAccount {
  readonly pubkey: string;
  readonly lamports: number;
  readonly owner: string;
  readonly dataBase64: string;
  readonly dataSha256: string;
}

export interface SequentialStepResult {
  readonly label: string;
  readonly status: string;
  readonly transactionError: string | null;
  readonly computeUnitsConsumed: number | null;
  readonly logs: readonly string[];
  readonly preAccounts: readonly ObservedAccount[];
  readonly postAccounts: readonly ObservedAccount[];
  readonly unobserved: readonly string[];
}

export interface SequentialRunResult {
  readonly jobId: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly litesvmVersion: string;
  readonly binarySha256: string;
  readonly programsLoaded: readonly string[];
  /** True only when EVERY step committed. */
  readonly sequentialComplete: boolean;
  readonly steps: readonly SequentialStepResult[];
  readonly incompleteness: readonly string[];
}

export class SequentialRuntimeUnavailable extends Error {
  constructor(reason: string) {
    super(`sequential runtime unavailable: ${reason}`);
    this.name = 'SequentialRuntimeUnavailable';
  }
}

/** Where the worker binary lives. WSL path, because that is where it builds. */
export const WORKER_WSL_PATH = '/mnt/c/Users/lyman/tradseee/offline-worker/target/release/epitaxy-offline-worker';

export interface RunOptions {
  readonly jobId: string;
  readonly snapshot: FrozenRuntimeSnapshot;
  readonly steps: readonly SequentialStep[];
  readonly maxComputeUnits?: number;
  /** Hard wall-clock bound. A worker that hangs is a worker that lies. */
  readonly timeoutMs?: number;
}

/**
 * Run a sequence against one committed state.
 *
 * Throws rather than returning a partial result when the WORKER fails, because
 * an apparatus failure and a market refusal are different facts and only the
 * second is evidence.
 */
export function runSequential(opts: RunOptions): SequentialRunResult {
  const dir = mkdtempSync(join(tmpdir(), 'seqrt-'));
  const jobPath = join(dir, 'job.json');
  const outPath = join(dir, 'result.json');

  const job = {
    job_id: opts.jobId,
    programs: opts.snapshot.programs.map((p) => ({ program_id: p.programId, elf_base64: p.elfBase64 })),
    accounts: opts.snapshot.accounts.map((a) => ({
      pubkey: a.pubkey,
      data_base64: a.dataBase64,
      owner: a.owner,
      // The worker takes u64; a lamport count is never fractional.
      lamports: Number(a.lamports),
      executable: a.executable ?? false,
      rent_epoch: Number(a.rentEpoch ?? 0n),
    })),
    slot: opts.snapshot.slot,
    unix_timestamp: opts.snapshot.unixTimestamp,
    steps: opts.steps.map((s) => ({
      label: s.label,
      transaction_base64: s.transactionBase64,
      observe: [...s.observe],
    })),
    max_compute_units: opts.maxComputeUnits ?? 1_400_000,
  };

  try {
    writeFileSync(jobPath, JSON.stringify(job));
    // Paths are translated for the worker, which runs inside WSL.
    const wslJob = jobPath.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
    const wslOut = outPath.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');

    execFileSync('wsl', ['-d', 'Ubuntu-24.04', '--', WORKER_WSL_PATH, wslJob, wslOut], {
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const raw = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    return {
      jobId: String(raw['job_id']),
      runtime: String(raw['runtime']),
      runtimeVersion: String(raw['runtime_version']),
      litesvmVersion: String(raw['litesvm_version']),
      binarySha256: String(raw['binary_sha256']),
      programsLoaded: (raw['programs_loaded'] as string[]) ?? [],
      sequentialComplete: raw['sequential_complete'] === true,
      steps: ((raw['steps'] as Record<string, unknown>[]) ?? []).map((s) => ({
        label: String(s['label']),
        status: String(s['status']),
        transactionError: (s['transaction_error'] as string | null) ?? null,
        computeUnitsConsumed: (s['compute_units_consumed'] as number | null) ?? null,
        logs: (s['logs'] as string[]) ?? [],
        preAccounts: (s['pre_accounts'] as ObservedAccount[]) ?? [],
        postAccounts: (s['post_accounts'] as ObservedAccount[]) ?? [],
        unobserved: (s['unobserved'] as string[]) ?? [],
      })),
      incompleteness: (raw['incompleteness'] as string[]) ?? [],
    };
  } catch (e) {
    throw new SequentialRuntimeUnavailable((e as Error).message.slice(0, 300));
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS reclaims a temp dir */
    }
  }
}

/**
 * The SPL token amount an observed account holds. u64 LE at offset 64.
 *
 * Returns null for anything that is not a token account. Null is the honest
 * answer; zero would be indistinguishable from an empty balance.
 */
export function tokenAmountOf(a: ObservedAccount): bigint | null {
  const buf = Buffer.from(a.dataBase64, 'base64');
  if (buf.length < 72) return null;
  return buf.readBigUInt64LE(64);
}
