import { DatabaseSync } from 'node:sqlite';
import { loadConfig, loadSecrets, modeFromArgv } from '../packages/domain/src/config.js';
import { WSOL_MINT } from '../packages/domain/src/types.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { openDb, schemaVersion } from '../packages/storage/src/db.js';
import { buildRunContext } from '../packages/domain/src/provenance.js';
import { upsertRunContext } from '../packages/storage/src/provenance-repo.js';
import { SCHEMA_VERSION as JUP_SCHEMA } from '../packages/adapters/src/jupiter/schemas.js';
import { observeRoute } from '../apps/engine/src/observe-route.js';
import { legIsExecutable, legIsConfirmatory, netExpectedOutput, netMinimumOutput } from '../packages/domain/src/execution.js';
import { formatAmount } from '../packages/domain/src/amounts.js';

/**
 * End-to-end proof that one observation is one observation.
 *
 * Runs the exact code path a paper entry takes — `observeRoute()` then
 * `legIsExecutable()` — against the live endpoint at the exact canary notional,
 * and prints what each gate actually answered.
 *
 * This exists because the engine only reaches that path when an eligible
 * candidate appears, which can be hours. Waiting for one would mean reporting
 * that a refusal "should" happen. This makes it happen.
 *
 * Writes an observation row like any other. It is tagged with the same run
 * context the engine uses, so it is development data by exactly the same rules.
 */

const config = loadConfig(modeFromArgv() ?? 'paper');
const secrets = loadSecrets();
const taker = secrets.paperTakerPubkey;
if (taker === null) {
  console.error('PAPER_TAKER_PUBKEY unset');
  process.exit(1);
}

const argMint = process.argv.find((a) => a.startsWith('--mint='))?.slice('--mint='.length);
const ro = new DatabaseSync(secrets.databasePath, { readOnly: true });
const picked =
  argMint ??
  (
    ro
      .prepare(
        `SELECT mint FROM quotes WHERE side = 'sell' AND CAST(out_amount AS INTEGER) > 0
         ORDER BY requested_utc_ms DESC LIMIT 1`,
      )
      .get() as { mint: string } | undefined
  )?.mint;
ro.close();
if (picked === undefined) {
  console.error('no recently routed mint; pass --mint=');
  process.exit(1);
}

const db = openDb({ path: secrets.databasePath });
const ctx = buildRunContext(config, {
  schemaVersion: schemaVersion(db),
  quoteSchemaVersion: JUP_SCHEMA,
  nowUtcMs: Date.now(),
});
const contextHash = upsertRunContext(db, ctx, config.mode);

const limiter = RateLimiter.fromConfig(secrets.jupiterApiKey !== null);
const jupiter = new JupiterClient({ limiter, apiKey: secrets.jupiterApiKey });

const amount = config.canaryShadowNotionalLamports;
console.log(`observing ${picked} for exactly ${formatAmount(amount, 9)} SOL as ${config.primaryRouteFamily}\n`);

const obs = await observeRoute(db, jupiter, {
  family: config.primaryRouteFamily as 'BUILD_CUSTOM',
  mint: picked,
  side: 'buy',
  positionId: null,
  shadowPositionId: null,
  purpose: 'verification',
  inputMint: WSOL_MINT,
  outputMint: picked,
  amount,
  taker,
  slippageBps: config.risk.maxSlippageBps,
  maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
  broadcasterTipLamports: config.assumedBroadcasterTipLamports,
  priority: 'risk',
  contextHash,
});

console.log(`  observationId        ${obs.observationId}`);
console.log(`  family               ${obs.family}`);
console.log(`  requestedAmount      ${obs.requestedAmount}   <- the exact size, not a scaled probe`);
console.log(`  expectedOutput       ${obs.expectedOutput}`);
console.log(`  minimumOutput        ${obs.minimumOutput}`);
console.log(`  net expected         ${netExpectedOutput(obs)}   <- fee charged once, by the family contract`);
console.log(`  net minimum          ${netMinimumOutput(obs)}`);
console.log(`  routePlanHash        ${obs.routePlanHash.slice(0, 16)}`);
console.log(`  instructionSetHash   ${(obs.instructionSetHash ?? 'none').slice(0, 16)}   <- includes isSigner/isWritable/order/ALT`);
console.log(`  instructions         ${obs.instructionCount}`);
console.log(`  computeUnitLimit     ${obs.computeUnitLimit}`);
console.log(`  estimatedBytes       ${obs.transactionBytes}`);
console.log(`  lastValidBlockHeight ${obs.lastValidBlockHeight}   <- from THIS response's blockhash`);
console.log(`  rawPayloadHash       ${(obs.rawPayloadHash ?? 'none').slice(0, 16)}`);
console.log('');
console.log(`  instructionPolicy    ${obs.instructionPolicy}`);
console.log(`  transactionPolicy    ${obs.transactionPolicy}`);
console.log(`  simulation           ${obs.simulation}`);
console.log(`  policyDetail         ${obs.policyDetail ?? 'n/a'}`);
console.log('');

const asConfigured = legIsExecutable(obs, { requireLocalSimulation: config.requireLocalSimulation });
const asEvidence = legIsConfirmatory(obs);

console.log(`  executable under this config (requireLocalSimulation=${config.requireLocalSimulation}):`);
console.log(`    ${asConfigured.ok ? 'YES' : 'NO'}${asConfigured.ok ? '' : ' — ' + asConfigured.reasons.join('; ')}`);
console.log(`  admissible as CONFIRMATORY evidence:`);
console.log(`    ${asEvidence.ok ? 'YES' : 'NO'}${asEvidence.ok ? '' : ' — ' + asEvidence.reasons.join('; ')}`);
console.log('');
console.log(`  ${obs.simulationDetail ?? ''}`);

db.close();
