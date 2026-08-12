import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import type { Db } from '../../packages/storage/src/db.js';
import {
  claimIntent,
  recordAttempt,
  updateAttempt,
  unresolvedAttempts,
  intentById,
  newId,
} from '../../packages/storage/src/repo.js';
import { resolveOutstanding, executeIntent, idempotencyKey } from '../../packages/execution/src/machine.js';
import type { ExecutorDeps } from '../../packages/execution/src/machine.js';
import type { ExecutionRpc } from '../../packages/execution/src/rpc.js';
import type { Signer } from '../../packages/execution/src/signer.js';
import type { TradeIntent } from '../../packages/domain/src/types.js';

/**
 * Crash and partition behaviour.
 *
 * Every test here describes a process that died, or a network that went quiet,
 * at the one moment where it matters: after a transaction was signed and before
 * anyone learned what happened to it. The system's claim is that it can tell
 * "never sent" from "sent, fate unknown", and that it refuses to trade while
 * the second is true. These tests are what makes that claim checkable.
 *
 * The RPC and signer are stubs that throw on any call a given test does not
 * expect, so "the code did not reach the network" is asserted rather than
 * assumed.
 */

const dir = mkdtempSync(join(tmpdir(), 'chaos-'));
let db: Db;
let n = 0;

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A locked SQLite file on Windows is not a test failure.
  }
});

beforeEach(() => {
  db = openDb({ path: join(dir, `chaos-${n++}.db`) });
});

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

let epoch = 1_700_000_000_000;

function intent(over: Partial<TradeIntent> = {}): TradeIntent {
  const id = newId();
  // Distinct epoch per call, so two intents in one test are two decisions
  // rather than one decision claimed twice. Tests that want a duplicate spread
  // an existing intent instead of calling this again.
  return {
    intentId: id,
    idempotencyKey: idempotencyKey({
      mint: MINT,
      side: 'buy',
      strategyVersion: 'test-v1',
      amount: 50_000_000n,
      epochMs: epoch++,
    }),
    mint: MINT,
    side: 'buy',
    inputMint: SOL,
    outputMint: MINT,
    maxInputAmount: 50_000_000n,
    minOutputAmount: 1_000n,
    maxTotalFeeLamports: 3_000_000n,
    maxPriorityFeeLamports: 1_000_000n,
    deadlineUtcMs: 2_000_000_000_000,
    strategyVersion: 'test-v1',
    riskSnapshotHash: 'h',
    createdUtcMs: 1_000,
    ...over,
  };
}

/** An attempt row in the exact state a crash between signing and sending leaves. */
function signedButUnsent(intentId: string, over: { lastValidHeight?: number; signature?: string } = {}): string {
  const attemptId = newId();
  recordAttempt(db, {
    attemptId,
    intentId,
    attemptNo: 1,
    signature: over.signature ?? `sig-${attemptId}`,
    blockhash: 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1X',
    lastValidHeight: over.lastValidHeight ?? 1_000,
    signedUtcMs: Date.now(),
    simulatedOut: 5_000n,
    simulatedIn: 50_000_000n,
  });
  return attemptId;
}

interface RpcStub {
  status?: { slot: number; err: unknown } | null;
  statusThrows?: string;
  height?: number;
  heightThrows?: string;
}

function rpc(stub: RpcStub): ExecutionRpc {
  return {
    getSignatureStatus: async () => {
      if (stub.statusThrows !== undefined) throw new Error(stub.statusThrows);
      return stub.status ?? null;
    },
    getBlockHeight: async () => {
      if (stub.heightThrows !== undefined) throw new Error(stub.heightThrows);
      if (stub.height === undefined) throw new Error('test did not expect a height read');
      return stub.height;
    },
  } as unknown as ExecutionRpc;
}

function deps(over: Partial<ExecutorDeps> & { rpc: ExecutionRpc }): ExecutorDeps {
  return {
    db,
    signer: {
      get publicKey(): string {
        throw new Error('test did not expect the signer to be touched');
      },
      sign: () => {
        throw new Error('test did not expect a signature');
      },
    } as unknown as Signer,
    limiter: null as never,
    jupiterApiKey: null,
    slippageBps: 200,
    maxAttemptsPerIntent: 1,
    confirmTimeoutMs: 1_000,
    log: () => {},
    ...over,
  };
}

describe('a signed transaction whose fate is unknown blocks everything', () => {
  it('stays unresolved while the blockhash could still be accepted', async () => {
    const i = intent();
    claimIntent(db, i, false);
    signedButUnsent(i.intentId, { lastValidHeight: 1_000 });

    // No status yet, and the chain has not passed the last valid height. The
    // honest answer is "not yet", not "gone".
    const left = await resolveOutstanding(deps({ rpc: rpc({ status: null, height: 999 }) }));
    expect(left).toBe(1);
    expect(unresolvedAttempts(db)).toHaveLength(1);
    expect(intentById(db, i.intentId)?.state).toBe('UNKNOWN');
  });

  /**
   * Absence of a status only becomes evidence of absence once no leader can
   * accept the blockhash. This is the single condition under which the system
   * is allowed to conclude a transaction did not happen.
   */
  it('declares expiry only once the block height provably passed the last valid height', async () => {
    const i = intent();
    claimIntent(db, i, false);
    signedButUnsent(i.intentId, { lastValidHeight: 1_000 });

    const left = await resolveOutstanding(deps({ rpc: rpc({ status: null, height: 1_001 }) }));
    expect(left).toBe(0);
    expect(unresolvedAttempts(db)).toHaveLength(0);
    expect(intentById(db, i.intentId)?.state).toBe('EXPIRED');
  });

  it('does not expire anything when the height cannot be read at all', async () => {
    const i = intent();
    claimIntent(db, i, false);
    signedButUnsent(i.intentId, { lastValidHeight: 1_000 });

    // An unreachable chain is not permission to guess. Nothing may be marked
    // expired on a pass that could not establish where the chain actually is.
    const left = await resolveOutstanding(deps({ rpc: rpc({ status: null, heightThrows: 'ECONNRESET' }) }));
    expect(left).toBe(1);
    expect(intentById(db, i.intentId)?.state).toBe('UNKNOWN');
  });

  it('leaves an attempt unresolved when the status query itself fails', async () => {
    const i = intent();
    claimIntent(db, i, false);
    signedButUnsent(i.intentId);

    const left = await resolveOutstanding(deps({ rpc: rpc({ statusThrows: 'ETIMEDOUT', height: 1_000_000 }) }));
    expect(left).toBe(1);
    expect(unresolvedAttempts(db)).toHaveLength(1);
  });
});

