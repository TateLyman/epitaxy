import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import { SimulationClient } from '../packages/simulator/src/client.js';
import { compareRuns } from '../packages/simulator/src/parity-compare.js';
import type { SnapshotBlob } from '../packages/simulator/src/protocol.js';

/**
 * `pnpm simulator:prospective-parity` — §7.
 *
 * Historical execution parity needs historical account state and an archival
 * node. Prospective parity does not: build a route against the chain as it is
 * RIGHT NOW, simulate it with JIT fetching, freeze everything that fetch
 * touched, replay it offline from the freeze, and require the two to agree.
 *
 * That is the question that actually matters. It asks whether an offline
 * snapshot is a faithful freeze of the state a real route executed against. If
 * it is, offline replay is reproducible evidence. If it is not, every offline
 * number is a confident answer about a chain that never existed.
 *
 * Nothing is signed and nothing is submitted. The taker is an address no key
 * exists for; the daemon funds it hypothetically inside a throwaway SVM.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OUTPUT = process.env['PARITY_MINT'] ?? USDC;
const AMOUNT = BigInt(process.env['PARITY_LAMPORTS'] ?? '20000000');
const BASE_URL = process.env['SIMULATORD_URL'] ?? 'http://127.0.0.1:8787';
const TOKEN = process.env['SIMULATORD_TOKEN'] ?? 'local-dev-token-0123456789';

const secrets = loadSecrets();
loadConfig('paper');

// The taker is a PUBLIC key with no keypair anywhere in this system. It exists
// so /swap/v2/build has an address to compile against; the daemon funds it
// hypothetically inside a throwaway SVM that is destroyed after the job.
const taker = secrets.paperTakerPubkey;
if (taker === null) {
  console.log('PAPER_TAKER_PUBKEY is unset, so there is no address to build a route for.');
  process.exit(2);
}

const jup = new JupiterClient({
  limiter: RateLimiter.fromConfig(secrets.jupiterApiKey !== null),
  apiKey: secrets.jupiterApiKey,
});

console.log(`building ${AMOUNT} lamports ${SOL.slice(0, 6)} -> ${OUTPUT.slice(0, 6)} for taker ${taker.slice(0, 8)}`);
const built = await jup.build({ inputMint: SOL, outputMint: OUTPUT, amount: AMOUNT, taker });

if (!built.buildable) {
  console.log(`NOT BUILDABLE: ${built.failure} ${built.errorMessage ?? ''}`);
  console.log('No route means no parity check. This is a fact about the route, not about the simulator.');
  process.exit(2);
}

console.log(
  `built: ${built.instructionCount} instruction(s), ${Object.keys(built.lookupTables).length} lookup table(s), ` +
    `out ${built.outAmount}, route ${built.routeLabels.join('+')}`,
);
if (built.blockhash === null) {
  console.log('the build carried no blockhash; refusing rather than inventing one');
  process.exit(2);
}

// §5 — the EXACT bytes, compiled once and used for both runs. Two compilations
// of "the same" instructions are two transactions.
const message = compileMessage(built.instructions, taker, built.blockhash, built.lookupTables);
const bytes = encodeUnsignedTransaction(message);
const txBase64 = Buffer.from(bytes).toString('base64');
const decoded = decodeTransaction(bytes);
console.log(
  `compiled: ${bytes.length} packet bytes, ${decoded.staticAccountKeys.length} static keys, ` +
    `${decoded.addressTableLookups.length} lookup(s), ${decoded.numRequiredSignatures} signature(s)`,
);

const client = new SimulationClient({
  baseUrl: BASE_URL,
  token: TOKEN,
  pinnedIdentity: null,
  requirePinned: false,
  timeoutMs: 180_000,
});

const health = await client.health();
console.log(`simulator: ${JSON.stringify(health)}`);

const common = {
  transactionBase64: txBase64,
  originalTransactionHash: createHash('sha256').update(bytes).digest('hex'),
  originalMessageHash: createHash('sha256').update(decoded.messageBytes).digest('hex'),
  originalBlockhash: built.blockhash,
  originalLastValidBlockHeight: built.lastValidBlockHeight,
  routeFamily: 'BUILD_CUSTOM',
  requestedAmount: AMOUNT.toString(),
  // Enough SOL to cover the swap, the fee and any rent the route creates. This
  // is hypothetical funding inside a throwaway SVM, not a wallet.
  balanceMutations: [{ kind: 'sol' as const, owner: taker, amount: (AMOUNT * 10n).toString() }],
  bounds: {
    feePayer: taker,
    maxLamportsSpent: (AMOUNT * 2n).toString(),
    mint: OUTPUT,
  },
  contextHash: null,
};

// ---------------------------------------------------------------- pass 1: JIT
console.log('\n--- DEVELOPMENT_JIT against current mainnet state ---');
const jitReq = client.buildRequest({
  ...common,
  executionObservationId: 'prospective-parity-jit',
  mode: 'DEVELOPMENT_JIT',
  snapshotManifestHash: 'jit-no-frozen-snapshot',
  snapshotAccounts: [],
});
const jit = await client.simulate(jitReq);
console.log(`  status            ${jit.status}`);
console.log(`  error             ${jit.transactionError ?? 'none'}`);
console.log(`  unitsConsumed     ${jit.unitsConsumed}`);
console.log(`  baseFee           ${jit.baseFeeLamports ?? 'unknown'}`);
console.log(`  priorityFee       ${jit.priorityFeeLamports ?? 'unknown'}`);
console.log(`  rentCreated       ${jit.rentCreatedLamports ?? 'unknown'}`);
console.log(`  created/closed    ${jit.createdAccounts.length}/${jit.closedAccounts.length}`);
console.log(`  startup/sim       ${jit.startupMs}ms / ${jit.simulateMs}ms`);
console.log(`  exported accounts ${jit.exportedSnapshot.length}`);
console.log(`  with program ELF  ${jit.exportedSnapshot.filter((a) => (a.programElfBase64 ?? null) !== null).length}`);
console.log(`  omissions         ${jit.exportOmissions.length}`);
for (const o of jit.exportOmissions.slice(0, 8)) console.log(`    - ${o}`);
console.log(`  detail            ${jit.detail}`);
for (const l of jit.logs.slice(0, 6)) console.log(`    | ${l}`);

if (jit.exportedSnapshot.length === 0) {
  console.log('\nnothing was exported, so there is nothing to replay offline');
  process.exit(1);
}

// ------------------------------------------------- pass 2: offline from freeze
const snapshot: SnapshotBlob[] = [...jit.exportedSnapshot];
const manifest = createHash('sha256')
  .update(JSON.stringify([...snapshot].sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1)).map((a) => [a.pubkey, a.dataBase64.length, a.lamports])))
  .digest('hex');

console.log(`\n--- CONFIRMATORY_OFFLINE from the frozen snapshot (${snapshot.length} accounts, manifest ${manifest.slice(0, 12)}) ---`);
const offlineReq = client.buildRequest({
  ...common,
  executionObservationId: 'prospective-parity-offline',
  mode: 'CONFIRMATORY_OFFLINE',
  snapshotManifestHash: manifest,
  snapshotAccounts: snapshot,
});
const offline = await client.simulate(offlineReq);
console.log(`  status            ${offline.status}`);
console.log(`  error             ${offline.transactionError ?? 'none'}`);
console.log(`  unitsConsumed     ${offline.unitsConsumed}`);
console.log(`  startup/sim       ${offline.startupMs}ms / ${offline.simulateMs}ms`);
console.log(`  detail            ${offline.detail}`);
for (const l of offline.logs.slice(0, 6)) console.log(`    | ${l}`);

// --------------------------------------------------------------- the verdict
const verdict = compareRuns(jit, offline);
console.log(`\n--- parity ---`);
console.log(`  agrees            ${verdict.agrees ? 'YES' : 'NO'}`);
for (const d of verdict.diffs.slice(0, 25)) {
  console.log(`    ${d.field}: jit=${d.jit.slice(0, 60)} offline=${d.offline.slice(0, 60)}`);
}
if (verdict.diffs.length > 25) console.log(`    ... and ${verdict.diffs.length - 25} more`);
for (const d of verdict.disqualifiers) console.log(`  DISQUALIFIED      ${d}`);

const established = verdict.agrees && verdict.disqualifiers.length === 0;
console.log(`\n  execution parity  ${established ? 'ESTABLISHED for this route' : 'NOT ESTABLISHED'}`);

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/simulator-parity.json',
  `${JSON.stringify(
    {
      takenAtUtcMs: Date.now(),
      inputMint: SOL,
      outputMint: OUTPUT,
      amountLamports: AMOUNT.toString(),
      routeLabels: built.routeLabels,
      packetBytes: bytes.length,
      lookupTables: decoded.addressTableLookups.length,
      jit: { status: jit.status, unitsConsumed: jit.unitsConsumed, error: jit.transactionError },
      offline: { status: offline.status, unitsConsumed: offline.unitsConsumed, error: offline.transactionError },
      exportedAccounts: snapshot.length,
      programsWithElf: snapshot.filter((a) => (a.programElfBase64 ?? null) !== null).length,
      omissions: jit.exportOmissions,
      agrees: verdict.agrees,
      diffs: verdict.diffs.slice(0, 50),
      disqualifiers: verdict.disqualifiers,
      executionParityEstablished: established,
    },
    null,
    2,
  )}\n`,
);
console.log('  wrote artifacts/simulator-parity.json');
process.exitCode = established ? 0 : 1;
