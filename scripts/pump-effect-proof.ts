import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { resolveSimulatorToken } from '../packages/simulator/src/token.js';
import { SimulationClient } from '../packages/simulator/src/client.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import { verifyEffect } from '../packages/simulator/src/effect.js';
import { associatedTokenAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../packages/solana/src/pda.js';

/**
 * `pnpm pump:effect-proof` — P6. Ten live proof cases, before any broader work.
 *
 * Five Pump buys and five Pump sells, built fresh against the chain as it is
 * right now, simulated with a setup that describes the leg, and verified for
 * economic effect.
 *
 * The point is not to produce ten passes. It is to produce ten results whose
 * failures, if any, are the market's rather than ours:
 *
 *   a failed real route is useful
 *   a failed apparatus is not
 *
 * So every case records enough to tell those apart — the exact bytes, the
 * balance mutations, every writable, the fee decomposition and the refusal
 * list. Nothing is signed and nothing is submitted; the taker is an address no
 * key exists for, funded hypothetically inside a throwaway SVM.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const secrets = loadSecrets();
const config = loadConfig();
const db = openDb({ path: secrets.databasePath, readonly: true });

const { token: simToken } = resolveSimulatorToken();
if (secrets.paperTakerPubkey === null || simToken.length === 0) {
  console.error('PAPER_TAKER_PUBKEY and a simulator token are both required; this proves nothing without them');
  process.exit(1);
}
// Bound after the guard so the type is a string from here down. The taker is a
// PUBLIC key with no keypair anywhere in this system; the daemon funds it
// hypothetically inside a throwaway SVM that is destroyed after the job.
const taker: string = secrets.paperTakerPubkey;

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

/** Pump mints seen recently, most recent first. Live routes, not fixtures. */
const candidates = (
  db
    .prepare(
      `SELECT DISTINCT mint FROM execution_observations
       WHERE route_labels LIKE '%Pump%' AND received_utc_ms > ?
       ORDER BY received_utc_ms DESC LIMIT 24`,
    )
    .all(Date.now() - 6 * 3600_000) as { mint: string }[]
).map((r) => r.mint);

if (candidates.length === 0) {
  console.error('no Pump mint observed in the last six hours; nothing current to prove against');
  process.exit(1);
}

console.log(`${candidates.length} candidate Pump mint(s)\n`);

interface ProofCase {
  side: 'buy' | 'sell';
  mint: string;
  inputAmount: string;
  tokenProgram: string;
  routeLabels: string[];
  buildable: boolean;
  runtimeStatus: string;
  transactionError: string | null;
  effectOk: boolean;
  refusals: readonly string[];
  inputDebit: string | null;
  outputCredit: string | null;
  baseFee: string | null;
  priorityFee: string | null;
  rentCreated: string | null;
  createdAccounts: readonly string[];
  closedAccounts: readonly string[];
  tokenDeltas: unknown[];
  exportOmissions: readonly string[];
  contextSlot: number | null;
  /** Ours or the market's. The distinction the whole exercise exists for. */
  classification: string;
}

/**
 * Whether a failure is the apparatus or the route.
 *
 * An instrument failure is one where the setup did not describe the leg, the
 * simulator could not answer, or a number was lost. Anything the runtime
 * decided about a real transaction on real state is the market's answer, even
 * when it is a refusal.
 */
function classify(c: Omit<ProofCase, 'classification'>): string {
  if (!c.buildable) return 'ROUTE_NOT_BUILDABLE';
  if (c.runtimeStatus === 'SIMULATOR_UNAVAILABLE' || c.runtimeStatus === 'SIMULATION_UNKNOWN') {
    return 'INSTRUMENT_SIMULATOR_UNAVAILABLE';
  }
  if (c.exportOmissions.length > 0) return 'INSTRUMENT_INCOMPLETE_CAPTURE';
  const refusals = c.refusals.join(' ');
  if (/token identity could not be resolved/.test(refusals)) return 'INSTRUMENT_TOKEN_IDENTITY';
  if (/could not be measured|delta is missing/.test(refusals) && c.runtimeStatus === 'SIMULATED_OK') {
    return 'INSTRUMENT_MISSING_OBSERVATION';
  }
  if (c.effectOk) return 'EFFECT_OK';
  if (c.transactionError !== null) return 'ROUTE_PROGRAM_REJECTION';
  return 'ROUTE_ECONOMIC_REFUSAL';
}

/**
 * Which token program a mint actually uses, decided by the transaction.
 *
 * The first version read this from a stored observation's static key list and
 * got it wrong on four of five mints: they are Token-2022 and it declared
 * legacy Token. The effect verifier then refused them, correctly — it had been
 * told to assert a program that was not the one in play, and an assertion that
 * does not hold is a refusal, not a near-enough match.
 *
 * The authoritative answer needs no RPC. An associated token address is derived
 * FROM the program, so exactly one of the two derivations appears among the
 * accounts the route compiled against. That one is the program.
 *
 * Null when neither appears, which is a real possibility (a non-associated
 * token account) and is reported rather than guessed at.
 */
function tokenProgramFromTransaction(accounts: readonly string[], owner: string, mint: string): string | null {
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      if (accounts.includes(associatedTokenAddress(owner, mint, program))) return program;
    } catch {
      /* an address we cannot derive is not the one in the transaction */
    }
  }
  return null;
}

