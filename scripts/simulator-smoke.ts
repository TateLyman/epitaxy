import { createHash } from 'node:crypto';
import { SimulationClient, responseIsConfirmatory } from '../packages/simulator/src/client.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { SYSTEM_PROGRAM } from '../packages/solana/src/txpolicy.js';
import { base58Encode } from '../packages/solana/src/base58.js';

/**
 * Does the whole boundary work?
 *
 * Windows assembles the bytes, the WSL daemon executes them, and the answer
 * comes back over loopback. This is the first thing that crosses the platform
 * split, so it is worth proving with a transaction whose economics are trivial
 * and whose failure modes are unambiguous.
 *
 * A SOL transfer needs no mainnet state, so the run is offline, reproducible,
 * and isolates the question being asked: does the transport, the identity
 * check, the idempotency key and the execution actually connect?
 */

const BASE = process.env['SIMULATORD_URL'] ?? 'http://127.0.0.1:8787';
const TOKEN = process.env['SIMULATORD_TOKEN'] ?? 'local-dev-token-0123456789';

const client = new SimulationClient({
  baseUrl: BASE,
  token: TOKEN,
  pinnedIdentity: null,
  requirePinned: false,
  timeoutMs: 60_000,
});

const health = await client.health();
console.log('health:', JSON.stringify(health));

const identity = await client.identity();
console.log('identity:');
for (const [k, v] of Object.entries(identity)) console.log(`  ${k.padEnd(30)} ${String(v)}`);

// A payer we control nothing of — the daemon funds it hypothetically. No key
// for this address exists anywhere, and none is needed: nothing is signed.
const payer = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 3 : i + 1)));
const recipient = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 5 : i + 2)));
// Any 32 bytes: the runtime replaces the blockhash, and the substitution is
// recorded rather than hidden.
const blockhash = base58Encode(Uint8Array.from({ length: 32 }, () => 7));

const data = Buffer.alloc(12);
data.writeUInt32LE(2, 0);
data.writeBigUInt64LE(1_000_000n, 4);

const message = compileMessage(
  [
    {
      programId: SYSTEM_PROGRAM,
      accounts: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
      ],
      data: data.toString('base64'),
    },
  ],
  payer,
  blockhash,
);
const bytes = encodeUnsignedTransaction(message);
const txBase64 = Buffer.from(bytes).toString('base64');

const request = client.buildRequest({
  executionObservationId: 'smoke-observation',
  // Offline and reproducible. A transfer needs no mainnet state, so the frozen
  // snapshot is a single account rather than nothing -- the daemon refuses an
  // empty snapshot in this mode, and it is right to.
  mode: 'CONFIRMATORY_OFFLINE',
  transactionBase64: txBase64,
  originalTransactionHash: createHash('sha256').update(bytes).digest('hex'),
  originalMessageHash: createHash('sha256').update(bytes).digest('hex'),
  originalBlockhash: blockhash,
  originalLastValidBlockHeight: null,
  routeFamily: 'BUILD_CUSTOM',
  requestedAmount: '1000000',
  snapshotManifestHash: 'smoke-transfer-snapshot-v1',
  snapshotAccounts: [
    {
      pubkey: recipient,
      owner: SYSTEM_PROGRAM,
      lamports: '0',
      dataBase64: '',
      executable: false,
      slot: 0,
    },
  ],
  balanceMutations: [{ kind: 'sol', owner: payer, amount: '5000000000' }],
  bounds: { feePayer: payer, maxLamportsSpent: '10000000' },
  contextHash: null,
});

console.log(`\njobId       ${request.jobId}`);
console.log(`requestHash ${request.requestHash}`);

const res = await client.simulate(request);
console.log('\nresult:');
console.log(`  status              ${res.status}`);
console.log(`  error               ${res.transactionError ?? 'none'}`);
console.log(`  unitsConsumed       ${res.unitsConsumed}`);
console.log(`  startupMs           ${res.startupMs}`);
console.log(`  simulateMs          ${res.simulateMs}`);
console.log(`  totalMs             ${res.totalMs}`);
console.log(`  blockhashReplaced   ${res.blockhashReplacement === null ? 'no' : 'yes'}`);
if (res.blockhashReplacement !== null) {
  const r = res.blockhashReplacement;
  console.log(`    proof: instructions=${r.instructionsUnchanged} accounts=${r.accountsUnchanged} header=${r.headerUnchanged}`);
}
console.log(`  mutatedAccounts     ${Object.keys(res.mutatedAccountHashes).length}`);
console.log(`  eventDigest         ${res.runtimeEventDigest?.slice(0, 16) ?? 'none'}`);
console.log(`  logs                ${res.logs.length} line(s)`);

const conf = responseIsConfirmatory(res, request.mode);
console.log(`\n  confirmatory        ${conf.ok ? 'YES' : 'NO'}`);
for (const r of conf.reasons) console.log(`    - ${r}`);

// §8 — the same job with the same bytes must be idempotent.
const again = await client.simulate(request);
console.log(`\n  idempotent replay   ${again.jobId === res.jobId && again.requestHash === res.requestHash ? 'same job/hash' : 'MISMATCH'}`);
console.log(`  replay status       ${again.status}`);

// And the same job id with different bytes must be refused.
const tampered = { ...request, transactionBase64: `${txBase64.slice(0, -4)}AAAA` };
try {
  await client.simulate(tampered);
  console.log('  tampered replay     ACCEPTED — DEFECT');
  process.exitCode = 1;
} catch (e) {
  console.log(`  tampered replay     refused (${(e as Error).message.slice(0, 70)})`);
}
