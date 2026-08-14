import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { FrozenRuntimeSnapshot, SequentialStep, SequentialStepResult, ObservedAccount } from './sequential-runtime.js';
import { WORKER_WSL_PATH, SequentialRuntimeUnavailable } from './sequential-runtime.js';

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
}

export interface StepOutcome {
  readonly step: SequentialStepResult;
  /** Hash over every account this runtime has been told about. */
  readonly stateHash: string;
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
}

export interface WorkerOptions {
  /** Hard bound per command. A worker that hangs is a worker that lies. */
  readonly commandTimeoutMs?: number;
  /** Bytes of stdout allowed before the worker is killed. */
  readonly maxOutputBytes?: number;
  readonly wslDistro?: string;
  readonly workerPath?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 128 * 1024 * 1024;

export class SequentialWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private pending: ((r: RawResponse | Error) => void)[] = [];
  private bytesSeen = 0;
  private closed = false;
  private identity: WorkerIdentity | null = null;
  private incompleteness: string[] = [];

  constructor(private readonly opts: WorkerOptions = {}) {}

  get runtimeIdentity(): WorkerIdentity | null {
    return this.identity;
  }

  get initIncompleteness(): readonly string[] {
    return this.incompleteness;
  }

  private start(): void {
    if (this.proc !== null) return;
    const distro = this.opts.wslDistro ?? 'Ubuntu-24.04';
    const worker = this.opts.workerPath ?? WORKER_WSL_PATH;
    const proc = spawn('wsl', ['-d', distro, '--', worker, '--serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
        if (e) settle(new SequentialRuntimeUnavailable(`could not write to the worker: ${e.message}`));
      });
    });
  }

  /** Build the runtime. Everything after this runs against it. */
  async init(snapshot: FrozenRuntimeSnapshot, opts: { jobId: string; maxComputeUnits?: number }): Promise<WorkerIdentity> {
    const r = await this.send({
      cmd: 'init',
      job_id: opts.jobId,
      programs: snapshot.programs.map((p) => ({ program_id: p.programId, elf_base64: p.elfBase64 })),
      accounts: snapshot.accounts.map((a) => ({
        pubkey: a.pubkey,
        data_base64: a.dataBase64,
        owner: a.owner,
        lamports: Number(a.lamports),
        executable: a.executable ?? false,
        rent_epoch: Number(a.rentEpoch ?? 0n),
      })),
      slot: snapshot.slot,
      unix_timestamp: snapshot.unixTimestamp,
      steps: [],
      max_compute_units: opts.maxComputeUnits ?? 1_400_000,
    });
    if (r.ok !== true || r.runtime_identity === undefined) {
      throw new SequentialRuntimeUnavailable(r.error ?? 'init returned no runtime identity');
    }
    this.incompleteness = r.incompleteness ?? [];
    this.identity = {
      runtime: r.runtime_identity.runtime,
      runtimeVersion: r.runtime_identity.runtime_version,
      litesvmVersion: r.runtime_identity.litesvm_version,
      binarySha256: r.runtime_identity.binary_sha256,
      programsLoaded: r.runtime_identity.programs_loaded,
    };
    return this.identity;
  }

  /** Read state WITHOUT executing, so the caller can build the next leg from it. */
  async observe(accounts: readonly string[]): Promise<ObserveResult> {
    const r = await this.send({ cmd: 'observe', observe: [...accounts] });
    if (r.ok !== true) throw new SequentialRuntimeUnavailable(r.error ?? 'observe failed');
    return {
      accounts: (r.accounts ?? []).map(toObserved),
      unobserved: r.unobserved ?? [],
      stateHash: r.state_hash ?? '',
    };
  }

  /** Execute one transaction and COMMIT it. The next step sees this state. */
  async step(step: SequentialStep): Promise<StepOutcome> {
    const r = await this.send({
      cmd: 'step',
      step: { label: step.label, transaction_base64: step.transactionBase64, observe: [...step.observe] },
    });
    if (r.step === undefined) throw new SequentialRuntimeUnavailable(r.error ?? 'step returned no result');
    const s = r.step;
    return {
      stateHash: r.state_hash ?? '',
      step: {
        label: String(s['label']),
        status: String(s['status']),
        transactionError: (s['transaction_error'] as string | null) ?? null,
        computeUnitsConsumed: (s['compute_units_consumed'] as number | null) ?? null,
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
  // has stopped describing the type, and `lamports` is a number here.
  const observed: ObservedAccount = {
    pubkey: String(a['pubkey']),
    lamports: Number(a['lamports']),
    owner: String(a['owner']),
    dataBase64: String(a['data_base64']),
    dataSha256: String(a['data_sha256']),
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
  const quotedByKey = new Map(quoted.accounts.map((a) => [a.pubkey, a.dataSha256]));
  const differing: string[] = [];
  for (const pre of sellStep.preAccounts) {
    const q = quotedByKey.get(pre.pubkey);
    if (q === undefined) continue; // not part of the quote
    if (q !== pre.dataSha256) differing.push(pre.pubkey);
  }
  // An account that was quoted and is absent at execution moved too.
  for (const [key] of quotedByKey) {
    if (!sellStep.preAccounts.some((p) => p.pubkey === key)) differing.push(key);
  }
  if (differing.length > 0) {
    throw new QuoteStateMoved(quoted.stateHash, 'per-account', [...new Set(differing)]);
  }
}
