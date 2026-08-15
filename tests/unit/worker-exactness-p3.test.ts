import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  SequentialWorker,
  assertQuoteStateSurvived,
  QuoteStateMoved,
  RuntimeInstanceChanged,
} from '../../packages/simulator/src/sequential-worker.js';
import {
  RENT_EXEMPT_EPOCH,
  ObservedBytesNotRequested,
  observedTokenAtoms,
  observedBytes,
  exactClock,
  exactRent,
  exactEpochSchedule,
  createdAccountRent,
  type ObservedAccount,
  type SequentialStepResult,
} from '../../packages/simulator/src/sequential-runtime.js';
import { accountSourceOf } from '../../packages/solana/src/pumpswap-offline.js';

/**
 * The directive's required worker tests, 11 through 19.
 *
 * Each of these fails against `29c7cc7`, and each one is about the WIRE or the
 * CLIENT rather than about a pure function — the defect class this project
 * keeps rediscovering is a correct module nothing calls, so the assertions are
 * made against what `SequentialWorker` actually sends and what it does with
 * what comes back.
 *
 * The real binary is exercised separately by `pnpm worker:exactness-proof`,
 * which is where the runtime-side half of these claims is established. These
 * are the half that must hold with no worker installed at all, so an
 * independent party can check them.
 */

/** A worker whose child process is a script, so the WIRE is inspectable. */
function wiredWorker(responses: Record<string, unknown>[]): {
  worker: SequentialWorker;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  let n = 0;

  const stdout = new EventEmitter() as EventEmitter & { readable: boolean };
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new EventEmitter(),
    stdin: {
      write(chunk: string, cb: (e?: Error | null) => void): boolean {
        sent.push(JSON.parse(chunk) as Record<string, unknown>);
        // The response is delivered asynchronously, exactly as a pipe would.
        setImmediate(() => {
          const r = responses[n++] ?? { ok: true };
          stdout.emit('data', Buffer.from(JSON.stringify(r) + '\n'));
        });
        cb(null);
        return true;
      },
    },
    kill(): void {},
  });

  const worker = new SequentialWorker({});
  // The client builds its process lazily; this replaces the spawn.
  (worker as unknown as { start: () => void }).start = function start(this: {
    proc: unknown;
    rl: unknown;
    pending: ((r: unknown) => void)[];
  }): void {
    if (this.proc !== null) return;
    this.proc = proc;
    stdout.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        const resolve = this.pending.shift();
        if (resolve !== undefined) resolve(JSON.parse(line));
      }
    });
  };
  return { worker, sent };
}

const IDENTITY = {
  runtime: 'litesvm',
  runtime_version: '0.1.0',
  litesvm_version: '0.6.1',
  binary_sha256: 'abc',
  programs_loaded: [],
};

const SNAPSHOT = {
  programs: [],
  accounts: [
    {
      pubkey: 'A',
      dataBase64: '',
      owner: 'Sys',
      lamports: 9_007_199_254_740_993n,
      executable: false,
      rentEpoch: RENT_EXEMPT_EPOCH,
    },
  ],
  slot: 439_000_000,
  unixTimestamp: 1_760_000_000,
};

