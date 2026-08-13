import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import { SimulationClient } from '../packages/simulator/src/client.js';
import { resolveSimulatorToken } from '../packages/simulator/src/token.js';

/**
 * `pnpm simulator:crosscheck` — §7.4.
 *
 * Run the SAME unsigned transaction through two independent simulators: the
 * local Surfpool SVM in WSL, and mainnet's own `simulateTransaction`. If they
 * disagree about whether it executes and what it consumes, one of them is
 * wrong, and the one we built is the likelier candidate.
 *
 * This is the only check available that does not depend on our own code being
 * right. Fee parity compares our arithmetic against settled outcomes; offline
 * replay compares our simulator against itself. This compares it against an
 * implementation nobody here can influence.
 *
 * IMPORTANT LIMITATION, and it is the whole reason the verdict is hedged.
 * Mainnet simulates against the chain as it is at that instant, and the local
 * SVM fetched its state moments earlier. A memecoin pool moves between the two
 * calls. So a disagreement on OUTPUT AMOUNTS is expected and means little; a
 * disagreement on whether the transaction executes at all, or on which program
 * failed, is the signal.
 *
 * Read-only. sigVerify is false, nothing is signed, nothing is submitted.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OUTPUT = process.env['CROSSCHECK_MINT'] ?? USDC;
const AMOUNT = BigInt(process.env['CROSSCHECK_LAMPORTS'] ?? '20000000');
const RPC = process.env['SOLANA_RPC_HTTP'] ?? 'https://api.mainnet-beta.solana.com';

const secrets = loadSecrets();
const taker = secrets.paperTakerPubkey;
if (taker === null) {
  console.log('PAPER_TAKER_PUBKEY is unset; there is no address to build for.');
  process.exit(2);
}

const jup = new JupiterClient({
  limiter: RateLimiter.fromConfig(secrets.jupiterApiKey !== null),
  apiKey: secrets.jupiterApiKey,
});

async function rpc(method: string, params: unknown[]): Promise<Record<string, unknown> | null> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: Record<string, unknown>; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result ?? null;
}

console.log(`building ${AMOUNT} lamports SOL -> ${OUTPUT.slice(0, 8)}`);
const built = await jup.build({ inputMint: SOL, outputMint: OUTPUT, amount: AMOUNT, taker });
if (!built.buildable || built.blockhash === null) {
  console.log(`NOT BUILDABLE (${built.failure ?? 'no blockhash'}); no route means no cross-check`);
  process.exit(2);
}

const bytes = encodeUnsignedTransaction(
  compileMessage(built.instructions, taker, built.blockhash, built.lookupTables),
);
const txBase64 = Buffer.from(bytes).toString('base64');
const decoded = decodeTransaction(bytes);
console.log(`compiled ${bytes.length} bytes, route ${built.routeLabels.join('+')}\n`);

// ------------------------------------------------------------------ mainnet
const mainnetRaw = (await rpc('simulateTransaction', [
  txBase64,
  { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' },
])) as { context?: { slot?: number }; value?: Record<string, unknown> } | null;
const mainnet = mainnetRaw?.value ?? null;
const mainnetSlot = mainnetRaw?.context?.slot ?? null;
const mainnetErr = mainnet?.['err'] ?? null;
const mainnetUnits = typeof mainnet?.['unitsConsumed'] === 'number' ? (mainnet['unitsConsumed'] as number) : null;
const mainnetLogs = Array.isArray(mainnet?.['logs']) ? (mainnet['logs'] as string[]) : [];
console.log(`mainnet   slot=${mainnetSlot ?? '?'} err=${JSON.stringify(mainnetErr)} units=${mainnetUnits}`);

/**
 * Did mainnet refuse before executing anything, because of the WALLET?
 *
 * Measured: an unfunded taker gives `AccountNotFound` with zero units and no
 * logs — mainnet cannot even load the fee payer, let alone run the route. An
 * account with SOL but not enough gives `InsufficientFunds`. Both are facts
 * about the wallet and neither says anything about the route.
 *
 * This is not a failure of the cross-check. It is the reason the local SVM
 * exists: mainnet cannot simulate a position this system has deliberately never
 * funded, and a paper engine that could only test routes it had already paid
 * for would not be a paper engine.
 */
const err = JSON.stringify(mainnetErr ?? '');
const refusedOnWallet = err.includes('InsufficientFunds') || err.includes('AccountNotFound');
if (refusedOnWallet) {
  console.log(
    '          mainnet refused before executing: the taker is unfunded, so this is a fact about the wallet\n' +
      '          and the cross-check is NOT ESTABLISHABLE for this transaction.',
  );
}

// -------------------------------------------------------------------- local
const { token } = resolveSimulatorToken();
if (token.length === 0) {
  console.log('\nno simulator token; cannot cross-check');
  process.exit(2);
}
const client = new SimulationClient({
  baseUrl: process.env['SIMULATORD_URL'] ?? 'http://127.0.0.1:8787',
  token,
  pinnedIdentity: null,
  requirePinned: false,
  timeoutMs: 180_000,
});

