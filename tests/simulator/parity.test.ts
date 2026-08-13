import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { decodeTransaction, readComputeBudget, priorityFeeLamports, writableStaticKeys } from '../../packages/solana/src/transaction.js';
import { compileMessage, encodeUnsignedTransaction } from '../../packages/solana/src/encode.js';
import { SYSTEM_PROGRAM } from '../../packages/solana/src/txpolicy.js';
import { base58Encode } from '../../packages/solana/src/base58.js';
import { computeRequestHash, SIMULATION_PROTOCOL_VERSION, ACCOUNT_SNAPSHOT_SCHEMA_VERSION, EXECUTION_PARITY_ESTABLISHED } from '../../packages/simulator/src/protocol.js';
import { responseIsConfirmatory } from '../../packages/simulator/src/client.js';
import type { SimulationRequest, SimulationResponse, SnapshotBlob } from '../../packages/simulator/src/protocol.js';

/**
 * §15 — parity, and the exact boundary of what parity establishes.
 *
 * Everything here runs offline against outcomes the chain already settled. No
 * network, no Surfnet, no key: a settled fee is a settled fee on any machine.
 */

const CORPUS = 'tests/fixtures/parity/mainnet-confirmed.json';

interface CorpusRow {
  signature: string;
  slot: number;
  numRequiredSignatures: number;
  unitLimit: number | null;
  unitPriceMicroLamports: string | null;
  observedFeeLamports: string;
  observedComputeUnits: number | null;
  modelBaseFeeLamports: string;
  modelPriorityFeeLamports: string;
  modelTotalFeeLamports: string;
  agrees: boolean;
}

describe('fee parity against settled mainnet transactions', () => {
  const rows: CorpusRow[] = existsSync(CORPUS) ? (JSON.parse(readFileSync(CORPUS, 'utf8')) as CorpusRow[]) : [];

  it('has a corpus at all', () => {
    // A parity suite with no cases passes trivially and proves nothing, which
    // is worse than failing: it reports green while establishing nothing.
    expect(rows.length).toBeGreaterThan(0);
  });

  it('reproduces every settled fee exactly from the transaction bytes', () => {
    const fixtures = JSON.parse(readFileSync('tests/fixtures/transactions/jupiter-v6.json', 'utf8')) as {
      signature: string;
      base64: string;
    }[];
    const bySig = new Map(fixtures.map((f) => [f.signature, f.base64]));

    for (const row of rows) {
      const b64 = bySig.get(row.signature);
      expect(b64, `no bytes for ${row.signature}`).toBeDefined();
      const tx = decodeTransaction(Buffer.from(b64 as string, 'base64'));
      const base = 5_000n * BigInt(tx.numRequiredSignatures);
      const priority = priorityFeeLamports(readComputeBudget(tx));
      // Recomputed here rather than trusted from the corpus file: a fixture
      // that records its own verdict tests only that JSON round-trips.
      expect(base + priority, `fee mismatch on ${row.signature.slice(0, 12)}`).toBe(BigInt(row.observedFeeLamports));
    }
  });

  it('covers a multi-signature transaction, where the base fee is not 5000', () => {
    // A corpus of only single-signature transactions cannot tell a per-signature
    // fee from a flat one, and would pass with the multiplier deleted.
    expect(rows.some((r) => r.numRequiredSignatures > 1)).toBe(true);
  });

  it('covers a transaction that actually paid a priority fee', () => {
    expect(rows.some((r) => BigInt(r.modelPriorityFeeLamports) > 0n)).toBe(true);
  });

  it('records compute units observed on chain without claiming to reproduce them', () => {
    // Execution parity is not established: replaying a settled transaction needs
    // the account state at its slot, which needs an archival node. The units are
    // recorded so a future archival run has something to be checked against.
    for (const row of rows) expect(row.observedComputeUnits).toBeGreaterThan(0);
  });
});

describe('writableStaticKeys', () => {
  const key = (n: number): string => base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : i + 1)));

  it('marks the fee payer writable and a program readonly', () => {
    const payer = key(3);
    const dest = key(5);
    const msg = compileMessage(
      [
        {
          programId: SYSTEM_PROGRAM,
          accounts: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: dest, isSigner: false, isWritable: true },
          ],
          data: 'AA==',
        },
      ],
      payer,
      key(7),
    );
    const tx = decodeTransaction(encodeUnsignedTransaction(msg));
    const w = writableStaticKeys(tx);
    expect(w.has(payer)).toBe(true);
    expect(w.has(dest)).toBe(true);
    // The whole reason this function exists: a program comes back null from a
    // simulation, and without this it looks like it was closed.
    expect(w.has(SYSTEM_PROGRAM)).toBe(false);
  });

  it('marks a readonly non-signer readonly', () => {
    const payer = key(3);
    const ro = key(9);
    const msg = compileMessage(
      [
        {
          programId: SYSTEM_PROGRAM,
          accounts: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: ro, isSigner: false, isWritable: false },
          ],
          data: 'AA==',
        },
      ],
      payer,
      key(7),
    );
    const tx = decodeTransaction(encodeUnsignedTransaction(msg));
    const w = writableStaticKeys(tx);
    expect(w.has(payer)).toBe(true);
    expect(w.has(ro)).toBe(false);
  });

  it('marks a readonly signer as a signer that cannot be written', () => {
    const payer = key(3);
    const cosigner = key(11);
    const msg = compileMessage(
      [
        {
          programId: SYSTEM_PROGRAM,
          accounts: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: cosigner, isSigner: true, isWritable: false },
          ],
          data: 'AA==',
        },
      ],
      payer,
      key(7),
    );
    const tx = decodeTransaction(encodeUnsignedTransaction(msg));
    const w = writableStaticKeys(tx);
    expect(w.has(payer)).toBe(true);
    expect(w.has(cosigner)).toBe(false);
  });
});

