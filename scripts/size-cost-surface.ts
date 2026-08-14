import { writeFileSync, mkdirSync } from 'node:fs';
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
  associatedTokenAddressOf,
  WSOL_MINT,
  FEE_CONFIG_ADDR,
  SWAP_PROGRAM_IDS,
} from '../packages/solana/src/pumpswap-offline.js';
import { buildCloseAccount } from '../packages/solana/src/closeaccount.js';
import { sequentialRoundTrip, standardPumpSwapSell } from '../packages/pipeline/src/sequential-round-trip.js';
import { SequentialWorker } from '../packages/simulator/src/sequential-worker.js';
import { createdAccountRentAcross } from '../packages/simulator/src/sequential-runtime.js';
import { feeTiersOf, tierFor } from '../packages/solana/src/fee-tiers.js';
import { mechanicsStratum } from '../packages/solana/src/cashback.js';
import type { RawInstruction } from '../packages/solana/src/instructionpolicy.js';
import type { TransactionInstruction } from '@solana/web3.js';

/**
 * P14 — the size and cost surface, and the diagnostic for an open question.
 *
 * Five notionals against ONE shared snapshot per token. The network read is
 * shared; local sizes are cheap, because the runtime is already alive and the
 * buy is built by the official PumpSwap builder rather than fetched per size.
 *
 * This also settles something the previous run could not. The immediate round
 * trip lost on 20 of 20 tokens, but the losses clustered on repeated EXACT
 * lamport values across different tokens, which price impact cannot produce.
 * A size sweep separates the two cleanly:
 *
 *   drag constant in LAMPORTS as size grows  → a fixed cost (fees, rent, dust)
 *   drag constant in BPS as size grows       → proportional (venue fee)
 *   drag growing faster than size            → price impact
 *
 * Reported as amounts AND rates, because a constant shortfall expressed only as
 * a rate reads as a different pricing error at every notional — the same defect
 * reported as several numbers.
 */

const SIZES_LAMPORTS = [2_500_000n, 5_000_000n, 10_000_000n, 20_000_000n, 40_000_000n];
const SLIPPAGE_PCT = 3;
const TARGET_TOKENS = Number(process.env['SIZE_SURFACE_TOKENS'] ?? 8);

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

const tokenAmountAt = (a: { dataBase64: string } | undefined): bigint => {
  if (a === undefined) return 0n;
  const b = Buffer.from(a.dataBase64, 'base64');
  return b.length >= 72 ? b.readBigUInt64LE(64) : 0n;
};

