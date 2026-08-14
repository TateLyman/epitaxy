/**
 * P5 — five complete buy → measured credit → sell those exact atoms → close.
 *
 * The previous proof ran ten INDEPENDENT legs, each in a fresh SVM with an
 * invented wallet. Five buys and five sells is not five round trips: nothing
 * carried the buy's post-state into the sell, so the sell spent an amount
 * nobody had acquired, out of an account nobody had created, and the rent the
 * buy paid was never the rent the sell recovered.
 *
 * Here the sell spends EXACTLY the atoms the buy was measured to credit, out of
 * the account the buy created, starting from the SOL balance the buy left. One
 * wallet, one lifecycle, one cash flow.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { resolveSimulatorToken } from '../packages/simulator/src/token.js';
import { SimulationClient } from '../packages/simulator/src/client.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { verifyEffect } from '../packages/simulator/src/effect.js';
import { associatedTokenAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../packages/solana/src/pda.js';
import { buildCloseAccount, CannotClose } from '../packages/solana/src/closeaccount.js';
import { legSpec, buildSimulationRequestForLeg } from '../packages/simulator/src/leg.js';
import { fingerprintOf } from '../packages/research/src/capability.js';
import type { SimulationResponse, ObservedTokenBalance, BalanceMutation } from '../packages/simulator/src/protocol.js';

const SOL = 'So11111111111111111111111111111111111111112';
const BUY_LAMPORTS = 20_000_000n;
const TARGET_CASES = 5;

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

const big = (v: string | null | undefined): bigint => {
  try {
    return v === null || v === undefined ? 0n : BigInt(v);
  } catch {
    return 0n;
  }
};

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

/** The taker's balance for one mint, from the structured post-state. */
function heldAfter(accounts: readonly ObservedTokenBalance[], mint: string): { atoms: bigint; account: string; program: string } | null {
  const hits = accounts.filter((a) => a.owner === taker && a.mint === mint);
  if (hits.length !== 1) return null;
  const h = hits[0];
  if (h === undefined) return null;
  return { atoms: big(h.amount), account: h.tokenAccount, program: h.tokenProgram };
}

interface CaseResult {
  mint: string;
  symbol: string;
  decimals: number | null;
  status: string;
  detail: string | null;
  entryFingerprint: string | null;
  exitFingerprint: string | null;
  acquiredAtoms: string | null;
  aboveTwoPow53: boolean;
  entryCashOutLamports: string | null;
  exitGrossCreditLamports: string | null;
  exitCashInLamports: string | null;
  baseFeesLamports: string | null;
  priorityFeesLamports: string | null;
  rentCreatedLamports: string | null;
  rentRecoveredLamports: string | null;
  residualAtoms: string | null;
  withheldAtoms: string | null;
  ataCreated: boolean;
  ataCloseBuildable: boolean;
  ataCloseReason: string | null;
  netPnlLamports: string | null;
  immediateRoundTripLossBps: number | null;
  tradingLossBps: number | null;
  entryEffectOk: boolean;
  exitEffectOk: boolean;
  refusals: string[];
}

