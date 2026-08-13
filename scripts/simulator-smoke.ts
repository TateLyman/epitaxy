import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { SimulationClient, responseIsConfirmatory } from '../packages/simulator/src/client.js';
import { resolveSimulatorToken } from '../packages/simulator/src/token.js';
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
// Resolved from the supervisor's token file, so the credential never has to
// pass through a shell, an argument list or a log line.
const { token: TOKEN, source: TOKEN_SOURCE } = resolveSimulatorToken();

const client = new SimulationClient({
  baseUrl: BASE,
  token: TOKEN,
  pinnedIdentity: null,
  requirePinned: false,
  timeoutMs: 60_000,
});

const health = await client.health();
console.log(`token from ${TOKEN_SOURCE}`);
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
console.log(`  baseFee             ${res.baseFeeLamports ?? 'unknown'}`);
console.log(`  priorityFee         ${res.priorityFeeLamports ?? 'unknown'}`);
console.log(`  rentCreated         ${res.rentCreatedLamports ?? 'unknown'}`);
console.log(`  rentRecovered       ${res.rentRecoveredLamports ?? 'unknown'}`);
console.log(`  created/closed      ${res.createdAccounts.length}/${res.closedAccounts.length}`);
console.log(`  payer pre -> post   ${res.preSolBalances[payer] ?? '?'} -> ${res.postSolBalances[payer] ?? '?'}`);
console.log(`  recip pre -> post   ${res.preSolBalances[recipient] ?? '?'} -> ${res.postSolBalances[recipient] ?? '?'}`);
console.log(`  boundsViolations    ${res.boundsViolations.length === 0 ? 'none' : res.boundsViolations.join('; ')}`);
console.log(`  mutatedAccounts     ${Object.keys(res.mutatedAccountHashes).length}`);
console.log(`  eventDigest         ${res.runtimeEventDigest?.slice(0, 16) ?? 'none'}`);
console.log(`  logs                ${res.logs.length} line(s)`);
// The reason a run failed is the whole value of a failed run. Printing the
// status without the detail is how a diagnosable problem becomes a mystery.
console.log(`  detail              ${res.detail}`);
for (const line of res.logs.slice(0, 12)) console.log(`    | ${line}`);

const conf = responseIsConfirmatory(res, request.mode);
console.log(`\n  confirmatory        ${conf.ok ? 'YES' : 'NO'}`);
for (const r of conf.reasons) console.log(`    - ${r}`);

// §8 — the same job with the same bytes must be idempotent.
const again = await client.simulate(request);
console.log(`\n  idempotent replay   ${again.jobId === res.jobId && again.requestHash === res.requestHash ? 'same job/hash' : 'MISMATCH'}`);
console.log(`  replay status       ${again.status}`);

// And the same job id with different bytes must be refused.
// A smoke test that prints a failure and exits zero is not a test. These are
// the facts that must hold for the boundary to be working at all, checked
// against numbers this run measured rather than against a hard-coded expectation
// of what the runtime charges.
const transfer = 1_000_000n;
const payerSpent = BigInt(res.preSolBalances[payer] ?? '0') - BigInt(res.postSolBalances[payer] ?? '0');
const recipientGained = BigInt(res.postSolBalances[recipient] ?? '0') - BigInt(res.preSolBalances[recipient] ?? '0');
const checks: [string, boolean][] = [
  ['status is SIMULATED_OK', res.status === 'SIMULATED_OK'],
  ['compute units were reported', res.unitsConsumed !== null && res.unitsConsumed > 0],
  ['the recipient actually received the transfer', recipientGained === transfer],
  ['the payer paid the transfer plus a fee', payerSpent > transfer],
  ['the base fee was measured', res.baseFeeLamports !== null],
  ['payer spend decomposes exactly into transfer + base fee + priority fee',
    payerSpent === transfer + BigInt(res.baseFeeLamports ?? '0') + BigInt(res.priorityFeeLamports ?? '0')],
  ['the asserted bounds held', res.boundsViolations.length === 0],
  ['the blockhash substitution was recorded', res.blockhashReplacement !== null],
];
console.log('\nchecks:');
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

// §13 — a program cannot be restored by setAccount, which has no executable
// parameter. A snapshot naming one without its ELF must be refused, because
// restoring it as non-executable would fail every route through it with an
// error that reads as a fact about the token.
const programSnapshot = client.buildRequest({
  ...request,
  executionObservationId: 'smoke-executable-refusal',
  snapshotAccounts: [
    { pubkey: recipient, owner: SYSTEM_PROGRAM, lamports: '1', dataBase64: '', executable: true, slot: 0 },
  ],
});
const refusal = await client.simulate(programSnapshot);
const refusedProgram = refusal.status === 'SIMULATOR_UNAVAILABLE' && refusal.detail.includes('programElfBase64');
console.log(`\n  executable refusal  ${refusedProgram ? 'PASS' : 'FAIL'} (${refusal.status})`);
if (!refusedProgram) process.exitCode = 1;

// §15 — the daemon checked against outcomes it did not produce.
const CORPUS = 'tests/fixtures/parity/mainnet-confirmed.json';
if (existsSync(CORPUS)) {
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as { signature: string; observedFeeLamports: string; observedComputeUnits: number | null }[];
  const bytesBySig = new Map(
    (JSON.parse(readFileSync('tests/fixtures/transactions/jupiter-v6.json', 'utf8')) as { signature: string; base64: string }[]).map((f) => [
      f.signature,
      f.base64,
    ]),
  );
  const parity = await client.parity(
    corpus.map((c) => ({
      signature: c.signature,
      transactionBase64: bytesBySig.get(c.signature) ?? '',
      observedFeeLamports: c.observedFeeLamports,
      observedComputeUnits: c.observedComputeUnits,
      observedErr: null,
    })),
  );
  console.log('\nparity vs settled mainnet transactions:');
  for (const c of parity.cases) {
    console.log(
      `  ${c.feeParity ? 'PASS' : 'FAIL'}  ${c.signature.slice(0, 12)}  chain charged ${c.observedFeeLamports}, ` +
        `model says ${c.modelTotalFeeLamports} (${c.modelBaseFeeLamports} base + ${c.modelPriorityFeeLamports} priority)`,
    );
    if (!c.feeParity) process.exitCode = 1;
  }
  console.log(`  execution parity    ${parity.cases[0]?.executionParity ?? 'no cases'}`);
} else {
  console.log(`\nparity: no corpus at ${CORPUS} — run scripts/capture-parity-corpus.ts`);
  process.exitCode = 1;
}

const tampered = { ...request, transactionBase64: `${txBase64.slice(0, -4)}AAAA` };
try {
  await client.simulate(tampered);
  console.log('  tampered replay     ACCEPTED — DEFECT');
  process.exitCode = 1;
} catch (e) {
  console.log(`  tampered replay     refused (${(e as Error).message.slice(0, 70)})`);
}