const req = client.buildRequest({
  executionObservationId: 'crosscheck',
  mode: 'DEVELOPMENT_JIT',
  transactionBase64: txBase64,
  originalTransactionHash: createHash('sha256').update(bytes).digest('hex'),
  originalMessageHash: createHash('sha256').update(decoded.messageBytes).digest('hex'),
  originalBlockhash: built.blockhash,
  originalLastValidBlockHeight: built.lastValidBlockHeight,
  routeFamily: 'BUILD_CUSTOM',
  requestedAmount: AMOUNT.toString(),
  targetSlot: mainnetSlot,
  snapshotManifestHash: 'jit-no-frozen-snapshot',
  snapshotAccounts: [],
  balanceMutations: [{ kind: 'sol', owner: taker, amount: (AMOUNT * 10n).toString() }],
  bounds: { feePayer: taker, maxLamportsSpent: (AMOUNT * 2n).toString() },
  contextHash: null,
});
const local = await client.simulate(req);
console.log(`local     status=${local.status} err=${local.transactionError ?? 'none'} units=${local.unitsConsumed}`);

// ----------------------------------------------------------------- compare
/** Programs invoked, in order. The structural fact both sides can agree on. */
function invoked(logs: readonly string[]): string[] {
  return logs
    .map((l) => /^Program (\S+) invoke \[1\]$/.exec(l)?.[1])
    .filter((p): p is string => p !== undefined);
}
const mainnetPrograms = invoked(mainnetLogs);
const localPrograms = invoked(local.logs);

const agreements: [string, boolean, string][] = [];

// Everything below is only a COMPARISON when mainnet actually ran the thing.
// Scoring an inability as a disagreement would report a defect in the simulator
// on every single run, and a check that always fails is a check nobody reads.
if (refusedOnWallet) {
  console.log('\ncross-check: NOT ESTABLISHABLE');
  console.log('  mainnet never executed the route, so there is nothing to compare against.');
  console.log(`  local ran it: status=${local.status}, ${local.unitsConsumed ?? '?'} units, ${localPrograms.length} top-level programs.`);
  console.log('  This is the expected result for an unfunded taker and is not a simulator defect.');
} else {
  agreements.push(
    [
      'both simulators accepted the transaction structurally',
      mainnetLogs.length > 0 && local.logs.length > 0,
      `mainnet ${mainnetLogs.length} log lines, local ${local.logs.length}`,
    ],
    [
      'the same top-level programs were invoked, in the same order',
      JSON.stringify(mainnetPrograms) === JSON.stringify(localPrograms),
      `mainnet [${mainnetPrograms.join(', ')}] local [${localPrograms.join(', ')}]`,
    ],
    [
      'both agree on whether it executes',
      (mainnetErr === null) === (local.status === 'SIMULATED_OK'),
      `mainnet err=${JSON.stringify(mainnetErr)} local=${local.status}`,
    ],
  );
  // Guarded on a NON-ZERO mainnet figure. Comparing against zero units divides
  // by zero and passes trivially, which is how a broken check looks green.
  if (mainnetUnits !== null && mainnetUnits > 0 && local.unitsConsumed !== null) {
    const pct = (Math.abs(mainnetUnits - local.unitsConsumed) / mainnetUnits) * 100;
    agreements.push([
      'compute units agree within 5%',
      pct <= 5,
      `mainnet ${mainnetUnits}, local ${local.unitsConsumed}, ${pct.toFixed(1)}% apart`,
    ]);
  }

  console.log('\ncross-check:');
  for (const [name, ok, detail] of agreements) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`        ${detail}`);
    if (!ok) process.exitCode = 1;
  }
}

console.log(
  '\nNote: mainnet simulates against the chain at that instant and the local SVM fetched its state moments\n' +
    'earlier, so output amounts legitimately differ. A disagreement about whether it EXECUTES, or about which\n' +
    'program ran, is the signal worth acting on.',
);

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/simulator-crosscheck.json',
  `${JSON.stringify(
    {
      takenAtUtcMs: Date.now(),
      route: built.routeLabels,
      packetBytes: bytes.length,
      mainnet: { slot: mainnetSlot, err: mainnetErr, unitsConsumed: mainnetUnits, programs: mainnetPrograms },
      local: { status: local.status, err: local.transactionError, unitsConsumed: local.unitsConsumed, programs: localPrograms },
      mainnetRefusedOnWallet: refusedOnWallet,
      crossCheckEstablishable: !refusedOnWallet,
      agreements: agreements.map(([name, ok, detail]) => ({ name, ok, detail })),
    },
    null,
    2,
  )}\n`,
);
console.log('wrote artifacts/simulator-crosscheck.json');