async function runCase(mint: string, symbol: string, decimals: number | null): Promise<CaseResult> {
  const r: CaseResult = {
    mint,
    symbol,
    decimals,
    status: 'PENDING',
    detail: null,
    entryFingerprint: null,
    exitFingerprint: null,
    acquiredAtoms: null,
    aboveTwoPow53: false,
    entryCashOutLamports: null,
    exitGrossCreditLamports: null,
    exitCashInLamports: null,
    baseFeesLamports: null,
    priorityFeesLamports: null,
    rentCreatedLamports: null,
    rentRecoveredLamports: null,
    residualAtoms: null,
    withheldAtoms: null,
    ataCreated: false,
    ataCloseBuildable: false,
    ataCloseReason: null,
    netPnlLamports: null,
    immediateRoundTripLossBps: null,
    tradingLossBps: null,
    entryEffectOk: false,
    exitEffectOk: false,
    refusals: [],
  };

  // ---- 1. the exact buy the engine would send -----------------------------
  const buyBuild = await jupiter
    .build({ inputMint: SOL, outputMint: mint, amount: BUY_LAMPORTS, taker, slippageBps: 300, priority: 'risk' })
    .catch((e: unknown) => {
      r.status = 'MARKET_NO_BUY_ROUTE';
      r.detail = (e as Error).message.slice(0, 160);
      return null;
    });
  if (buyBuild === null) return r;

  // A missing blockhash is a fact about the provider's response, named rather
  // than coerced to an empty string that would fail later as something else.
  if (buyBuild.blockhash === null || buyBuild.blockhash === undefined) {
    r.status = 'MARKET_BUY_NO_BLOCKHASH';
    r.detail = 'the build response carried no blockhash';
    return r;
  }
  const buyBytes = encodeUnsignedTransaction(
    compileMessage(buyBuild.instructions, taker, buyBuild.blockhash, buyBuild.lookupTables),
  );
  const buyAccounts = [
    ...buyBuild.instructions.flatMap((i) => (i.accounts ?? []).map((a) => a.pubkey)),
    ...Object.values(buyBuild.lookupTables).flat(),
  ];
  const tokenProgram = tokenProgramFromTransaction(buyAccounts, taker, mint);
  if (tokenProgram === null) {
    r.status = 'INSTRUMENT_NO_TOKEN_PROGRAM';
    r.detail = 'neither ATA derivation appears in the buy transaction';
    return r;
  }
  const entryFp = fingerprintOf({
    routeLabels: buyBuild.routeLabels?.join(' > ') ?? '',
    programs: [...new Set(buyBuild.instructions.map((i) => i.programId))],
    tokenPrograms: [tokenProgram],
    lookupTableCount: Object.keys(buyBuild.lookupTables).length,
    simulatorFeatureSet: null,
  });
  r.entryFingerprint = entryFp;

  const buyLeg = legSpec({
    side: 'buy',
    routeFamily: 'BUILD_CUSTOM',
    capabilityFingerprint: entryFp,
    taker,
    inputMint: SOL,
    outputMint: mint,
    inputAmount: BUY_LAMPORTS,
    maxTotalPayerDebitLamports: BUY_LAMPORTS * 2n,
    inputTokenProgram: null,
    outputTokenProgram: tokenProgram,
    minimumOutput: buyBuild.otherAmountThreshold,
    expectedOutput: buyBuild.outAmount,
  });

  // A wallet with enough SOL to cover the leg, its fees and any rent. Inside a
  // throwaway SVM; not a funded mainnet account.
  const startingLamports = BUY_LAMPORTS * 10n;
  const buyRes: SimulationResponse = await sim.simulate(
    buildSimulationRequestForLeg(sim, buyLeg, {
      executionObservationId: `srt-buy-${mint.slice(0, 8)}`,
      mode: 'DEVELOPMENT_JIT',
      transactionBase64: Buffer.from(buyBytes).toString('base64'),
      originalTransactionHash: 'stateful-proof',
      originalMessageHash: 'stateful-proof',
      originalBlockhash: buyBuild.blockhash,
      originalLastValidBlockHeight: buyBuild.lastValidBlockHeight ?? null,
      targetSlot: buyBuild.contextSlot ?? null,
      snapshotManifestHash: 'jit-no-frozen-snapshot',
      snapshotAccounts: [],
      fundingLamports: startingLamports,
      contextHash: 'stateful-roundtrip-proof',
    }),
  );

  if (buyRes.status !== 'SIMULATED_OK' || buyRes.transactionError !== null) {
    r.status = 'MARKET_BUY_FAILED';
    r.detail = (buyRes.transactionError ?? buyRes.detail ?? buyRes.status).slice(0, 160);
    return r;
  }

  const buyEffect = verifyEffect(
    buildSimulationRequestForLeg(sim, buyLeg, {
      executionObservationId: `srt-buy-${mint.slice(0, 8)}`,
      mode: 'DEVELOPMENT_JIT',
      transactionBase64: Buffer.from(buyBytes).toString('base64'),
      originalTransactionHash: 'stateful-proof',
      originalMessageHash: 'stateful-proof',
      originalBlockhash: buyBuild.blockhash,
      originalLastValidBlockHeight: buyBuild.lastValidBlockHeight ?? null,
      targetSlot: buyBuild.contextSlot ?? null,
      snapshotManifestHash: 'jit-no-frozen-snapshot',
      snapshotAccounts: [],
      fundingLamports: startingLamports,
      contextHash: 'stateful-roundtrip-proof',
    }),
    buyRes,
    {
      taker,
      side: 'buy',
      inputMint: SOL,
      outputMint: mint,
      inputTokenProgram: null,
      outputTokenProgram: tokenProgram,
    },
  );
  r.entryEffectOk = buyEffect.simulatedEffectOk;
  if (!buyEffect.simulatedEffectOk) r.refusals.push(...buyEffect.refusals.map((x) => `buy: ${x}`));

  // ---- 2. THE MEASURED CREDIT --------------------------------------------
  const held = heldAfter(buyRes.postTokenAccounts, mint);
  if (held === null || held.atoms <= 0n) {
    r.status = 'INSTRUMENT_NO_MEASURED_CREDIT';
    r.detail = 'the buy post-state does not name exactly one taker account for this mint';
    return r;
  }
  r.acquiredAtoms = held.atoms.toString();
  r.aboveTwoPow53 = held.atoms > 9_007_199_254_740_992n;
  r.ataCreated = !buyRes.preTokenAccounts.some((a) => a.tokenAccount === held.account);

  const buyPostSol = big(buyRes.postSolBalances[taker]);
  const buyPreSol = big(buyRes.preSolBalances[taker]);
  r.entryCashOutLamports = (buyPreSol - buyPostSol).toString();

  // ---- 3. the sell for EXACTLY those atoms --------------------------------
  const sellBuild = await jupiter
    .build({ inputMint: mint, outputMint: SOL, amount: held.atoms, taker, slippageBps: 300, priority: 'risk' })
    .catch((e: unknown) => {
      r.status = 'MARKET_NO_SELL_ROUTE';
      r.detail = (e as Error).message.slice(0, 160);
      return null;
    });
  if (sellBuild === null) return r;

  const exitFp = fingerprintOf({
    routeLabels: sellBuild.routeLabels?.join(' > ') ?? '',
    programs: [...new Set(sellBuild.instructions.map((i) => i.programId))],
    tokenPrograms: [held.program],
    lookupTableCount: Object.keys(sellBuild.lookupTables).length,
    simulatorFeatureSet: null,
  });
  r.exitFingerprint = exitFp;

  /**
   * The close, appended to the exit rather than sent separately.
   *
   * Built BEFORE the sell is simulated, because whether it is buildable is a
   * fact about the account and the program, not about the outcome. If it
   * cannot be built the reason is recorded and the sell runs without it — the
   * rent is then genuinely locked, and the lifecycle says so.
   */
  const instructions = [...sellBuild.instructions];
  try {
    const close = buildCloseAccount({
      tokenAccount: held.account,
      destination: taker,
      owner: taker,
      tokenProgram: held.program,
      // The sell spends the ENTIRE balance, so the account is empty afterwards.
      residualAtoms: 0n,
      withheldAtoms: 0n,
    });
    instructions.push(close);
    r.ataCloseBuildable = true;
  } catch (e) {
    r.ataCloseBuildable = false;
    r.ataCloseReason = e instanceof CannotClose ? e.message.slice(0, 140) : (e as Error).message.slice(0, 140);
  }

  if (sellBuild.blockhash === null || sellBuild.blockhash === undefined) {
    r.status = 'MARKET_SELL_NO_BLOCKHASH';
    r.detail = 'the sell build response carried no blockhash';
    return r;
  }
  const sellBytes = encodeUnsignedTransaction(
    compileMessage(instructions, taker, sellBuild.blockhash, sellBuild.lookupTables),
  );

  const sellLeg = legSpec({
    side: 'sell',
    routeFamily: 'BUILD_CUSTOM',
    capabilityFingerprint: exitFp,
    taker,
    inputMint: mint,
    outputMint: SOL,
    // EXACTLY what the buy credited. Not the router's floor, not a round number.
    inputAmount: held.atoms,
    maxTotalPayerDebitLamports: 30_000_000n,
    inputTokenProgram: held.program,
    outputTokenProgram: null,
    minimumOutput: sellBuild.otherAmountThreshold,
    expectedOutput: sellBuild.outAmount,
    allowedClosedAccounts: r.ataCloseBuildable ? [held.account] : [],
  });

  /**
   * THE STATEFUL CARRY.
   *
   * The sell starts from the SOL the buy LEFT, not from a fresh wallet. That
   * one substitution is the difference between five buys plus five sells and
   * five round trips: the fees the buy paid are gone, and the sell's cash flow
   * continues the buy's rather than beginning again.
   */
  const sellCtx = {
    executionObservationId: `srt-sell-${mint.slice(0, 8)}`,
    mode: 'DEVELOPMENT_JIT' as const,
    transactionBase64: Buffer.from(sellBytes).toString('base64'),
    originalTransactionHash: 'stateful-proof',
    originalMessageHash: 'stateful-proof',
    originalBlockhash: sellBuild.blockhash,
    originalLastValidBlockHeight: sellBuild.lastValidBlockHeight ?? null,
    targetSlot: sellBuild.contextSlot ?? null,
    snapshotManifestHash: 'jit-no-frozen-snapshot',
    snapshotAccounts: [] as readonly unknown[],
    fundingLamports: buyPostSol,
    contextHash: 'stateful-roundtrip-proof',
    extraMutations: [] as readonly BalanceMutation[],
  };
  const sellReq = buildSimulationRequestForLeg(sim, sellLeg, sellCtx);
  const sellRes: SimulationResponse = await sim.simulate(sellReq);

  if (sellRes.status !== 'SIMULATED_OK' || sellRes.transactionError !== null) {
    r.status = 'MARKET_SELL_FAILED';
    r.detail = (sellRes.transactionError ?? sellRes.detail ?? sellRes.status).slice(0, 160);
    return r;
  }

  const sellEffect = verifyEffect(sellReq, sellRes, {
    taker,
    side: 'sell',
    inputMint: mint,
    outputMint: SOL,
    inputTokenProgram: held.program,
    outputTokenProgram: null,
  });
  r.exitEffectOk = sellEffect.simulatedEffectOk;
  if (!sellEffect.simulatedEffectOk) r.refusals.push(...sellEffect.refusals.map((x) => `sell: ${x}`));

  // ---- 4. residual, rent and the one cash flow ----------------------------
  const after = heldAfter(sellRes.postTokenAccounts, mint);
  r.residualAtoms = after === null ? '0' : after.atoms.toString();
  const sellPostSol = big(sellRes.postSolBalances[taker]);
  r.exitCashInLamports = (sellPostSol - buyPostSol).toString();
  r.exitGrossCreditLamports = (sellEffect.outputCredit ?? 0n).toString();

  // A null here means the quantity was NOT measured. It is reported as null
  // rather than summed as zero, which would be the model claiming knowledge it
  // does not have about a cost.
  const pair = (a: bigint | null, b: bigint | null): string | null =>
    a === null || b === null ? null : (a + b).toString();
  r.baseFeesLamports = pair(buyEffect.baseFeeLamports, sellEffect.baseFeeLamports);
  r.priorityFeesLamports = pair(buyEffect.priorityFeeLamports, sellEffect.priorityFeeLamports);
  r.rentCreatedLamports = pair(buyEffect.rentCreatedLamports, sellEffect.rentCreatedLamports);
  r.rentRecoveredLamports = pair(buyEffect.rentRecoveredLamports, sellEffect.rentRecoveredLamports);
  r.withheldAtoms = sellEffect.withheldFeeLamports === null ? null : sellEffect.withheldFeeLamports.toString();

  // ONE wallet-to-wallet flow: where the wallet started, where it ended.
  const net = sellPostSol - buyPreSol;
  r.netPnlLamports = net.toString();
  const out = buyPreSol - buyPostSol;
  r.immediateRoundTripLossBps = out <= 0n ? null : Number((-net * 10_000n) / out);

  // Rent excluded from both sides: it is capital the account holds, returned
  // when it closes, and it does not scale with the edge.
  const rentLocked = big(r.rentCreatedLamports) - big(r.rentRecoveredLamports);
  const tradingOut = out - (buyEffect.rentCreatedLamports ?? 0n);
  r.tradingLossBps = tradingOut <= 0n ? null : Number((-(net + rentLocked) * 10_000n) / tradingOut);

  /**
   * A lifecycle with an UNKNOWN money-critical cost is not complete.
   *
   * Six Token-2022 round trips returned between 5 and 22,421 lamports on a
   * 20,000,000 lamport buy — 99.9% loss — while the one legacy round trip in
   * the same batch lost 54 bps. Six independent tokens do not share that
   * outcome by coincidence; a shared unmeasured cost does.
   *
   * The transfer fee and the withheld fee were never measured on any of them.
   * Whether the 99.9% is a transfer fee, a transfer hook, or the simulator
   * failing to fetch a Token-2022 pool's state is exactly what is not known —
   * and calling it COMPLETE would file that ignorance as five valid labels.
   *
   * Unknown is not zero and unknown is not safe.
   */
  const tokenSideIs2022 =
    held.program === TOKEN_2022_PROGRAM || tokenProgram === TOKEN_2022_PROGRAM;
  const unknownCosts: string[] = [];
  if (tokenSideIs2022) {
    if (sellEffect.transferFeeLamports === null) unknownCosts.push('transfer fee not measured');
    if (sellEffect.withheldFeeLamports === null) unknownCosts.push('withheld fee not measured');
  }
  if (r.baseFeesLamports === null) unknownCosts.push('base fee not measured');
  if (r.priorityFeesLamports === null) unknownCosts.push('priority fee not measured');
  if (r.rentCreatedLamports === null) unknownCosts.push('rent created not measured');
  if (r.rentRecoveredLamports === null) unknownCosts.push('rent recovered not measured');

  if (unknownCosts.length > 0) {
    r.status = 'UNKNOWN_MONEY_CRITICAL_COST';
    r.detail = unknownCosts.join('; ');
    r.refusals.push(...unknownCosts);
    return r;
  }

  r.status = r.entryEffectOk && r.exitEffectOk ? 'COMPLETE' : 'EFFECT_REFUSED';
  return r;
}

