import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { captureSnapshot } from '../packages/solana/src/snapshot-capture.js';
import { associatedTokenAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../packages/solana/src/pda.js';
import {
  accountSourceOf,
  poolAddressesFrom,
  swapAccountAddresses,
  associatedTokenAddressOf,
  WSOL_MINT,
} from '../packages/solana/src/pumpswap-offline.js';
import { buildCloseAccount } from '../packages/solana/src/closeaccount.js';
import { sequentialRoundTrip, standardPumpSwapSell } from '../packages/pipeline/src/sequential-round-trip.js';
import { SequentialWorker } from '../packages/simulator/src/sequential-worker.js';
import { createdAccountRentAcross, observedTokenAtoms } from '../packages/simulator/src/sequential-runtime.js';
import type { RawInstruction } from '../packages/solana/src/instructionpolicy.js';
import type { TransactionInstruction } from '@solana/web3.js';

/**
 * P3/P4 — a real trajectory through the ONE-PASS path.
 *
 * Everything before this was apparatus. This is the question the apparatus was
 * built to answer: does a migrated token, taken from the confirmed-migration
 * queue, go buy → sell → close inside ONE runtime, with the sell priced from the
 * state the buy committed and executed against that same state?
 *
 * Candidates come from `confirmed_migrations`, not from the screening stream.
 * Only about 3% of screened mints have a canonical pool, and a trajectory
 * budget spent on the other 97% measures nothing.
 */

const BUY_LAMPORTS = BigInt(process.env['ONE_PASS_LAMPORTS'] ?? '20000000');
const TARGET = Number(process.env['ONE_PASS_TARGET'] ?? 6);
const SLIPPAGE_PCT = 3;

const toRaw = (i: TransactionInstruction | RawInstruction): RawInstruction =>
  'programId' in i && typeof (i as RawInstruction).programId === 'string'
    ? (i as RawInstruction)
    : {
        programId: (i as TransactionInstruction).programId.toBase58(),
        accounts: (i as TransactionInstruction).keys.map((k) => ({
          pubkey: k.pubkey.toBase58(),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        data: Buffer.from((i as TransactionInstruction).data).toString('base64'),
      };

async function main(): Promise<void> {
  const secrets = loadSecrets();
  const config = loadConfig('paper');
  if (secrets.paperTakerPubkey === null || secrets.rpcHttp === null) {
    console.error('PAPER_TAKER_PUBKEY and an RPC endpoint are both required');
    process.exit(1);
  }
  const taker = secrets.paperTakerPubkey;
  const { rpc, host } = researchRpc(secrets);
  const db = openDb({ path: secrets.databasePath, readonly: true });
  const jupiter = new JupiterClient({
    limiter: RateLimiter.fromConfig(secrets.jupiterApiKey !== null),
    apiKey: secrets.jupiterApiKey,
  });
  void config;

  const candidates = db
    .prepare(
      `SELECT mint, canonical_pool FROM confirmed_migrations
        WHERE reversal_status = 'CONFIRMED' ORDER BY slot DESC LIMIT 40`,
    )
    .all() as { mint: string; canonical_pool: string }[];
  db.close();

  console.log(`endpoint ${host}`);
  console.log(`confirmed migration candidates: ${candidates.length}`);
  console.log('');

  const results: Record<string, unknown>[] = [];
  const outcomes: Record<string, number> = {};
  const worker = new SequentialWorker({ commandTimeoutMs: 240_000 });

  try {
    for (const c of candidates) {
      if (results.filter((r) => r['ok'] === true).length >= TARGET) break;
      const r: Record<string, unknown> = { mint: c.mint, pool: c.canonical_pool };

      const record = (outcome: string, detail?: string): void => {
        r['outcome'] = outcome;
        if (detail !== undefined) r['detail'] = detail.slice(0, 160);
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        results.push(r);
        console.log(`  ${c.mint.slice(0, 10)}  ${outcome}${detail ? '  ' + detail.slice(0, 70) : ''}`);
      };

      // The pool, and the accounts a sell will touch.
      let addrs;
      try {
        const raw = await rpc.getAccountRaw(c.canonical_pool);
        addrs = poolAddressesFrom(
          accountSourceOf([
            { pubkey: c.canonical_pool, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports },
          ]),
          c.canonical_pool,
        );
      } catch (e) {
        record('POOL_UNREADABLE', (e as Error).message);
        continue;
      }

      // The buy, from production's own builder.
      const buy = await jupiter
        .build({ inputMint: WSOL_MINT, outputMint: c.mint, amount: BUY_LAMPORTS, taker, slippageBps: 300, priority: 'risk' })
        .catch((e: unknown) => {
          r['buildError'] = (e as Error).message.slice(0, 140);
          return null;
        });
      if (buy === null) {
        record('MARKET_NO_BUY_ROUTE', String(r['buildError'] ?? ''));
        continue;
      }
      if (buy.blockhash === null || buy.blockhash === undefined) {
        record('MARKET_NO_BLOCKHASH');
        continue;
      }
      // Bound once. The narrowing does not survive into the closures below,
      // and widening the parameter to accept null would push the check down to
      // where it can no longer refuse the candidate.
      const blockhash: string = buy.blockhash;

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
        record('NO_TOKEN_PROGRAM_IN_ROUTE');
        continue;
      }
      const takerAta = associatedTokenAddress(taker, c.mint, tokenProgram);
      const takerWsol = associatedTokenAddressOf(taker, WSOL_MINT, TOKEN_PROGRAM);

      // The snapshot, including every account the SELL will touch and the
      // lookup TABLES themselves, not only their resolved contents.
      let snapshot;
      try {
        snapshot = await captureSnapshot(rpc, [buyBytes], {
          extraAccounts: [
            taker,
            takerAta,
            takerWsol,
            ...Object.keys(buy.lookupTables),
            ...Object.values(buy.lookupTables).flat(),
            addrs.poolBaseTokenAccount,
            addrs.poolQuoteTokenAccount,
            ...swapAccountAddresses({
              poolKey: c.canonical_pool,
              baseMint: c.mint,
              user: taker,
              coinCreator: addrs.coinCreator,
            }),
          ],
          extraPrograms: [...new Set(buy.instructions.map((i) => i.programId))],
        });
      } catch (e) {
        record('SNAPSHOT_FAILED', (e as Error).message);
        continue;
      }

      // A funded wallet, because a research trajectory has no capital of its
      // own and an unfunded payer fails for a reason that is not about the
      // token. This mutates only the LOCAL runtime; nothing is funded on chain.
      const withWallet = [
        ...snapshot.accounts.filter((a) => a.pubkey !== taker),
        {
          pubkey: taker,
          dataBase64: '',
          owner: '11111111111111111111111111111111',
          lamports: 5_000_000_000n,
          executable: false,
          rentEpoch: 0n,
        },
      ];

      const priceBearing = [
        c.canonical_pool,
        addrs.poolBaseTokenAccount,
        addrs.poolQuoteTokenAccount,
        c.mint,
      ];
      const observe = [...new Set([...priceBearing, taker, takerAta, takerWsol])];
      const preSrc = accountSourceOf(withWallet as never);

      const trip = await sequentialRoundTrip(
        {
          snapshot: {
            programs: snapshot.programs.map((p) => ({ programId: p.programId, elfBase64: p.elfBase64 })),
            accounts: withWallet as never,
            slot: snapshot.slot,
            unixTimestamp: snapshot.unixTimestamp,
          },
          pool: c.canonical_pool,
          taker,
          takerAta,
          slippagePct: SLIPPAGE_PCT,
          buyTransactionBase64: buyBytes,
          blockhash,
          priceBearingAccounts: priceBearing,
          observe,
          buildSell: standardPumpSwapSell({
            preState: preSrc,
            pool: c.canonical_pool,
            taker,
            slippagePct: SLIPPAGE_PCT,
            blockhash,
            encode: (ixs, bh) =>
              Buffer.from(
                encodeUnsignedTransaction(
                  compileMessage((ixs as (TransactionInstruction | RawInstruction)[]).map(toRaw), taker, bh, {}),
                ),
              ).toString('base64'),
          }),
          // Only the BASE account. The official sell appends its own
          // CloseAccount on the wrapped-SOL side when the quote mint is native.
          buildCloseBase64: () =>
            Buffer.from(
              encodeUnsignedTransaction(
                compileMessage(
                  [
                    buildCloseAccount({
                      tokenAccount: takerAta,
                      destination: taker,
                      owner: taker,
                      tokenProgram,
                      residualAtoms: 0n,
                      withheldAtoms: 0n,
                    }),
                  ],
                  taker,
                  blockhash,
                  {},
                ),
              ),
            ).toString('base64'),
          jobId: `one-pass-${c.mint.slice(0, 8)}`,
        },
        worker,
      );

      /**
       * Did the buy actually move the pool the SELL will use?
       *
       * The buy comes from Jupiter and may route anywhere; the sell is built
       * directly against the canonical PumpSwap pool. If the buy landed on some
       * other venue, the round trip crosses two markets and its loss is a
       * cross-venue spread rather than a mechanics floor — and a "stateful"
       * claim over an untouched pool is vacuous.
       */
      const baseBefore = trip.buy?.preAccounts.find((a) => a.pubkey === addrs.poolBaseTokenAccount)?.dataSha256 ?? null;
      const baseAfter = trip.buy?.postAccounts.find((a) => a.pubkey === addrs.poolBaseTokenAccount)?.dataSha256 ?? null;
      r['buyMutatedSellPool'] = baseBefore !== null && baseAfter !== null ? baseBefore !== baseAfter : null;
      r['buyProgramIds'] = [...new Set(buy.instructions.map((i) => i.programId))];

      r['acquiredAtoms'] = trip.acquiredAtoms?.toString() ?? null;
      r['quoteStateSurvived'] = trip.quoteStateSurvived;
      r['selfImpactLamports'] = trip.selfImpactLamports?.toString() ?? null;
      r['quotedStateHash'] = trip.quoted?.stateHash ?? null;
      r['buyStatus'] = trip.buy?.status ?? null;
      r['sellStatus'] = trip.sell?.status ?? null;
      r['closeStatus'] = trip.close?.status ?? null;

      if (!trip.ok) {
        record(trip.failure ?? 'UNKNOWN', trip.detail ?? undefined);
        continue;
      }

      // The one cash flow that matters: what the wallet had, and what it has.
      const before = trip.buy?.preAccounts.find((a) => a.pubkey === taker)?.lamports ?? null;
      const after = trip.close?.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? null;
      r['walletBefore'] = before;
      r['walletAfterClose'] = after;
      const net = before !== null && after !== null ? after - before : null;
      r['netLamports'] = net;

      /**
       * RENT IS NOT PRICE, and conflating them is a documented trap in this
       * repository.
       *
       * A trade that has to OPEN the coin-creator fee vault or the user volume
       * accumulator pays their rent-exempt minimum out of the payer's balance.
       * That rent is not a trading cost: it is capital parked in an account,
       * it is paid once per (creator, mint) rather than per trade, and those
       * accounts are protocol-owned so this system cannot close them to recover
       * it.
       *
       * The shortfall is CONSTANT, so measured as a rate it reads as a wildly
       * different "pricing error" at every notional — the same defect reported
       * as six different numbers. Measured here as an amount, and separated.
       *
       * An account counts as created when the step began with nothing at that
       * address and ended with lamports in it. That is a measurement of the
       * step rather than a list of account names, so it stays correct when the
       * protocol adds another one.
       */
      // The base ATA is excluded: the close recovers its rent, so it is not a
      // cost. Everything else the trade opened is rent this system cannot get
      // back, because those accounts are protocol-owned.
      const created = createdAccountRentAcross(
        [trip.buy, trip.sell, trip.close].filter((x) => x !== null) as never,
        [takerAta],
      );
      r['rentCreatedLamports'] = created.lamports.toString();
      r['rentCreatedAccounts'] = created.accounts;
      const unrecoveredRent = created.lamports;
      r['unrecoveredRentLamports'] = unrecoveredRent.toString();

      /**
       * WRAPPED SOL IS STILL THE WALLET'S VALUE.
       *
       * The native balance alone is not the trajectory's economics. A buy that
       * wraps SOL and a sell that leaves proceeds wrapped both move value into
       * the WSOL associated account, where it is still the taker's — it simply
       * is not in the native balance the payer delta measures.
       *
       * Measuring only the native side made the same token report -2.54% on one
       * run and -22.94% on another, which is not a property of the token. It is
       * an incomplete measurement varying with whatever the router decided to
       * wrap that time.
       */
      const wsolAtClose = trip.close?.postAccounts.find((a) => a.pubkey === takerWsol);
      const wsolLamports = observedTokenAtoms(wsolAtClose);
      r['wsolHeldAtCloseLamports'] = wsolLamports.toString();

      const residualAcct = trip.close?.postAccounts.find((a) => a.pubkey === takerAta);
      const residualAtoms = observedTokenAtoms(residualAcct);
      r['residualTokenAtoms'] = residualAtoms.toString();

      // The complete cash view: native delta, plus value still held in wrapped
      // SOL, plus the rent this system cannot recover.
      const fullNet = net === null ? null : BigInt(net) + wsolLamports;
      r['netIncludingWrappedLamports'] = fullNet?.toString() ?? null;
      r['tradingCostLamports'] = fullNet === null ? null : (fullNet + unrecoveredRent).toString();
      r['ok'] = true;
      record('COMPLETE_ROUND_TRIP');
    }
  } finally {
    await worker.close();
  }

  const complete = results.filter((x) => x['ok'] === true);
  const artifact = {
    host,
    buyLamports: BUY_LAMPORTS.toString(),
    candidatesTried: results.length,
    completeRoundTrips: complete.length,
    quoteStateSurvivedOnAllComplete: complete.every((x) => x['quoteStateSurvived'] === true),
    outcomes,
    results,
  };
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/live-one-pass-trajectory.json', JSON.stringify(artifact, null, 2) + '\n');

  console.log('');
  console.log('candidates tried      :', results.length);
  console.log('complete round trips  :', complete.length);
  console.log('quote state survived  :', artifact.quoteStateSurvivedOnAllComplete);
  console.log('outcomes              :', JSON.stringify(outcomes));
}

await main();
