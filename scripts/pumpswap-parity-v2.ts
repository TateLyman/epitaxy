/**
 * P14 — parity beyond five buy quotes at one size.
 *
 * What the previous matrix proved: five buys, one 0.02 SOL notional, current
 * `Pump.fun Amm` routes, a local wrapper over the official SDK. What it did not
 * prove is most of what a production family needs — sells, other sizes, and
 * whether the number the model produces is the number the chain produces.
 *
 * Four independent sources per cell, so a disagreement names its own side:
 *
 *   SDK_OVER_RPC       the official SDK reading mainnet through our RPC
 *   OFFLINE_MODEL      the same SDK reading a captured account SET
 *   RUNTIME_EXECUTED   what the transaction ACTUALLY moved in the runtime
 *   JUPITER_BENCHMARK  the router's own expected output
 *
 * The first two agreeing tests our account extraction. The second and third
 * agreeing tests the model against execution, which is the one that matters:
 * a quote nobody executes is an opinion. Jupiter is a benchmark and is allowed
 * to differ — it may route elsewhere entirely, and when it does that is a fact
 * about the route, not a parity failure.
 *
 * Nothing here grades itself. It reports residuals in bps and a residual is
 * either zero or it is not.
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
import { quoteBuy, quoteSell, PUMPSWAP_SDK_VERSION } from '../packages/solana/src/pumpswap-model.js';
import {
  accountSourceOf,
  overlaySource,
  quoteBuyFrom,
  quoteSellFrom,
  buildBuyFrom,
  buildSellFrom,
  poolAddressesFrom,
  poolFactsFrom,
  canonicalPool,
  swapAccountAddresses,
  associatedTokenAddressOf,
  SWAP_PROGRAM_IDS,
  WSOL_MINT,
} from '../packages/solana/src/pumpswap-offline.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';
import type { RawInstruction } from '../packages/solana/src/instructionpolicy.js';
import type { TransactionInstruction } from '@solana/web3.js';

/** The preregistered size grid. Chosen before any result, and not revised after. */
const SIZES: readonly bigint[] = [1_000_000n, 2_500_000n, 5_000_000n, 10_000_000n, 20_000_000n, 40_000_000n];
const SLIPPAGE_PCT = 3;
const TARGET_MINTS = Number(process.env['PARITY_MINTS'] ?? 4);

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

function toRaw(ix: TransactionInstruction): RawInstruction {
  return {
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data).toString('base64'),
  };
}

const bps = (a: bigint, b: bigint): number | null => (b === 0n ? null : Number(((a - b) * 10_000n) / b));

interface Cell {
  mint: string;
  pool: string;
  side: 'buy' | 'sell';
  sizeLamports: string;
  baseTokenProgram: string | null;
  quoteMint: string | null;
  virtualQuoteReserves: string | null;
  feeConfigPresent: boolean | null;
  /** The four sources. Null is "not obtained", never zero. */
  sdkOverRpc: string | null;
  offlineModel: string | null;
  runtimeExecuted: string | null;
  jupiterBenchmark: string | null;
  offlineVsSdkBps: number | null;
  runtimeVsOfflineBps: number | null;
  jupiterVsOfflineBps: number | null;
  /** Rent the leg had to pay to open accounts that did not exist. */
  setupRentLamports: string | null;
  createdAccounts: string[];
  /** Lamports those accounts received beyond their rent - a fee, not a cost to us. */
  createdAccountExcessLamports: string | null;
  status: string;
  detail: string | null;
}

/**
 * An explicit mint list, for closing a named coverage gap.
 *
 * The default scan takes whatever is recent, which is how the matrix ended up
 * entirely Token-2022 and entirely bottom-tier. `parity-coverage` finds the
 * mints that fill a specific cell and they are passed in by name, so the
 * selection is a reviewable artifact rather than a hidden filter.
 */
const explicitList = (process.env['PARITY_MINTS_LIST'] ?? '').split(',').filter((x) => x.length > 0);
const candidates = explicitList.length > 0
  ? explicitList.map((mint) => ({ mint }))
  : db
  .prepare(
    `SELECT DISTINCT o.mint FROM execution_observations o
      WHERE o.side = 'buy' AND o.exact_transaction_blob IS NOT NULL AND o.received_utc_ms > ?
      ORDER BY o.received_utc_ms DESC LIMIT 400`,
  )
  .all(Date.now() - 7 * 86_400_000) as { mint: string }[];

