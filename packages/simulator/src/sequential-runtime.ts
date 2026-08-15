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

/**
 * F9 — the sysvars EXACTLY as the chain had them.
 *
 * Without these the worker derives `epoch = slot / 432_000` and leaves Rent and
 * EpochSchedule at the runtime default. Epoch-by-division is wrong across the
 * warmup epochs, and a program that reads Rent to size an account it creates
 * gets a different answer than mainnet gave it. Neither shows up as an error —
 * they show up as an economic number that is quietly not the chain's.
 *
 * These are the shapes `decodeClock`/`decodeRent`/`decodeEpochSchedule` in
 * packages/solana/src/coherent-snapshot.ts already return.
 */
export interface ExactClock {
  readonly slot: string;
  readonly epochStartTimestamp: string;
  readonly epoch: string;
  readonly leaderScheduleEpoch: string;
  readonly unixTimestamp: string;
}

export interface ExactRent {
  readonly lamportsPerByteYear: string;
  readonly exemptionThreshold: number;
  readonly burnPercent: number;
}

export interface ExactEpochSchedule {
  readonly slotsPerEpoch: string;
  readonly leaderScheduleSlotOffset: string;
  readonly warmup: boolean;
  readonly firstNormalEpoch: string;
  readonly firstNormalSlot: string;
}

export interface FrozenRuntimeSnapshot {
  readonly programs: readonly LoadedProgram[];
  readonly accounts: readonly FrozenAccount[];
  /** The slot and wall time the snapshot was taken at. */
  readonly slot: number | null;
  readonly unixTimestamp: number | null;

  /** F9 — restored verbatim when present. Nothing is derived from them. */
  readonly clock?: ExactClock | null;
  readonly rent?: ExactRent | null;
  readonly epochSchedule?: ExactEpochSchedule | null;
  /** Refuse rather than derive, for a caller that DID capture exact state. */
  readonly requireExactSysvars?: boolean;

  /**
   * Without these this runtime is not the one the caller asked for.
   *
   * A missing account is not a note in an incompleteness list somebody might
   * read later. The transaction fails with an error that reads as a fact about
   * the token, so init refuses instead.
   */
  readonly requiredAccounts?: readonly string[];
  readonly requiredPrograms?: readonly string[];
}

export interface ObservedAccount {
  readonly pubkey: string;
  /** F7 — a u64. Never a `number`, in either direction across the wire. */
  readonly lamports: bigint;
  readonly owner: string;
  readonly executable: boolean;
  /** u64::MAX for a rent-exempt account, which is every mainnet account here. */
  readonly rentEpoch: bigint;
  readonly dataLen: number;
  /**
   * F8 — the bytes, and only for accounts the caller declared economic.
   *
   * Null means "not requested", NOT "empty". Everything else about the account
   * is still reported, which is enough to detect any change and enough to price
   * a wallet.
   */
  readonly dataBase64: string | null;
  readonly dataSha256: string;
  /**
   * F10 — the COMPLETE identity: owner, lamports, executability, rent epoch,
   * length and data.
   *
   * The survival check compared `dataSha256` alone, so a sell could execute
   * against a state whose owner and balance had both changed and the assertion
   * still passed. Those are the fields a runtime consults before it will
   * execute against the account at all.
   */
  readonly accountHash: string;
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
    lamports: BigInt(String(a['lamports'] ?? '0')),
    owner: String(a['owner'] ?? ''),
    executable: a['executable'] === true,
    rentEpoch: BigInt(String(a['rent_epoch'] ?? '0')),
    dataLen: Number(a['data_len'] ?? 0),
    dataBase64: a['data_base64'] === undefined ? null : String(a['data_base64']),
    dataSha256: String(a['data_sha256'] ?? ''),
    accountHash: String(a['account_hash'] ?? ''),
  }));
}

/**
 * The rent epoch the chain uses for an account it considers exempt.
 *
 * Defaulting to 0 — which is what the protocol did — restores every mainnet
 * account as rent-PAYING. That is a different account.
 */
export const RENT_EXEMPT_EPOCH = 18_446_744_073_709_551_615n;

export function exactClock(s: FrozenRuntimeSnapshot): Record<string, string> | null {
  const c = s.clock;
  if (c === null || c === undefined) return null;
  return {
    slot: c.slot,
    epoch_start_timestamp: c.epochStartTimestamp,
    epoch: c.epoch,
    leader_schedule_epoch: c.leaderScheduleEpoch,
    unix_timestamp: c.unixTimestamp,
  };
}

export function exactRent(s: FrozenRuntimeSnapshot): Record<string, unknown> | null {
  const r = s.rent;
  if (r === null || r === undefined) return null;
  return {
    lamports_per_byte_year: r.lamportsPerByteYear,
    exemption_threshold: r.exemptionThreshold,
    burn_percent: r.burnPercent,
  };
}