describe('recovery reads the truth off the chain', () => {
  it('records a landed transaction as confirmed even though the process never saw the send return', async () => {
    const i = intent();
    claimIntent(db, i, false);
    signedButUnsent(i.intentId);

    const left = await resolveOutstanding(deps({ rpc: rpc({ status: { slot: 42, err: null } }) }));
    expect(left).toBe(0);
    expect(intentById(db, i.intentId)?.state).toBe('CONFIRMED');
    expect(unresolvedAttempts(db)).toHaveLength(0);
  });

  it('records a landed-but-reverted transaction as failed, not as never-sent', async () => {
    const i = intent();
    claimIntent(db, i, false);
    signedButUnsent(i.intentId);

    const left = await resolveOutstanding(
      deps({ rpc: rpc({ status: { slot: 43, err: { InstructionError: [2, 'Custom'] } } }) }),
    );
    expect(left).toBe(0);
    expect(intentById(db, i.intentId)?.state).toBe('FAILED');
  });

  it('resolves each outstanding attempt independently, so one bad row cannot mask another', async () => {
    const a = intent();
    const b = intent();
    claimIntent(db, a, false);
    claimIntent(db, b, false);
    signedButUnsent(a.intentId, { lastValidHeight: 10 });
    signedButUnsent(b.intentId, { lastValidHeight: 10 });

    // Both are past expiry; both must be resolved on a single pass.
    const left = await resolveOutstanding(deps({ rpc: rpc({ status: null, height: 11 }) }));
    expect(left).toBe(0);
    expect(intentById(db, a.intentId)?.state).toBe('EXPIRED');
    expect(intentById(db, b.intentId)?.state).toBe('EXPIRED');
  });

  it('reports nothing to do on a clean ledger without calling the chain', async () => {
    // rpc() with no stubs throws on any height read; reaching it would fail here.
    const left = await resolveOutstanding(deps({ rpc: rpc({}) }));
    expect(left).toBe(0);
  });
});

describe('the same decision, replayed after a crash, is one intent', () => {
  /**
   * Idempotency lives in a UNIQUE constraint rather than a read-then-write,
   * because read-then-write is not atomic across a crash and a crash is exactly
   * what interrupts this operation.
   */
  it('claims an idempotency key exactly once', () => {
    const i = intent();
    const first = claimIntent(db, i, false);
    const second = claimIntent(db, { ...i, intentId: newId() }, false);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it('returns duplicate without touching the signer or the network', async () => {
    const i = intent();
    claimIntent(db, i, false);

    // Both stubs throw on any use, so this passes only if the duplicate check
    // short-circuits before either is reached.
    const out = await executeIntent(deps({ rpc: rpc({}) }), { ...i, intentId: newId() });
    expect(out.status).toBe('duplicate');
  });

  /**
   * Two rows carrying one signature would let the same transaction be counted,
   * reconciled and P&L'd twice. The database refuses instead of the caller
   * remembering to.
   */
  /**
   * An attempt whose intent does not exist resolves into nothing: recovery
   * reads the chain, learns the transaction's fate, and then updates an intent
   * row that is not there. The signature would be real and unattributable.
   */
  it('refuses an attempt that belongs to no intent', () => {
    expect(() => signedButUnsent(newId())).toThrow();
  });

  it('refuses to record two attempts under one signature', () => {
    const i = intent();
    claimIntent(db, i, false);
    signedButUnsent(i.intentId, { signature: 'duplicate-signature' });
    expect(() => signedButUnsent(i.intentId, { signature: 'duplicate-signature' })).toThrow();
  });
});

describe('an attempt that reached the wire is never silently downgraded', () => {
  it('keeps a SUBMITTED attempt outstanding until the chain answers', async () => {
    const i = intent();
    claimIntent(db, i, false);
    const attemptId = signedButUnsent(i.intentId, { lastValidHeight: 5_000 });
    updateAttempt(db, attemptId, { outcome: 'SUBMITTED', sentUtcMs: Date.now() });

    const left = await resolveOutstanding(deps({ rpc: rpc({ status: null, height: 4_999 }) }));
    expect(left).toBe(1);
  });

  it('treats a send that threw as unknown rather than failed', async () => {
    const i = intent();
    claimIntent(db, i, false);
    const attemptId = signedButUnsent(i.intentId, { lastValidHeight: 5_000 });
    // This is what executeIntent writes when rpc.send throws: the transaction
    // may well be in flight, so the outcome is UNKNOWN and it stays blocking.
    updateAttempt(db, attemptId, { outcome: 'UNKNOWN', sendError: 'socket hang up', sentUtcMs: Date.now() });

    expect(unresolvedAttempts(db)).toHaveLength(1);
    const left = await resolveOutstanding(deps({ rpc: rpc({ status: null, height: 4_000 }) }));
    expect(left).toBe(1);
  });
});
