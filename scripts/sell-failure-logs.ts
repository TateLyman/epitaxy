import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { BlobStore, type ExactTransactionBlob } from '../packages/storage/src/blobstore.js';
import { SimulationClient } from '../packages/simulator/src/client.js';
import { resolveSimulatorToken } from '../packages/simulator/src/token.js';

/**
 * One failing sell, with its logs.
 *
 * The P2 repair provisions the token and one of eight stale sells now executes.
 * Seven still return the same error at the same instruction. That is either a
 * second setup defect or a fact about those routes, and the difference is not
 * something to reason about from the outside: the runtime says which
 * instruction failed and why, and it has been saying so all along.
 */

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const blobs = new BlobStore();
const { token } = resolveSimulatorToken();
const taker = secrets.paperTakerPubkey;
if (token.length === 0 || taker === null) {
  console.error('no simulator token or taker; nothing can be established');
  process.exit(1);
}

const client = new SimulationClient({
  baseUrl: process.env['SIMULATORD_URL'] ?? 'http://127.0.0.1:8787',
  token,
  pinnedIdentity: null,
  requirePinned: false,
  timeoutMs: 120_000,
});

const row = db
  .prepare(
    `SELECT o.observation_id, o.mint, o.requested_amount, o.exact_transaction_blob,
            o.static_account_keys, o.minimum_output, o.expected_output, o.context_slot
     FROM execution_observations o
     JOIN simulation_jobs s ON s.execution_observation_id = o.observation_id
     WHERE o.side = 'sell' AND s.context_hash = 'sell-repair-proof'
       AND s.status = 'SIMULATION_FAILED' AND o.exact_transaction_blob IS NOT NULL
     LIMIT 1`,
  )
  .get() as
  | {
      observation_id: string;
      mint: string;
      requested_amount: string;
      exact_transaction_blob: string;
      static_account_keys: string | null;
      minimum_output: string | null;
      expected_output: string | null;
      context_slot: number | null;
    }
  | undefined;

if (row === undefined) {
  console.error('no failing sell from the proof run to inspect');
  process.exit(1);
}

const blob = blobs.get<ExactTransactionBlob>(row.exact_transaction_blob);
console.log(`observation ${row.observation_id}`);
console.log(`mint        ${row.mint}`);
console.log(`amount      ${row.requested_amount}`);
console.log(`minOut      ${row.minimum_output}   expectedOut ${row.expected_output}`);
console.log(`built at slot ${row.context_slot}\n`);
console.log('instructions:');
blob.instructions.forEach((ix, i) => {
  console.log(`  ${i}  ${ix.programId}  ${ix.accounts.length} accounts  data=${ix.data.length} chars`);
});

const request = client.buildRequest({
  executionObservationId: row.observation_id,
  mode: 'DEVELOPMENT_JIT',
  transactionBase64: blob.transactionBase64,
  originalTransactionHash: blob.transactionHash,
  originalMessageHash: blob.messageHash,
  originalBlockhash: blob.blockhash,
  originalLastValidBlockHeight: blob.lastValidBlockHeight,
  routeFamily: 'BUILD_CUSTOM',
  requestedAmount: row.requested_amount,
  targetSlot: blob.contextSlot,
  snapshotManifestHash: 'jit-no-frozen-snapshot',
  snapshotAccounts: [],
  balanceMutations: [
    { kind: 'sol', owner: taker, amount: '200000000' },
    {
      kind: 'token',
      owner: taker,
      mint: row.mint,
      amount: row.requested_amount,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    },
  ],
  bounds: { feePayer: taker, maxLamportsSpent: '20000000' },
  contextHash: 'sell-failure-logs',
});

const res = await client.simulate(request);
console.log(`\nstatus  ${res.status}`);
console.log(`error   ${res.transactionError ?? 'none'}`);
console.log(`\npre  token balances: ${JSON.stringify(res.preTokenBalances)}`);
console.log(`post token balances: ${JSON.stringify(res.postTokenBalances)}`);
console.log('\nlogs:');
for (const line of res.logs) console.log(`  ${line}`);
db.close();
