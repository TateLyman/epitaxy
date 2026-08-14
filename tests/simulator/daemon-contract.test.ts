import { describe, it, expect, beforeAll } from 'vitest';
import { SimulationClient } from '../../packages/simulator/src/client.js';
import { resolveSimulatorToken } from '../../packages/simulator/src/token.js';
import type { SimulationRequest } from '../../packages/simulator/src/protocol.js';
import { compileMessage, encodeUnsignedTransaction } from '../../packages/solana/src/encode.js';
import { SYSTEM_PROGRAM } from '../../packages/solana/src/txpolicy.js';
import { base58Encode } from '../../packages/solana/src/base58.js';

/**
 * §22 items 5-9 — the daemon contract, against the running daemon.
 *
 * These are behaviours of a concurrent HTTP service and cannot be established
 * by unit-testing the pieces: in-flight idempotency is about two requests
 * racing, and a single-Surfnet guarantee is about what happens when they do.
 *
 * Skipped, loudly, when no daemon is reachable. A test that silently passes
 * because the thing it tests was absent is worse than no test — it reports
 * coverage that does not exist.
 */

const BASE = process.env['SIMULATORD_URL'] ?? 'http://127.0.0.1:8787';
const { token } = resolveSimulatorToken();

let reachable = false;
beforeAll(async () => {
  try {
    const r = await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(3000) });
    reachable = r.ok;
  } catch {
    reachable = false;
  }
});

const client = (): SimulationClient =>
  new SimulationClient({ baseUrl: BASE, token, pinnedIdentity: null, requirePinned: false, timeoutMs: 120_000 });

/**
 * A real, decodable transfer.
 *
 * The daemon decodes the bytes BEFORE it checks amounts or program ELFs, which
 * is the right order -- bytes it cannot read are refused before anything is
 * started. So a dummy byte string short-circuits every later refusal and the
 * tests below would assert against "transaction bytes did not decode" instead
 * of the thing they are named for.
 */
const PAYER = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 3 : i + 1)));
const DEST = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 5 : i + 2)));

function realTransfer(): string {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(1_000_000n, 4);
  const msg = compileMessage(
    [
      {
        programId: SYSTEM_PROGRAM,
        accounts: [
          { pubkey: PAYER, isSigner: true, isWritable: true },
          { pubkey: DEST, isSigner: false, isWritable: true },
        ],
        data: data.toString('base64'),
      },
    ],
    PAYER,
    base58Encode(Uint8Array.from({ length: 32 }, () => 7)),
  );
  return Buffer.from(encodeUnsignedTransaction(msg)).toString('base64');
}

/** A request that is cheap to run and needs no mainnet state. */
function request(over: Partial<SimulationRequest> = {}): SimulationRequest {
  const c = client();
  return c.buildRequest({
    executionObservationId: 'contract-test',
    mode: 'CONFIRMATORY_OFFLINE',
    transactionBase64: realTransfer(),
    originalTransactionHash: 'h',
    originalMessageHash: 'm',
    originalBlockhash: 'b',
    originalLastValidBlockHeight: null,
    routeFamily: 'BUILD_CUSTOM',
    requestedAmount: '1',
    targetSlot: null,
    snapshotManifestHash: 'contract-test-snapshot',
    snapshotAccounts: [
      { pubkey: DEST, owner: SYSTEM_PROGRAM, lamports: '1', dataBase64: '', executable: false, slot: 0 },
    ],
    balanceMutations: [{ kind: 'sol', owner: PAYER, amount: '5000000000' }],
    bounds: { feePayer: PAYER, maxLamportsSpent: '10000000' },
    contextHash: null,
    ...over,
  });
}

describe('§22.7 only one Surfnet is active', () => {
  it('advertises a hard limit of one', async () => {
    if (!reachable) {
      console.warn('SKIPPED: no daemon at ' + BASE + ' — this test establishes nothing on this run');
      return;
    }
    const h = (await client().health()) as unknown as { maxActiveSurfnets: number; active: number };
    // Documented "fresh instance per job" and permitted sixteen. Isolation was
    // asserted by a comment and enforced by nothing.
    expect(h.maxActiveSurfnets).toBe(1);
    expect(h.active).toBeLessThanOrEqual(1);
  });
});

describe('§22.8 the queue reports what an operator needs', () => {
  it('exposes depth, ages and outcome counts rather than a liveness bit', async () => {
    if (!reachable) {
      console.warn('SKIPPED: no daemon reachable');
      return;
    }
    const h = (await client().health()) as unknown as Record<string, unknown>;
    for (const field of [
      'active',
      'queued',
      'oldestQueueAgeMs',
      'jobsCompleted',
      'jobsFailed',
      'jobsUnknown',
      'medianStartupMs',
      'medianSimulationMs',
      'queueLimit',
    ]) {
      expect(h, `health is missing ${field}`).toHaveProperty(field);
    }
    // Whether the mark SLA is survivable is a question about these numbers.
    expect(typeof h['queued']).toBe('number');
    expect(typeof h['jobsFailed']).toBe('number');
  });
});