// ---- candidates: prefer high atom counts, so one case clears 2^53 ---------
const candidates = db
  .prepare(
    `SELECT DISTINCT o.mint, COALESCE(c.symbol,'?') symbol, c.decimals
     FROM execution_observations o
     LEFT JOIN candidates c ON c.mint = o.mint
     WHERE o.side='buy' AND o.exact_transaction_blob IS NOT NULL AND o.received_utc_ms > ?
     -- P3 requires a LIVE case above 2^53 atoms. The cheapest tokens per atom
     -- are the ones that can reach it at a fixed notional, and the last
     -- observation already measured how many atoms a buy of this size bought.
     ORDER BY CAST(o.expected_output AS REAL) / NULLIF(CAST(o.requested_amount AS REAL),0) DESC,
              o.received_utc_ms DESC
     LIMIT 120`,
  )
  .all(Date.now() - 24 * 3_600_000) as { mint: string; symbol: string; decimals: number | null }[];

console.log(`${candidates.length} recent buildable candidates\n`);

const results: CaseResult[] = [];
for (const c of candidates) {
  if (results.filter((x) => x.status === 'COMPLETE').length >= TARGET_CASES) break;
  process.stdout.write(`  ${c.symbol.padEnd(10).slice(0, 10)} ${c.mint.slice(0, 10)} ... `);
  try {
    const res = await runCase(c.mint, c.symbol, c.decimals);
    results.push(res);
    console.log(
      `${res.status}${res.acquiredAtoms === null ? '' : ` acquired=${res.acquiredAtoms}${res.aboveTwoPow53 ? ' (>2^53)' : ''}`}` +
        `${res.entryCashOutLamports === null ? '' : ` out=${res.entryCashOutLamports}`}` +
        `${res.exitCashInLamports === null ? '' : ` in=${res.exitCashInLamports}`}` +
        `${res.exitGrossCreditLamports === null ? '' : ` gross=${res.exitGrossCreditLamports}`}` +
        `${res.tradingLossBps === null ? '' : ` trading=${res.tradingLossBps}bps`}` +
        `${res.refusals.length === 0 ? '' : ` | ${res.refusals.slice(0, 2).join('; ').slice(0, 150)}`}` +
        `${res.detail === null ? '' : ` | ${res.detail.slice(0, 110)}`}`,
    );
  } catch (e) {
    // A throw is not a market fact and is not silently a case. It is recorded
    // as what it is, so the denominator stays honest.
    console.log(`HARNESS_ERROR ${(e as Error).message.slice(0, 100)}`);
    results.push({
      mint: c.mint,
      symbol: c.symbol,
      decimals: c.decimals,
      status: 'INSTRUMENT_HARNESS_ERROR',
      detail: (e as Error).message.slice(0, 200),
      entryFingerprint: null,
      exitFingerprint: null,
      acquiredAtoms: null,
      aboveTwoPow53: false,
      entryCashOutLamports: null,
      exitGrossCreditLamports: null,
      exitCashInLamports: null,
      baseFeesLamports: null,
      priorityFeesLamports: null,
      rentCreatedLamports: null,
      rentRecoveredLamports: null,
      residualAtoms: null,
      withheldAtoms: null,
      ataCreated: false,
      ataCloseBuildable: false,
      ataCloseReason: null,
      netPnlLamports: null,
      immediateRoundTripLossBps: null,
      tradingLossBps: null,
      entryEffectOk: false,
      exitEffectOk: false,
      refusals: [],
    });
  }
}