export function exactEpochSchedule(s: FrozenRuntimeSnapshot): Record<string, unknown> | null {
  const e = s.epochSchedule;
  if (e === null || e === undefined) return null;
  return {
    slots_per_epoch: e.slotsPerEpoch,
    leader_schedule_slot_offset: e.leaderScheduleSlotOffset,
    warmup: e.warmup,
    first_normal_epoch: e.firstNormalEpoch,
    first_normal_slot: e.firstNormalSlot,
  };
}

/**
 * F8 — somebody read a balance out of an account whose bytes were never asked for.
 *
 * `dataBase64: null` means NOT REQUESTED. It is not an empty account and it is
 * not a zero balance, and the difference is the whole reason output scoping is
 * safe to do at all: an account nobody fetched must refuse rather than report
 * identically to one that holds nothing.
 *
 * This is an apparatus defect — the caller declared the wrong economic set —
 * and never a fact about the token.
 */
export class ObservedBytesNotRequested extends Error {
  constructor(readonly pubkey: string) {
    super(
      `the bytes of ${pubkey} were never requested, so nothing can be decoded from it. ` +
        'Name it in the economic set of the observe/step that produced this account.',
    );
    this.name = 'ObservedBytesNotRequested';
  }
}

export function observedBytes(a: { pubkey: string; dataBase64: string | null }): Buffer {
  if (a.dataBase64 === null) throw new ObservedBytesNotRequested(a.pubkey);
  return Buffer.from(a.dataBase64, 'base64');
}

/**
 * The SPL token amount an observed account holds.
 *
 * `undefined` is an account the run never saw, which is genuinely zero. Bytes
 * that were not requested REFUSE, via `observedBytes`.
 */
export function observedTokenAtoms(
  a: { pubkey: string; dataBase64: string | null } | undefined,
): bigint {
  if (a === undefined) return 0n;
  const b = observedBytes(a);
  return b.length >= 72 ? b.readBigUInt64LE(64) : 0n;
}

export class SequentialRuntimeUnavailable extends Error {
  constructor(reason: string) {
    super(`sequential runtime unavailable: ${reason}`);
    this.name = 'SequentialRuntimeUnavailable';
  }
}

/** Where the worker binary lives. WSL path, because that is where it builds. */
export const WORKER_WSL_PATH = '/mnt/c/Users/lyman/tradseee/offline-worker/target/release/epitaxy-offline-worker';

/**
 * Where the worker lives on a machine that is not Windows.
 *
 * Repository-relative, so a clone that ran `cargo build --release` needs no
 * configuration. `EPITAXY_WORKER_PATH` overrides it.
 */
export const DEFAULT_NATIVE_WORKER_PATH = 'offline-worker/target/release/epitaxy-offline-worker';

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
      // F7 — decimal strings. `rent_epoch` for a rent-exempt account is
      // u64::MAX, which no double can hold: it comes back one higher and prints
      // as 18446744073709552000.
      lamports: a.lamports.toString(),
      executable: a.executable ?? false,
      rent_epoch: (a.rentEpoch ?? RENT_EXEMPT_EPOCH).toString(),
    })),
    slot: opts.snapshot.slot === null ? null : String(opts.snapshot.slot),
    unix_timestamp: opts.snapshot.unixTimestamp === null ? null : String(opts.snapshot.unixTimestamp),
    clock: exactClock(opts.snapshot),
    rent: exactRent(opts.snapshot),
    epoch_schedule: exactEpochSchedule(opts.snapshot),
    steps: opts.steps.map((s) => ({
      label: s.label,
      transaction_base64: s.transactionBase64,
      observe: [...s.observe],
    })),
    max_compute_units: String(opts.maxComputeUnits ?? 1_400_000),
  };

  try {
    writeFileSync(jobPath, JSON.stringify(job));
    // Paths are translated for the worker, which runs inside WSL.
    const wslJob = jobPath.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
    const wslOut = outPath.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');

    // Windows runs the worker through WSL because that is where it builds;
    // every other platform executes it directly. See workerCommand (F9).
    const native = process.platform !== 'win32';
    const bin = process.env['EPITAXY_WORKER_PATH'] ?? (native ? DEFAULT_NATIVE_WORKER_PATH : WORKER_WSL_PATH);
    const cmd = native ? bin : 'wsl';
    const argv = native ? [jobPath, outPath] : ['-d', 'Ubuntu-24.04', '--', bin, wslJob, wslOut];
    execFileSync(cmd, argv, {
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
        computeUnitsConsumed:
          s['compute_units_consumed'] === null || s['compute_units_consumed'] === undefined
            ? null
            : Number(s['compute_units_consumed']),
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
    const existed = prior !== undefined && (prior.lamports > 0n || prior.dataLen > 0);
    if (existed || a.lamports <= 0n) continue;
    // Only the EXEMPTION is rent. The coin-creator fee vault is opened and paid
    // in the same transaction, so its closing balance is rent PLUS a fee the
    // pool sent it; crediting the whole balance back to the payer flattered
    // every sell by a few basis points and by 94 on one of them.
    // `dataLen` rather than the payload, so rent is measurable for an account
    // whose bytes the caller never asked for. Length is always reported.
    const bytes = BigInt(a.dataLen);
    const rent = rentExemptLamports(bytes);
    const actual = a.lamports;
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