describe('11 — every u64 crosses the NDJSON wire as a decimal string', () => {
  it('sends lamports, rent epoch, slot, timestamp and CU limit as strings', async () => {
    const { worker, sent } = wiredWorker([{ ok: true, runtime_identity: IDENTITY, instance_id: 'i1' }]);
    await worker.init(SNAPSHOT, { jobId: 'j', maxComputeUnits: 1_400_000 });

    const init = sent[0] as Record<string, unknown>;
    const acct = (init['accounts'] as Record<string, unknown>[])[0] as Record<string, unknown>;

    expect(typeof acct['lamports']).toBe('string');
    expect(typeof acct['rent_epoch']).toBe('string');
    expect(typeof init['slot']).toBe('string');
    expect(typeof init['unix_timestamp']).toBe('string');
    expect(typeof init['max_compute_units']).toBe('string');
  });

  it('carries u64::MAX exactly, which a JSON number cannot', async () => {
    const { worker, sent } = wiredWorker([{ ok: true, runtime_identity: IDENTITY, instance_id: 'i1' }]);
    await worker.init(SNAPSHOT, { jobId: 'j' });
    const acct = ((sent[0] as Record<string, unknown>)['accounts'] as Record<string, unknown>[])[0];

    expect(acct?.['rent_epoch']).toBe('18446744073709551615');
    // What the previous protocol would have put on the wire. The difference is
    // silent at both ends, and rent_epoch is how the chain says "exempt".
    expect(String(Number(RENT_EXEMPT_EPOCH))).toBe('18446744073709552000');
    expect(BigInt(Number(RENT_EXEMPT_EPOCH))).not.toBe(RENT_EXEMPT_EPOCH);
  });

  it('reads lamports back as a bigint, never a number', async () => {
    const { worker } = wiredWorker([
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i1' },
      {
        ok: true,
        instance_id: 'i1',
        accounts: [
          {
            pubkey: 'A',
            lamports: '9007199254740993',
            owner: 'Sys',
            executable: false,
            rent_epoch: '18446744073709551615',
            data_len: '0',
            data_base64: '',
            data_sha256: 'x',
            account_hash: 'h',
          },
        ],
        unobserved: [],
        state_hash: 's',
      },
    ]);
    await worker.init(SNAPSHOT, { jobId: 'j' });
    const seen = await worker.observe(['A'], ['A']);

    expect(seen.accounts[0]?.lamports).toBe(9_007_199_254_740_993n);
    expect(seen.accounts[0]?.rentEpoch).toBe(RENT_EXEMPT_EPOCH);
  });
});

describe('12/13 — Init resets what belongs to a job', () => {
  it('sends the reset-bearing fields and a fresh identity on every init', async () => {
    const { worker, sent } = wiredWorker([
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i1' },
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i2' },
    ]);
    await worker.init(SNAPSHOT, { jobId: 'one' });
    expect(worker.instanceId).toBe('i1');
    await worker.init(SNAPSHOT, { jobId: 'two' });
    expect(worker.instanceId).toBe('i2');

    expect((sent[0] as Record<string, unknown>)['job_id']).toBe('one');
    expect((sent[1] as Record<string, unknown>)['job_id']).toBe('two');
  });

  it('resets the host byte counter, so job two does not inherit job one', async () => {
    const { worker } = wiredWorker([
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i1' },
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i2' },
    ]);
    await worker.init(SNAPSHOT, { jobId: 'one' });

    // Stand in for a job that spent most of the allowance. The scripted child
    // does not go through the readline path that counts real bytes, so the
    // spend is set directly — the claim under test is the RESET, not the
    // counting, and the real counting is proved by worker:exactness-proof.
    (worker as unknown as { bytesSeen: number }).bytesSeen = 127 * 1024 * 1024;

    await worker.init(SNAPSHOT, { jobId: 'two' });

    // THE assertion. Without the reset, job two starts one megabyte from a
    // 128 MB bound it never approached, and dies for job one's spending.
    expect((worker as unknown as { bytesSeen: number }).bytesSeen).toBeLessThan(1024);
  });

  it('a response from a different instance refuses', async () => {
    const { worker } = wiredWorker([
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i1' },
      { ok: true, instance_id: 'SOMETHING-ELSE', accounts: [], unobserved: [], state_hash: 's' },
    ]);
    await worker.init(SNAPSHOT, { jobId: 'j' });
    await expect(worker.observe(['A'], ['A'])).rejects.toBeInstanceOf(RuntimeInstanceChanged);
  });
});