async function proveLeg(
  side: 'buy' | 'sell',
  mint: string,
  amount: bigint,
  declaredTokenProgram: string,
): Promise<ProofCase | null> {
  const inputMint = side === 'buy' ? SOL : mint;
  const outputMint = side === 'buy' ? mint : SOL;

  const built = await jupiter.build({
    inputMint,
    outputMint,
    amount,
    taker,
    slippageBps: Math.min(config.risk.maxSlippageBps, 300),
    priority: 'risk',
  });
  if (!built.buildable) {
    console.log(`  ${side} ${mint.slice(0, 10)}  NOT BUILDABLE (${built.failure ?? '?'})`);
    return null;
  }

  if (built.blockhash === null) {
    // Refused rather than invented. A transaction compiled against a blockhash
    // we made up is not the transaction the route described.
    console.log(`  ${side} ${mint.slice(0, 10)}  build carried no blockhash`);
    return null;
  }
  const message = compileMessage(built.instructions, taker, built.blockhash, built.lookupTables);
  const bytes = encodeUnsignedTransaction(message);
  const decoded = decodeTransaction(bytes);

  // Every address the route names, including those the tables resolve.
  const allAccounts = [
    ...decoded.staticAccountKeys,
    ...Object.values(built.lookupTables).flat(),
  ];
  const tokenProgram = tokenProgramFromTransaction(allAccounts, taker, mint) ?? declaredTokenProgram;
  if (tokenProgram !== declaredTokenProgram) {
    console.log(`       token program from the transaction: ${tokenProgram.slice(0, 12)} (stored row said ${declaredTokenProgram.slice(0, 12)})`);
  }

  const mutations: { kind: 'sol' | 'token'; owner: string; mint?: string; amount: string; tokenProgram?: string }[] = [
    // A buy spends lamports and must cover the input, the fees and any rent it
    // creates. A sell spends tokens and needs SOL only for fees.
    { kind: 'sol', owner: taker, amount: side === 'buy' ? (amount * 10n).toString() : '200000000' },
  ];
  if (side === 'sell') {
    // EXACTLY the hypothetical position. More would let a sell succeed that the
    // real balance could not cover.
    mutations.push({ kind: 'token', owner: taker, mint, amount: amount.toString(), tokenProgram });
  }

  const request = sim.buildRequest({
    executionObservationId: `proof-${side}-${mint.slice(0, 8)}`,
    mode: 'DEVELOPMENT_JIT',
    transactionBase64: Buffer.from(bytes).toString('base64'),
    originalTransactionHash: 'proof',
    originalMessageHash: 'proof',
    originalBlockhash: built.blockhash,
    originalLastValidBlockHeight: built.lastValidBlockHeight ?? null,
    routeFamily: 'BUILD_CUSTOM',
    requestedAmount: amount.toString(),
    targetSlot: built.contextSlot ?? null,
    snapshotManifestHash: 'jit-no-frozen-snapshot',
    snapshotAccounts: [],
    balanceMutations: mutations,
    bounds: {
      feePayer: taker,
      maxLamportsSpent: side === 'buy' ? (amount * 2n).toString() : '30000000',
      // P3 — each side named as the asset it actually is. A token->SOL sell
      // credits native lamports, and asking `minTokenDelta` about it inspects
      // an account the trade never touches.
      inputAsset:
        side === 'buy'
          ? { kind: 'native_sol', exactDebitLamports: amount.toString(), maxTotalDebitLamports: (amount * 2n).toString() }
          : {
              kind: 'token',
              mint,
              tokenProgram,
              tokenAccount: associatedTokenAddress(taker, mint, tokenProgram),
              exactDebitAtoms: amount.toString(),
            },
      outputAsset:
        side === 'buy'
          ? {
              kind: 'token',
              mint: outputMint,
              tokenProgram,
              tokenAccount: associatedTokenAddress(taker, outputMint, tokenProgram),
              // The route's own floor, bound only when the route stated one. A
              // null threshold is an unknown and is not turned into a zero
              // minimum, which would assert that any output is acceptable.
              ...(built.otherAmountThreshold !== null && built.otherAmountThreshold > 0n
                ? { minCreditAtoms: built.otherAmountThreshold.toString() }
                : {}),
              expectedCreditAtoms: built.outAmount.toString(),
            }
          : {
              kind: 'native_sol',
              ...(built.otherAmountThreshold !== null && built.otherAmountThreshold > 0n
                ? { minCreditLamports: built.otherAmountThreshold.toString() }
                : {}),
              expectedCreditLamports: built.outAmount.toString(),
            },
      declaredTipLamports: '0',
    },
    contextHash: 'pump-effect-proof',
  });

  const res = await sim.simulate(request);
  const verdict = verifyEffect(request, res, {
    taker,
    side,
    inputMint,
    outputMint,
    inputTokenProgram: side === 'sell' ? tokenProgram : null,
    outputTokenProgram: side === 'buy' ? tokenProgram : null,
    // A sell's source account has to be opened before it can be spent, and the
    // payer carries that rent. It is our setup cost, not the market's, and
    // against a 0.02 SOL leg it is ten percent of the notional.
    provisioningRentLamports: side === 'sell' ? BigInt(res.rentCreatedLamports ?? '0') : 0n,
  });

  const partial: Omit<ProofCase, 'classification'> = {
    side,
    mint,
    inputAmount: amount.toString(),
    tokenProgram,
    routeLabels: [...built.routeLabels],
    buildable: true,
    runtimeStatus: res.status,
    transactionError: res.transactionError,
    effectOk: verdict.simulatedEffectOk,
    refusals: verdict.refusals,
    inputDebit: verdict.inputDebit === null ? null : verdict.inputDebit.toString(),
    outputCredit: verdict.outputCredit === null ? null : verdict.outputCredit.toString(),
    baseFee: verdict.baseFeeLamports?.toString() ?? null,
    priorityFee: verdict.priorityFeeLamports?.toString() ?? null,
    rentCreated: verdict.rentCreatedLamports?.toString() ?? null,
    createdAccounts: res.createdAccounts,
    closedAccounts: res.closedAccounts,
    tokenDeltas: verdict.tokenDeltas.map((d) => ({
      owner: d.owner,
      mint: d.mint,
      tokenProgram: d.tokenProgram,
      delta: d.delta === null ? null : d.delta.toString(),
      created: d.created,
      closed: d.closed,
    })),
    exportOmissions: res.exportOmissions,
    contextSlot: res.contextSlot,
  };
  void decoded;
  const c: ProofCase = { ...partial, classification: classify(partial) };

  console.log(
    `  ${side.padEnd(4)} ${mint.slice(0, 10)} ${String(built.routeLabels.join('>')).slice(0, 16).padEnd(16)} ` +
      `${res.status.padEnd(18)} effect=${c.effectOk ? 'OK ' : 'NO '} ${c.classification}`,
  );
  if (!c.effectOk) for (const r of verdict.refusals.slice(0, 2)) console.log(`         ${r.slice(0, 96)}`);
  return c;
}

