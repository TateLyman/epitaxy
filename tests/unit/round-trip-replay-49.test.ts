import { describe, it, expect } from 'vitest';
import { sequentialRoundTrip } from '../../packages/pipeline/src/sequential-round-trip.js';
import type { SequentialWorker } from '../../packages/simulator/src/sequential-worker.js';
import type { ReplayStep } from '../../packages/pipeline/src/event-replay.js';

/**
 * Item 49 — the intervening events, executed in the runtime the sell runs in.
 *
 * The worker is a double: what is under test is the ORDER — observe, build,
 * commit, re-observe, per event — and whether a hole in that sequence is
 * refused rather than absorbed. The real runtime is exercised by the collector.
 */

const POOL = 'PoolAAA';
const ATA = 'AtaAAA';

function tokenAccountBytes(amount: bigint): string {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b.toString('base64');
}

function observed(pubkey: string, dataBase64: string, sha: string) {
  return {
    pubkey,
    lamports: 1_000n,
    owner: 'Sys',
    executable: false,
    rentEpoch: 18_446_744_073_709_551_615n,
    dataLen: Buffer.from(dataBase64, 'base64').length,
    dataBase64,
    dataSha256: sha,
    accountHash: `h:${sha}`,
  };
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

/**
 * A worker whose pool reserve MOVES with each replayed event.
 *
 * The reserve is what the caller reads to build the next event, so a fixture
 * with a static pool could not tell a replay that compounds from one that
 * prices every event against the post-buy state.
 */
function replayWorker(script: {
  replayStatuses?: Record<string, string>;
  /** Observation index (0 = post-buy) that returns nothing. */
  blindAt?: number;
  sellPreShaOverride?: string;
}): { worker: SequentialWorker; calls: string[]; reserve: () => bigint } {
  const calls: string[] = [];
  let reserve = 1_000n;
  let observations = 0;

  const worker = {
    initIncompleteness: [],
    async init() {
      calls.push('init');
      return { runtime: 'litesvm', runtimeVersion: '0', litesvmVersion: '0', binarySha256: 'x', programsLoaded: [] };
    },
    async observe() {
      const n = observations++;
      calls.push(`observe:${reserve}`);
      if (script.blindAt === n) return { accounts: [], unobserved: [POOL], stateHash: 'qh', instanceId: 'i' };
      return {
        accounts: [observed(POOL, tokenAccountBytes(reserve), `sha:${reserve}`)],
        unobserved: [],
        stateHash: `qh:${reserve}`,
        instanceId: 'i',
      };
    },
    async step(s: { label: string }) {
      calls.push(`step:${s.label}`);
      if (s.label === 'buy') {
        return {
          stateHash: 'h',
          step: stepResult('buy', 'SIMULATED_OK', [], [observed(ATA, tokenAccountBytes(1_000_000n), 'ata')]),
        };
      }
      if (s.label.startsWith('replay:')) {
        const status = script.replayStatuses?.[s.label] ?? 'SIMULATED_OK';
        // Only a committed event moves the pool.
        if (status === 'SIMULATED_OK') reserve += 100n;
        return { stateHash: 'h', step: stepResult(s.label, status, [], []) };
      }
      // The sell's PRE state is whatever the pool holds now. The survival check
      // compares it against the observation the sell was priced from.
      return {
        stateHash: 'h',
        step: stepResult(
          'sell',
          'SIMULATED_OK',
          [observed(POOL, tokenAccountBytes(reserve), script.sellPreShaOverride ?? `sha:${reserve}`)],
          [],
        ),
      };
    },
    async close() {
      calls.push('workerClose');
    },
  } as unknown as SequentialWorker;

  return { worker, calls, reserve: () => reserve };
}

const step = (signature: string, slot: number, kind: 'BUY' | 'SELL' = 'BUY'): ReplayStep => ({
  signature,
  slot,
  kind,
  inputAmount: 500n,
});

function request(over: Record<string, unknown> = {}) {
  return {
    snapshot: { programs: [], accounts: [], slot: 1, unixTimestamp: 1 },
    pool: POOL,
    taker: 'TakerAAA',
    takerAta: ATA,
    slippagePct: 3,
    buyTransactionBase64: 'YnV5',
    blockhash: 'bh',
    priceBearingAccounts: [POOL],
    observe: [POOL, ATA],
    buildSell: async () => ({ transactionBase64: 'c2VsbA==', selfImpactLamports: 5n }),
    jobId: 'test',
    ...over,
  } as never;
}

describe('49 — the events run BETWEEN the buy and the sell', () => {
  it('commits each event and re-reads the pool before building the next', async () => {
    const seen: bigint[] = [];
    const { worker, calls } = replayWorker({});
    const r = await sequentialRoundTrip(
      request({
        intervening: {
          steps: [step('aaaaaaaa11', 110), step('bbbbbbbb22', 120)],
          build: async (_s: ReplayStep, state: { bytesOf?: unknown }) => {
            // Building an event from the state the PREVIOUS one left is the
            // whole construction. Building them all up front would price every
            // event against the post-buy reserves — the same substitution the
            // replay exists to remove, one level down.
            const acct = (state as { get?: (k: string) => { dataBase64: string } | null }).get?.(POOL);
            seen.push(acct === null || acct === undefined ? -1n : BigInt(Buffer.from(acct.dataBase64, 'base64').readBigUInt64LE(64)));
            return 'ZXY=';
          },
        },
      }),
      worker,
    );

    expect(r.failure).toBeNull();
    expect(calls).toEqual([
      'init',
      'step:buy',
      'observe:1000',
      'step:replay:110:aaaaaaaa',
      'observe:1100',
      'step:replay:120:bbbbbbbb',
      'observe:1200',
      'step:sell',
    ]);
    // The second event saw the reserve the first one moved.
    expect(seen).toEqual([1_000n, 1_100n]);
  });

  it('records every event it applied, with the input it applied', async () => {
    const { worker } = replayWorker({});
    const r = await sequentialRoundTrip(
      request({
        intervening: { steps: [step('aaaaaaaa11', 110, 'SELL')], build: async () => 'ZXY=' },
      }),
      worker,
    );
    expect(r.replayed).toEqual([
      { signature: 'aaaaaaaa11', slot: 110, kind: 'SELL', inputAmount: 500n, status: 'SIMULATED_OK' },
    ]);
  });

  it('distinguishes "no replay requested" from "the pool did not trade"', async () => {
    // An empty array is a holding period in which nothing happened. Null is a
    // round trip that never asked. Collapsing them would let a mechanics run
    // present itself as a replayed holding period.
    const bare = await sequentialRoundTrip(request(), replayWorker({}).worker);
    expect(bare.replayed).toBeNull();

    const empty = await sequentialRoundTrip(
      request({ intervening: { steps: [], build: async () => 'ZXY=' } }),
      replayWorker({}).worker,
    );
    expect(empty.replayed).toEqual([]);
  });
});

describe('49 — the survival check follows the state the sell was priced from', () => {
  it('does not report QUOTE_STATE_MOVED for the replay it was told to run', async () => {
    // The replay moves the pool ON PURPOSE. Checking the sell against the
    // post-buy state would flag the intended behaviour — and the fix must not
    // be to weaken the assertion, but to point it at the right state.
    const { worker } = replayWorker({});
    const r = await sequentialRoundTrip(
      request({ intervening: { steps: [step('aaaaaaaa11', 110)], build: async () => 'ZXY=' } }),
      worker,
    );
    expect(r.failure).toBeNull();
    expect(r.quoteStateSurvived).toBe(true);
    // And `quoted` is the POST-REPLAY observation, which is what the sell was
    // genuinely priced from.
    expect(r.quoted?.stateHash).toBe('qh:1100');
  });

  it('still catches a pool that moved AFTER the last replayed event', async () => {
    // The assertion must not have been weakened into uselessness by following
    // the replay: something moving between the final read and the sell is still
    // the defect it always was.
    const { worker } = replayWorker({ sellPreShaOverride: 'sha:somethingElse' });
    const r = await sequentialRoundTrip(
      request({ intervening: { steps: [step('aaaaaaaa11', 110)], build: async () => 'ZXY=' } }),
      worker,
    );
    expect(r.failure).toBe('QUOTE_STATE_MOVED');
  });
});

describe('49 — a hole in the replay refuses the trajectory', () => {
  it('refuses when an event does not commit, rather than carrying on', async () => {
    // A replay missing one trade is a pool at the wrong reserves for every
    // event after it, presented as the exact reference the bounded class is
    // calibrated against.
    const { worker, calls } = replayWorker({ replayStatuses: { 'replay:110:aaaaaaaa': 'FAILED' } });
    const r = await sequentialRoundTrip(
      request({
        intervening: { steps: [step('aaaaaaaa11', 110), step('bbbbbbbb22', 120)], build: async () => 'ZXY=' },
      }),
      worker,
    );
    expect(r.failure).toBe('REPLAY_EVENT_FAILED');
    // The second event was never attempted.
    expect(calls).not.toContain('step:replay:120:bbbbbbbb');
    expect(calls).not.toContain('step:sell');
    // And the failed one is still on the record, with its status.
    expect(r.replayed?.[0]?.status).toBe('FAILED');
  });

  it('refuses when the state after an event cannot be read', async () => {
    // The same vacuity F1 found on the post-buy read: an empty observation
    // would leave the pricing state at the point BEFORE this event, and every
    // later event would compound the error.
    const { worker } = replayWorker({ blindAt: 1 });
    const r = await sequentialRoundTrip(
      request({ intervening: { steps: [step('aaaaaaaa11', 110)], build: async () => 'ZXY=' } }),
      worker,
    );
    expect(r.failure).toBe('REPLAY_STATE_UNOBSERVED');
    expect(r.replayed).toHaveLength(1);
  });

  it('refuses when an event cannot be BUILT, naming the signature', async () => {
    const { worker } = replayWorker({});
    const r = await sequentialRoundTrip(
      request({
        intervening: {
          steps: [step('aaaaaaaa11', 110)],
          build: async () => {
            throw new Error('the pool decoder refused');
          },
        },
      }),
      worker,
    );
    expect(r.failure).toBe('REPLAY_EVENT_FAILED');
    expect(r.detail).toContain('aaaaaaaa11');
  });
});
