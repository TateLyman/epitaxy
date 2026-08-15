import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { FrozenRuntimeSnapshot, SequentialStep, SequentialStepResult, ObservedAccount } from './sequential-runtime.js';
import {
  WORKER_WSL_PATH,
  DEFAULT_NATIVE_WORKER_PATH,
  SequentialRuntimeUnavailable,
  RENT_EXEMPT_EPOCH,
  exactClock,
  exactRent,
  exactEpochSchedule,
} from './sequential-runtime.js';

/**
 * P3 — one persistent sequential runtime, driven asynchronously.
 *
 * Two defects are removed here and they are separate.
 *
 * **The two-pass architecture.** Pass one ran the buy in runtime instance A to
 * learn what it produced; the sell was built from that; pass two then ran
 * buy-then-sell in a FRESH instance B. Two instances replaying the same buy
 * ought to agree — but nothing checked that they did, and a sell priced against
 * a state it did not execute in is not an exact sequential mechanic. It is an
 * approximation that looks exactly like one.
 *
 * This client keeps ONE runtime alive:
 *
 * ```
 * init → step(buy) → observe(price-bearing accounts)
 *      → [caller builds the sell from THOSE bytes]
 *      → step(sell)   ← same runtime, same committed state
 * ```
 *
 * and `assertQuoteStateSurvived` proves the property rather than assuming it, by
 * comparing the hash returned by `observe` with the sell step's own pre-state.
 *
 * **The blocking call.** `runSequential` uses `execFileSync`, which stops the
 * Node event loop for the whole run — up to four minutes. In a process that is
 * also marking positions on a schedule, that is not a performance question: the
 * mark scheduler simply does not run, and marks that never happened cannot be
 * distinguished afterwards from marks that found nothing.
 */

export interface WorkerIdentity {
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly litesvmVersion: string;
  readonly binarySha256: string;
  readonly programsLoaded: readonly string[];
}

export interface ObserveResult {
  readonly accounts: readonly ObservedAccount[];
  readonly unobserved: readonly string[];
  /** Hash over exactly the accounts requested, in canonical order. */
  readonly stateHash: string;
  /** Which runtime instance answered. See `RuntimeInstanceChanged`. */
  readonly instanceId: string | null;
}

export interface StepOutcome {
  readonly step: SequentialStepResult;
  /** Hash over every account this runtime has been told about. */
  readonly stateHash: string;
  readonly instanceId: string | null;
}

/**
 * P3 — the quote and the execution it priced came from DIFFERENT runtimes.
 *
 * Nothing could detect this before, because no response said which instance
 * answered. An `init` between an observe and a step replaces the world; the
 * hashes then compare accounts across two universes and can agree or disagree
 * for reasons that have nothing to do with the trade.
 */
export class RuntimeInstanceChanged extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `the runtime instance changed mid-sequence (quoted in ${expected}, answered by ${actual}). ` +
        'A sell priced in one runtime and executed in another is not a sequential mechanic.',
    );
    this.name = 'RuntimeInstanceChanged';
  }
}

interface RawResponse {
  ok?: boolean;
  error?: string;
  runtime_identity?: {
    runtime: string;
    runtime_version: string;
    litesvm_version: string;
    binary_sha256: string;
    programs_loaded: string[];
  };
  step?: Record<string, unknown>;
  accounts?: Record<string, unknown>[];
  unobserved?: string[];
  state_hash?: string;
  incompleteness?: string[];
  instance_id?: string;
  job_output_bytes?: string;
}