describe('14 — a failed write cannot shift responses onto the wrong caller', () => {
  it('removes its own slot from the queue when the write fails', async () => {
    const sent: Record<string, unknown>[] = [];
    const stdout = new EventEmitter();
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new EventEmitter(),
      stdin: {
        write(chunk: string, cb: (e?: Error | null) => void): boolean {
          sent.push(JSON.parse(chunk) as Record<string, unknown>);
          // The FIRST write fails; the second succeeds and is answered.
          if (sent.length === 1) {
            cb(new Error('EPIPE'));
          } else {
            cb(null);
            setImmediate(() =>
              stdout.emit(
                'data',
                Buffer.from(JSON.stringify({ ok: true, runtime_identity: IDENTITY, instance_id: 'i2' }) + '\n'),
              ),
            );
          }
          return true;
        },
      },
      kill(): void {},
    });

    const worker = new SequentialWorker({});
    (worker as unknown as { start: () => void }).start = function start(this: {
      proc: unknown;
      pending: ((r: unknown) => void)[];
    }): void {
      if (this.proc !== null) return;
      this.proc = proc;
      stdout.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n').filter(Boolean)) {
          const resolve = this.pending.shift();
          if (resolve !== undefined) resolve(JSON.parse(line));
        }
      });
    };

    await expect(worker.init(SNAPSHOT, { jobId: 'doomed' })).rejects.toThrow(/could not write/);

    // THE assertion. If the failed write left its slot behind, the next
    // command's answer is handed to a settled promise and this call hangs
    // until its timeout — every later response paired with the wrong request.
    const pending = (worker as unknown as { pending: unknown[] }).pending;
    expect(pending.length).toBe(0);

    const second = await worker.init(SNAPSHOT, { jobId: 'survivor' });
    expect(second.runtime).toBe('litesvm');
  });
});

describe('15/16 — exact sysvars, and refusing to derive them', () => {
  it('sends the captured Clock, Rent and EpochSchedule verbatim', async () => {
    const { worker, sent } = wiredWorker([{ ok: true, runtime_identity: IDENTITY, instance_id: 'i1' }]);
    await worker.init(
      {
        ...SNAPSHOT,
        clock: {
          slot: '439000000',
          epochStartTimestamp: '1759000000',
          epoch: '1021',
          leaderScheduleEpoch: '1022',
          unixTimestamp: '1760000000',
        },
        rent: { lamportsPerByteYear: '3480', exemptionThreshold: 2, burnPercent: 50 },
        epochSchedule: {
          slotsPerEpoch: '432000',
          leaderScheduleSlotOffset: '432000',
          warmup: false,
          firstNormalEpoch: '0',
          firstNormalSlot: '0',
        },
      },
      { jobId: 'j' },
    );

    const clock = (sent[0] as Record<string, unknown>)['clock'] as Record<string, unknown>;
    expect(clock['epoch']).toBe('1021');
    // The value the worker used to DERIVE. Off by five epochs at this slot.
    expect(String(Math.floor(439_000_000 / 432_000))).toBe('1016');
    expect((sent[0] as Record<string, unknown>)['rent']).not.toBeNull();
    expect((sent[0] as Record<string, unknown>)['epoch_schedule']).not.toBeNull();
  });

  it('sends null rather than a fabricated sysvar when none was captured', () => {
    expect(exactClock(SNAPSHOT)).toBeNull();
    expect(exactRent(SNAPSHOT)).toBeNull();
    expect(exactEpochSchedule(SNAPSHOT)).toBeNull();
  });

  it('asks the worker to refuse when the caller requires exactness', async () => {
    const { worker, sent } = wiredWorker([{ ok: true, runtime_identity: IDENTITY, instance_id: 'i1' }]);
    await worker.init({ ...SNAPSHOT, requireExactSysvars: true, requiredAccounts: ['A'] }, { jobId: 'j' });
    expect((sent[0] as Record<string, unknown>)['require_exact_sysvars']).toBe(true);
    expect((sent[0] as Record<string, unknown>)['required_accounts']).toEqual(['A']);
  });
});

