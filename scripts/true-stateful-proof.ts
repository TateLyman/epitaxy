/**
 * P2 — a Pump/PumpSwap lifecycle in ONE local market state.
 *
 * The shape the previous proof could not have:
 *
 *   1. capture the current pool, its vaults, and the program's actual ELF
 *   2. run the buy in the local runtime — it COMMITS
 *   3. read the token balance and the POST-BUY pool from that runtime
 *   4. build the sell against THAT state, for exactly the credited atoms
 *   5. run the sell in the same runtime
 *   6. one wallet-to-wallet cash flow
 *
 * Step 4 is the whole point. Jupiter builds against current mainnet and cannot
 * price a pool that a hypothetical buy just moved, so the sell must be
 * constructed locally from the post-buy reserves — which is why this needs the
 * official SDK rather than a router.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { SolanaRpc } from '../packages/solana/src/rpc.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { captureSnapshot } from '../packages/solana/src/snapshot-capture.js';
import { runSequential, tokenAmountOf } from '../packages/simulator/src/sequential-runtime.js';
import { associatedTokenAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../packages/solana/src/pda.js';

const SOL = 'So11111111111111111111111111111111111111112';
const BUY_LAMPORTS = 20_000_000n;
const TARGET = Number(process.env['TRUE_STATEFUL_TARGET'] ?? 10);

const secrets = loadSecrets();
const config = loadConfig('paper');
const db = openDb({ path: secrets.databasePath, readonly: true });
if (secrets.paperTakerPubkey === null || secrets.rpcHttp === null) {
  console.error('PAPER_TAKER_PUBKEY and an RPC endpoint are both required');
  process.exit(1);
}
const taker: string = secrets.paperTakerPubkey;
const rpc = new SolanaRpc(RateLimiter.fromConfig(true), {
  primary: secrets.rpcHttp,
  fallback: secrets.rpcHttpFallback,
});
const jupiter = new JupiterClient({
  limiter: RateLimiter.fromConfig(secrets.jupiterApiKey !== null),
  apiKey: secrets.jupiterApiKey,
});
void config;

interface Case {
  mint: string;
  status: string;
  detail: string | null;
  programsLoaded: string[];
  snapshotAccounts: number;
  missingAccounts: number;
  buyStatus: string | null;
  sellStatus: string | null;
  acquiredAtoms: string | null;
  /** Whether the sell saw the buy's pool state. THE property. */
  sellSawPostBuyState: boolean | null;
  poolBaseBefore: string | null;
  poolBaseAfterBuy: string | null;
  walletBefore: string | null;
  walletAfterBuy: string | null;
  walletAfterSell: string | null;
  netLamports: string | null;
  notes: string[];
}

const candidates = db
  .prepare(
    `SELECT DISTINCT o.mint
       FROM execution_observations o
      WHERE o.side = 'buy' AND o.exact_transaction_blob IS NOT NULL
        AND o.received_utc_ms > ?
      ORDER BY o.received_utc_ms DESC
      LIMIT 40`,
  )
  .all(Date.now() - 6 * 3_600_000) as { mint: string }[];

console.log(`${candidates.length} candidates, target ${TARGET} lifecycles\n`);

const cases: Case[] = [];