export interface WorkerOptions {
  /** Hard bound per command. A worker that hangs is a worker that lies. */
  readonly commandTimeoutMs?: number;
  /** Bytes of stdout allowed before the worker is killed. */
  readonly maxOutputBytes?: number;
  readonly wslDistro?: string;
  readonly workerPath?: string;
  /** Testing seam so both platform branches are reachable from one host. */
  readonly forcePlatform?: NodeJS.Platform;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 128 * 1024 * 1024;


/**
 * F9 — the `wsl` wrapper is a WINDOWS detail, not part of the worker.
 *
 * Both entry points spawned the literal command
 * `wsl -d Ubuntu-24.04 -- /mnt/c/Users/.../epitaxy-offline-worker`, and
 * `workerPath` could change the path but not the wrapper. The Rust worker is
 * portable and runs natively on Linux; the CLIENT was not, so no independent
 * party could re-derive a trajectory. An audit that cannot run the apparatus
 * cannot check anything it produces, which is how most of one became
 * NOT TESTABLE.
 *
 * On Windows the worker still runs inside WSL, because that is where it builds.
 * Everywhere else it is executed directly. `EPITAXY_WORKER_PATH` overrides the
 * binary on any platform.
 */
export function workerCommand(
  opts: { wslDistro?: string; workerPath?: string; forcePlatform?: NodeJS.Platform },
  extraArgs: readonly string[] = [],
): { command: string; args: string[] } {
  const platform = opts.forcePlatform ?? process.platform;
  const fromEnv = process.env['EPITAXY_WORKER_PATH'];

  if (platform === 'win32') {
    const distro = opts.wslDistro ?? 'Ubuntu-24.04';
    const worker = opts.workerPath ?? fromEnv ?? WORKER_WSL_PATH;
    return { command: 'wsl', args: ['-d', distro, '--', worker, ...extraArgs] };
  }

  // Native. The default is the repository-relative release build, so a clone
  // that ran `cargo build --release` needs no configuration at all.
  const worker = opts.workerPath ?? fromEnv ?? DEFAULT_NATIVE_WORKER_PATH;
  return { command: worker, args: [...extraArgs] };
}

export class SequentialWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private pending: ((r: RawResponse | Error) => void)[] = [];
  private bytesSeen = 0;
  private closed = false;
  private identity: WorkerIdentity | null = null;
  private incompleteness: string[] = [];
  private instance: string | null = null;

  /** Which runtime instance is live. Null before `init`. */
  get instanceId(): string | null {
    return this.instance;
  }

  constructor(private readonly opts: WorkerOptions = {}) {}

  get runtimeIdentity(): WorkerIdentity | null {
    return this.identity;
  }

  get initIncompleteness(): readonly string[] {
    return this.incompleteness;
  }

