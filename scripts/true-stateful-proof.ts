/**
 * P2 — a Pump/PumpSwap lifecycle in ONE local market state.
 *
 * The shape a linked pair of JIT requests cannot have:
 *
 *   1. capture the current pool, its vaults, and the programs' actual ELF
 *   2. run the buy in the local runtime — it COMMITS
 *   3. read the token balance and the POST-BUY POOL from that runtime
 *   4. price and build the sell against THAT pool, for exactly the credited atoms
 *   5. run buy then sell in one runtime, so the sell EXECUTES on what the buy left
 *   6. one wallet-to-wallet cash flow
 *
 * Steps 3–4 are the whole point, and they are why this cannot use Jupiter for
 * the exit. A router builds against current mainnet. It cannot price a pool
 * that a hypothetical buy just moved, so its sell would be chosen against
 * pre-buy depth — the exact linked-leg defect the runtime exists to remove.
 * The sell is therefore built by the official PumpSwap builder fed from the
 * runtime's own committed bytes.
 *
 * The two sell quotes — one against pre-buy reserves, one against post-buy —
 * are both recorded. Their difference is the self-impact a fresh-state sell
 * silently ignores, and it is a measurement rather than an argument.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { captureSnapshot } from '../packages/solana/src/snapshot-capture.js';
import { runSequential, tokenAmountOf, createdAccountRent } from '../packages/simulator/src/sequential-runtime.js';
import type { ObservedAccount, SequentialStepResult } from '../packages/simulator/src/sequential-runtime.js';
import { associatedTokenAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../packages/solana/src/pda.js';
import {
  accountSourceOf,
  overlaySource,
  buildSellFrom,
  quoteSellFrom,
  poolAddressesFrom,
  canonicalPool,
  swapAccountAddresses,
  associatedTokenAddressOf,
  OfflineStateIncomplete,
  WSOL_MINT,
  GLOBAL_CONFIG_ADDR,
  FEE_CONFIG_ADDR,
} from '../packages/solana/src/pumpswap-offline.js';
import { buildCloseAccount } from '../packages/solana/src/closeaccount.js';
import { classifyRoundTrip, selfImpactBps } from '../packages/domain/src/statefulness.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';
import type { RawInstruction } from '../packages/solana/src/instructionpolicy.js';
import type { TransactionInstruction } from '@solana/web3.js';

const SOL = WSOL_MINT;
const BUY_LAMPORTS = BigInt(process.env['TRUE_STATEFUL_LAMPORTS'] ?? '20000000');
const TARGET = Number(process.env['TRUE_STATEFUL_TARGET'] ?? 10);
const SLIPPAGE_PCT = 3;

const secrets = loadSecrets();
const config = loadConfig('paper');
const db = openDb({ path: secrets.databasePath, readonly: true });
if (secrets.paperTakerPubkey === null || secrets.rpcHttp === null) {
  console.error('PAPER_TAKER_PUBKEY and an RPC endpoint are both required');
  process.exit(1);
}
const taker: string = secrets.paperTakerPubkey;
const { rpc, host: rpcHost, overridden } = researchRpc(secrets);
console.log(`endpoint ${rpcHost}${overridden ? ' (explicit override)' : ''}`);
const jupiter = new JupiterClient({
  limiter: RateLimiter.fromConfig(secrets.jupiterApiKey !== null),
  apiKey: secrets.jupiterApiKey,
});
void config;

/** web3.js instruction → the shape our encoder speaks. */
function toRaw(ix: TransactionInstruction): RawInstruction {
  return {
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data).toString('base64'),
  };
}