function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] ?? null;
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
      `SELECT mint, canonical_pool, is_cashback_coin, is_mayhem_mode FROM confirmed_migrations
        WHERE reversal_status = 'CONFIRMED' ORDER BY slot DESC LIMIT 40`,
    )
    .all() as { mint: string; canonical_pool: string; is_cashback_coin: number | null; is_mayhem_mode: number | null }[];
  db.close();

  // The fee tier table, decoded once.
  const feeRaw = await rpc.getAccountRaw(FEE_CONFIG_ADDR);
  const { PumpAmmSdk } = await import('@pump-fun/pump-swap-sdk');
  const { PublicKey } = await import('@solana/web3.js');
  const feeConfig = new PumpAmmSdk().decodeFeeConfig({
    owner: new PublicKey(feeRaw.owner),
    data: Buffer.from(feeRaw.dataBase64, 'base64'),
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  });
  const tiers = feeTiersOf(feeConfig);

  const rows: Record<string, unknown>[] = [];
  // Observing every touched account on pre AND post of three steps across five
  // sizes returns a lot of base64. The default bound is sized for one trip.
  let worker = new SequentialWorker({ commandTimeoutMs: 240_000, maxOutputBytes: 256 * 1024 * 1024 });
  let tokensDone = 0;

  try {
    for (const c of candidates) {
      if (tokensDone >= TARGET_TOKENS) break;

      let addrs;
      let poolRaw;
      try {
        poolRaw = await rpc.getAccountRaw(c.canonical_pool);
        addrs = poolAddressesFrom(
          accountSourceOf([
            { pubkey: c.canonical_pool, owner: poolRaw.owner, dataBase64: poolRaw.dataBase64, lamports: poolRaw.lamports },
          ]),
          c.canonical_pool,
        );
      } catch {
        continue;
      }

      /**
       * The token program comes from the MINT'S OWNER, not from an assumption.
       *
       * Hardcoding the legacy Token program derives an associated account
       * address that a Token-2022 mint never creates, so the buy commits and
       * the credit is observed at an address nothing ever wrote to — reported
       * as "the buy credited no tokens", which is a statement about the wrong
       * account rather than about the trade.
       */
      let mintTokenProgram: string;
      try {
        mintTokenProgram = (await rpc.getAccountRaw(c.mint)).owner;
      } catch {
        continue;
      }
      const takerAta = associatedTokenAddress(taker, c.mint, mintTokenProgram);
      const takerWsol = associatedTokenAddressOf(taker, WSOL_MINT, TOKEN_PROGRAM);

      // ONE snapshot, reused for every size. This is the shared network read.
      let snapshot;
      try {
        snapshot = await captureSnapshot(rpc, [], {
          extraAccounts: [
            taker,
            takerAta,
            takerWsol,
            c.mint,
            c.canonical_pool,
            addrs.poolBaseTokenAccount,
            addrs.poolQuoteTokenAccount,
            FEE_CONFIG_ADDR,
            ...swapAccountAddresses({
              poolKey: c.canonical_pool,
              baseMint: c.mint,
              user: taker,
              coinCreator: addrs.coinCreator,
            }),
          ],
          // The AMM CPIs into the fee program, and Anchor answers a program
          // that is present but not executable in the runtime with
          // InvalidProgramExecutable (Custom 3009) — which names nothing. Every
          // swap program is loaded, not just the one the top-level instruction
          // addresses.
          extraPrograms: [...SWAP_PROGRAM_IDS],
        });
      } catch {
        continue;
      }

      const withWallet = [
        ...snapshot.accounts.filter((a) => a.pubkey !== taker),
        {
          pubkey: taker,
          dataBase64: '',
          owner: '11111111111111111111111111111111',
          lamports: 500_000_000_000n,
          executable: false,
          rentEpoch: 0n,
        },
      ];
      const preSrc = accountSourceOf(withWallet as never);
      const blockhash = '11111111111111111111111111111111';

      const quoteTotal = tokenAmountAt(
        withWallet.find((a) => a.pubkey === addrs.poolQuoteTokenAccount) as never,
      );
      const tier = tierFor(tiers, quoteTotal);
      const stratum = mechanicsStratum({ canonicalPool: true, cashbackCoin: c.is_cashback_coin === 1 });

      /**
       * A fresh runtime per TOKEN.
       *
       * The client's output bound is cumulative over a worker's lifetime, and
       * observing every touched account on both sides of three steps across
       * five sizes exceeds it partway through — which killed the worker and
       * turned every remaining token into RUNTIME_UNAVAILABLE. A per-token
       * runtime keeps the bound doing its job (catching a runaway) instead of
       * capping the study.
       *
       * Sizes within a token still share one runtime and one snapshot, which is
       * what makes them comparable.
       */
      await worker.close();
      worker = new SequentialWorker({ commandTimeoutMs: 240_000, maxOutputBytes: 256 * 1024 * 1024 });

      let anySize = false;
      for (const size of SIZES_LAMPORTS) {
        // The buy, built offline from the SAME snapshot. No network per size.
        let buyBytes: string;
        try {
          const built = await buildBuyFrom(preSrc, {
            poolKey: c.canonical_pool,
            user: taker,
            quoteLamports: size,
            slippagePct: SLIPPAGE_PCT,
          });
          buyBytes = encode(built.instructions as unknown[], taker, blockhash);
        } catch {
          continue;
        }

        const priceBearing = [c.canonical_pool, addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount, c.mint];

        /**
         * OBSERVE EVERY ACCOUNT THE LEG TOUCHES, not just the price-bearing set.
         *
         * `createdAccountRentAcross` decides an account was created by comparing
         * its pre and post state — so an account the runtime was never asked
         * about is invisible to it, and reports as zero rent rather than as
         * unmeasured. That is exactly what happened: the coin-creator vault and
         * the volume accumulator were in the SNAPSHOT but not in this list, so
         * setup rent measured 0 while the drag was visibly moving in exact
         * multiples of 2,039,280 lamports.
         *
         * An account nobody observed is not an account that cost nothing.
         */
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
          ]),
        ];

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
              encode: (ixs, bh) => encode(ixs, taker, bh),
            }),
            buildCloseBase64: () =>
              encode(
                [
                  buildCloseAccount({
                    tokenAccount: takerAta,
                    destination: taker,
                    owner: taker,
                    tokenProgram: mintTokenProgram,
                    residualAtoms: 0n,
                    withheldAtoms: 0n,
                  }),
                ],
                taker,
                blockhash,
              ),
            jobId: `size-${c.mint.slice(0, 6)}-${size}`,
          },
          worker,
        );

        const row: Record<string, unknown> = {
          mint: c.mint,
          sizeLamports: size.toString(),
          stratum,
          isCashbackCoin: c.is_cashback_coin === 1,
          isMayhemMode: c.is_mayhem_mode === 1,
          feeTierRoundTripBps: tier?.roundTripBps ?? null,
          outcome: trip.ok ? 'COMPLETE' : (trip.failure ?? 'UNKNOWN'),
          detail: trip.ok ? null : (trip.detail ?? null)?.slice(0, 100) ?? null,
          quoteStateSurvived: trip.quoteStateSurvived,
        };

        if (trip.ok) {
          anySize = true;
          const before = trip.buy?.preAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0;
          const after = trip.close?.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0;
          const net = BigInt(after) - BigInt(before);
          const wsol = tokenAmountAt(trip.close?.postAccounts.find((a) => a.pubkey === takerWsol));
          const residual = tokenAmountAt(trip.close?.postAccounts.find((a) => a.pubkey === takerAta));
          const rent = createdAccountRentAcross(
            [trip.buy, trip.sell, trip.close].filter((x) => x !== null) as never,
            [takerAta],
          );
          const full = net + wsol;
          row['acquiredAtoms'] = trip.acquiredAtoms?.toString() ?? null;
          row['netLamports'] = net.toString();
          row['wsolHeldLamports'] = wsol.toString();
          row['residualAtoms'] = residual.toString();
          row['setupRentLamports'] = rent.lamports.toString();
          row['setupRentAccounts'] = rent.accounts.length;
          row['dragLamports'] = (-full).toString();
          row['dragBps'] = Number((-full * 10_000n) / size);
          row['selfImpactLamports'] = trip.selfImpactLamports?.toString() ?? null;
        }
        rows.push(row);
      }
      if (anySize) tokensDone++;
      console.log(`  ${c.mint.slice(0, 10)}  ${anySize ? 'sized' : 'no size completed'}`);
    }
  } finally {
    await worker.close();
  }

  // The surface, per size.
  const bySize = SIZES_LAMPORTS.map((size) => {
    const done = rows.filter((r) => r['sizeLamports'] === size.toString() && r['outcome'] === 'COMPLETE');
    const bps = done.map((r) => Number(r['dragBps']));
    const lam = done.map((r) => Number(r['dragLamports']));
    return {
      sizeLamports: size.toString(),
      completed: done.length,
      dragBps: {
        p50: percentile(bps, 50),
        p75: percentile(bps, 75),
        p90: percentile(bps, 90),
        worst: bps.length === 0 ? null : Math.max(...bps),
      },
      dragLamports: {
        p50: percentile(lam, 50),
        p90: percentile(lam, 90),
        worst: lam.length === 0 ? null : Math.max(...lam),
      },
      setupRentLamportsTotal: done.reduce((a, r) => a + Number(r['setupRentLamports'] ?? 0), 0),
      failedInstructionRate:
        rows.filter((r) => r['sizeLamports'] === size.toString()).length === 0
          ? null
          : 1 - done.length / rows.filter((r) => r['sizeLamports'] === size.toString()).length,
    };
  });

  /**
   * The diagnostic. Constant lamports means a FIXED cost; constant bps means a
   * proportional one. Reported explicitly so nobody has to infer it.
   */
  const medLam = bySize.map((s) => s.dragLamports.p50).filter((x): x is number => x !== null);
  const medBps = bySize.map((s) => s.dragBps.p50).filter((x): x is number => x !== null);
  const spread = (xs: number[]): number | null =>
    xs.length < 2 ? null : (Math.max(...xs) - Math.min(...xs)) / Math.max(1, Math.min(...xs));
  const lamSpread = spread(medLam);
  const bpsSpread = spread(medBps);

  const surface = {
    host,
    sizesLamports: SIZES_LAMPORTS.map((s) => s.toString()),
    tokensAttempted: new Set(rows.map((r) => r['mint'])).size,
    tokensWithAnyCompletedSize: tokensDone,
    bySize,
    costShape: {
      medianDragLamportsBySize: medLam,
      medianDragBpsBySize: medBps,
      lamportSpreadAcrossSizes: lamSpread,
      bpsSpreadAcrossSizes: bpsSpread,
      // Whichever varies LESS across a 16x size range is the one the cost is
      // actually constant in.
      verdict:
        lamSpread === null || bpsSpread === null
          ? 'insufficient sizes completed to decide'
          : lamSpread < bpsSpread
            ? 'drag is closer to CONSTANT IN LAMPORTS: a fixed cost dominates, not price impact'
            : 'drag is closer to CONSTANT IN BPS: a proportional cost dominates',
    },
    byStratum: [...new Set(rows.map((r) => r['stratum']))].map((s) => ({
      stratum: s,
      rows: rows.filter((r) => r['stratum'] === s && r['outcome'] === 'COMPLETE').length,
      medianDragBps: percentile(
        rows.filter((r) => r['stratum'] === s && r['outcome'] === 'COMPLETE').map((r) => Number(r['dragBps'])),
        50,
      ),
    })),
    rows,
  };

  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/size-cost-surface.json', JSON.stringify(surface, null, 2) + '\n');

  console.log('');
  console.log('size surface (drag, per notional):');
  for (const s of bySize) {
    console.log(
      `  ${String(s.sizeLamports).padStart(9)}  n=${String(s.completed).padStart(2)}  ` +
        `bps p50=${String(s.dragBps.p50).padStart(6)} p90=${String(s.dragBps.p90).padStart(6)}  ` +
        `lamports p50=${String(s.dragLamports.p50).padStart(9)}`,
    );
  }
  console.log('');
  console.log('lamport spread across sizes:', lamSpread?.toFixed(3));
  console.log('bps spread across sizes    :', bpsSpread?.toFixed(3));
  console.log('VERDICT:', surface.costShape.verdict);
}

await main();