  private start(): void {
    if (this.proc !== null) return;
    const { command, args } = workerCommand(this.opts, ['--serve']);
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    // A crash must reject everything waiting, not hang the caller forever.
    const die = (why: string): void => {
      this.closed = true;
      const waiting = this.pending;
      this.pending = [];
      for (const r of waiting) r(new SequentialRuntimeUnavailable(why));
    };
    proc.on('error', (e) => die(`worker could not start: ${e.message}`));
    proc.on('exit', (code, signal) => {
      if (this.pending.length > 0) die(`worker exited (code ${code}, signal ${signal})`);
      this.closed = true;
    });

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4_000);
    });

    this.rl = createInterface({ input: proc.stdout });
    this.rl.on('line', (line: string) => {
      // F8 — reset by `init`, exactly like the worker's own budget. A
      // process-lifetime total lets job one spend the whole allowance and job
      // two die for it, and the death looks like a fact about job two.
      this.bytesSeen += line.length;
      if (this.bytesSeen > (this.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT)) {
        die(`worker exceeded the output bound (${this.bytesSeen} bytes)`);
        proc.kill('SIGKILL');
        return;
      }
      const resolve = this.pending.shift();
      if (resolve === undefined) return; // unsolicited output is ignored, not fatal
      try {
        resolve(JSON.parse(line) as RawResponse);
      } catch {
        resolve(new SequentialRuntimeUnavailable(`worker wrote a non-JSON line: ${line.slice(0, 120)}${stderr ? ` | stderr: ${stderr.slice(-200)}` : ''}`));
      }
    });
  }

  private send(command: unknown): Promise<RawResponse> {
    this.start();
    const proc = this.proc;
    if (proc === null || this.closed) {
      return Promise.reject(new SequentialRuntimeUnavailable('the worker is not running'));
    }
    return new Promise<RawResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove our slot so a late reply is not handed to the NEXT caller,
        // which would silently pair a response with the wrong request.
        const i = this.pending.indexOf(settle);
        if (i >= 0) this.pending.splice(i, 1);
        this.closed = true;
        proc.kill('SIGKILL');
        reject(new SequentialRuntimeUnavailable(`worker did not answer within ${this.opts.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
      }, this.opts.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS);

      const settle = (r: RawResponse | Error): void => {
        clearTimeout(timer);
        if (r instanceof Error) reject(r);
        else resolve(r);
      };
      this.pending.push(settle);
      proc.stdin.write(JSON.stringify(command) + '\n', (e) => {
        if (e === null || e === undefined) return;
        // F8 — the slot has to come OUT of the queue, not merely be rejected.
        //
        // Rejecting the promise and leaving `settle` in `pending` means the
        // next line the worker writes is handed to an already-settled slot and
        // silently dropped, and every subsequent response is paired with the
        // wrong request. The corruption is invisible: each caller gets a
        // well-formed answer to somebody else's question.
        const i = this.pending.indexOf(settle);
        if (i >= 0) this.pending.splice(i, 1);
        settle(new SequentialRuntimeUnavailable(`could not write to the worker: ${e.message}`));
      });
    });
  }

  /** Build the runtime. Everything after this runs against it. */
  async init(
    snapshot: FrozenRuntimeSnapshot,
    opts: { jobId: string; maxComputeUnits?: number; maxJobOutputBytes?: number },
  ): Promise<WorkerIdentity> {
    // F8 — the host's own byte counter is job-scoped for the same reason the
    // worker's is. Reset BEFORE the command, so init's own response counts
    // against the new job rather than the previous one.
    this.bytesSeen = 0;
    this.instance = null;
    const r = await this.send({
      cmd: 'init',
      job_id: opts.jobId,
      programs: snapshot.programs.map((p) => ({ program_id: p.programId, elf_base64: p.elfBase64 })),
      accounts: snapshot.accounts.map((a) => ({
        pubkey: a.pubkey,
        data_base64: a.dataBase64,
        owner: a.owner,
        // F7 — decimal strings. u64::MAX through a JSON double comes back one
        // higher than it went in, silently, on the economic path.
        lamports: a.lamports.toString(),
        executable: a.executable ?? false,
        rent_epoch: (a.rentEpoch ?? RENT_EXEMPT_EPOCH).toString(),
      })),
      slot: snapshot.slot === null ? null : String(snapshot.slot),
      unix_timestamp: snapshot.unixTimestamp === null ? null : String(snapshot.unixTimestamp),
      // F9 — restored verbatim. Nothing derived from slot.
      clock: exactClock(snapshot),
      rent: exactRent(snapshot),
      epoch_schedule: exactEpochSchedule(snapshot),
      require_exact_sysvars: snapshot.requireExactSysvars === true,
      required_accounts: [...(snapshot.requiredAccounts ?? [])],
      required_programs: [...(snapshot.requiredPrograms ?? [])],
      steps: [],
      max_compute_units: String(opts.maxComputeUnits ?? 1_400_000),
      max_job_output_bytes:
        opts.maxJobOutputBytes === undefined ? null : String(opts.maxJobOutputBytes),
    });
    if (r.ok !== true || r.runtime_identity === undefined) {
      throw new SequentialRuntimeUnavailable(r.error ?? 'init returned no runtime identity');
    }
    this.incompleteness = r.incompleteness ?? [];
    this.instance = r.instance_id ?? null;
    this.identity = {
      runtime: r.runtime_identity.runtime,
      runtimeVersion: r.runtime_identity.runtime_version,
      litesvmVersion: r.runtime_identity.litesvm_version,
      binarySha256: r.runtime_identity.binary_sha256,
      programsLoaded: r.runtime_identity.programs_loaded,
    };
    return this.identity;
  }

  /**
   * Read state WITHOUT executing, so the caller can build the next leg from it.
   *
   * `economic` (F8) names the accounts whose BYTES the caller needs — the pool
   * and its vaults, typically. Everything named in `accounts` is still reported
   * with owner, lamports, executability, rent epoch, length and hashes; only
   * the base64 payload is restricted. Omitting it returns every payload, which
   * is what produced ~280 MB on a size surface and killed the worker.
   */
  async observe(accounts: readonly string[], economic?: readonly string[]): Promise<ObserveResult> {
    const r = await this.send({
      cmd: 'observe',
      observe: [...accounts],
      economic: economic === undefined ? null : [...economic],
    });
    if (r.ok !== true) throw new SequentialRuntimeUnavailable(r.error ?? 'observe failed');
    this.assertSameInstance(r);
    return {
      accounts: (r.accounts ?? []).map(toObserved),
      unobserved: r.unobserved ?? [],
      stateHash: r.state_hash ?? '',
      instanceId: r.instance_id ?? null,
    };
  }

  /**
   * The runtime that answered must be the one that was initialised.
   *
   * Checked on every command rather than at the end, so a sequence that
   * straddled two instances is refused at the first response from the wrong
   * one — while the caller can still name which step it was.
   */
  private assertSameInstance(r: RawResponse): void {
    const got = r.instance_id ?? null;
    if (this.instance === null || got === null) return;
    if (got !== this.instance) throw new RuntimeInstanceChanged(this.instance, got);
  }

  /** Execute one transaction and COMMIT it. The next step sees this state. */
  async step(step: SequentialStep, economic?: readonly string[]): Promise<StepOutcome> {
    const r = await this.send({
      cmd: 'step',
      step: {
        label: step.label,
        transaction_base64: step.transactionBase64,
        observe: [...step.observe],
        economic: economic === undefined ? null : [...economic],
      },
    });
    if (r.step === undefined) throw new SequentialRuntimeUnavailable(r.error ?? 'step returned no result');
    this.assertSameInstance(r);
    const s = r.step;
    const cu = s['compute_units_consumed'];
    return {
      stateHash: r.state_hash ?? '',
      instanceId: r.instance_id ?? null,
      step: {
        label: String(s['label']),
        status: String(s['status']),
        transactionError: (s['transaction_error'] as string | null) ?? null,
        computeUnitsConsumed: cu === null || cu === undefined ? null : Number(cu),
        logs: (s['logs'] as string[]) ?? [],
        preAccounts: ((s['pre_accounts'] as Record<string, unknown>[]) ?? []).map(toObserved),
        postAccounts: ((s['post_accounts'] as Record<string, unknown>[]) ?? []).map(toObserved),
        unobserved: (s['unobserved'] as string[]) ?? [],
      },
    };
  }

  async close(): Promise<void> {
    if (this.proc === null || this.closed) return;
    try {
      await this.send({ cmd: 'close' });
    } catch {
      /* a worker that will not say goodbye is killed below */
    }
    this.closed = true;
    this.rl?.close();
    this.proc.kill();
    this.proc = null;
  }
}

function toObserved(a: Record<string, unknown>): ObservedAccount {
  // Built to the real type rather than cast to it: a forced cast is a cast that
  // has stopped describing the type.
  const observed: ObservedAccount = {
    pubkey: String(a['pubkey']),
    lamports: BigInt(String(a['lamports'])),
    owner: String(a['owner']),
    executable: a['executable'] === true,
    rentEpoch: BigInt(String(a['rent_epoch'] ?? '0')),
    dataLen: Number(a['data_len'] ?? 0),
    // Absent means NOT REQUESTED. It must not collapse to the empty string,
    // which is a real and different state: an account with no data.
    dataBase64: a['data_base64'] === undefined ? null : String(a['data_base64']),
    dataSha256: String(a['data_sha256']),
    accountHash: String(a['account_hash'] ?? ''),
  };
  return observed;
}

export class QuoteStateMoved extends Error {
  constructor(
    readonly quotedHash: string,
    readonly executedHash: string,
    readonly differing: readonly string[],
  ) {
    super(
      `the state used to quote the sell is not the state it executed against ` +
        `(quoted ${quotedHash.slice(0, 12)}, executed ${executedHash.slice(0, 12)}; ` +
        `${differing.length} account(s) differ)`,
    );
    this.name = 'QuoteStateMoved';
  }
}

/**
 * The directive's required assertion, checked rather than asserted:
 *
 * ```
 * state used to quote sell == state immediately before sell execution
 * ```
 *
 * Compared per account by content hash, so a failure names WHICH account moved.
 * The two-pass design could not run this check at all — it had two runtimes, and
 * comparing an account across them proves they agreed on a replay, not that the
 * quote and the execution saw one state.
 */
export function assertQuoteStateSurvived(quoted: ObserveResult, sellStep: SequentialStepResult): void {
  // F10 — the COMPLETE account hash, not the data hash.
  //
  // Comparing `dataSha256` asks only whether the bytes moved. An account whose
  // owner changed, whose lamports changed, which stopped being executable or
  // which became rent-paying has the same data and is not the same account to
  // the runtime that has to execute against it.
  const quotedByKey = new Map(quoted.accounts.map((a) => [a.pubkey, a.accountHash]));
  const differing: string[] = [];
  for (const pre of sellStep.preAccounts) {
    const q = quotedByKey.get(pre.pubkey);
    if (q === undefined) continue; // not part of the quote
    if (q !== pre.accountHash) differing.push(pre.pubkey);
  }
  // An account that was quoted and is absent at execution moved too.
  for (const [key] of quotedByKey) {
    if (!sellStep.preAccounts.some((p) => p.pubkey === key)) differing.push(key);
  }
  if (differing.length > 0) {
    throw new QuoteStateMoved(quoted.stateHash, 'per-account', [...new Set(differing)]);
  }
}