describe('§22.5 a duplicate in-flight request attaches rather than racing', () => {
  it('answers two identical concurrent requests with one job', async () => {
    if (!reachable) {
      console.warn('SKIPPED: no daemon reachable');
      return;
    }
    const req = request({ executionObservationId: `inflight-${Date.now()}` });
    // Fired together on purpose. The completed-job cache cannot help a job that
    // is still running, so before the in-flight map a client timeout followed
    // by a retry started a SECOND simulation under the same job id: two
    // Surfnets, two answers, one job id, and whichever finished last won.
    const [a, b] = await Promise.all([client().simulate(req), client().simulate(req)]);
    expect(a.jobId).toBe(b.jobId);
    expect(a.requestHash).toBe(b.requestHash);
    // Same job means the same answer, not merely a similar one.
    expect(a.status).toBe(b.status);
    expect(a.detail).toBe(b.detail);
  });
});

describe('§22.6 the same job id with different bytes is refused', () => {
  it('refuses rather than reconciling', async () => {
    if (!reachable) {
      console.warn('SKIPPED: no daemon reachable');
      return;
    }
    const req = request({ executionObservationId: `conflict-${Date.now()}` });
    await client().simulate(req);
    // Same job id, different bytes. The hash no longer matches the body, which
    // is a caller defect and is refused: reconciling it would mean deciding
    // which of two different transactions the job was about.
    const tampered = { ...req, transactionBase64: `${req.transactionBase64.slice(0, -4)}AAAA` };
    await expect(client().simulate(tampered)).rejects.toThrow(/requestHash|hash/i);
  });
});

describe('§22.9 an amount that cannot be passed exactly is refused', () => {
  it('carries 10^18 token atoms to raw account bytes without exactNumber', async () => {
    if (!reachable) {
      console.warn('SKIPPED: no daemon reachable');
      return;
    }
    // A nine-decimal memecoin with a billion supply is 10^18 atoms, three
    // orders of magnitude past Number.MAX_SAFE_INTEGER. This was REFUSED,
    // because a precheck ran exactNumber over every mutation — guarding an API
    // the token path no longer uses. The account is written as u64 bytes, so
    // the amount never crosses a JS number and the refusal was excluding the
    // ordinary case.
    const req = request({
      executionObservationId: `bigint-${Date.now()}`,
      balanceMutations: [
        { kind: 'token', owner: PAYER, mint: DEST, amount: '1000000000000000001' },
      ],
    });
    const res = await client().simulate(req);
    expect(res.detail ?? '').not.toMatch(/MAX_SAFE_INTEGER/i);
  });

  it('refuses a token amount outside u64, which is not a balance the chain can hold', async () => {
    if (!reachable) {
      console.warn('SKIPPED: no daemon reachable');
      return;
    }
    const req = request({
      executionObservationId: `u64-${Date.now()}`,
      balanceMutations: [
        { kind: 'token', owner: PAYER, mint: DEST, amount: '18446744073709551616' },
      ],
    });
    const res = await client().simulate(req);
    expect(res.status).toBe('SIMULATOR_UNAVAILABLE');
    expect(res.detail).toMatch(/u64/i);
  });

  it('accepts an amount at the boundary', async () => {
    if (!reachable) {
      console.warn('SKIPPED: no daemon reachable');
      return;
    }
    const req = request({
      executionObservationId: `boundary-${Date.now()}`,
      balanceMutations: [{ kind: 'sol', owner: PAYER, amount: String(Number.MAX_SAFE_INTEGER) }],
    });
    const res = await client().simulate(req);
    // 2^53-1 is representable, so the refusal must not fire one short.
    expect(res.detail).not.toMatch(/MAX_SAFE_INTEGER/i);
  });
});

describe('§22.21 incomplete coverage cannot be confirmatory', () => {
  it('refuses a CONFIRMATORY_OFFLINE run with no frozen snapshot', async () => {
    if (!reachable) {
      console.warn('SKIPPED: no daemon reachable');
      return;
    }
    const res = await client().simulate(
      request({ executionObservationId: `nosnap-${Date.now()}`, snapshotAccounts: [] }),
    );
    expect(res.status).toBe('SIMULATOR_UNAVAILABLE');
    expect(res.detail).toMatch(/frozen account snapshot/i);
  });

  it('refuses a snapshot naming a program without its ELF', async () => {
    if (!reachable) {
      console.warn('SKIPPED: no daemon reachable');
      return;
    }
    const res = await client().simulate(
      request({
        executionObservationId: `noelf-${Date.now()}`,
        snapshotAccounts: [
          {
            pubkey: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
            owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
            lamports: '1',
            dataBase64: '',
            executable: true,
            slot: 0,
          },
        ],
      }),
    );
    // setAccount has no executable parameter, so restoring a program without
    // its code produces a NON-executable account and every route through it
    // fails with an error that reads as a fact about the token.
    expect(res.status).toBe('SIMULATOR_UNAVAILABLE');
    expect(res.detail).toMatch(/programElfBase64/i);
  });
});