const cells: Cell[] = [];
const mintsDone: string[] = [];

console.log(`${candidates.length} candidates, ${SIZES.length} sizes x 2 sides, target ${TARGET_MINTS} mints\n`);

for (const c of candidates) {
  if (mintsDone.length >= TARGET_MINTS) break;

  const pool = canonicalPool(c.mint);
  let addrs;
  try {
    const raw = await rpc.getAccountRaw(pool);
    addrs = poolAddressesFrom(
      accountSourceOf([{ pubkey: pool, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports }]),
      pool,
    );
  } catch (e) {
    // A silent continue here is indistinguishable from "this mint has no pool",
    // and a rate-limited read looks exactly like a bonding-curve token.
    console.log(`${c.mint.slice(0, 12)}  skipped: ${(e as Error).message.slice(0, 80)}`);
    continue;
  }
  console.log(`${c.mint.slice(0, 12)}  pool ${pool.slice(0, 10)}`);

  // ---- one capture per mint, reused by every size ------------------------
  const takerAtaLegacy = associatedTokenAddressOf(taker, c.mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const takerAta2022 = associatedTokenAddressOf(taker, c.mint, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const takerWsol = associatedTokenAddressOf(taker, WSOL_MINT, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  const wanted = [
    taker,
    takerAtaLegacy,
    takerAta2022,
    takerWsol,
    addrs.poolBaseTokenAccount,
    addrs.poolQuoteTokenAccount,
    ...swapAccountAddresses({
      poolKey: pool,
      baseMint: c.mint,
      user: taker,
      coinCreator: addrs.coinCreator,
    }),
  ];

  let snapshot;
  try {
    snapshot = await captureSnapshot(rpc, [], {
      extraAccounts: wanted,
      extraPrograms: [...SWAP_PROGRAM_IDS],
    });
  } catch (e) {
    console.log(`  INSTRUMENT_SNAPSHOT_FAILED ${(e as Error).message.slice(0, 80)}`);
    continue;
  }
  if (snapshot.programs.length === 0) {
    console.log('  INSTRUMENT_NO_PROGRAM_ELF');
    continue;
  }

  const preSrc = accountSourceOf(snapshot.accounts);
  let facts;
  try {
    facts = poolFactsFrom(preSrc, pool);
  } catch (e) {
    console.log(`  INSTRUMENT_POOL_INCOMPLETE ${(e as Error).message.slice(0, 80)}`);
    continue;
  }
  const takerAta = associatedTokenAddressOf(taker, c.mint, facts.baseTokenProgram);
  const observe = [...new Set([...wanted, takerAta, pool])];

  const fundedAccounts = [
    ...snapshot.accounts.map((a) => (a.pubkey === taker ? { ...a, lamports: 4_000_000_000n } : a)),
    ...(snapshot.accounts.some((a) => a.pubkey === taker)
      ? []
      : [
          {
            pubkey: taker,
            dataBase64: '',
            owner: '11111111111111111111111111111111',
            lamports: 4_000_000_000n,
            executable: false,
            rentEpoch: 0n,
          },
        ]),
  ];

  let anyCell = false;
  for (const size of SIZES) {
    const buyCell: Cell = {
      mint: c.mint,
      pool,
      side: 'buy',
      sizeLamports: size.toString(),
      baseTokenProgram: facts.baseTokenProgram,
      quoteMint: facts.quoteMint,
      virtualQuoteReserves: facts.virtualQuoteReserves.toString(),
      feeConfigPresent: null,
      sdkOverRpc: null,
      offlineModel: null,
      runtimeExecuted: null,
      jupiterBenchmark: null,
      offlineVsSdkBps: null,
      runtimeVsOfflineBps: null,
      jupiterVsOfflineBps: null,
      setupRentLamports: null,
      createdAccounts: [],
      createdAccountExcessLamports: null,
      status: 'PENDING',
      detail: null,
    };

    // 1. the official SDK over the RPC.
    //
    // Once per mint, at the first size only. This arm re-reads five accounts
    // per call and running it across the whole grid earned HTTP 429 rather than
    // a second opinion; what it is actually testing is whether our CAPTURE
    // equals a fresh read, which one size answers as well as six.
    if (size === SIZES[0]) {
      try {
        const q = await quoteBuy(rpc, pool, size, SLIPPAGE_PCT);
        buyCell.sdkOverRpc = q.baseOutAtoms.toString();
        buyCell.feeConfigPresent = q.feeConfigPresent;
      } catch (e) {
        buyCell.detail = `sdk: ${(e as Error).message.slice(0, 90)}`;
      }
    }

    // 2. the same SDK over the captured account set
    let offlineBuyAtoms: bigint | null = null;
    try {
      const q = quoteBuyFrom(preSrc, pool, size, SLIPPAGE_PCT);
      offlineBuyAtoms = q.baseOutAtoms;
      buyCell.offlineModel = q.baseOutAtoms.toString();
    } catch (e) {
      buyCell.detail = `${buyCell.detail ?? ''} offline: ${(e as Error).message.slice(0, 90)}`;
    }
    if (buyCell.sdkOverRpc !== null && offlineBuyAtoms !== null) {
      buyCell.offlineVsSdkBps = bps(offlineBuyAtoms, BigInt(buyCell.sdkOverRpc));
    }

    // 3. what the transaction actually moves, in the runtime
    let postSrc = preSrc;
    let executedAtoms: bigint | null = null;
    if (offlineBuyAtoms !== null && offlineBuyAtoms > 0n) {
      try {
        const built = await buildBuyFrom(preSrc, { poolKey: pool, user: taker, quoteLamports: size, slippagePct: SLIPPAGE_PCT });
        const bytes = Buffer.from(
          encodeUnsignedTransaction(
            compileMessage(built.instructions.map(toRaw), taker, '11111111111111111111111111111111', {}),
          ),
        ).toString('base64');
        const run = runSequential({
          jobId: `parity-${c.mint.slice(0, 8)}-b${size}`,
          snapshot: {
            programs: snapshot.programs.map((p) => ({ programId: p.programId, elfBase64: p.elfBase64 })),
            accounts: fundedAccounts,
            slot: snapshot.slot,
            unixTimestamp: snapshot.unixTimestamp,
          },
          steps: [{ label: 'buy', transactionBase64: bytes, observe }],
          timeoutMs: 180_000,
        });
        const step = run.steps[0];
        if (step !== undefined && step.status === 'SIMULATED_OK') {
          const post = step.postAccounts.find((a) => a.pubkey === takerAta);
          const pre = step.preAccounts.find((a) => a.pubkey === takerAta);
          const after = post === undefined ? null : tokenAmountOf(post);
          const before = pre === undefined ? 0n : (tokenAmountOf(pre) ?? 0n);
          executedAtoms = after === null ? null : after - before;
          buyCell.runtimeExecuted = executedAtoms === null ? null : executedAtoms.toString();
          postSrc = overlaySource(preSrc, accountSourceOf(step.postAccounts));
        } else {
          buyCell.detail = `${buyCell.detail ?? ''} runtime: ${(step?.transactionError ?? 'no result').slice(0, 80)}`;
        }
      } catch (e) {
        buyCell.detail = `${buyCell.detail ?? ''} runtime: ${(e as Error).message.slice(0, 80)}`;
      }
    }
    if (executedAtoms !== null && offlineBuyAtoms !== null) {
      buyCell.runtimeVsOfflineBps = bps(executedAtoms, offlineBuyAtoms);
    }

    // 4. the router, as a benchmark that is allowed to disagree
    try {
      const q = await jupiter.quote({ inputMint: WSOL_MINT, outputMint: c.mint, amount: size, slippageBps: 300 });
      buyCell.jupiterBenchmark = q.outAmount.toString();
      if (offlineBuyAtoms !== null) buyCell.jupiterVsOfflineBps = bps(q.outAmount, offlineBuyAtoms);
    } catch (e) {
      buyCell.detail = `${buyCell.detail ?? ''} jupiter: ${(e as Error).message.slice(0, 60)}`;
    }

    buyCell.status = buyCell.runtimeExecuted !== null ? 'MEASURED' : 'PARTIAL';
    cells.push(buyCell);
    anyCell = anyCell || buyCell.status === 'MEASURED';
    console.log(
      `    buy  ${String(size).padStart(9)}  offline/sdk ${buyCell.offlineVsSdkBps}bps  runtime/offline ${buyCell.runtimeVsOfflineBps}bps  jup/offline ${buyCell.jupiterVsOfflineBps}bps`,
    );

    // ---- the SELL, of exactly what the buy credited, against the buy state --
    if (executedAtoms === null || executedAtoms <= 0n) continue;
    const sellCell: Cell = {
      ...buyCell,
      side: 'sell',
      sizeLamports: executedAtoms.toString(),
      sdkOverRpc: null,
      offlineModel: null,
      runtimeExecuted: null,
      jupiterBenchmark: null,
      offlineVsSdkBps: null,
      runtimeVsOfflineBps: null,
      jupiterVsOfflineBps: null,
      setupRentLamports: null,
      createdAccounts: [],
      createdAccountExcessLamports: null,
      status: 'PENDING',
      detail: null,
    };

    // The SDK over RPC prices against the PRE-buy pool, because that is all an
    // RPC has. Recorded, and its gap to the offline post-buy figure is the
    // self-impact a fresh-state exit cannot see.
    if (size === SIZES[0]) {
      try {
        const q = await quoteSell(rpc, pool, executedAtoms, SLIPPAGE_PCT);
        sellCell.sdkOverRpc = q.quoteOutLamports.toString();
      } catch (e) {
        sellCell.detail = `sdk: ${(e as Error).message.slice(0, 90)}`;
      }
    }

    let offlineSellOut: bigint | null = null;
    try {
      const q = quoteSellFrom(postSrc, pool, executedAtoms, SLIPPAGE_PCT);
      offlineSellOut = q.quoteOutLamports;
      sellCell.offlineModel = q.quoteOutLamports.toString();
      sellCell.feeConfigPresent = q.feeConfigPresent;
    } catch (e) {
      sellCell.detail = `${sellCell.detail ?? ''} offline: ${(e as Error).message.slice(0, 90)}`;
    }
    if (sellCell.sdkOverRpc !== null && offlineSellOut !== null) {
      sellCell.offlineVsSdkBps = bps(offlineSellOut, BigInt(sellCell.sdkOverRpc));
    }

    if (offlineSellOut !== null) {
      try {
        const buyBuilt = await buildBuyFrom(preSrc, { poolKey: pool, user: taker, quoteLamports: size, slippagePct: SLIPPAGE_PCT });
        const buyBytes = Buffer.from(
          encodeUnsignedTransaction(
            compileMessage(buyBuilt.instructions.map(toRaw), taker, '11111111111111111111111111111111', {}),
          ),
        ).toString('base64');
        const sellBuilt = await buildSellFrom(postSrc, {
          poolKey: pool,
          user: taker,
          baseAtoms: executedAtoms,
          slippagePct: SLIPPAGE_PCT,
        });
        const sellBytes = Buffer.from(
          encodeUnsignedTransaction(
            compileMessage(sellBuilt.instructions.map(toRaw), taker, '11111111111111111111111111111111', {}),
          ),
        ).toString('base64');
        const run = runSequential({
          jobId: `parity-${c.mint.slice(0, 8)}-s${size}`,
          snapshot: {
            programs: snapshot.programs.map((p) => ({ programId: p.programId, elfBase64: p.elfBase64 })),
            accounts: fundedAccounts,
            slot: snapshot.slot,
            unixTimestamp: snapshot.unixTimestamp,
          },
          steps: [
            { label: 'buy', transactionBase64: buyBytes, observe },
            // The sell's OWN account list, not just the ones this script knew
            // to ask for. The two accounts it opens on the way — and their
            // 2,044,221 lamports each — were invisible to a fixed observe list,
            // which reported the resulting shortfall as a pricing error that
            // scaled from 1,045 bps to 41,818 bps purely with the denominator.
            { label: 'sell', transactionBase64: sellBytes, observe: [...new Set([...observe, ...sellBuilt.accounts])] },
          ],
          timeoutMs: 240_000,
        });
        const step = run.steps[1];
        if (step !== undefined && step.status === 'SIMULATED_OK') {
          const before = BigInt(step.preAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0);
          const after = BigInt(step.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0);
          // What the POOL paid, recovered from what the payer's balance did:
          // the base fee and the rent on accounts this step had to open are
          // both real costs and neither is a pricing error.
          const created = createdAccountRent(step, [taker]);
          sellCell.setupRentLamports = created.lamports.toString();
          sellCell.createdAccounts = created.accounts.map((a) => a.pubkey);
          sellCell.createdAccountExcessLamports = created.accounts
            .reduce((t, a) => t + BigInt(a.excessLamports), 0n)
            .toString();
          const realized = after - before + 5_000n + created.lamports;
          sellCell.runtimeExecuted = realized.toString();
          sellCell.runtimeVsOfflineBps = bps(realized, offlineSellOut);
        } else {
          sellCell.detail = `${sellCell.detail ?? ''} runtime: ${(step?.transactionError ?? 'no result').slice(0, 80)}`;
        }
      } catch (e) {
        sellCell.detail = `${sellCell.detail ?? ''} runtime: ${(e as Error).message.slice(0, 80)}`;
      }
    }

    try {
      const q = await jupiter.quote({ inputMint: c.mint, outputMint: WSOL_MINT, amount: executedAtoms, slippageBps: 300 });
      sellCell.jupiterBenchmark = q.outAmount.toString();
      if (offlineSellOut !== null) sellCell.jupiterVsOfflineBps = bps(q.outAmount, offlineSellOut);
    } catch (e) {
      sellCell.detail = `${sellCell.detail ?? ''} jupiter: ${(e as Error).message.slice(0, 60)}`;
    }

    sellCell.status = sellCell.runtimeExecuted !== null ? 'MEASURED' : 'PARTIAL';
    cells.push(sellCell);
    console.log(
      `    sell ${String(size).padStart(9)}  offline/sdk ${sellCell.offlineVsSdkBps}bps  runtime/offline ${sellCell.runtimeVsOfflineBps}bps  jup/offline ${sellCell.jupiterVsOfflineBps}bps`,
    );
  }

  if (anyCell) mintsDone.push(c.mint);
}

const measured = cells.filter((x) => x.status === 'MEASURED');
const exact = (f: (c: Cell) => number | null): number => measured.filter((c) => f(c) === 0).length;
const compared = (f: (c: Cell) => number | null): number => measured.filter((c) => f(c) !== null).length;
const summary = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'schema-v30',
    sampleInclusionQuery: 'execution_observations buys, last 7d, canonical PumpSwap pool present',
  }),
  sdkVersion: PUMPSWAP_SDK_VERSION,
  sizes: SIZES.map(String),
  slippagePct: SLIPPAGE_PCT,
  mints: mintsDone.length,
  cells: cells.length,
  measured: measured.length,
  buys: measured.filter((c) => c.side === 'buy').length,
  sells: measured.filter((c) => c.side === 'sell').length,
  exactOfflineVsSdk: exact((c) => c.offlineVsSdkBps),
  comparedOfflineVsSdk: compared((c) => c.offlineVsSdkBps),
  exactRuntimeVsOffline: exact((c) => c.runtimeVsOfflineBps),
  comparedRuntimeVsOffline: compared((c) => c.runtimeVsOfflineBps),
  /** Token programs seen. A matrix that never met Token-2022 has not tested it. */
  baseTokenPrograms: [...new Set(cells.map((c) => c.baseTokenProgram).filter((x): x is string => x !== null))],
  quoteMints: [...new Set(cells.map((c) => c.quoteMint).filter((x): x is string => x !== null))],
  feeConfigPresent: measured.filter((c) => c.feeConfigPresent === true).length,
  rows: cells,
  note:
    'runtimeVsOfflineBps is the parity that decides whether the offline model may drive a mark. ' +
    'jupiterVsOfflineBps is a benchmark and may differ legitimately when the router uses another venue. ' +
    'On the sell side sdkOverRpc necessarily prices the PRE-buy pool, so its gap to offlineModel is self-impact.',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/pumpswap-parity-v2.json', JSON.stringify(summary, null, 2));

console.log(`\nmints ${summary.mints}  cells ${summary.cells}  measured ${summary.measured}`);
console.log(`buys ${summary.buys}  sells ${summary.sells}`);
console.log(`exact offline/sdk ${summary.exactOfflineVsSdk}/${summary.comparedOfflineVsSdk}`);
console.log(`exact runtime/offline ${summary.exactRuntimeVsOffline}/${summary.comparedRuntimeVsOffline}`);
console.log(`token programs ${summary.baseTokenPrograms.join(', ')}`);
console.log('artifacts/pumpswap-parity-v2.json');
db.close();
