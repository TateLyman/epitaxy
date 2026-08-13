import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { BlobStore, type ExactTransactionBlob } from '../packages/storage/src/blobstore.js';
import { SimulationClient } from '../packages/simulator/src/client.js';
import { resolveSimulatorToken } from '../packages/simulator/src/token.js';
import { simulateLeg, exactBlobFor, simulatorHealth } from '../apps/engine/src/simulate-observation.js';
import { observeRoute } from '../apps/engine/src/observe-route.js';
import { legIsExecutable } from '../packages/domain/src/execution.js';

/**
 * The whole §9 path, end to end, against a throwaway database.
 *
 * Build a real route, store its exact bytes, simulate them, and check that the
 * observation moves out of NOT_SIMULATED and becomes an executable leg. This is
 * the loop that turns "0 of 6,700 observations simulated" into a number, so it
 * is worth proving on its own rather than discovering inside a live engine.
 *
 * Writes to a TEMPORARY database. The research corpus is not touched.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AMOUNT = 20_000_000n;

const secrets = loadSecrets();
const config = loadConfig('paper');
const taker = secrets.paperTakerPubkey;
if (taker === null) {
  console.log('PAPER_TAKER_PUBKEY is unset; there is no address to build for.');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'epitaxy-e2e-'));
const db = openDb({ path: join(dir, 'e2e.db'), skipBackup: true });
const blobs = new BlobStore(join(dir, 'blobs'));
const jup = new JupiterClient({
  limiter: RateLimiter.fromConfig(secrets.jupiterApiKey !== null),
  apiKey: secrets.jupiterApiKey,
});

const { token, source } = resolveSimulatorToken();
if (token.length === 0) {
  console.log('no simulator token found; the engine would refuse every fill requiring simulation');
  process.exit(2);
}
const client = new SimulationClient({
  baseUrl: process.env['SIMULATORD_URL'] ?? 'http://127.0.0.1:8787',
  token,
  pinnedIdentity: null,
  requirePinned: false,
  timeoutMs: 120_000,
});

const health = await simulatorHealth(db, client);
console.log(`simulator  reachable=${health.reachable} identity=${health.identityMatch} token from ${source}`);
console.log(`           parity=${health.parityStatus} snapshots=${health.snapshotFreezeStatus}`);

console.log(`\nbuilding ${AMOUNT} lamports SOL -> USDC`);
const obs = await observeRoute(db, jup, {
  family: 'BUILD_CUSTOM',
  mint: USDC,
  side: 'buy',
  positionId: null,
  shadowPositionId: null,
  purpose: 'entry',
  inputMint: SOL,
  outputMint: USDC,
  amount: AMOUNT,
  taker,
  slippageBps: config.risk.maxSlippageBps,
  maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
  broadcasterTipLamports: config.assumedBroadcasterTipLamports,
  priority: 'risk',
  contextHash: 'e2e',
  // Into the temporary store, so the research corpus is untouched.
  blobs,
});

console.log(`  observation       ${obs.observationId}`);
console.log(`  instructionPolicy ${obs.instructionPolicy}  transactionPolicy ${obs.transactionPolicy}`);
console.log(`  simulation        ${obs.simulation}`);
// The typed refusal lives on the row, not on the in-memory observation.
const failRow = db
  .prepare('SELECT failure AS f, policy_detail AS d FROM execution_observations WHERE observation_id = ?')
  .get(obs.observationId) as { f: string | null; d: string | null };
console.log(`  failure           ${failRow.f ?? 'none'}`);
console.log(`  policyDetail      ${failRow.d ?? 'none'}`);
const bhRow = db.prepare('SELECT blockhash AS b FROM execution_observations WHERE observation_id = ?').get(obs.observationId) as { b: string | null };
console.log(`  blockhash column  ${bhRow.b ?? 'NULL'}`);

// §5 — the exact bytes must be there before anything can be simulated.
const blobHash = exactBlobFor(db, obs.observationId);
console.log(`  exact tx blob     ${blobHash === null ? 'MISSING' : blobHash.slice(0, 16)}`);
if (blobHash !== null) {
  const blob = blobs.get<ExactTransactionBlob>(blobHash);
  console.log(`                    ${blob.packetBytes} packet bytes, ${blob.staticAccountKeys.length} static keys, ${Object.keys(blob.lookupTables).length} table(s)`);
}

const before = legIsExecutable(obs, { requireLocalSimulation: true });
console.log(`\n  before simulating: executable=${before.ok}`);
for (const r of before.reasons) console.log(`    - ${r}`);

const { simulated, attempt } = await simulateLeg(db, blobs, client, obs.observationId, taker, {
  mode: 'DEVELOPMENT_JIT',
  fundingLamports: AMOUNT * 10n,
  maxLamportsSpent: AMOUNT * 2n,
  contextHash: 'e2e',
});
console.log(`\n  simulate          kind=${attempt?.kind ?? 'none'} simulated=${simulated}`);
if (attempt?.kind === 'ok') {
  console.log(`                    status=${attempt.status} confirmatory=${attempt.confirmatory}`);
  for (const r of attempt.reasons) console.log(`                    not confirmatory: ${r}`);
} else if (attempt?.kind === 'unavailable' || attempt?.kind === 'skipped') {
  console.log(`                    reason: ${attempt.reason}`);
}

const row = db
  .prepare('SELECT simulation AS s FROM execution_observations WHERE observation_id = ?')
  .get(obs.observationId) as { s: string };
console.log(`  row simulation    ${row.s}`);

const after = legIsExecutable({ ...obs, simulation: row.s as never }, { requireLocalSimulation: true });
console.log(`  after simulating: executable=${after.ok}`);
for (const r of after.reasons) console.log(`    - ${r}`);

const jobs = db.prepare('SELECT status, confirmatory FROM simulation_jobs').all() as {
  status: string;
  confirmatory: number;
}[];
console.log(`\n  durable jobs      ${jobs.length}`);
for (const j of jobs) console.log(`                    ${j.status} confirmatory=${j.confirmatory}`);

const checks: [string, boolean][] = [
  ['the exact transaction was stored', blobHash !== null],
  ['a durable job row exists', jobs.length === 1],
  ['the leg was NOT executable before simulating', !before.ok],
  ['the observation left NOT_SIMULATED', row.s !== 'NOT_SIMULATED'],
  ['the leg is executable after a successful simulation', row.s !== 'SIMULATED_OK' || after.ok],
  ['a JIT run is not confirmatory', attempt?.kind !== 'ok' || !attempt.confirmatory],
];
console.log('\nchecks:');
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}
db.close();
console.log(`\ntemporary database at ${dir}; the research corpus was not touched`);
