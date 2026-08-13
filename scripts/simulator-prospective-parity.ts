import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { resolveSimulatorToken } from '../packages/simulator/src/token.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import { SimulationClient } from '../packages/simulator/src/client.js';
import { compareRuns } from '../packages/simulator/src/parity-compare.js';
import { verifyEffect, type EffectContext } from '../packages/simulator/src/effect.js';
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
// Resolved from the supervisor's token file, so the credential never has to
// pass through a shell, an argument list or a log line.
const { token: TOKEN, source: TOKEN_SOURCE } = resolveSimulatorToken();

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
console.log(`simulator: ${JSON.stringify(health)} (token from ${TOKEN_SOURCE})`);

const common = {
  transactionBase64: txBase64,
  originalTransactionHash: createHash('sha256').update(bytes).digest('hex'),
  originalMessageHash: createHash('sha256').update(decoded.messageBytes).digest('hex'),
  originalBlockhash: built.blockhash,
  originalLastValidBlockHeight: built.lastValidBlockHeight,
  routeFamily: 'BUILD_CUSTOM',
  requestedAmount: AMOUNT.toString(),
  targetSlot: null,
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
console.log(`  contextSlot       ${jit.contextSlot ?? 'unknown'}`);
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
  // Stand where the JIT run stood. Without this the replay sits at slot 33 of a
  // fresh chain and refuses to resolve any lookup table extended since.
  targetSlot: jit.contextSlot,
  snapshotManifestHash: manifest,
  snapshotAccounts: snapshot,
});
// The snapshot carries program code, so the request is large. Printed because
// a body limit is a thing you want to see coming rather than discover as a
// timeout with no status.
const requestBytes = Buffer.byteLength(JSON.stringify(offlineReq));
console.log(`  request size      ${(requestBytes / 1024 / 1024).toFixed(1)} MiB`);
const offline = await client.simulate(offlineReq);
console.log(`  status            ${offline.status}`);
console.log(`  error             ${offline.transactionError ?? 'none'}`);
console.log(`  unitsConsumed     ${offline.unitsConsumed}`);
console.log(`  startup/sim       ${offline.startupMs}ms / ${offline.simulateMs}ms`);
console.log(`  detail            ${offline.detail}`);
for (const l of offline.logs.slice(0, 6)) console.log(`    | ${l}`);

/**
 * The leg both runs describe. One object, used for both, so a difference in the
 * verdicts cannot come from having described the trade two different ways.
 */
const effectCtx: EffectContext = { taker, side: 'buy', inputMint: SOL, outputMint: OUTPUT };

// ------------------------------------------------- P4.12 the ECONOMIC effects
//
// Byte-level parity and economic parity are different questions, and the
// difference matters here: redeploying a program from its ELF does not preserve
// the program account's lamports, so full-state parity can never hold while the
// restore works that way. That is our mechanism, not a divergence in what the
// transaction did.
//
// What must agree is the EFFECT: the same success or failure, the same debit,
// the same credit, the same fees and rent, the same bounds outcome, and the
// same accounts created and closed. Those are computed by the same verifier the
// engine uses, so a difference here is a difference the engine would act on.
const jitEffect = verifyEffect(jitReq, jit, effectCtx);
const offlineEffect = verifyEffect(offlineReq, offline, effectCtx);

const effectFields: readonly (readonly [string, string, string])[] = [
  ['simulatedEffectOk', String(jitEffect.simulatedEffectOk), String(offlineEffect.simulatedEffectOk)],
  ['RUNTIME_OK', String(jitEffect.checks.RUNTIME_OK), String(offlineEffect.checks.RUNTIME_OK)],
  ['EFFECT_OK', String(jitEffect.checks.EFFECT_OK), String(offlineEffect.checks.EFFECT_OK)],
  ['FEE_DECOMPOSITION_OK', String(jitEffect.checks.FEE_DECOMPOSITION_OK), String(offlineEffect.checks.FEE_DECOMPOSITION_OK)],
  ['ACCOUNT_COVERAGE_OK', String(jitEffect.checks.ACCOUNT_COVERAGE_OK), String(offlineEffect.checks.ACCOUNT_COVERAGE_OK)],
  ['inputDebit', String(jitEffect.inputDebit), String(offlineEffect.inputDebit)],
  ['outputCredit', String(jitEffect.outputCredit), String(offlineEffect.outputCredit)],
  ['baseFee', String(jitEffect.baseFeeLamports), String(offlineEffect.baseFeeLamports)],
  ['priorityFee', String(jitEffect.priorityFeeLamports), String(offlineEffect.priorityFeeLamports)],
  ['rentCreated', String(jitEffect.rentCreatedLamports), String(offlineEffect.rentCreatedLamports)],
  ['rentRecovered', String(jitEffect.rentRecoveredLamports), String(offlineEffect.rentRecoveredLamports)],
  ['boundsViolations', JSON.stringify(jitEffect.boundsViolations), JSON.stringify(offlineEffect.boundsViolations)],
  ['createdAccounts', JSON.stringify([...jit.createdAccounts].sort()), JSON.stringify([...offline.createdAccounts].sort())],
  ['closedAccounts', JSON.stringify([...jit.closedAccounts].sort()), JSON.stringify([...offline.closedAccounts].sort())],
  ['transactionError', String(jit.transactionError), String(offline.transactionError)],
];
const effectDiffs = effectFields.filter(([, a, b]) => a !== b).map(([field, a, b]) => ({ field, jit: a, offline: b }));