describe('the protocol carries what changes meaning', () => {
  const blob = (over: Partial<SnapshotBlob> = {}): SnapshotBlob => ({
    pubkey: 'Acc1',
    owner: SYSTEM_PROGRAM,
    lamports: '10',
    dataBase64: '',
    executable: false,
    slot: 1,
    ...over,
  });
  const base = (accounts: SnapshotBlob[]): Omit<SimulationRequest, 'requestHash' | 'jobId'> => ({
    protocolVersion: SIMULATION_PROTOCOL_VERSION,
    executionObservationId: 'obs-1',
    mode: 'CONFIRMATORY_OFFLINE',
    transactionBase64: 'AA==',
    originalTransactionHash: 'h',
    originalMessageHash: 'm',
    originalBlockhash: 'b',
    originalLastValidBlockHeight: null,
    routeFamily: 'BUILD_CUSTOM',
    requestedAmount: '1',
    targetSlot: null,
    snapshotManifestHash: 'snap',
    snapshotAccounts: accounts,
    balanceMutations: [],
    bounds: { feePayer: 'P', maxLamportsSpent: '1' },
    contextHash: null,
  });

  it('hashes two different program ELFs differently', () => {
    // Otherwise a run against one build of a program is idempotently served the
    // result of a run against a different one.
    const a = computeRequestHash(base([blob({ executable: true, programElfBase64: 'AAAA' })]));
    const b = computeRequestHash(base([blob({ executable: true, programElfBase64: 'BBBB' })]));
    expect(a).not.toBe(b);
  });

  it('is stable when nothing that matters changed', () => {
    expect(computeRequestHash(base([blob()]))).toBe(computeRequestHash(base([blob()])));
  });

  it('bumped both versions when the snapshot gained the ELF field', () => {
    // A daemon that silently ignores a field it does not know about produces a
    // wrong answer confidently, which is the failure this pair of numbers exists
    // to prevent.
    // Bumped again to 3 when the snapshot gained exported program code and the
    // response gained exportedSnapshot. The literal is the point: a version
    // that drifts without anyone noticing is a version that proves nothing.
    expect(SIMULATION_PROTOCOL_VERSION).toBe(4);
    expect(ACCOUNT_SNAPSHOT_SCHEMA_VERSION).toBe(4);
  });
});

describe('a successful run is not automatically evidence', () => {
  const ok = (over: Partial<SimulationResponse> = {}): SimulationResponse =>
    ({
      protocolVersion: SIMULATION_PROTOCOL_VERSION,
      jobId: 'j',
      requestHash: 'r',
      identity: {
        protocolVersion: SIMULATION_PROTOCOL_VERSION,
        sourceSha: 'abc123',
        lockfileHash: 'lock',
        surfpoolPackageVersion: '1.5.0',
        surfpoolBinaryHash: 'bin',
        nodeVersion: 'v24.16.0',
        runtimeVersion: '4.1.2',
        featureSet: '3345198602',
        accountSnapshotSchemaVersion: ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
        platform: 'linux/x64',
      },
      snapshotManifestHash: 'snap',
      status: 'SIMULATED_OK',
      transactionError: null,
      logs: [],
      unitsConsumed: 150,
      preSolBalances: {},
      postSolBalances: {},
      preTokenBalances: {},
      postTokenBalances: {},
      baseFeeLamports: '5000',
      priorityFeeLamports: '0',
      rentCreatedLamports: '0',
      rentRecoveredLamports: '0',
      transferFeeLamports: null,
      withheldFeeLamports: null,
      createdAccounts: [],
      closedAccounts: [],
      mutatedAccountHashes: {},
      boundsViolations: [],
      blockhashReplacement: null,
      runtimeEventDigest: 'd',
      jitFetchedAccounts: [],
      contextSlot: 123,
      queueWaitMs: 0,
      startupMs: 20,
      simulateMs: 2,
      totalMs: 25,
      detail: '',
      ...over,
    }) as SimulationResponse;

  it('refuses even a spotless offline run while execution parity is unestablished', () => {
    // §15 is an ordering: parity first, evidence second. This is the test that
    // stops the gate opening by accident the day a snapshot pipeline lands.
    const v = responseIsConfirmatory(ok(), 'CONFIRMATORY_OFFLINE');
    expect(EXECUTION_PARITY_ESTABLISHED).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('execution parity against settled mainnet transactions has not been established');
  });

  it('has nothing else wrong with a spotless run, so flipping parity is the only thing standing in the way', () => {
    // If this ever grows a second reason, the gate is refusing for a cause
    // nobody wrote down, and the parity constant is not what is actually
    // blocking evidence.
    expect(responseIsConfirmatory(ok(), 'CONFIRMATORY_OFFLINE').reasons).toHaveLength(1);
  });

  it('refuses a run that violated the bounds the caller asserted', () => {
    const v = responseIsConfirmatory(ok({ boundsViolations: ['fee payer spent 900 lamports, above the asserted cap of 100'] }), 'CONFIRMATORY_OFFLINE');
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('asserted bounds violated');
  });

  it('refuses a JIT run however well it went', () => {
    expect(responseIsConfirmatory(ok(), 'DEVELOPMENT_JIT').ok).toBe(false);
  });

  it('refuses a daemon whose tree does not match its commit', () => {
    expect(responseIsConfirmatory(ok({ identity: { ...ok().identity, sourceSha: 'abc123+dirty' } }), 'CONFIRMATORY_OFFLINE').ok).toBe(false);
  });
});