interface Case {
  mint: string;
  status: string;
  detail: string | null;
  pool: string | null;
  programsLoaded: number;
  snapshotAccounts: number;
  buyStatus: string | null;
  sellStatus: string | null;
  acquiredAtoms: string | null;
  /** THE property: the sell's own pool bytes changed between pre and post buy. */
  buyMutatedSellPool: boolean | null;
  poolBaseBefore: string | null;
  poolBaseAfterBuy: string | null;
  poolQuoteBefore: string | null;
  poolQuoteAfterBuy: string | null;
  /** What a pre-buy-state sell would have quoted for the same atoms. */
  sellQuotePreBuyState: string | null;
  /** What the true post-buy state quotes. The difference is self-impact. */
  sellQuotePostBuyState: string | null;
  selfImpactLamports: string | null;
  selfImpactBps: number | null;
  walletBeforeBuy: string | null;
  walletAfterBuy: string | null;
  walletAfterSell: string | null;
  closeStatus: string | null;
  residualAtomsAfterSell: string | null;
  walletAfterClose: string | null;
  recoveredRentLamports: string | null;
  /** Accounts the legs had to CREATE, and what their rent cost. */
  createdAccounts: { pubkey: string; rentLamports: string; excessLamports: string }[];
  setupRentLamports: string | null;
  /** Buy debit above the principal: entry rent, base fee, priority, tip. */
  buyOverheadLamports: string | null;
  /**
   * Offline quote MINUS what the sell actually credited.
   *
   * A parity measurement, not a cost: when nothing new had to be created it
   * is exactly the 5,000 lamport base fee, which says the offline model
   * priced the post-buy pool to the lamport.
   */
  sellQuoteVsRealizedLamports: string | null;
  /** Quoted proceeds minus principal: the AMM round trip with no fees at all. */
  ammDragLamports: string | null;
  ammDragBps: number | null;
  /** Decided by rule, from what the exit was priced from and executed on. */
  evidenceClass: string | null;
  evidenceReasons: string[];
  /** The same round trip on a mint whose shared accounts already exist. */
  repeatTradeNetLamports: string | null;
  repeatTradeLossBps: number | null;
  roundTripNetLamports: string | null;
  roundTripLossBps: number | null;
  notes: string[];
}

const candidates = db
  .prepare(
    `SELECT DISTINCT o.mint
       FROM execution_observations o
      WHERE o.side = 'buy' AND o.exact_transaction_blob IS NOT NULL
        AND o.received_utc_ms > ?
      ORDER BY o.received_utc_ms DESC
      LIMIT 400`,
  )
  .all(Date.now() - 7 * 86_400_000) as { mint: string }[];

console.log(`${candidates.length} candidates, target ${TARGET} lifecycles, ${BUY_LAMPORTS} lamports\n`);

const cases: Case[] = [];
let fixtureWritten = false;
const sha = (a: readonly ObservedAccount[], p: string): string | null =>
  a.find((x) => x.pubkey === p)?.dataSha256 ?? null;
const amt = (a: readonly ObservedAccount[], p: string): bigint | null => {
  const found = a.find((x) => x.pubkey === p);
  return found === undefined ? null : tokenAmountOf(found);
};