const complete = results.filter((x) => x.status === 'COMPLETE');
const summary = {
  generatedUtcMs: Date.now(),
  buyLamports: BUY_LAMPORTS.toString(),
  attempted: results.length,
  complete: complete.length,
  instrumentFailures: results.filter((x) => x.status.startsWith('INSTRUMENT')).length,
  unknownCost: results.filter((x) => x.status === 'UNKNOWN_MONEY_CRITICAL_COST').length,
  marketFailures: results.filter((x) => x.status.startsWith('MARKET')).length,
  effectRefused: results.filter((x) => x.status === 'EFFECT_REFUSED').length,
  anyAboveTwoPow53: results.some((x) => x.aboveTwoPow53),
  ataCreatedAndClosed: complete.filter((x) => x.ataCreated && x.ataCloseBuildable).length,
  cases: results,
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/stateful-roundtrip-proof.json', JSON.stringify(summary, null, 2));
console.log(
  `\ncomplete ${summary.complete}/${TARGET_CASES}  unknown-cost ${summary.unknownCost}  ` +
    `instrument failures ${summary.instrumentFailures}  market ${summary.marketFailures}`,
);
console.log(`>2^53 seen: ${summary.anyAboveTwoPow53}   ATA created+closed: ${summary.ataCreatedAndClosed}`);
console.log('artifacts/stateful-roundtrip-proof.json');
db.close();