/**
 * Compute units, against a frozen tolerance.
 *
 * The two runs are the same transaction on the same state, so a difference is
 * the runtime's own accounting and not the trade's. It is bounded rather than
 * required to be zero, and the bound is frozen here so that widening it is an
 * edit somebody has to make on purpose.
 */
const UNITS_TOLERANCE_BPS = 10;
const jitUnits = jit.unitsConsumed ?? 0;
const offlineUnits = offline.unitsConsumed ?? 0;
const unitsDriftBps =
  jitUnits === 0 ? null : Math.round((Math.abs(offlineUnits - jitUnits) / jitUnits) * 10_000);
const unitsWithinTolerance = unitsDriftBps !== null && unitsDriftBps <= UNITS_TOLERANCE_BPS;

console.log('\n--- economic effect parity (P4.12) ---');
for (const [field, a, b] of effectFields) {
  const same = a === b;
  console.log(`  ${same ? ' ' : '!'} ${field.padEnd(22)} jit=${a.slice(0, 28).padEnd(28)} offline=${b.slice(0, 28)}`);
}
console.log(
  `  ${unitsWithinTolerance ? ' ' : '!'} unitsConsumed          jit=${jitUnits} offline=${offlineUnits} ` +
    `drift=${unitsDriftBps ?? 'n/a'}bps tolerance=${UNITS_TOLERANCE_BPS}bps`,
);

const effectParity = effectDiffs.length === 0 && unitsWithinTolerance;
console.log(`\n  economic effect parity  ${effectParity ? 'AGREES' : 'DIFFERS'}`);
if (!effectParity && effectDiffs.length === 0) {
  console.log('  the effects agree; only the compute accounting drifted past its frozen tolerance');
}

/**
 * P4 -- the slot interval, recorded rather than fabricated.
 *
 * Jupiter often omits `contextSlot`. A later-state simulation can model
 * decision latency and must never be called same-slot truth, so the interval is
 * written down and the drift is named.
 */
const slots = {
  buildContextSlot: built.contextSlot ?? null,
  jitContextSlot: jit.contextSlot ?? null,
  offlineTargetSlot: offlineReq.targetSlot ?? null,
  maxObservedDriftSlots:
    built.contextSlot != null && jit.contextSlot != null ? Math.abs(jit.contextSlot - built.contextSlot) : null,
  sameSlotTruth: built.contextSlot != null && jit.contextSlot != null && built.contextSlot === jit.contextSlot,
};
console.log('\n--- slot interval ---');
console.log(`  build contextSlot   ${slots.buildContextSlot ?? 'not reported by the provider'}`);
console.log(`  JIT contextSlot     ${slots.jitContextSlot ?? 'unknown'}`);
console.log(`  offline targetSlot  ${slots.offlineTargetSlot ?? 'none'}`);
console.log(`  max observed drift  ${slots.maxObservedDriftSlots ?? 'not computable'} slot(s)`);
console.log(`  same-slot truth     ${slots.sameSlotTruth ? 'YES' : 'NO — this models decision latency, not same-slot truth'}`);

// --------------------------------------------------------------- the verdict
const verdict = compareRuns(jit, offline);
console.log(`\n--- parity ---`);
console.log(`  EXECUTION agrees  ${verdict.executionAgrees ? 'YES' : 'NO'}   (status, error, units, logs, fees, rent, created/closed)`);
for (const d of verdict.executionDiffs) console.log(`    ! ${d.field}: jit=${d.jit.slice(0, 70)} offline=${d.offline.slice(0, 70)}`);
console.log(`  full state agrees ${verdict.agrees ? 'YES' : 'NO'}`);
console.log(`  program-account balance diffs (deploy does not preserve lamports): ${verdict.programAccountDiffs.length}`);
for (const d of verdict.diffs.slice(0, 25)) {
  console.log(`    ${d.field}: jit=${d.jit.slice(0, 60)} offline=${d.offline.slice(0, 60)}`);
}
if (verdict.diffs.length > 25) console.log(`    ... and ${verdict.diffs.length - 25} more`);
for (const d of verdict.disqualifiers) console.log(`  DISQUALIFIED      ${d}`);

// Execution parity is the claim. Full-state parity is reported and not claimed,
// because the differences in it are ours -- a redeploy rewriting a program
// account's balance -- and cannot change what the transaction did.
const established = verdict.executionAgrees && verdict.disqualifiers.length === 0;
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
      executionAgrees: verdict.executionAgrees,
      executionDiffs: verdict.executionDiffs,
      programAccountDiffs: verdict.programAccountDiffs.length,
      diffs: verdict.diffs.slice(0, 50),
      disqualifiers: verdict.disqualifiers,
      executionParityEstablished: established,
      // P4.12 -- the comparison that decides whether an offline replay may
      // stand in for a JIT run as evidence about a trade.
      effectParity: {
        agrees: effectParity,
        diffs: effectDiffs,
        unitsDriftBps,
        unitsToleranceBps: UNITS_TOLERANCE_BPS,
        unitsWithinTolerance,
        jit: { simulatedEffectOk: jitEffect.simulatedEffectOk, refusals: jitEffect.refusals },
        offline: { simulatedEffectOk: offlineEffect.simulatedEffectOk, refusals: offlineEffect.refusals },
      },
      slots,
    },
    null,
    2,
  )}\n`,
);
console.log('  wrote artifacts/simulator-parity.json');
process.exitCode = established ? 0 : 1;
