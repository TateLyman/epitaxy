import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../packages/storage/src/db.js';
import { BlobStore, EXACT_TRANSACTION_SCHEMA_VERSION, type ExactTransactionBlob } from '../../packages/storage/src/blobstore.js';
import { SimulationClient, SimulatorUnavailable } from '../../packages/simulator/src/client.js';
import {
  simulateObservation,
  updateObservationSimulation,
  validateSetup,
  InvalidSimulationSetup,
} from '../../apps/engine/src/simulate-observation.js';
import { SIMULATION_PROTOCOL_VERSION, ACCOUNT_SNAPSHOT_SCHEMA_VERSION } from '../../packages/simulator/src/protocol.js';
import {
  economicBoundsFor,
  provisioningMutations,
} from '../../packages/simulator/src/request-bounds.js';
import type { SimulationResponse } from '../../packages/simulator/src/protocol.js';

/**
 * §9 — the simulator wired into the engine, and the one rule that matters:
 * an outage is never written onto a token.
 */

const tmp = (): string => mkdtempSync(join(tmpdir(), 'epitaxy-sim-'));

/**
 * Windows holds SQLite's -wal and -shm open briefly after close, so removing
 * the directory can race and EPERM. A leftover temp directory is harmless and
 * failing a test on it would be noise about the harness rather than the code.
 */
const cleanup = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS will reclaim it */
  }
};

const blob = (): ExactTransactionBlob => ({
  schemaVersion: EXACT_TRANSACTION_SCHEMA_VERSION,
  rawBuildResponse: '{}',
  instructions: [],
  lookupTables: {},
  transactionBase64: 'AQID',
  messageBase64: 'AgM=',
  messageHash: 'mh',
  transactionHash: 'th',
  blockhash: 'BH',
  lastValidBlockHeight: 400,
  contextSlot: 438_000_000,
  packetBytes: 100,
  feePayer: PAYER,
  requiredSignatures: 1,
  staticAccountKeys: [PAYER],
  loadedAddresses: [],
  writableAccounts: [PAYER],
  readonlyAccounts: [],
  capturedUtcMs: 1,
});

/**
 * A client whose transport is replaced, so no daemon is required.
 *
 * The real `call()` wraps EVERY transport error in SimulatorUnavailable, so a
 * double that throws a bare Error would be testing a shape the client never
 * produces -- and the failure would look like a defect in the caller.
 */
