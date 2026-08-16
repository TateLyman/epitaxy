import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { captureSnapshot } from '../packages/solana/src/snapshot-capture.js';
import { associatedTokenAddress, TOKEN_PROGRAM } from '../packages/solana/src/pda.js';
import {
  accountSourceOf,
  poolAddressesFrom,
  buildBuyFrom,
  swapAccountAddresses,
  swapAccountRoles,
  associatedTokenAddressOf,
  WSOL_MINT,
  FEE_CONFIG_ADDR,
  SWAP_PROGRAM_IDS,
} from '../packages/solana/src/pumpswap-offline.js';
import { buildCloseAccount } from '../packages/solana/src/closeaccount.js';
import { sequentialRoundTrip, standardPumpSwapSell } from '../packages/pipeline/src/sequential-round-trip.js';
import { SequentialWorker } from '../packages/simulator/src/sequential-worker.js';
import { RENT_EXEMPT_EPOCH } from '../packages/simulator/src/sequential-runtime.js';
import { prewarmNonPriceAccounts, sharedAccountsToPrewarm } from '../packages/simulator/src/prewarm.js';
import { classifyCreatedAccount, summariseSetup } from '../packages/solana/src/created-accounts.js';
import { frozenComputeLimit, priorityFeeSaving } from '../packages/solana/src/cu-budget.js';
import { mechanicsStratum } from '../packages/solana/src/cashback.js';
import type { RawInstruction } from '../packages/solana/src/instructionpolicy.js';
import type { TransactionInstruction } from '@solana/web3.js';

/**
 * P6 — COLD, PREWARMED and REPEAT, from ONE original price state.
 *
 * The size surface answered the wrong question. It reset from a cold snapshot
 * for every notional, reported zero created-account rent on every row, and then
 * labelled the residual a recurring mechanics floor — from which the only
 * available recommendation was a larger trade.
 *
 * Amortising a first trader's rent over a bigger trade does not make the rent
 * smaller. It hides it behind a size the strategy then has to justify on other
 * grounds. The question that matters is not *how big* but *how warm*:
 *
 * ```
 * COLD                          we open every shared account ourselves
 * PREWARMED_NON_PRICE_ACCOUNTS  somebody else opened them; reserves UNTOUCHED
 * REPEAT                        the second trade, after the first moved the pool
 * ```
 *
 * COLD − PREWARMED is the setup cost, and it is one-time.
 * PREWARMED − REPEAT is self-impact, and it is not.
 *
 * Those two have opposite policy implications — *wait for a warm pool* versus
 * *trade smaller* — which is why the middle surface exists at all and why it is
 * built by transplanting only NON-price-bearing accounts. A surface that lets
 * the first trade's reserves leak into the second measures a different market
 * and recommends neither.
 *
 * Nothing here is funded, signed or submitted. These are mechanics measured in
 * an isolated local runtime against exact captured mainnet state.
 */

/** Frozen. This is not a size search — that is what the old surface was. */
const NOTIONAL_LAMPORTS = BigInt(process.env['COLD_WARM_LAMPORTS'] ?? '20000000');
const SLIPPAGE_PCT = 3;
const TARGET_TOKENS = Number(process.env['COLD_WARM_TOKENS'] ?? 6);

/** A representative price, for reporting what an explicit CU limit would save. */
const REFERENCE_UNIT_PRICE_MICROLAMPORTS = 10_000n;

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

const encode = (ixs: unknown[], taker: string, bh: string): string =>
  Buffer.from(
    encodeUnsignedTransaction(
      compileMessage((ixs as (TransactionInstruction | RawInstruction)[]).map(toRaw), taker, bh, {}),
    ),
  ).toString('base64');

interface SnapAccount {
  pubkey: string;
  owner: string;
  dataBase64: string;
  lamports: bigint;
  executable?: boolean;
  rentEpoch?: bigint;
}

/** An observed account, as the worker returns it. */
interface Observed {
  pubkey: string;
  owner: string;
  lamports: bigint;
  dataLen: number;
  dataBase64: string | null;
}

const lamportsOf = (xs: readonly Observed[], key: string): bigint | null =>
  xs.find((a) => a.pubkey === key)?.lamports ?? null;

/**
 * Overlay observed post-state onto a snapshot.
 *
 * Used for REPEAT, and ONLY for REPEAT: it carries reserves forward on purpose,
 * which is exactly what PREWARMED must not do.
 */