const cases: ProofCase[] = [];
const BUY_LAMPORTS = 20_000_000n;

for (const mint of candidates) {
  if (cases.filter((c) => c.side === 'buy').length >= 5 && cases.filter((c) => c.side === 'sell').length >= 5) break;

  // Which token program this mint actually uses, read from a stored
  // observation's account list rather than assumed.
  const keys = db
    .prepare(
      `SELECT static_account_keys FROM execution_observations
       WHERE mint = ? AND static_account_keys IS NOT NULL ORDER BY received_utc_ms DESC LIMIT 1`,
    )
    .get(mint) as { static_account_keys: string } | undefined;
  let parsed: string[] = [];
  try {
    parsed = JSON.parse(keys?.static_account_keys ?? '[]') as string[];
  } catch {
    parsed = [];
  }
  const tokenProgram = parsed.includes(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;

  if (cases.filter((c) => c.side === 'buy').length < 5) {
    const buy = await proveLeg('buy', mint, BUY_LAMPORTS, tokenProgram).catch((e: unknown) => {
      console.log(`  buy  ${mint.slice(0, 10)}  ERROR ${(e as Error).message.slice(0, 60)}`);
      return null;
    });
    if (buy !== null) cases.push(buy);
  }

  if (cases.filter((c) => c.side === 'sell').length < 5) {
    // The sell is at the amount a buy of the same size would acquire, so the
    // pair is a round trip rather than two unrelated trades.
    const quote = await jupiter
      .build({ inputMint: SOL, outputMint: mint, amount: BUY_LAMPORTS, taker, slippageBps: 300, priority: 'risk' })
      .catch(() => null);
    const held = quote?.buildable === true && quote.outAmount > 0n ? quote.outAmount : null;
    if (held !== null) {
      const sell = await proveLeg('sell', mint, held, tokenProgram).catch((e: unknown) => {
        console.log(`  sell ${mint.slice(0, 10)}  ERROR ${(e as Error).message.slice(0, 60)}`);
        return null;
      });
      if (sell !== null) cases.push(sell);
    }
  }
}

const buys = cases.filter((c) => c.side === 'buy');
const sells = cases.filter((c) => c.side === 'sell');
const instrumentFailures = cases.filter((c) => c.classification.startsWith('INSTRUMENT_'));
const effectOk = cases.filter((c) => c.effectOk);

console.log(`\n  buys        ${buys.length}   effect-ok ${buys.filter((c) => c.effectOk).length}`);
console.log(`  sells       ${sells.length}   effect-ok ${sells.filter((c) => c.effectOk).length}`);
console.log(`  effect OK   ${effectOk.length}/${cases.length}`);
console.log(`  INSTRUMENT failures ${instrumentFailures.length}  (required: 0)`);
for (const c of instrumentFailures) console.log(`    ${c.side} ${c.mint.slice(0, 10)} ${c.classification}`);

const byClass = new Map<string, number>();
for (const c of cases) byClass.set(c.classification, (byClass.get(c.classification) ?? 0) + 1);
console.log('\n  by classification:');
for (const [k, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(34)} ${n}`);

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/pump-effect-proof.json',
  `${JSON.stringify(
    {
      generatedUtcMs: Date.now(),
      taker,
      buyLamports: BUY_LAMPORTS.toString(),
      counts: {
        buys: buys.length,
        sells: sells.length,
        effectOk: effectOk.length,
        instrumentFailures: instrumentFailures.length,
      },
      cases,
    },
    null,
    2,
  )}\n`,
);
console.log('\nwrote artifacts/pump-effect-proof.json');
db.close();
