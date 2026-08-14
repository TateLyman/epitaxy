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

/**
 * The worker emits snake_case; this file speaks camelCase.
 *
 * Passing the raw objects through left `dataBase64` undefined on every
 * observed account, which surfaced as a Buffer.from type error three layers
 * away rather than as "the field is not there".
 */
function mapAccounts(raw: unknown): ObservedAccount[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((a) => ({
    pubkey: String(a['pubkey'] ?? ''),
    lamports: Number(a['lamports'] ?? 0),
    owner: String(a['owner'] ?? ''),
    dataBase64: String(a['data_base64'] ?? ''),
    dataSha256: String(a['data_sha256'] ?? ''),
  }));
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
        preAccounts: mapAccounts(s['pre_accounts']),
        postAccounts: mapAccounts(s['post_accounts']),
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
 * Rent paid into accounts this step had to CREATE.
 *
 * A leg's cash flow is not its price. A sell whose pool pays exactly what the
 * model quoted still shows a four-million-lamport shortfall in the payer's
 * native balance when it had to open the coin-creator fee vault and the user
 * volume accumulator on the way — and that shortfall is CONSTANT, so measured
 * as a rate it reads as a 41,818 bps pricing error at 0.001 SOL and a 1,044 bps
 * one at 0.04 SOL. The same defect, reported as six different numbers.
 *
 * An account counts as created when the step began with nothing at that address
 * and ended with lamports in it. That is a measurement of the step rather than
 * a list of account names this code expects to see, so it stays correct when
 * the protocol adds another one.
 */
export function createdAccountRent(
  step: SequentialStepResult,
  exclude: readonly string[] = [],
): {
  lamports: bigint;
  accounts: { pubkey: string; rentLamports: string; excessLamports: string }[];
} {
  const skip = new Set(exclude);
  const pre = new Map(step.preAccounts.map((a) => [a.pubkey, a]));
  const accounts: { pubkey: string; rentLamports: string; excessLamports: string }[] = [];
  let lamports = 0n;
  for (const a of step.postAccounts) {
    if (skip.has(a.pubkey)) continue;
    const prior = pre.get(a.pubkey);
    const existed = prior !== undefined && (prior.lamports > 0 || prior.dataBase64.length > 0);
    if (existed || a.lamports <= 0) continue;
    // Only the EXEMPTION is rent. The coin-creator fee vault is opened and paid
    // in the same transaction, so its closing balance is rent PLUS a fee the
    // pool sent it; crediting the whole balance back to the payer flattered
    // every sell by a few basis points and by 94 on one of them.
    const bytes = BigInt(Buffer.from(a.dataBase64, 'base64').length);
    const rent = rentExemptLamports(bytes);
    const actual = BigInt(a.lamports);
    const charged = actual < rent ? actual : rent;
    accounts.push({
      pubkey: a.pubkey,
      rentLamports: charged.toString(),
      excessLamports: (actual - charged).toString(),
    });
    lamports += charged;
  }
  return { lamports, accounts };
}

/**
 * Rent still locked in accounts the WHOLE SEQUENCE opened.
 *
 * Per-step is the wrong unit for a lifecycle. The coin-creator fee vault and
 * the user volume accumulator are opened by the BUY and are still open after
 * the close, so a per-step reading of the sell finds nothing and the four
 * million lamports they hold get attributed to the trade's economics instead of
 * to one-time setup. That difference is the whole point of separating a first
 * trade on a mint from a repeat one.
 *
 * Baseline is the first step's pre-state and the final state is the last step's
 * post-state, so an account opened and then closed inside the sequence — the
 * wrapped-SOL account, every time — correctly costs nothing.
 */
export function createdAccountRentAcross(
  steps: readonly SequentialStepResult[],
  exclude: readonly string[] = [],
): {
  lamports: bigint;
  accounts: { pubkey: string; rentLamports: string; excessLamports: string }[];
} {
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (first === undefined || last === undefined) return { lamports: 0n, accounts: [] };
  return createdAccountRent(
    { ...last, preAccounts: first.preAccounts, postAccounts: last.postAccounts },
    exclude,
  );
}

/**
 * The rent-exempt minimum for an account of `dataLen` bytes.
 *
 * The chain's own constants: 3,480 lamports per byte-year, a two-year
 * exemption threshold, and 128 bytes of storage overhead charged to every
 * account. A 165-byte SPL token account is (128 + 165) x 3480 x 2 =
 * 2,039,280, which is the figure this system has been quoting for ATA rent all
 * along — derived here rather than hard-coded, so a Token-2022 account with
 * extensions gets its own larger number instead of that one.
 */
export function rentExemptLamports(dataLen: bigint): bigint {
  const LAMPORTS_PER_BYTE_YEAR = 3_480n;
  const EXEMPTION_YEARS = 2n;
  const ACCOUNT_STORAGE_OVERHEAD = 128n;
  return (ACCOUNT_STORAGE_OVERHEAD + dataLen) * LAMPORTS_PER_BYTE_YEAR * EXEMPTION_YEARS;
}

/**
 * The SPL token amount an observed account holds. u64 LE at offset 64.
 *
 * Returns null for anything that is not a token account. Null is the honest
 * answer; zero would be indistinguishable from an empty balance.
 */
export function tokenAmountOf(a: ObservedAccount): bigint | null {
  if (typeof a.dataBase64 !== 'string' || a.dataBase64.length === 0) return null;
  const buf = Buffer.from(a.dataBase64, 'base64');
  if (buf.length < 72) return null;
  return buf.readBigUInt64LE(64);
}