function overlayAll(base: readonly SnapAccount[], observed: readonly Observed[]): SnapAccount[] {
  const out = new Map(base.map((a) => [a.pubkey, a]));
  for (const o of observed) {
    if (o.dataBase64 === null) continue; // withheld bytes cannot restore an account
    out.set(o.pubkey, {
      pubkey: o.pubkey,
      owner: o.owner,
      dataBase64: o.dataBase64,
      lamports: o.lamports,
      executable: false,
      rentEpoch: RENT_EXEMPT_EPOCH,
    });
  }
  return [...out.values()];
}

async function main(): Promise<void> {
  const secrets = loadSecrets();
  if (secrets.paperTakerPubkey === null || secrets.rpcHttp === null) {
    console.error('PAPER_TAKER_PUBKEY and an RPC endpoint are both required');
    process.exit(1);
  }
  const taker = secrets.paperTakerPubkey;
  const { rpc, host } = researchRpc(secrets);
  const db = openDb({ path: secrets.databasePath, readonly: true });
  const candidates = db
    .prepare(
      `SELECT mint, canonical_pool, is_cashback_coin FROM confirmed_migrations
        WHERE reversal_status = 'CONFIRMED' ORDER BY slot DESC LIMIT 40`,
    )
    .all() as { mint: string; canonical_pool: string; is_cashback_coin: number | null }[];
  db.close();

  const rows: Record<string, unknown>[] = [];
  const refusals: Record<string, number> = {};
  let done = 0;
  let worker = new SequentialWorker({ commandTimeoutMs: 240_000, maxOutputBytes: 256 * 1024 * 1024 });

  const refuse = (why: string): void => {
    refusals[why] = (refusals[why] ?? 0) + 1;
  };

  try {
    for (const c of candidates) {
      if (done >= TARGET_TOKENS) break;

      let addrs;
      try {
        const poolRaw = await rpc.getAccountRaw(c.canonical_pool);
        addrs = poolAddressesFrom(
          accountSourceOf([
            {
              pubkey: c.canonical_pool,
              owner: poolRaw.owner,
              dataBase64: poolRaw.dataBase64,
              lamports: poolRaw.lamports,
            },
          ]),
          c.canonical_pool,
        );
      } catch {
        refuse('the pool did not read or decode');
        continue;
      }

      // The token program comes from the MINT'S OWNER. Assuming the legacy
      // program derives an address a Token-2022 mint never creates, and the
      // credit is then observed at an account nothing ever wrote to.
      let mintTokenProgram: string;
      try {
        mintTokenProgram = (await rpc.getAccountRaw(c.mint)).owner;
      } catch {
        refuse('the mint did not read');
        continue;
      }

      const takerAta = associatedTokenAddress(taker, c.mint, mintTokenProgram);
      const takerWsol = associatedTokenAddressOf(taker, WSOL_MINT, TOKEN_PROGRAM);
      const priceBearing = [c.canonical_pool, addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount, c.mint];
      const roles = swapAccountRoles({
        user: taker,
        baseMint: c.mint,
        coinCreator: addrs.coinCreator,
        quoteMint: WSOL_MINT,
        quoteTokenProgram: TOKEN_PROGRAM,
      });
      const extraRoleAccounts = [roles.accumulatorWsolAta, roles.poolV2, roles.userVolumeAccumulator].filter(
        (a): a is string => a !== null,
      );

      // ONE snapshot. Every surface below starts from these exact bytes, which
      // is the only thing that makes the three comparable at all.
      let snapshot;
      try {
        snapshot = await captureSnapshot(rpc, [], {
          extraAccounts: [
            taker,
            takerAta,
            takerWsol,
            ...priceBearing,
            FEE_CONFIG_ADDR,
            ...swapAccountAddresses({
              poolKey: c.canonical_pool,
              baseMint: c.mint,
              user: taker,
              coinCreator: addrs.coinCreator,
            }),
            ...extraRoleAccounts,
          ],
          extraPrograms: [...SWAP_PROGRAM_IDS],
        });
      } catch {
        refuse('the snapshot did not capture');
        continue;
      }

      const original: SnapAccount[] = [
        ...(snapshot.accounts as SnapAccount[]).filter((a) => a.pubkey !== taker),
        {
          pubkey: taker,
          dataBase64: '',
          owner: '11111111111111111111111111111111',
          lamports: 500_000_000_000n,
          executable: false,
          // Exempt, like every funded system account on mainnet. Epoch 0
          // restores it as rent-PAYING, which is a different account.
          rentEpoch: RENT_EXEMPT_EPOCH,
        },
      ];
      const blockhash = '11111111111111111111111111111111';
      const observe = [
        ...new Set([
          ...priceBearing,
          taker,
          takerAta,
          takerWsol,
          ...swapAccountAddresses({
            poolKey: c.canonical_pool,
            baseMint: c.mint,
            user: taker,
            coinCreator: addrs.coinCreator,
          }),
          ...extraRoleAccounts,
        ]),
      ];

      /** One surface: build the buy from `accounts`, run the trip, measure. */
      const runSurface = async (
        label: 'COLD' | 'PREWARMED_NON_PRICE_ACCOUNTS' | 'REPEAT',
        accounts: readonly SnapAccount[],
      ) => {
        const src = accountSourceOf(accounts as never);
        let buyBytes: string;
        try {
          const built = await buildBuyFrom(src, {
            poolKey: c.canonical_pool,
            user: taker,
            quoteLamports: NOTIONAL_LAMPORTS,
            slippagePct: SLIPPAGE_PCT,
          });
          buyBytes = encode(built.instructions as unknown[], taker, blockhash);
        } catch (e) {
          return { label, ok: false as const, refusal: `buy build: ${(e as Error).message.slice(0, 90)}` };
        }

        // A fresh runtime per surface. The client's output bound is cumulative
        // over a worker's lifetime, and three full trips with every payload
        // returned exceeds it — which turns a runaway guard into a cap on the
        // study.
        await worker.close();
        worker = new SequentialWorker({ commandTimeoutMs: 240_000, maxOutputBytes: 256 * 1024 * 1024 });

        const trip = await sequentialRoundTrip(
          {
            snapshot: {
              programs: snapshot.programs.map((p) => ({ programId: p.programId, elfBase64: p.elfBase64 })),
              accounts: accounts as never,
              slot: snapshot.slot,
              unixTimestamp: snapshot.unixTimestamp,
              requiredAccounts: priceBearing,
              requiredPrograms: [...SWAP_PROGRAM_IDS],
            },
            pool: c.canonical_pool,
            taker,
            takerAta,
            slippagePct: SLIPPAGE_PCT,
            buyTransactionBase64: buyBytes,
            blockhash,
            priceBearingAccounts: priceBearing,
            observe,
            // Every payload comes back: the transplant needs the BYTES of the
            // accounts the first trade created, not just their balances.
            economicAccounts: observe,
            buildSell: standardPumpSwapSell({
              preState: src,
              pool: c.canonical_pool,
              taker,
              slippagePct: SLIPPAGE_PCT,
              blockhash,
              encode: (ixs, bh) => encode(ixs, taker, bh),
              // P6 — the close rides in the sell rather than costing a third
              // signature and landing interval.
              appendInstructions: () => [
                buildCloseAccount({
                  tokenAccount: takerAta,
                  destination: taker,
                  owner: taker,
                  tokenProgram: mintTokenProgram,
                  residualAtoms: 0n,
                  withheldAtoms: 0n,
                }),
              ],
            }),
            takerBaseAtaToClose: takerAta,
            jobId: `cold-warm-${label}-${c.mint.slice(0, 8)}`,
          },
          worker,
        );

        if (trip.buy === null || trip.sell === null || trip.acquiredAtoms === null) {
          return { label, ok: false as const, refusal: `${trip.failure ?? 'unknown'}: ${(trip.detail ?? '').slice(0, 80)}` };
        }

        const pre = trip.buy.preAccounts as unknown as Observed[];
        const post = trip.sell.postAccounts as unknown as Observed[];

        // What the entry brought into existence, classified.
        const preByKey = new Map(pre.map((a) => [a.pubkey, a]));
        const buyPost = trip.buy.postAccounts as unknown as Observed[];
        const created = buyPost
          .filter((a) => {
            const prior = preByKey.get(a.pubkey);
            return (prior === undefined || (prior.lamports <= 0n && prior.dataLen === 0)) && a.lamports > 0n;
          })
          .map((a) =>
            classifyCreatedAccount(
              { pubkey: a.pubkey, owner: a.owner, space: a.dataLen, lamports: a.lamports },
              {
                taker,
                takerBaseAta: takerAta,
                takerQuoteAta: takerWsol,
                pool: c.canonical_pool,
                poolBaseVault: addrs.poolBaseTokenAccount,
                poolQuoteVault: addrs.poolQuoteTokenAccount,
                baseMint: c.mint,
                quoteMint: WSOL_MINT,
                coinCreator: addrs.coinCreator,
                coinCreatorVaultAta: roles.coinCreatorVaultAta,
                coinCreatorVaultAuthority: roles.coinCreatorVaultAuthority,
                userVolumeAccumulator: roles.userVolumeAccumulator,
                globalVolumeAccumulator: roles.globalVolumeAccumulator,
                accumulatorWsolAta: roles.accumulatorWsolAta,
                poolV2: roles.poolV2,
              },
            ),
          );
        const setup = summariseSetup(created);

        /**
         * The payer's own cash, start to finish.
         *
         * Wallet lamports plus whatever is still sitting wrapped: WSOL the exit
         * produced is ours, and counting it as spent would report every round
         * trip as a total loss of its own proceeds.
         */
        const payerPre = lamportsOf(pre, taker) ?? 0n;
        const payerPost = lamportsOf(post, taker) ?? 0n;
        const wsolPre = lamportsOf(pre, takerWsol) ?? 0n;
        const wsolPost = lamportsOf(post, takerWsol) ?? 0n;
        const drag = payerPre + wsolPre - (payerPost + wsolPost);

        const cu = Math.max(trip.buy.computeUnitsConsumed ?? 0, trip.sell.computeUnitsConsumed ?? 0);
        const plan = frozenComputeLimit(cu || null);

        return {
          label,
          ok: true as const,
          acquiredAtoms: trip.acquiredAtoms.toString(),
          dragLamports: drag.toString(),
          dragBps: NOTIONAL_LAMPORTS > 0n ? Number((drag * 10_000n) / NOTIONAL_LAMPORTS) : null,
          selfImpactLamports: trip.selfImpactLamports?.toString() ?? null,
          baseAtaClosedInSell: trip.baseAtaClosedInSell,
          createdAccounts: created.map((a) => ({
            pubkey: a.pubkey,
            owner: a.owner,
            space: a.space,
            rentLamports: a.rentExemptMinimumLamports.toString(),
            excessLamports: a.excessLamports.toString(),
            scope: a.scope,
            recoverability: a.recoverability,
            shared: a.sharedWithOtherTraders,
          })),
          setup: {
            totalRentLamports: setup.totalRentLamports.toString(),
            recoverableLamports: setup.recoverableLamports.toString(),
            unrecoverableLamports: setup.unrecoverableLamports.toString(),
            subsidyToOtherTradersLamports: setup.subsidyToOtherTradersLamports.toString(),
            unknownScopeCount: setup.unknownScopeCount,
          },
          computeUnitsConsumed: cu || null,
          requestedComputeUnits: plan?.requestedUnits ?? null,
          // What the explicit limit is worth at a representative price. The
          // development runtime pays no priority fee at all, so this is the only
          // place the figure can come from before a live path exists.
          priorityFeeSavedAtReferencePrice:
            plan === null
              ? null
              : priorityFeeSaving({
                  plan,
                  // Five non-builtin instructions is the observed PumpSwap shape.
                  derivedUnits: 1_000_000,
                  unitPriceMicroLamports: REFERENCE_UNIT_PRICE_MICROLAMPORTS,
                }).savedLamports.toString(),
          sellPostObserved: post,
          buyPostObserved: buyPost,
        };
      };

      // ---- COLD ---------------------------------------------------------
      const cold = await runSurface('COLD', original);
      if (!cold.ok) {
        refuse(`COLD ${cold.refusal}`);
        continue;
      }

      // ---- PREWARMED ----------------------------------------------------
      //
      // Only the SHARED accounts, and never a price-bearing one. Our own ATAs
      // stay cold: their rent is a float either way, so transplanting them
      // moves a number without changing an economic fact.
      const toWarm = sharedAccountsToPrewarm(
        cold.createdAccounts.map((a) => ({ pubkey: a.pubkey, sharedWithOtherTraders: a.shared })),
      );
      let prewarmed: Awaited<ReturnType<typeof runSurface>> | null = null;
      if (toWarm.length > 0) {
        const warmState = prewarmNonPriceAccounts({
          original,
          afterFirstTrade: cold.buyPostObserved
            .filter((a) => a.dataBase64 !== null)
            .map((a) => ({
              pubkey: a.pubkey,
              owner: a.owner,
              dataBase64: a.dataBase64 as string,
              lamports: a.lamports,
            })),
          priceBearing,
          transplant: toWarm,
        });
        prewarmed = await runSurface('PREWARMED_NON_PRICE_ACCOUNTS', warmState.accounts as SnapAccount[]);
      }

      // ---- REPEAT -------------------------------------------------------
      //
      // Everything carried forward, reserves included. This is the surface the
      // old one was actually producing under the wrong name.
      const repeat = await runSurface('REPEAT', overlayAll(original, cold.sellPostObserved));

      const strip = (s: Awaited<ReturnType<typeof runSurface>> | null): unknown => {
        if (s === null) return null;
        if (!s.ok) return { label: s.label, ok: false, refusal: s.refusal };
        const { sellPostObserved: _a, buyPostObserved: _b, ...rest } = s;
        return rest;
      };

      const dragOf = (s: Awaited<ReturnType<typeof runSurface>> | null): bigint | null =>
        s !== null && s.ok ? BigInt(s.dragLamports) : null;

      const coldDrag = dragOf(cold);
      const warmDrag = dragOf(prewarmed);
      const repeatDrag = dragOf(repeat);

      rows.push({
        mint: c.mint,
        pool: c.canonical_pool,
        stratum: mechanicsStratum({ canonicalPool: true, cashbackCoin: c.is_cashback_coin === 1 }),
        notionalLamports: NOTIONAL_LAMPORTS.toString(),
        surfaces: { cold: strip(cold), prewarmed: strip(prewarmed), repeat: strip(repeat) },
        // The two decompositions, kept apart because they recommend opposite
        // things. Null rather than zero when a surface refused: an unmeasured
        // difference is not a difference of zero.
        setupCostLamports: coldDrag !== null && warmDrag !== null ? (coldDrag - warmDrag).toString() : null,
        selfImpactAndFeeLamports: warmDrag !== null && repeatDrag !== null ? (warmDrag - repeatDrag).toString() : null,
        prewarmSkipped: toWarm.length === 0 ? 'the entry created no shared account, so COLD is already warm' : null,
      });
      done++;
      console.log(
        `${c.mint.slice(0, 10)}  cold=${coldDrag ?? 'n/a'}  warm=${warmDrag ?? 'n/a'}  repeat=${repeatDrag ?? 'n/a'}  ` +
          `shared=${toWarm.length}`,
      );
    }
  } finally {
    await worker.close();
  }

  let commit = 'unknown';
  let dirty = true;
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    /* provenance that cannot be read is reported unknown, never omitted */
  }

  const out = {
    artifact: 'cold-warm-size-surface',
    directiveSection: 'P6',
    generatedUtcMs: Date.now(),
    sourceCommit: commit,
    dirty,
    endpoint: host,
    notionalLamports: NOTIONAL_LAMPORTS.toString(),
    slippagePct: SLIPPAGE_PCT,
    referenceUnitPriceMicroLamports: REFERENCE_UNIT_PRICE_MICROLAMPORTS.toString(),
    tokens: rows.length,
    refusals,
    rows,
    reading: {
      COLD: 'we open every shared account ourselves',
      PREWARMED_NON_PRICE_ACCOUNTS: 'somebody else opened them; reserves untouched',
      REPEAT: 'the second trade, after the first moved the pool',
      setupCostLamports: 'COLD minus PREWARMED. One-time. Says WAIT FOR A WARM POOL.',
      selfImpactAndFeeLamports: 'PREWARMED minus REPEAT. Recurring. Says TRADE SMALLER.',
    },
    notClaimed:
      'mechanics measured in an isolated local runtime against exact captured state. ' +
      'Not a strategy outcome, not a profitability claim. Nothing funded, signed or submitted.',
  };

  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/cold-warm-size-surface.json', JSON.stringify(out, null, 2));
  console.log(`\nwrote artifacts/cold-warm-size-surface.json (${rows.length} token(s))`);
  for (const [r, n] of Object.entries(refusals).sort((a, b) => b[1] - a[1])) {
    console.log(`  refused ${String(n).padStart(3)}  ${r}`);
  }
}

await main();
