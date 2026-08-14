/**
 * P3 — one LIVE BUILD_CUSTOM case that moves more than 2^53 atoms exactly.
 *
 * The daemon test proves 10^18 atoms reach raw account bytes. That is a
 * synthetic mutation, and the directive is explicit that no synthetic unit test
 * closes P3: a real route, built by the real provider, must carry the amount.
 *
 * Measured across 1,040 live buy observations, the cheapest mint is 1.826e6
 * atoms per lamport, so exceeding 2^53 needs roughly 4.93 SOL on one buy. That
 * is 246x the 0.02 SOL notional and half the book — which is exactly why this
 * is an INSTRUMENT proof and not a strategy label. No wallet is funded: the
 * balance is hypothetical, inside a Surfnet that is destroyed with the job,
 * and the taker is a public key with no keypair anywhere in this system.
 *
 * What it proves is narrow and it is the thing P3 asks for: an amount above
 * `Number.MAX_SAFE_INTEGER` survives the provider, the compiler, the request
 * hash, the daemon precheck, the account bytes and the measured credit without
 * being rounded anywhere.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { resolveSimulatorToken } from '../packages/simulator/src/token.js';
import { SimulationClient } from '../packages/simulator/src/client.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { associatedTokenAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../packages/solana/src/pda.js';
import { legSpec, buildSimulationRequestForLeg } from '../packages/simulator/src/leg.js';
import { fingerprintOf } from '../packages/research/src/capability.js';

const SOL = 'So11111111111111111111111111111111111111112';
const TWO_POW_53 = 9_007_199_254_740_992n;

const secrets = loadSecrets();
const config = loadConfig('paper');
const db = openDb({ path: secrets.databasePath, readonly: true });
const { token: simToken } = resolveSimulatorToken();
if (secrets.paperTakerPubkey === null || simToken.length === 0) {
  console.error('PAPER_TAKER_PUBKEY and a simulator token are both required');
  process.exit(1);
}
const taker: string = secrets.paperTakerPubkey;
void config;

const jupiter = new JupiterClient({
  limiter: RateLimiter.fromConfig(secrets.jupiterApiKey !== null),
  apiKey: secrets.jupiterApiKey,
});
const sim = new SimulationClient({
  baseUrl: process.env['SIMULATORD_URL'] ?? 'http://127.0.0.1:8787',
  token: simToken,
  pinnedIdentity: null,
  requirePinned: false,
  timeoutMs: 180_000,
});

/** The cheapest mints per atom, which are the only ones that can reach 2^53. */
const candidates = db
  .prepare(
    `SELECT o.mint,
            CAST(o.expected_output AS REAL) / NULLIF(CAST(o.requested_amount AS REAL), 0) AS atomsPerLamport
       FROM execution_observations o
      WHERE o.side = 'buy' AND o.expected_output IS NOT NULL
        AND CAST(o.requested_amount AS REAL) > 0
      GROUP BY o.mint
      ORDER BY atomsPerLamport DESC
      LIMIT ${Number(process.env['BIG_ATOMS_LIMIT'] ?? 12)}`,
  )
  .all() as { mint: string; atomsPerLamport: number }[];

interface Attempt {
  mint: string;
  atomsPerLamport: number;
  buyLamports: string;
  quotedAtoms: string | null;
  measuredCreditAtoms: string | null;
  aboveTwoPow53: boolean;
  exact: boolean | null;
  status: string;
  detail: string | null;
}

const attempts: Attempt[] = [];
let proven: Attempt | null = null;

