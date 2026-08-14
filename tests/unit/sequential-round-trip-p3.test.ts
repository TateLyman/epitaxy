import { describe, it, expect } from 'vitest';
import { sequentialRoundTrip } from '../../packages/pipeline/src/sequential-round-trip.js';
import type { SequentialWorker } from '../../packages/simulator/src/sequential-worker.js';

/**
 * P3 — the one-pass round trip, with a scripted worker.
 *
 * The worker is a double rather than the real WSL binary: what is under test is
 * the ORDER of operations, and the order is the thing the two-pass design got
 * wrong. `scripts/one-pass-sequential-proof.ts` exercises the real runtime.
 */

const POOL = 'PoolAAA';
const TAKER = 'TakerAAA';
const ATA = 'AtaAAA';

/** An SPL token account whose u64 amount at offset 64 is `amount`. */
function tokenAccountBytes(amount: bigint): string {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b.toString('base64');
}

function observed(pubkey: string, dataBase64: string, sha: string) {
  return { pubkey, lamports: 1_000, owner: 'Sys', dataBase64, dataSha256: sha };
}

function stepResult(label: string, status: string, pre: unknown[], post: unknown[]) {
  return {
    label,
    status,
    transactionError: status === 'SIMULATED_OK' ? null : 'refused',
    computeUnitsConsumed: 1,
    logs: [],
    preAccounts: pre,
    postAccounts: post,
    unobserved: [],
  };
}

/** Records the call order so the test can assert on it. */
function scriptedWorker(script: {
  buyStatus?: string;
  acquired?: bigint;
  quotedSha?: string;
  sellPreSha?: string;
  sellStatus?: string;
  closeStatus?: string;
}): { worker: SequentialWorker; calls: string[] } {
  const calls: string[] = [];
  const quotedSha = script.quotedSha ?? 'aaa';
  const worker = {
    initIncompleteness: [],
    async init() {
      calls.push('init');
      return { runtime: 'litesvm', runtimeVersion: '0', litesvmVersion: '0', binarySha256: 'x', programsLoaded: [] };
    },
    async observe() {
      calls.push('observe');
      return { accounts: [observed(POOL, tokenAccountBytes(0n), quotedSha)], unobserved: [], stateHash: 'qh' };
    },
    async step(s: { label: string }) {
      calls.push('step:' + s.label);
      if (s.label === 'buy') {
        return {
          stateHash: 'h',
          step: stepResult(
            'buy',
            script.buyStatus ?? 'SIMULATED_OK',
            [],
            [observed(ATA, tokenAccountBytes(script.acquired ?? 1_000_000n), 'ata')],
          ),
        };
      }
      if (s.label === 'sell') {
        return {
          stateHash: 'h',
          step: stepResult(
            'sell',
            script.sellStatus ?? 'SIMULATED_OK',
            [observed(POOL, tokenAccountBytes(0n), script.sellPreSha ?? quotedSha)],
            [],
          ),
        };
      }
      return { stateHash: 'h', step: stepResult('close', script.closeStatus ?? 'SIMULATED_OK', [], []) };
    },
    async close() {
      calls.push('close');
    },
  } as unknown as SequentialWorker;
  return { worker, calls };
}

const request = {
  snapshot: { programs: [], accounts: [], slot: 1, unixTimestamp: 1 },
  pool: POOL,
  taker: TAKER,
  takerAta: ATA,
  slippagePct: 3,
  buyTransactionBase64: 'YnV5',
  blockhash: 'bh',
  priceBearingAccounts: [POOL],
  observe: [POOL, ATA],
  buildCloseBase64: () => 'Y2xvc2U=',
  buildSell: async () => ({ transactionBase64: 'c2VsbA==', selfImpactLamports: 5n }),
  jobId: 'test',
} as never;

describe('P3 — the round trip observes BEFORE it builds the sell', () => {
  it('runs init, buy, observe, sell, close in that order', async () => {
    // The order is the point. `observe` between the buy and the sell is what
    // makes the sell priced from the state the buy committed, in the runtime
    // the sell executes in.
    const { worker, calls } = scriptedWorker({});
    await sequentialRoundTrip(request, worker);
    const meaningful = calls.filter((c) => c !== 'close' || calls.indexOf(c) === calls.length - 1);
    expect(meaningful.slice(0, 3)).toEqual(['init', 'step:buy', 'observe']);
    expect(calls).toContain('step:sell');
    expect(calls.indexOf('observe')).toBeLessThan(calls.indexOf('step:sell'));
  });

  it('never observes or sells when the buy did not commit', async () => {
    const { worker, calls } = scriptedWorker({ buyStatus: 'SIMULATION_FAILED' });
    const r = await sequentialRoundTrip(request, worker);
    expect(r.failure).toBe('BUY_FAILED');
    expect(calls).not.toContain('observe');
    expect(calls).not.toContain('step:sell');
  });

  it('refuses when the buy credited no tokens', async () => {
    const { worker } = scriptedWorker({ acquired: 0n });
    const r = await sequentialRoundTrip(request, worker);
    expect(r.failure).toBe('NO_MEASURED_CREDIT');
  });
});

describe('P3 — the quote-state assertion gates the price', () => {
  it('FAILS the round trip when the quoted state is not the executed state', async () => {
    const { worker } = scriptedWorker({ quotedSha: 'aaa', sellPreSha: 'MOVED' });
    const r = await sequentialRoundTrip(request, worker);
    expect(r.failure).toBe('QUOTE_STATE_MOVED');
    expect(r.quoteStateSurvived).toBe(false);
  });

  it('checks the state BEFORE it believes a successful sell', async () => {
    // Ordering matters: a sell that reports SIMULATED_OK against a state it was
    // not priced from is still a wrong price, and reporting it as a success
    // first would let the number escape.
    const { worker } = scriptedWorker({ quotedSha: 'aaa', sellPreSha: 'MOVED', sellStatus: 'SIMULATED_OK' });
    const r = await sequentialRoundTrip(request, worker);
    expect(r.failure).toBe('QUOTE_STATE_MOVED');
  });

  it('reports a failed sell as a sell failure once the state agreed', async () => {
    const { worker } = scriptedWorker({ sellStatus: 'SIMULATION_FAILED' });
    const r = await sequentialRoundTrip(request, worker);
    expect(r.failure).toBe('SELL_FAILED');
    expect(r.quoteStateSurvived).toBe(true);
  });

  it('separates an apparatus failure from a market refusal', async () => {
    const broken = {
      initIncompleteness: [],
      async init() {
        throw new Error('worker could not start');
      },
      async close() {},
    } as unknown as SequentialWorker;
    const r = await sequentialRoundTrip(request, broken);
    // Only a market refusal is evidence. An apparatus failure must never be
    // recorded as a token that could not be sold.
    expect(r.failure).toBe('RUNTIME_UNAVAILABLE');
  });
});
