# -*- coding: utf-8 -*-
import io, sys


def edit(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if s.count(old) != 1:
            print('MISS(%d) in %s: %s' % (s.count(old), path, old[:90].replace('\n', ' | ')))
            sys.exit(1)
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('ok', path)


edit('packages/simulator/src/sequential-worker.ts', [
    (
        """import type { FrozenRuntimeSnapshot, SequentialStep, SequentialStepResult, ObservedAccount } from './sequential-runtime.js';
import {
  WORKER_WSL_PATH,
  DEFAULT_NATIVE_WORKER_PATH,
  SequentialRuntimeUnavailable,
} from './sequential-runtime.js';""",
        """import type { FrozenRuntimeSnapshot, SequentialStep, SequentialStepResult, ObservedAccount } from './sequential-runtime.js';
import {
  WORKER_WSL_PATH,
  DEFAULT_NATIVE_WORKER_PATH,
  SequentialRuntimeUnavailable,
  RENT_EXEMPT_EPOCH,
  exactClock,
  exactRent,
  exactEpochSchedule,
} from './sequential-runtime.js';""",
    ),
    (
        """export interface ObserveResult {
  readonly accounts: readonly ObservedAccount[];
  readonly unobserved: readonly string[];
  /** Hash over exactly the accounts requested, in canonical order. */
  readonly stateHash: string;
}

export interface StepOutcome {
  readonly step: SequentialStepResult;
  /** Hash over every account this runtime has been told about. */
  readonly stateHash: string;
}""",
        """export interface ObserveResult {
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
}""",
    ),
    (
        """  state_hash?: string;
  incompleteness?: string[];
}""",
        """  state_hash?: string;
  incompleteness?: string[];
  instance_id?: string;
  job_output_bytes?: string;
}""",
    ),
    (
        """  private bytesSeen = 0;
  private closed = false;
  private identity: WorkerIdentity | null = null;
  private incompleteness: string[] = [];""",
        """  private bytesSeen = 0;
  private closed = false;
  private identity: WorkerIdentity | null = null;
  private incompleteness: string[] = [];
  private instance: string | null = null;

  /** Which runtime instance is live. Null before `init`. */
  get instanceId(): string | null {
    return this.instance;
  }""",
    ),
    # ---- F8: the host-side byte counter is per job, not per process ---------
    (
        """    this.rl = createInterface({ input: proc.stdout });
    this.rl.on('line', (line: string) => {
      this.bytesSeen += line.length;""",
        """    this.rl = createInterface({ input: proc.stdout });
    this.rl.on('line', (line: string) => {
      // F8 — reset by `init`, exactly like the worker's own budget. A
      // process-lifetime total lets job one spend the whole allowance and job
      // two die for it, and the death looks like a fact about job two.
      this.bytesSeen += line.length;""",
    ),
    # ---- F8: a failed write must not leave a slot in the queue --------------
    (
        """      this.pending.push(settle);
      proc.stdin.write(JSON.stringify(command) + '\\n', (e) => {
        if (e) settle(new SequentialRuntimeUnavailable(`could not write to the worker: ${e.message}`));
      });""",
        """      this.pending.push(settle);
      proc.stdin.write(JSON.stringify(command) + '\\n', (e) => {
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
      });""",
    ),
    # ---- init ---------------------------------------------------------------
    (
        """  /** Build the runtime. Everything after this runs against it. */
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
    this.incompleteness = r.incompleteness ?? [];""",
        """  /** Build the runtime. Everything after this runs against it. */
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
        // F7 — decimal strings. u64::MAX through a JSON double comes back
        // 1615 short of itself, silently, on the economic path.
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
    this.instance = r.instance_id ?? null;""",
    ),
    # ---- observe ------------------------------------------------------------
    (
        """  /** Read state WITHOUT executing, so the caller can build the next leg from it. */
  async observe(accounts: readonly string[]): Promise<ObserveResult> {
    const r = await this.send({ cmd: 'observe', observe: [...accounts] });
    if (r.ok !== true) throw new SequentialRuntimeUnavailable(r.error ?? 'observe failed');
    return {
      accounts: (r.accounts ?? []).map(toObserved),
      unobserved: r.unobserved ?? [],
      stateHash: r.state_hash ?? '',
    };
  }""",
        """  /**
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
  }""",
    ),
    # ---- step ---------------------------------------------------------------
    (
        """  /** Execute one transaction and COMMIT it. The next step sees this state. */
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
  }""",
        """  /** Execute one transaction and COMMIT it. The next step sees this state. */
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
  }""",
    ),
    # ---- toObserved ---------------------------------------------------------
    (
        """function toObserved(a: Record<string, unknown>): ObservedAccount {
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
}""",
        """function toObserved(a: Record<string, unknown>): ObservedAccount {
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
}""",
    ),
    # ---- F10: the survival check compares the WHOLE account ------------------
    (
        """export function assertQuoteStateSurvived(quoted: ObserveResult, sellStep: SequentialStepResult): void {
  const quotedByKey = new Map(quoted.accounts.map((a) => [a.pubkey, a.dataSha256]));
  const differing: string[] = [];
  for (const pre of sellStep.preAccounts) {
    const q = quotedByKey.get(pre.pubkey);
    if (q === undefined) continue; // not part of the quote
    if (q !== pre.dataSha256) differing.push(pre.pubkey);
  }""",
        """export function assertQuoteStateSurvived(quoted: ObserveResult, sellStep: SequentialStepResult): void {
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
  }""",
    ),
])