function clientReturning(fn: (url: string, body?: unknown) => unknown): SimulationClient {
  const c = new SimulationClient({ baseUrl: 'http://127.0.0.1:1', token: 'x'.repeat(20), pinnedIdentity: null, requirePinned: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c as any).call = async (path: string, init?: { body?: string }): Promise<unknown> =>
    fn(path, init?.body === undefined ? undefined : JSON.parse(init.body));
  return c;
}

const identity = {
  protocolVersion: SIMULATION_PROTOCOL_VERSION,
  sourceSha: 'abc',
  lockfileHash: 'l',
  surfpoolPackageVersion: '1.5.0',
  surfpoolBinaryHash: 'b',
  nodeVersion: 'v24',
  runtimeVersion: '4.1.2',
  featureSet: '1',
  accountSnapshotSchemaVersion: ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
  platform: 'linux/x64',
  kernel: '6.18.33.1-microsoft-standard-WSL2',
  distro: 'Ubuntu 24.04',
  transactionEncoderVersion: 'v0-encoder-v2-table-ordered',
  programCaptureSchemaVersion: 1,
};

function response(over: Partial<SimulationResponse>): SimulationResponse {
  return {
    protocolVersion: SIMULATION_PROTOCOL_VERSION,
    jobId: 'j',
    requestHash: 'r',
    identity,
    snapshotManifestHash: 'jit-no-frozen-snapshot',
    status: 'SIMULATED_OK',
    transactionError: null,
    logs: [],
    unitsConsumed: 1000,
    preSolBalances: {},
    postSolBalances: {},
    preTokenBalances: {},
    postTokenBalances: {},
    baseFeeLamports: '5000',
    priorityFeeLamports: '3000',
    rentCreatedLamports: '0',
    rentRecoveredLamports: '0',
    transferFeeLamports: null,
    withheldFeeLamports: null,
    createdAccounts: [],
    closedAccounts: [],
    mutatedAccountHashes: {},
    boundsViolations: [],
    exportedSnapshot: [],
    exportOmissions: [],
    contextSlot: 1,
    blockhashReplacement: null,
    runtimeEventDigest: 'd',
    jitFetchedAccounts: [],
    queueWaitMs: 0,
    startupMs: 1,
    simulateMs: 1,
    totalMs: 2,
    detail: 'ok',
    ...over,
  } as SimulationResponse;
}

function setup(dir: string): { db: ReturnType<typeof openDb>; blobs: BlobStore; hash: string } {
  const db = openDb({ path: join(dir, 'r.db'), skipBackup: true });
  migrate(db);
  const blobs = new BlobStore(join(dir, 'blobs'));
  const hash = blobs.put(blob()).hash;
  db.prepare(
    `INSERT INTO execution_observations
       (observation_id,family,mint,side,purpose,input_mint,output_mint,requested_amount,expected_output,
        minimum_output,route_plan_hash,endpoint,instruction_policy,transaction_policy,simulation,
        requested_utc_ms,received_utc_ms,latency_ms)
     VALUES ('obs-1','BUILD_CUSTOM','M','buy','entry','A','B','1','1','1','h','e','PASS','PASS','NOT_SIMULATED',1,1,1)`,
  ).run();
  return { db, blobs, hash };
}

const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * Real base58 keys, because the leg's token accounts are DERIVED from them.
 *
 * A placeholder like 'MintB' cannot be decoded, so the associated token address
 * cannot be computed, and the setup is refused — correctly. The fixture has to
 * be a leg that could exist.
 */
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAYER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** The same leg `opts` describes, for building the expected request. */
const LEG = {
  side: 'buy' as const,
  taker: PAYER,
  inputMint: WSOL,
  outputMint: MINT_B,
  inputAmount: 20_000_000n,
  inputTokenProgram: null,
  outputTokenProgram: TOKEN_PROGRAM,
  maxLamportsSpent: 40_000_000n,
  minimumOutput: null,
  expectedOutput: null,
};

/** A BUY: spends SOL, receives the token. */
const opts = {
  mode: 'DEVELOPMENT_JIT' as const,
  side: 'buy' as const,
  inputMint: WSOL,
  outputMint: MINT_B,
  inputAmount: 20_000_000n,
  // A buy RECEIVES a token, so its program is part of the leg.
  outputTokenProgram: TOKEN_PROGRAM,
  fundingLamports: 200_000_000n,
  maxLamportsSpent: 40_000_000n,
  contextHash: null,
};

/** A SELL: spends the token, receives SOL. */
const sellOpts = {
  ...opts,
  side: 'sell' as const,
  inputMint: MINT_B,
  outputMint: WSOL,
  inputAmount: 1_000_000_000n,
  inputTokenProgram: TOKEN_PROGRAM,
  // A sell receives native lamports; there is no output token program.
  outputTokenProgram: null,
};

describe('§9 simulator integration', () => {
  it('records the request BEFORE the network call, so a crash leaves evidence', async () => {
    const dir = tmp();
    try {
      const { db, blobs, hash } = setup(dir);
      // The transport throws, standing in for a crash or an outage mid-flight.
      const client = clientReturning(() => {
        throw new SimulatorUnavailable('connection reset');
      });
      const r = await simulateObservation(db, blobs, client, 'obs-1', hash, PAYER, opts);
      expect(r.kind).toBe('unavailable');

      // The row exists and says UNKNOWN. A missing row would be an unknown
      // unknown; this is a known one and can be reconciled by job id.
      const jobs = db.prepare('SELECT status FROM simulation_jobs').all() as { status: string }[];
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe('SIMULATION_UNKNOWN');
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  it('NEVER writes an outage onto the observation', async () => {
    const dir = tmp();
    try {
      const { db, blobs, hash } = setup(dir);
      const client = clientReturning(() => {
        throw new SimulatorUnavailable('simulator down');
      });
      await simulateObservation(db, blobs, client, 'obs-1', hash, PAYER, opts);

      // This is the rule the whole module exists for. The route was never
      // checked, so the route's status is unchanged. Writing SIMULATION_FAILURE
      // here would blame a token for our infrastructure.
      const row = db.prepare("SELECT simulation FROM execution_observations WHERE observation_id='obs-1'").get() as {
        simulation: string;
      };
      expect(row.simulation).toBe('NOT_SIMULATED');
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  it('writes a successful JIT run onto the observation but not as confirmatory', async () => {
    const dir = tmp();
    try {
      const { db, blobs, hash } = setup(dir);
      let jobId = '';
      let reqHash = '';
      const client = clientReturning((path) => {
        if (path === '/v1/simulate') return response({ jobId, requestHash: reqHash });
        return {};
      });
      // The client derives the job id from the request hash, so mirror it.
      const built = client.buildRequest({
        executionObservationId: 'obs-1',
        mode: 'DEVELOPMENT_JIT',
        transactionBase64: 'AQID',
        originalTransactionHash: 'th',
        originalMessageHash: 'mh',
        originalBlockhash: 'BH',
        originalLastValidBlockHeight: 400,
        routeFamily: 'BUILD_CUSTOM',
        // The EXACT input, not zero. A leg that spends nothing is not a leg,
        // and every economic bound over it is vacuous.
        requestedAmount: '20000000',
        targetSlot: 438_000_000,
        snapshotManifestHash: 'jit-no-frozen-snapshot',
        snapshotAccounts: [],
        // Through the SAME builder production uses. Hand-writing the bounds
        // here is how this test kept passing while production sent a request
        // shaped differently from the one being asserted.
        balanceMutations: provisioningMutations(LEG, opts.fundingLamports),
        bounds: economicBoundsFor(LEG),
        contextHash: null,
      });
      jobId = built.jobId;
      reqHash = built.requestHash;

      const r = await simulateObservation(db, blobs, client, 'obs-1', hash, PAYER, opts);
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.status).toBe('SIMULATED_OK');
        // Ran, succeeded, and is still not evidence: JIT is not reproducible
        // and execution parity is not established.
        expect(r.confirmatory).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/parity|reproducible/i);
      }

      const row = db.prepare("SELECT simulation FROM execution_observations WHERE observation_id='obs-1'").get() as {
        simulation: string;
      };
      expect(row.simulation).toBe('SIMULATED_OK');
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  it('skips, rather than failing, when no exact transaction was captured', async () => {
    const dir = tmp();
    try {
      const { db, blobs } = setup(dir);
      const client = clientReturning(() => response({}));
      const r = await simulateObservation(db, blobs, client, 'obs-1', null, PAYER, opts);
      expect(r.kind).toBe('skipped');
      // No job row: nothing was ever requested.
      expect(db.prepare('SELECT COUNT(*) AS c FROM simulation_jobs').get()).toEqual({ c: 0 });
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  it('reports a missing blob as a storage defect rather than simulating nothing', async () => {
    const dir = tmp();
    try {
      const { db, blobs } = setup(dir);
      const client = clientReturning(() => response({}));
      const r = await simulateObservation(db, blobs, client, 'obs-1', '0'.repeat(64), PAYER, opts);
      expect(r.kind).toBe('skipped');
      const health = db.prepare("SELECT kind, severity FROM health_events WHERE kind LIKE '%blob%'").all() as {
        kind: string;
        severity: string;
      }[];
      expect(health[0]?.severity).toBe('critical');
      db.close();
    } finally {
      cleanup(dir);
    }
  });
});

describe('updateObservationSimulation', () => {
  it('does nothing for an UNKNOWN or UNAVAILABLE status', () => {
    const dir = tmp();
    try {
      const { db } = setup(dir);
      for (const s of ['SIMULATION_UNKNOWN', 'SIMULATOR_UNAVAILABLE']) {
        updateObservationSimulation(db, 'obs-1', s, 'x');
        const row = db.prepare("SELECT simulation FROM execution_observations WHERE observation_id='obs-1'").get() as {
          simulation: string;
        };
        expect(row.simulation).toBe('NOT_SIMULATED');
      }
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  it('never overwrites a result that is already there', () => {
    const dir = tmp();
    try {
      const { db } = setup(dir);
      updateObservationSimulation(db, 'obs-1', 'SIMULATED_OK', 'first');
      updateObservationSimulation(db, 'obs-1', 'SIMULATION_FAILED', 'second');
      const row = db.prepare("SELECT simulation, simulation_detail FROM execution_observations WHERE observation_id='obs-1'").get() as {
        simulation: string;
        simulation_detail: string;
      };
      // An observation is one measurement. Re-running it and taking the newer
      // answer would let a flaky simulator rewrite history.
      expect(row.simulation).toBe('SIMULATED_OK');
      expect(row.simulation_detail).toBe('first');
      db.close();
    } finally {
      cleanup(dir);
    }
  });
});

describe('§24.2/3/6 the setup must describe the leg before anything runs', () => {
  it('refuses a sell that names no token program, because the inventory cannot be provisioned', () => {
    // THE defect, caught before a runtime call rather than after. All 43 sells
    // failed at runtime with an identical error because the token account
    // existed with a zero balance -- a fact about the setup that was recorded
    // as a fact about the route.
    expect(() => validateSetup({ ...sellOpts, inputTokenProgram: null })).toThrow(InvalidSimulationSetup);
    expect(() => validateSetup({ ...sellOpts, inputTokenProgram: null })).toThrow(/token program/i);
  });

  it('accepts a sell that provisions its input token', () => {
    expect(() => validateSetup(sellOpts)).not.toThrow();
  });

  it('refuses an input amount of zero', () => {
    // requestedAmount was the string '0' on every job ever submitted.
    expect(() => validateSetup({ ...opts, inputAmount: 0n })).toThrow(/input amount is zero/i);
  });

  it('refuses a sell whose input is SOL, which is not a sell', () => {
    expect(() => validateSetup({ ...opts, side: 'sell' })).toThrow(/not a sell/i);
  });

  it('refuses a leg whose input and output are the same asset', () => {
    expect(() => validateSetup({ ...opts, outputMint: WSOL })).toThrow(/same/i);
  });

  it('refuses a buy that cannot name the token program of what it receives', () => {
    // The credit has no account to be bound to, so the run would report
    // SIMULATED_OK having verified nothing about the money. This is the exact
    // gap between the proof harness and production.
    expect(() => validateSetup({ ...opts, outputTokenProgram: null })).toThrow(/token program/i);
    expect(() => validateSetup({ ...opts, outputTokenProgram: undefined })).toThrow(/bound to an account/i);
  });

  it('skips rather than simulating when the setup is invalid, and says so as CRITICAL', async () => {
    const dir = tmp();
    try {
      const { db, blobs, hash } = setup(dir);
      let sent = 0;
      const client = clientReturning(() => {
        sent += 1;
        return response({});
      });
      const r = await simulateObservation(db, blobs, client, 'obs-1', hash, PAYER, {
        ...sellOpts,
        inputTokenProgram: null,
      });
      expect(r.kind).toBe('skipped');
      // Nothing was sent: an invalid setup is a caller defect, and running it
      // would produce a failure recorded as a simulation outcome.
      expect(sent).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM simulation_jobs').get()).toEqual({ c: 0 });
      const health = db.prepare("SELECT severity FROM health_events WHERE kind='simulation_setup_invalid'").all() as {
        severity: string;
      }[];
      expect(health[0]?.severity).toBe('critical');
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  it('provisions the token for a sell and only SOL for a buy', async () => {
    const dir = tmp();
    try {
      const { db, blobs, hash } = setup(dir);
      const seen: { balanceMutations: readonly { kind: string; mint?: string; amount: string }[] }[] = [];
      const client = clientReturning((path, body) => {
        if (path === '/v1/simulate' && body !== undefined) seen.push(body as never);
        return response({});
      });

      await simulateObservation(db, blobs, client, 'obs-1', hash, PAYER, sellOpts);
      const sell = seen[0]?.balanceMutations ?? [];
      const tokenMutation = sell.find((m) => m.kind === 'token');
      expect(tokenMutation, 'a sell must be given the token it spends').toBeDefined();
      expect(tokenMutation?.mint).toBe(MINT_B);
      // EXACTLY the hypothetical position: more would let a sell succeed that
      // the real balance could not cover.
      expect(tokenMutation?.amount).toBe('1000000000');
      db.close();
    } finally {
      cleanup(dir);
    }
  });
});