for (const c of candidates) {
  if (cases.filter((x) => x.status === 'COMPLETE').length >= TARGET) break;

  const r: Case = {
    mint: c.mint,
    status: 'PENDING',
    detail: null,
    pool: null,
    programsLoaded: 0,
    snapshotAccounts: 0,
    buyStatus: null,
    sellStatus: null,
    acquiredAtoms: null,
    buyMutatedSellPool: null,
    poolBaseBefore: null,
    poolBaseAfterBuy: null,
    poolQuoteBefore: null,
    poolQuoteAfterBuy: null,
    sellQuotePreBuyState: null,
    sellQuotePostBuyState: null,
    selfImpactLamports: null,
    selfImpactBps: null,
    walletBeforeBuy: null,
    walletAfterBuy: null,
    walletAfterSell: null,
    closeStatus: null,
    residualAtomsAfterSell: null,
    walletAfterClose: null,
    recoveredRentLamports: null,
    createdAccounts: [],
    setupRentLamports: null,
    buyOverheadLamports: null,
    sellQuoteVsRealizedLamports: null,
    ammDragLamports: null,
    ammDragBps: null,
    evidenceClass: null,
    evidenceReasons: [],
    repeatTradeNetLamports: null,
    repeatTradeLossBps: null,
    roundTripNetLamports: null,
    roundTripLossBps: null,
    notes: [],
  };
  process.stdout.write(`  ${c.mint.slice(0, 12)} ... `);
  const fail = (status: string, detail?: string): void => {
    r.status = status;
    if (detail !== undefined) r.detail = detail.slice(0, 160);
    console.log(`${status}${detail === undefined ? '' : ` ${detail.slice(0, 90)}`}`);
    cases.push(r);
  };

  // ---- 1. the canonical PumpSwap pool the SELL will use -------------------
  // Checked FIRST, and deliberately: it is one account read, it eliminates
  // every mint still on the bonding curve, and finding that out after a
  // Jupiter build spent a rate-limited request to learn it.
  const pool = canonicalPool(c.mint);
  r.pool = pool;
  let baseVault: string;
  let quoteVault: string;
  let coinCreator: string;
  try {
    const poolRaw = await rpc.getAccountRaw(pool);
    const addrs = poolAddressesFrom(
      accountSourceOf([
        { pubkey: pool, owner: poolRaw.owner, dataBase64: poolRaw.dataBase64, lamports: poolRaw.lamports },
      ]),
      pool,
    );
    baseVault = addrs.poolBaseTokenAccount;
    quoteVault = addrs.poolQuoteTokenAccount;
    coinCreator = addrs.coinCreator;
  } catch (e) {
    fail('MARKET_NO_CANONICAL_POOL', (e as Error).message);
    continue;
  }

  // ---- 2. the exact buy, from production's own builder --------------------
  const buy = await jupiter
    .build({ inputMint: SOL, outputMint: c.mint, amount: BUY_LAMPORTS, taker, slippageBps: 300, priority: 'risk' })
    .catch((e: unknown) => {
      r.detail = (e as Error).message.slice(0, 120);
      return null;
    });
  if (buy === null) {
    fail('MARKET_NO_BUY_ROUTE', r.detail ?? undefined);
    continue;
  }
  if (buy.blockhash === null || buy.blockhash === undefined) {
    fail('MARKET_NO_BLOCKHASH', 'the build response carried no blockhash');
    continue;
  }

  const buyBytes = Buffer.from(
    encodeUnsignedTransaction(compileMessage(buy.instructions, taker, buy.blockhash, buy.lookupTables)),
  ).toString('base64');

  const routeAccounts = [
    ...buy.instructions.flatMap((i) => (i.accounts ?? []).map((a) => a.pubkey)),
    ...Object.values(buy.lookupTables).flat(),
  ];
  let tokenProgram: string | null = null;
  for (const p of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      if (routeAccounts.includes(associatedTokenAddress(taker, c.mint, p))) tokenProgram = p;
    } catch {
      /* undecodable is not the program in the transaction */
    }
  }
  if (tokenProgram === null) {
    fail('INSTRUMENT_NO_TOKEN_PROGRAM');
    continue;
  }
  const takerAta = associatedTokenAddress(taker, c.mint, tokenProgram);
  const takerWsol = associatedTokenAddressOf(taker, WSOL_MINT, TOKEN_PROGRAM);

  // ---- 3. capture, including every account the SELL will touch ------------
  let snapshot;
  try {
    snapshot = await captureSnapshot(rpc, [buyBytes], {
      extraAccounts: [
        taker,
        takerAta,
        takerWsol,
        // The TABLES, not only the addresses inside them. A v0 message names
        // its lookup tables by address and the runtime has to READ each one to
        // resolve any account through it; capturing only the resolved contents
        // produced `AddressLookupTableNotFound` on every routed buy.
        ...Object.keys(buy.lookupTables),
        ...Object.values(buy.lookupTables).flat(),
        baseVault,
        quoteVault,
        ...swapAccountAddresses({ poolKey: pool, baseMint: c.mint, user: taker, coinCreator }),
      ],
      extraPrograms: [...new Set(buy.instructions.map((i) => i.programId))],
    });
  } catch (e) {
    fail('INSTRUMENT_SNAPSHOT_FAILED', (e as Error).message);
    continue;
  }
  r.snapshotAccounts = snapshot.accounts.length;
  r.notes.push(...snapshot.notes.slice(0, 3));
  if (snapshot.programs.length === 0) {
    fail('INSTRUMENT_NO_PROGRAM_ELF', snapshot.notes.slice(0, 2).join('; '));
    continue;
  }

  // A hypothetical wallet inside a runtime that is destroyed with the job.
  const withWallet = [
    ...snapshot.accounts.map((a) => (a.pubkey === taker ? { ...a, lamports: BUY_LAMPORTS * 20n } : a)),
    ...(snapshot.accounts.some((a) => a.pubkey === taker)
      ? []
      : [
          {
            pubkey: taker,
            dataBase64: '',
            owner: '11111111111111111111111111111111',
            lamports: BUY_LAMPORTS * 20n,
            executable: false,
            rentEpoch: 0n,
          },
        ]),
  ];

  // Everything the sell needs to be priced and built from the committed state.
  const observe = [
    ...new Set([
      taker,
      takerAta,
      takerWsol,
      pool,
      baseVault,
      quoteVault,
      c.mint,
      ...swapAccountAddresses({ poolKey: pool, baseMint: c.mint, user: taker, coinCreator }),
    ]),
  ];

  // ---- 4. pass one: run the buy and READ what it left --------------------
  const runOnce = (
    steps: { label: string; transactionBase64: string; observe: readonly string[] }[],
  ): { steps: readonly SequentialStepResult[]; programs: number; notes: readonly string[] } | null => {
    try {
      const run = runSequential({
        jobId: `true-stateful-${c.mint.slice(0, 8)}-${steps.length}`,
        snapshot: {
          programs: snapshot.programs.map((p) => ({ programId: p.programId, elfBase64: p.elfBase64 })),
          accounts: withWallet,
          slot: snapshot.slot,
          unixTimestamp: snapshot.unixTimestamp,
        },
        steps,
        timeoutMs: 240_000,
      });
      return { steps: run.steps, programs: run.programsLoaded.length, notes: run.incompleteness };
    } catch (e) {
      r.detail = (e as Error).message.slice(0, 160);
      return null;
    }
  };

  const pass1 = runOnce([{ label: 'buy', transactionBase64: buyBytes, observe }]);
  if (pass1 === null) {
    fail('INSTRUMENT_RUNTIME_FAILED', r.detail ?? undefined);
    continue;
  }
  r.programsLoaded = pass1.programs;
  r.notes.push(...pass1.notes.slice(0, 3));
  const buyStep = pass1.steps[0];
  r.buyStatus = buyStep?.status ?? 'MISSING';
  if (buyStep === undefined || buyStep.status !== 'SIMULATED_OK') {
    fail('BUY_FAILED_IN_RUNTIME', buyStep?.transactionError ?? 'no result');
    continue;
  }

  const acquiredAcct = buyStep.postAccounts.find((a) => a.pubkey === takerAta);
  const acquired = acquiredAcct === undefined ? null : tokenAmountOf(acquiredAcct);
  r.acquiredAtoms = acquired === null ? null : acquired.toString();
  r.walletBeforeBuy = String(buyStep.preAccounts.find((a) => a.pubkey === taker)?.lamports ?? '');
  r.walletAfterBuy = String(buyStep.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? '');
  if (acquired === null || acquired <= 0n) {
    fail('NO_MEASURED_CREDIT', 'the buy committed but credited no tokens');
    continue;
  }

  // Did the buy actually move the pool the sell will use? A route that landed
  // on some other venue leaves the canonical pool untouched, and a "stateful"
  // claim over an untouched pool is vacuous.
  const preSha = sha(buyStep.preAccounts, baseVault);
  const postSha = sha(buyStep.postAccounts, baseVault);
  r.buyMutatedSellPool = preSha !== null && postSha !== null ? preSha !== postSha : null;
  r.poolBaseBefore = String(amt(buyStep.preAccounts, baseVault) ?? '');
  r.poolBaseAfterBuy = String(amt(buyStep.postAccounts, baseVault) ?? '');
  r.poolQuoteBefore = String(amt(buyStep.preAccounts, quoteVault) ?? '');
  r.poolQuoteAfterBuy = String(amt(buyStep.postAccounts, quoteVault) ?? '');

  // ---- 5. price and build the sell FROM the committed post-buy state -----
  const preSrc = accountSourceOf(snapshot.accounts);
  const postSrc = overlaySource(preSrc, accountSourceOf(buyStep.postAccounts));

  let built;
  try {
    const qPre = quoteSellFrom(preSrc, pool, acquired, SLIPPAGE_PCT);
    const qPost = quoteSellFrom(postSrc, pool, acquired, SLIPPAGE_PCT);
    r.sellQuotePreBuyState = qPre.quoteOutLamports.toString();
    r.sellQuotePostBuyState = qPost.quoteOutLamports.toString();
    r.selfImpactLamports = (qPre.quoteOutLamports - qPost.quoteOutLamports).toString();
    r.selfImpactBps = selfImpactBps(qPre.quoteOutLamports, qPost.quoteOutLamports);

    built = await buildSellFrom(postSrc, { poolKey: pool, user: taker, baseAtoms: acquired, slippagePct: SLIPPAGE_PCT });
  } catch (e) {
    fail(
      e instanceof OfflineStateIncomplete ? 'INSTRUMENT_SELL_STATE_INCOMPLETE' : 'INSTRUMENT_SELL_BUILD_FAILED',
      (e as Error).message,
    );
    continue;
  }

  const sellBytes = Buffer.from(
    encodeUnsignedTransaction(compileMessage(built.instructions.map(toRaw), taker, buy.blockhash, {})),
  ).toString('base64');

  /**
   * The CLOSE, which is not optional accounting.
   *
   * Only the BASE account. The official sell already appends its own
   * `CloseAccount` on the wrapped-SOL side whenever the quote mint is native,
   * so the proceeds arrive unwrapped and a second close hits an account that no
   * longer exists — measured, as `InstructionError(0, InvalidAccountData)`, not
   * assumed. What the sell does NOT do is recover the rent the entry locked in
   * the base ATA, and that rent is real capital until the account is closed.
   */
  const closeIxs = [
    buildCloseAccount({
      tokenAccount: takerAta,
      destination: taker,
      owner: taker,
      tokenProgram,
      residualAtoms: 0n,
      withheldAtoms: 0n,
    }),
  ];
  const closeBytes = Buffer.from(
    encodeUnsignedTransaction(compileMessage(closeIxs, taker, buy.blockhash, {})),
  ).toString('base64');

  // ---- 6. pass two: buy THEN sell THEN close, in one committed state ------
  const sellObserve = [...new Set([...observe, ...built.accounts])];
  const pass2 = runOnce([
    { label: 'buy', transactionBase64: buyBytes, observe },
    { label: 'sell', transactionBase64: sellBytes, observe: sellObserve },
    { label: 'close', transactionBase64: closeBytes, observe: sellObserve },
  ]);
  if (pass2 === null) {
    fail('INSTRUMENT_RUNTIME_FAILED', r.detail ?? undefined);
    continue;
  }
  const sellStep = pass2.steps[1];
  r.sellStatus = sellStep?.status ?? 'MISSING';
  if (sellStep === undefined || sellStep.status !== 'SIMULATED_OK') {
    fail('SELL_FAILED_IN_RUNTIME', sellStep?.transactionError ?? 'no result');
    continue;
  }
  const before = BigInt(pass2.steps[0]?.preAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0);
  const afterSell = BigInt(sellStep.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0);
  r.walletAfterSell = afterSell.toString();

  const residual = amt(sellStep.postAccounts, takerAta);
  r.residualAtomsAfterSell = residual === null ? null : residual.toString();

  const closeStep = pass2.steps[2];
  r.closeStatus = closeStep?.status ?? 'MISSING';
  if (closeStep === undefined || closeStep.status !== 'SIMULATED_OK') {
    fail('CLOSE_FAILED_IN_RUNTIME', closeStep?.transactionError ?? 'no result');
    continue;
  }
  const after = BigInt(closeStep.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0);
  r.walletAfterClose = after.toString();
  r.recoveredRentLamports = (after - afterSell).toString();
  const net = after - before;

  /**
   * What the round trip paid ONCE rather than every time.
   *
   * At this notional the dominant cost is not the spread and not the fee: it
   * is rent on accounts that did not exist yet — the wrapped-SOL account, the
   * coin-creator fee vault, the user volume accumulator. A first trade on a
   * mint pays for all of them and a second trade on the same mint pays for
   * none, so quoting one number for "the cost of a round trip" describes
   * neither. An account is counted as created when it held nothing before the
   * sequence and holds lamports after it, which is a measurement of these
   * runs rather than a list of names this script expects.
   */
  const created = createdAccountRent(sellStep, [taker]);
  r.createdAccounts = created.accounts;
  const setupRent = created.lamports;
  r.setupRentLamports = setupRent.toString();

  const afterBuy = BigInt(r.walletAfterBuy === '' ? '0' : r.walletAfterBuy);
  r.buyOverheadLamports = (before - afterBuy - BUY_LAMPORTS).toString();
  const quoted = BigInt(r.sellQuotePostBuyState ?? '0');
  r.sellQuoteVsRealizedLamports = (quoted - (afterSell - afterBuy)).toString();
  const drag = quoted - BUY_LAMPORTS;
  r.ammDragLamports = drag.toString();
  r.ammDragBps = BUY_LAMPORTS > 0n ? Number((-drag * 10_000n) / BUY_LAMPORTS) : null;
  const repeat = net + setupRent;
  r.repeatTradeNetLamports = repeat.toString();
  r.repeatTradeLossBps = BUY_LAMPORTS > 0n ? Number((-repeat * 10_000n) / BUY_LAMPORTS) : null;
  r.roundTripNetLamports = net.toString();
  r.roundTripLossBps = BUY_LAMPORTS > 0n ? Number((-net * 10_000n) / BUY_LAMPORTS) : null;
  /**
   * The classification, by rule.
   *
   * Stamped from what actually happened in this run rather than asserted by the
   * name of the file: the exit was priced from the committed post-buy accounts
   * and executed as step 2 of the same runtime, and whether the buy moved the
   * pool the sell used was measured on the vault bytes.
   */
  const cls = classifyRoundTrip({
    entryCommitted: true,
    exitCommitted: true,
    exitPricedFrom: 'COMMITTED_PRIOR_STEP',
    exitExecutedOn: 'COMMITTED_PRIOR_STEP',
    entryMutatedExitVenue: r.buyMutatedSellPool,
  });
  r.evidenceClass = cls.evidenceClass;
  r.evidenceReasons = [...cls.reasons];

  /**
   * The first complete case leaves a fixture behind.
   *
   * Real PumpSwap bytes — pool, both vaults, mint, global config, fee config —
   * at their pre-buy AND post-buy values, so the self-impact property can be
   * re-derived by a unit test with no network, no runtime and no key. A test
   * that has to reach the chain to check an invariant is a test that stops
   * running the first time the chain is slow.
   */
  if (fixtureWritten === false) {
    const wanted = [pool, baseVault, quoteVault, c.mint, GLOBAL_CONFIG_ADDR, FEE_CONFIG_ADDR];
    const pre = snapshot.accounts
      .filter((a) => wanted.includes(a.pubkey))
      .map((a) => ({ pubkey: a.pubkey, owner: a.owner, dataBase64: a.dataBase64, lamports: a.lamports.toString() }));
    const post = (pass2.steps[0]?.postAccounts ?? [])
      .filter((a) => wanted.includes(a.pubkey))
      .map((a) => ({ pubkey: a.pubkey, owner: a.owner, dataBase64: a.dataBase64, lamports: String(a.lamports) }));
    if (pre.length >= 4 && post.length >= 4) {
      mkdirSync('tests/fixtures', { recursive: true });
      writeFileSync(
        'tests/fixtures/pumpswap-selfimpact.json',
        JSON.stringify(
          {
            note:
              'Captured by scripts/true-stateful-proof.ts. preBuy is mainnet at the snapshot slot; ' +
              'postBuy is the committed post-state of the buy inside the sequential runtime.',
            mint: c.mint,
            pool,
            baseVault,
            quoteVault,
            buyLamports: BUY_LAMPORTS.toString(),
            acquiredAtoms: acquired.toString(),
            preBuy: pre,
            postBuy: post,
          },
          null,
          2,
        ),
      );
      fixtureWritten = true;
    }
  }

  r.status = 'COMPLETE';
  console.log(
    `COMPLETE net=${net} loss=${r.roundTripLossBps}bps selfImpact=${r.selfImpactBps}bps mutated=${r.buyMutatedSellPool}`,
  );
  cases.push(r);
}

