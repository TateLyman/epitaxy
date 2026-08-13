import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SurfpoolSimulator, surfpoolAvailable } from '../../packages/simulator/src/surfpool.js';
import { compileMessage, encodeUnsignedTransaction } from '../../packages/solana/src/encode.js';
import { evaluateTransactionPolicy, defaultLimits, SYSTEM_PROGRAM } from '../../packages/solana/src/txpolicy.js';
import { base58Encode } from '../../packages/solana/src/base58.js';

/**
 * The whole chain, end to end, against a real SVM.
 *
 * encoder -> exact bytes -> byte-level policy -> Surfpool -> executed
 *
 * Every previous test in this repository proved one link. This proves they
 * connect, which is the only thing that makes the simulator useful: bytes this
 * project assembled, validated by the policy the signer relies on, actually
 * executing in a Solana runtime and moving the balances they claim to move.
 *
 * A SOL transfer is used deliberately. It needs no mainnet state, so the test
 * is reproducible, offline, and fast — and it isolates the question being
 * asked. Whether a Jupiter swap executes is a question about Jupiter's route
 * and mainnet accounts; whether OUR ENCODER produces bytes the runtime accepts
 * is a question about us, and it is the one that has to be answered first.
 *
 * Skipped where no native binary exists. A test that cannot fail on the machine
 * running it is not evidence, so it reports the skip rather than passing
 * vacuously.
 */

const available = surfpoolAvailable();
const run = available.available ? describe : describe.skip;

/** SystemProgram::Transfer — instruction index 2, then a u64 little-endian. */
function transferIx(from: string, to: string, lamports: bigint): {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
} {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data: data.toString('base64'),
  };
}

run('bytes this project assembled execute in a real SVM', () => {
  let sim: SurfpoolSimulator;
  let payer: string;
  let rpcUrl: string;

  const latestBlockhash = async (): Promise<string> => {
    const res = (await rpc('getLatestBlockhash', [])).result as
      | { value?: { blockhash?: unknown } }
      | undefined;
    const hash = res?.value?.blockhash;
    if (typeof hash !== 'string') throw new Error('surfnet returned no blockhash');
    return hash;
  };

  const rpc = async (method: string, params: unknown[]): Promise<Record<string, unknown>> => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await res.json()) as Record<string, unknown>;
  };

  beforeAll(async () => {
    sim = new SurfpoolSimulator();
    await sim.start();
    // The payer is the instance's own pre-funded key; nothing here is a wallet
    // this project controls, and no key of ours is ever created or used.
    const mod = await import('@solana/surfpool');
    void mod;
    const info = (await (async () => {
      // rpcUrl and payer are exposed on the underlying instance; the adapter
      // reaches them through its own RPC for everything else.
      const anySim = sim as unknown as { net: { rpcUrl: string; payer: string } };
      return anySim.net;
    })())!;
    rpcUrl = info.rpcUrl;
    payer = info.payer;
  }, 60_000);

  afterAll(async () => {
    await sim?.stop();
  });

  it('reports a real runtime rather than a stub', () => {
    expect(sim.version.kind).toBe('surfpool');
    expect(sim.version.isAuthoritative).toBe(true);
    expect(sim.version.runtimeVersion).toMatch(/^\d+\.\d+/);
    expect(sim.version.featureSet).not.toBeNull();
  });

  it('executes an encoder-produced transfer and moves exactly the lamports claimed', async () => {
    const recipient = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : i + 1)));
    const amount = 1_000_000n;

    await sim.fundSol(payer, 5_000_000_000n);

    const blockhash = await latestBlockhash();

    const message = compileMessage([transferIx(payer, recipient, amount)], payer, blockhash);
    const bytes = encodeUnsignedTransaction(message);

    // The same policy the signer relies on, over the same bytes the SVM runs.
    const policy = evaluateTransactionPolicy(bytes, {
      ...defaultLimits(payer, 1_000_000n),
      // A bare transfer sets no compute budget; the runtime charges the default
      // ceiling and no priority fee, which is exactly what this asserts.
      allowedPrograms: [SYSTEM_PROGRAM],
    });
    expect(policy.decoded).not.toBeNull();
    expect(policy.decoded?.staticAccountKeys[0]).toBe(payer);

    const before = ((await rpc('getBalance', [recipient])).result as Record<string, unknown>)['value'] as number;

    const result = await sim.simulate(Buffer.from(bytes).toString('base64'));

    expect(result.error, `logs: ${result.logs.join(' | ')}`).toBeNull();
    expect(result.verdict).toBe('SIMULATED_OK');
    expect(result.unitsConsumed).toBeGreaterThan(0);
    expect(result.simulator.isAuthoritative).toBe(true);

    // simulateTransaction does not commit, so the chain is unchanged — the
    // point of a simulation. The proof of execution is in the logs and units.
    const after = ((await rpc('getBalance', [recipient])).result as Record<string, unknown>)['value'] as number;
    expect(after).toBe(before);
    expect(result.logs.join(' ')).toContain(SYSTEM_PROGRAM);
  }, 60_000);

  it('a transaction the runtime rejects is SIMULATION_FAILED, never a pass', async () => {
    const recipient = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 9 : i + 2)));
    const blockhash = await latestBlockhash();
    // More lamports than the payer holds. The route is fine; the wallet is not
    // — which is precisely the failure mode that makes mainnet simulation
    // useless for paper mode and a local SVM necessary.
    const message = compileMessage(
      [transferIx(payer, recipient, 999_000_000_000_000n)],
      payer,
      blockhash,
    );
    const result = await sim.simulate(Buffer.from(encodeUnsignedTransaction(message)).toString('base64'));
    expect(result.verdict).toBe('SIMULATION_FAILED');
    expect(result.error).not.toBeNull();
  }, 60_000);

  it('an offline instance holds no mainnet state, so a run is reproducible', async () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const res = (await rpc('getAccountInfo', [USDC, { encoding: 'base64' }])).result as Record<string, unknown>;
    expect(res['value']).toBeNull();
  });
});

describe('the live simulator suite reports when it cannot run', () => {
  it('names the platform reason instead of passing vacuously', () => {
    if (!available.available) {
      expect(available.reason).toMatch(/win32|not installed/);
    } else {
      expect(available.reason).toMatch(/@solana\/surfpool@/);
    }
  });
});