for (const c of candidates) {
  if (cases.filter((x) => x.status === 'COMPLETE').length >= TARGET) break;

  const r: Case = {
    mint: c.mint,
    status: 'PENDING',
    detail: null,
    programsLoaded: [],
    snapshotAccounts: 0,
    missingAccounts: 0,
    buyStatus: null,
    sellStatus: null,
    acquiredAtoms: null,
    sellSawPostBuyState: null,
    poolBaseBefore: null,
    poolBaseAfterBuy: null,
    walletBefore: null,
    walletAfterBuy: null,
    walletAfterSell: null,
    netLamports: null,
    notes: [],
  };
  process.stdout.write(`  ${c.mint.slice(0, 12)} ... `);

  // ---- 1. the exact buy -------------------------------------------------
  const buy = await jupiter
    .build({ inputMint: SOL, outputMint: c.mint, amount: BUY_LAMPORTS, taker, slippageBps: 300, priority: 'risk' })
    .catch((e: unknown) => {
      r.status = 'MARKET_NO_BUY_ROUTE';
      r.detail = (e as Error).message.slice(0, 120);
      return null;
    });
  if (buy === null || buy.blockhash === null || buy.blockhash === undefined) {
    if (r.status === 'PENDING') {
      r.status = 'MARKET_NO_BLOCKHASH';
      r.detail = 'the build response carried no blockhash';
    }
    console.log(r.status);
    cases.push(r);
    continue;
  }

  const buyBytes = Buffer.from(
    encodeUnsignedTransaction(compileMessage(buy.instructions, taker, buy.blockhash, buy.lookupTables)),
  ).toString('base64');

  // The taker's token account, which the buy will credit.
  const accounts = [
    ...buy.instructions.flatMap((i) => (i.accounts ?? []).map((a) => a.pubkey)),
    ...Object.values(buy.lookupTables).flat(),
  ];
  let tokenProgram: string | null = null;
  for (const p of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      if (accounts.includes(associatedTokenAddress(taker, c.mint, p))) tokenProgram = p;
    } catch {
      /* undecodable is not the one in the transaction */
    }
  }
  if (tokenProgram === null) {
    r.status = 'INSTRUMENT_NO_TOKEN_PROGRAM';
    console.log(r.status);
    cases.push(r);
    continue;
  }
  const takerAta = associatedTokenAddress(taker, c.mint, tokenProgram);

  // ---- 2. capture the state, INCLUDING the executable code --------------
  let snapshot;
  try {
    snapshot = await captureSnapshot(rpc, [buyBytes], {
      // Every address the route resolves through its lookup tables. A v0
      // transaction keeps most of its accounts there, and capturing only the
      // static keys produced 14 accounts for a swap that touches dozens.
      extraAccounts: [taker, takerAta, ...Object.values(buy.lookupTables).flat()],
      // The build response names each instruction's program. Deriving them
      // from `programIdIndex` against static keys alone found only Jupiter.
      extraPrograms: [...new Set(buy.instructions.map((i) => i.programId))],
    });
  } catch (e) {
    r.status = 'INSTRUMENT_SNAPSHOT_FAILED';
    r.detail = (e as Error).message.slice(0, 140);
    console.log(`${r.status} ${r.detail}`);
    cases.push(r);
    continue;
  }
  r.snapshotAccounts = snapshot.accounts.length;
  r.missingAccounts = snapshot.missing.length;
  r.notes.push(...snapshot.notes.slice(0, 4));

  if (snapshot.programs.length === 0) {
    r.status = 'INSTRUMENT_NO_PROGRAM_ELF';
    r.detail = snapshot.notes.slice(0, 2).join('; ') || 'no program ELF captured';
    console.log(`${r.status} ${r.detail.slice(0, 80)}`);
    cases.push(r);
    continue;
  }

  // The wallet needs enough hypothetical SOL to cover the leg, inside a
  // runtime that is destroyed with the job. No wallet is funded.
  const funded = snapshot.accounts.map((a) =>
    a.pubkey === taker ? { ...a, lamports: BUY_LAMPORTS * 20n } : a,
  );
  const walletMissing = !funded.some((a) => a.pubkey === taker);
  const withWallet = walletMissing
    ? [
        ...funded,
        {
          pubkey: taker,
          dataBase64: '',
          owner: '11111111111111111111111111111111',
          lamports: BUY_LAMPORTS * 20n,
          executable: false,
          rentEpoch: 0n,
        },
      ]
    : funded;

  // ---- 3. run the buy; it COMMITS ---------------------------------------
  let run;
  try {
    run = runSequential({
      jobId: `true-stateful-${c.mint.slice(0, 8)}`,
      snapshot: {
        programs: snapshot.programs.map((p) => ({ programId: p.programId, elfBase64: p.elfBase64 })),
        accounts: withWallet,
        slot: snapshot.slot,
        unixTimestamp: snapshot.unixTimestamp,
      },
      steps: [{ label: 'buy', transactionBase64: buyBytes, observe: [taker, takerAta] }],
      timeoutMs: 180_000,
    });
  } catch (e) {
    r.status = 'INSTRUMENT_RUNTIME_FAILED';
    r.detail = (e as Error).message.slice(0, 140);
    console.log(`${r.status} ${r.detail.slice(0, 80)}`);
    cases.push(r);
    continue;
  }

  r.programsLoaded = [...run.programsLoaded];
  const buyStep = run.steps[0];
  r.buyStatus = buyStep?.status ?? 'MISSING';
  r.notes.push(...run.incompleteness.slice(0, 3));

  if (buyStep === undefined || buyStep.status !== 'SIMULATED_OK') {
    r.status = 'BUY_FAILED_IN_RUNTIME';
    r.detail = (buyStep?.transactionError ?? 'no result').slice(0, 140);
    console.log(`${r.status} ${r.detail.slice(0, 90)}`);
    cases.push(r);
    continue;
  }

  const ataAfter = buyStep.postAccounts.find((a) => a.pubkey === takerAta);
  const acquired = ataAfter === undefined ? null : tokenAmountOf(ataAfter);
  r.acquiredAtoms = acquired === null ? null : acquired.toString();
  r.walletBefore = String(buyStep.preAccounts.find((a) => a.pubkey === taker)?.lamports ?? '');
  r.walletAfterBuy = String(buyStep.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? '');

  if (acquired === null || acquired <= 0n) {
    r.status = 'NO_MEASURED_CREDIT';
    r.detail = 'the buy committed but credited no tokens to the taker';
    console.log(r.status);
    cases.push(r);
    continue;
  }

  /**
   * The buy committed and the credit is real. What remains is constructing the
   * sell FROM this runtime's post-buy pool state.
   *
   * That construction is the piece not yet built: it needs the official
   * PumpSwap instruction builder fed from the runtime's own post-buy reserves
   * rather than from mainnet. Recorded honestly rather than substituted with a
   * Jupiter sell, which would rebuild the linked-leg defect inside a runtime
   * that was specifically built to avoid it.
   */
  r.status = 'BUY_COMMITTED_SELL_NOT_BUILT';
  r.detail = 'post-buy sell construction from the official builder is not implemented';
  console.log(`${r.status} acquired=${acquired} programs=${run.programsLoaded.length}`);
  cases.push(r);
}