const complete = cases.filter((x) => x.status === 'COMPLETE');
const summary = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'schema-v30',
    sampleInclusionQuery: 'execution_observations, side=buy, exact blob present, last 12h',
  }),
  buyLamports: BUY_LAMPORTS.toString(),
  slippagePct: SLIPPAGE_PCT,
  attempted: cases.length,
  complete: complete.length,
  buysCommitted: cases.filter((x) => x.buyStatus === 'SIMULATED_OK').length,
  sellsCommitted: cases.filter((x) => x.sellStatus === 'SIMULATED_OK').length,
  closesCommitted: cases.filter((x) => x.closeStatus === 'SIMULATED_OK').length,
  buyMutatedSellPool: cases.filter((x) => x.buyMutatedSellPool === true).length,
  apparatusFailures: cases.filter((x) => x.status.startsWith('INSTRUMENT')).length,
  marketFailures: cases.filter((x) => x.status.startsWith('MARKET')).length,
  medianSelfImpactBps: median(complete.map((x) => x.selfImpactBps).filter((n): n is number => n !== null)),
  medianRoundTripLossBps: median(complete.map((x) => x.roundTripLossBps).filter((n): n is number => n !== null)),
  medianRepeatTradeLossBps: median(
    complete.map((x) => x.repeatTradeLossBps).filter((n): n is number => n !== null),
  ),
  medianAmmDragBps: median(complete.map((x) => x.ammDragBps).filter((n): n is number => n !== null)),
  /** How many sells the offline model priced to within the base fee. */
  sellsPricedToTheBaseFee: complete.filter((x) => x.sellQuoteVsRealizedLamports === '5000').length,
  medianSetupRentLamports: median(
    complete.map((x) => (x.setupRentLamports === null ? null : Number(x.setupRentLamports))).filter(
      (n): n is number => n !== null,
    ),
  ),
  trueSequentialRoundTrips: complete.filter((x) => x.evidenceClass === 'TRUE_SEQUENTIAL_ROUND_TRIP').length,
  cases,
  note:
    'The sell is priced AND built from the runtime post-buy account bytes, through the official ' +
    'PumpSwap builder, and executes as step 2 of one committed sequence. selfImpactBps is what a ' +
    'pre-buy-state sell would have over-reported for the same atoms.',
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/true-stateful-roundtrip-proof.json', JSON.stringify(summary, null, 2));

console.log(`\nattempted ${summary.attempted}  complete ${summary.complete}`);
console.log(`buys ${summary.buysCommitted}  sells ${summary.sellsCommitted}  pool mutated ${summary.buyMutatedSellPool}`);
console.log(`median self-impact ${summary.medianSelfImpactBps} bps  median round-trip loss ${summary.medianRoundTripLossBps} bps`);
console.log(`median AMM drag ${summary.medianAmmDragBps} bps  sells priced to the base fee ${summary.sellsPricedToTheBaseFee}/${summary.complete}`);
console.log('artifacts/true-stateful-roundtrip-proof.json');
db.close();