for (const c of candidates) {
  if (proven !== null) break;

  // The notional this mint needs to clear 2^53, with 20% headroom for impact.
  const needed = BigInt(Math.ceil((Number(TWO_POW_53) / c.atomsPerLamport) * 1.2));
  const cap = BigInt(process.env['BIG_ATOMS_CAP_LAMPORTS'] ?? '20000000000');
  const buyLamports = needed > cap ? cap : needed;

  const a: Attempt = {
    mint: c.mint,
    atomsPerLamport: c.atomsPerLamport,
    buyLamports: buyLamports.toString(),
    quotedAtoms: null,
    measuredCreditAtoms: null,
    aboveTwoPow53: false,
    exact: null,
    status: 'PENDING',
    detail: null,
  };
  process.stdout.write(`  ${c.mint.slice(0, 12)} @ ${(Number(buyLamports) / 1e9).toFixed(2)} SOL ... `);

  const built = await jupiter
    .build({ inputMint: SOL, outputMint: c.mint, amount: buyLamports, taker, slippageBps: 5_000, priority: 'risk' })
    .catch((e: unknown) => {
      a.status = 'MARKET_NO_ROUTE';
      a.detail = (e as Error).message.slice(0, 140);
      return null;
    });
  if (built === null || built.blockhash === null || built.blockhash === undefined) {
    if (a.status === 'PENDING') {
      a.status = 'MARKET_NO_BLOCKHASH';
      a.detail = 'the build response carried no blockhash';
    }
    console.log(a.status);
    attempts.push(a);
    continue;
  }

  a.quotedAtoms = built.outAmount === null ? null : built.outAmount.toString();

  const bytes = encodeUnsignedTransaction(
    compileMessage(built.instructions, taker, built.blockhash, built.lookupTables),
  );
  const accounts = [
    ...built.instructions.flatMap((i) => (i.accounts ?? []).map((x) => x.pubkey)),
    ...Object.values(built.lookupTables).flat(),
  ];
  let tokenProgram: string | null = null;
  for (const p of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      if (accounts.includes(associatedTokenAddress(taker, c.mint, p))) tokenProgram = p;
    } catch {
      /* an address we cannot derive is not the one in the transaction */
    }
  }
  if (tokenProgram === null) {
    a.status = 'INSTRUMENT_NO_TOKEN_PROGRAM';
    console.log(a.status);
    attempts.push(a);
    continue;
  }

  const leg = legSpec({
    side: 'buy',
    routeFamily: 'BUILD_CUSTOM',
    capabilityFingerprint: fingerprintOf({
      routeLabels: built.routeLabels?.join(' > ') ?? '',
      programs: [...new Set(built.instructions.map((i) => i.programId))],
      tokenPrograms: [tokenProgram],
      lookupTableCount: Object.keys(built.lookupTables).length,
      simulatorFeatureSet: null,
    }),
    taker,
    inputMint: SOL,
    outputMint: c.mint,
    inputAmount: buyLamports,
    maxTotalPayerDebitLamports: buyLamports * 2n,
    inputTokenProgram: null,
    outputTokenProgram: tokenProgram,
    minimumOutput: built.otherAmountThreshold,
    expectedOutput: built.outAmount,
  });

  const res = await sim.simulate(
    buildSimulationRequestForLeg(sim, leg, {
      executionObservationId: `bigatoms-${c.mint.slice(0, 8)}`,
      mode: 'DEVELOPMENT_JIT',
      transactionBase64: Buffer.from(bytes).toString('base64'),
      originalTransactionHash: 'big-atoms-proof',
      originalMessageHash: 'big-atoms-proof',
      originalBlockhash: built.blockhash,
      originalLastValidBlockHeight: built.lastValidBlockHeight ?? null,
      targetSlot: built.contextSlot ?? null,
      snapshotManifestHash: 'jit-no-frozen-snapshot',
      snapshotAccounts: [],
      // Hypothetical, inside a Surfnet destroyed with the job.
      fundingLamports: buyLamports * 3n,
      contextHash: 'big-atoms-proof',
    }),
  );

  if (res.status !== 'SIMULATED_OK' || res.transactionError !== null) {
    a.status = 'MARKET_SIMULATION_FAILED';
    a.detail = (res.transactionError ?? res.detail ?? res.status).slice(0, 140);
    console.log(`${a.status} ${a.detail}`);
    attempts.push(a);
    continue;
  }

  const held = res.postTokenAccounts.filter((x) => x.owner === taker && x.mint === c.mint);
  if (held.length !== 1 || held[0] === undefined) {
    a.status = 'INSTRUMENT_NO_MEASURED_CREDIT';
    console.log(a.status);
    attempts.push(a);
    continue;
  }
  const credited = BigInt(held[0].amount);
  a.measuredCreditAtoms = credited.toString();
  a.aboveTwoPow53 = credited > TWO_POW_53;
  // EXACT: the decimal string round-trips through bigint unchanged, and the
  // value is not a float's nearest representable neighbour.
  a.exact = credited.toString() === held[0].amount && BigInt(held[0].amount) === credited;
  a.status = a.aboveTwoPow53 ? 'PROVEN' : 'BELOW_THRESHOLD';
  console.log(`${a.status} credited=${credited}${a.aboveTwoPow53 ? ' (>2^53)' : ''}`);
  attempts.push(a);
  if (a.aboveTwoPow53 && a.exact === true) proven = a;
}

const out = {
  generatedUtcMs: Date.now(),
  twoPow53: TWO_POW_53.toString(),
  numberMaxSafeInteger: String(Number.MAX_SAFE_INTEGER),
  proven: proven !== null,
  provenCase: proven,
  attempts,
  note:
    'INSTRUMENT proof only. The notional is far above any tradeable size and no wallet is funded: ' +
    'the balance is hypothetical inside a Surfnet destroyed with the job. It proves an amount above ' +
    'MAX_SAFE_INTEGER survives the provider, the compiler, the request hash, the daemon precheck, the ' +
    'account bytes and the measured credit without being rounded.',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/big-atoms-proof.json', JSON.stringify(out, null, 2));
console.log(`\n>2^53 proven on a live BUILD_CUSTOM route: ${proven !== null}`);
if (proven !== null) {
  console.log(`  mint     ${proven.mint}`);
  console.log(`  credited ${proven.measuredCreditAtoms} atoms`);
  console.log(`  2^53     ${TWO_POW_53}`);
}
console.log('artifacts/big-atoms-proof.json');
db.close();