const summary = {
  generatedUtcMs: Date.now(),
  sourceCommit: execSync('git rev-parse HEAD').toString().trim(),
  dirty: execSync('git status --porcelain').toString().trim().length > 0,
  buyLamports: BUY_LAMPORTS.toString(),
  attempted: cases.length,
  complete: cases.filter((x) => x.status === 'COMPLETE').length,
  buysCommitted: cases.filter((x) => x.buyStatus === 'SIMULATED_OK').length,
  apparatusFailures: cases.filter((x) => x.status.startsWith('INSTRUMENT')).length,
  marketFailures: cases.filter((x) => x.status.startsWith('MARKET')).length,
  cases,
  note:
    'A buy that COMMITS in the local runtime is the prerequisite for the sequential lifecycle. ' +
    'The sell must be constructed from this runtime post-buy state, not from mainnet, or the ' +
    'linked-leg defect is rebuilt inside the runtime that exists to prevent it.',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/true-stateful-roundtrip-proof.json', JSON.stringify(summary, null, 2));

console.log(`\nattempted ${summary.attempted}  buys committed ${summary.buysCommitted}`);
console.log(`apparatus failures ${summary.apparatusFailures}  market ${summary.marketFailures}`);
console.log('artifacts/true-stateful-roundtrip-proof.json');
db.close();