describe('17/18 — the survival check compares the whole account', () => {
  function acct(pubkey: string, over: Partial<ObservedAccount> = {}): ObservedAccount {
    return {
      pubkey,
      lamports: 1_000n,
      owner: 'Sys',
      executable: false,
      rentEpoch: RENT_EXEMPT_EPOCH,
      dataLen: 4,
      dataBase64: 'AAAA',
      dataSha256: 'same-bytes',
      accountHash: 'same-account',
      ...over,
    };
  }

  const step = (pre: ObservedAccount[]): SequentialStepResult => ({
    label: 'sell',
    status: 'SIMULATED_OK',
    transactionError: null,
    computeUnitsConsumed: 1,
    logs: [],
    preAccounts: pre,
    postAccounts: [],
    unobserved: [],
  });

  const quoted = (accounts: ObservedAccount[]): Parameters<typeof assertQuoteStateSurvived>[0] => ({
    accounts,
    unobserved: [],
    stateHash: 'q',
    instanceId: 'i1',
  });

  it('passes when the account is identical', () => {
    expect(() => assertQuoteStateSurvived(quoted([acct('P')]), step([acct('P')]))).not.toThrow();
  });

  it('catches an owner change that leaves the DATA identical', () => {
    const moved = acct('P', { owner: 'TokenkegQ', accountHash: 'different-account' });
    // The old check compared this and saw nothing.
    expect(moved.dataSha256).toBe('same-bytes');
    expect(() => assertQuoteStateSurvived(quoted([acct('P')]), step([moved]))).toThrow(QuoteStateMoved);
  });

  it('catches a lamport change that leaves the DATA identical', () => {
    const moved = acct('P', { lamports: 999_999n, accountHash: 'different-account' });
    expect(moved.dataSha256).toBe('same-bytes');
    expect(() => assertQuoteStateSurvived(quoted([acct('P')]), step([moved]))).toThrow(QuoteStateMoved);
  });

  it('catches a rent-epoch change that leaves the DATA identical', () => {
    const moved = acct('P', { rentEpoch: 7n, accountHash: 'different-account' });
    expect(() => assertQuoteStateSurvived(quoted([acct('P')]), step([moved]))).toThrow(QuoteStateMoved);
  });

  it('catches the data moving', () => {
    const moved = acct('P', { dataSha256: 'other', accountHash: 'different-account' });
    expect(() => assertQuoteStateSurvived(quoted([acct('P')]), step([moved]))).toThrow(QuoteStateMoved);
  });
});

describe('19 — scoped output is safe because withheld bytes REFUSE', () => {
  const withheld: ObservedAccount = {
    pubkey: 'V',
    lamports: 2_039_280n,
    owner: 'TokenkegQ',
    executable: false,
    rentEpoch: RENT_EXEMPT_EPOCH,
    dataLen: 165,
    dataBase64: null,
    dataSha256: 'abc',
    accountHash: 'def',
  };

  it('asks the worker for only the economic payloads', async () => {
    const { worker, sent } = wiredWorker([
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i1' },
      { ok: true, instance_id: 'i1', accounts: [], unobserved: [], state_hash: 's' },
    ]);
    await worker.init(SNAPSHOT, { jobId: 'j', maxJobOutputBytes: 1_000 });
    await worker.observe(['A', 'B', 'C'], ['A']);

    expect((sent[0] as Record<string, unknown>)['max_job_output_bytes']).toBe('1000');
    expect((sent[1] as Record<string, unknown>)['economic']).toEqual(['A']);
  });

  it('reading a balance from withheld bytes refuses instead of reporting zero', () => {
    expect(() => observedTokenAtoms(withheld)).toThrow(ObservedBytesNotRequested);
    expect(() => observedBytes(withheld)).toThrow(ObservedBytesNotRequested);
    // An account the run never saw IS genuinely zero, and stays zero.
    expect(observedTokenAtoms(undefined)).toBe(0n);
  });

  it('a withheld account cannot enter a source the next leg is built from', () => {
    expect(() => accountSourceOf([withheld])).toThrow(/carries no bytes/);
  });

  it('rent is still measurable for a withheld account, because length is reported', () => {
    const step: SequentialStepResult = {
      label: 'buy',
      status: 'SIMULATED_OK',
      transactionError: null,
      computeUnitsConsumed: 1,
      logs: [],
      preAccounts: [],
      postAccounts: [withheld],
      unobserved: [],
    };
    // 165 bytes of token account, created by this transaction. The payload was
    // never fetched and the rent is exact anyway.
    expect(createdAccountRent(step).lamports).toBe(2_039_280n);
  });
});
