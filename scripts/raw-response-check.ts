import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { BlobStore, type ExactTransactionBlob } from '../packages/storage/src/blobstore.js';
import { SimulationClient } from '../packages/simulator/src/client.js';
import { resolveSimulatorToken } from '../packages/simulator/src/token.js';

/**
 * What the daemon actually puts on the wire.
 *
 * P2 repaired both ends of a mismatch. Asserting that it worked without looking
 * at the bytes between them would be repeating the original mistake in the
 * other direction: the whole defect was two files that each believed something
 * true about themselves and false about the wire.
 */

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const blobs = new BlobStore();
const { token } = resolveSimulatorToken();
const taker = secrets.paperTakerPubkey;
if (token.length === 0 || taker === null) {
  console.error('no simulator token or taker configured');
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
    `SELECT observation_id, mint, requested_amount, exact_transaction_blob, expected_output, minimum_output
     FROM execution_observations
     WHERE side = 'buy' AND exact_transaction_blob IS NOT NULL AND route_labels LIKE '%Pump%'
     ORDER BY received_utc_ms DESC LIMIT 1`,
  )
  .get() as
  | {
      observation_id: string;
      mint: string;
      requested_amount: string;
      exact_transaction_blob: string;
      expected_output: string | null;
      minimum_output: string | null;
    }
  | undefined;

if (row === undefined) {
  console.error('no Pump buy with stored bytes to replay');
  process.exit(1);
}

const blob = blobs.get<ExactTransactionBlob>(row.exact_transaction_blob);
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
  balanceMutations: [{ kind: 'sol', owner: taker, amount: '500000000' }],
  bounds: { feePayer: taker, maxLamportsSpent: '40000000' },
  contextHash: 'raw-response-check',
});

const res = await client.simulate(request);

console.log(`status  ${res.status}`);
console.log(`error   ${res.transactionError ?? 'none'}`);
console.log(`\nresponse keys: ${Object.keys(res).sort().join(', ')}\n`);

const pre = res.preTokenAccounts ?? null;
const post = res.postTokenAccounts ?? null;
console.log(`preTokenAccounts  ${pre === null ? 'ABSENT FROM THE RESPONSE' : `${pre.length} row(s)`}`);
console.log(`postTokenAccounts ${post === null ? 'ABSENT FROM THE RESPONSE' : `${post.length} row(s)`}`);

if (pre !== null) for (const b of pre.slice(0, 6)) console.log(`  pre  ${b.tokenAccount.slice(0, 10)} owner=${b.owner.slice(0, 10)} mint=${b.mint.slice(0, 10)} amt=${b.amount}`);
if (post !== null) for (const b of post.slice(0, 6)) console.log(`  post ${b.tokenAccount.slice(0, 10)} owner=${b.owner.slice(0, 10)} mint=${b.mint.slice(0, 10)} amt=${b.amount}`);

console.log(`\ntaker ${taker}`);
console.log(`mint  ${row.mint}`);
const hit = (post ?? []).filter((b) => b.owner === taker && b.mint === row.mint);
console.log(`\ntaker's post rows for this mint: ${hit.length}`);
for (const b of hit) console.log(`  ${b.tokenAccount} program=${b.tokenProgram} amount=${b.amount}`);

if (pre === null || post === null) {
  console.log('\nThe daemon is not sending the structured arrays. Either it is running');
  console.log('older code, or the field never left the response builder.');
} else if (hit.length === 0) {
  console.log('\nStructured arrays arrived, but none of them belongs to the taker and mint.');
  console.log('The identity is being decoded differently at the two ends.');
} else {
  console.log('\nThe token credit is visible with its identity intact.');
}
db.close();
