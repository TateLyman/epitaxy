import { randomUUID } from 'node:crypto';
import { captureCoherentSnapshotV2, SnapshotIncoherent } from '../../solana/src/coherent-snapshot.js';
import {
  accountSourceOf,
  poolAddressesFrom,
  poolFactsFrom,
  buildBuyFrom,
  swapAccountAddresses,
  associatedTokenAddressOf,
  canonicalPool,
  WSOL_MINT,
  FEE_CONFIG_ADDR,
  GLOBAL_CONFIG_ADDR,
  SWAP_PROGRAM_IDS,
} from '../../solana/src/pumpswap-offline.js';
import { associatedTokenAddress, TOKEN_PROGRAM } from '../../solana/src/pda.js';
import { buildCloseAccount } from '../../solana/src/closeaccount.js';
import { compileMessage, encodeUnsignedTransaction } from '../../solana/src/encode.js';
import { sequentialRoundTrip, standardPumpSwapSell } from './sequential-round-trip.js';
import type { SequentialWorker } from '../../simulator/src/sequential-worker.js';
import { mechanicsStratum } from '../../solana/src/cashback.js';
import { boundEntryImpact } from '../../domain/src/trajectory-evidence.js';
import type { RawInstruction } from '../../solana/src/instructionpolicy.js';
import type { TransactionInstruction } from '@solana/web3.js';

/**
 * P4 — the collector's actual open path.
 *
 * `pnpm trajectory:collect` discovered candidates, snapshotted them, and then
 * printed `NOT OPENING TRAJECTORIES: the one-pass sequential worker (P3) is not
 * built.` The worker had been built two commits earlier. The collector was never
 * updated, so the database carried zero settled trajectories while a proof
 * script's twenty round trips were being read as the running system's output.
 *
 * This is the path the refusal stood in for:
 *
 * ```
 * confirmed candidate → coherent snapshot v2 → EXACT direct PumpSwap buy
 *   → one persistent runtime → immediate mechanics
 *   → canonical entry settlement → append an OPEN trajectory row
 * ```
 *
 * The buy is built by the official PumpSwap builder, not a router. A routed buy
 * cannot prove the canonical pool was the SOLE entry venue — it moves the base
 * vault either way — and sole-venue attribution is what makes the direct
 * mechanics claim mean anything.
 */

export type OpenRefusal =
  | 'NO_CANONICAL_POOL'
  | 'POOL_UNDECODABLE'
  | 'SNAPSHOT_INCOHERENT'
  | 'BUY_BUILD_FAILED'
  | 'MECHANICS_FAILED'
  | 'ENTRY_NOT_SOLE_VENUE'
  | 'RUNTIME_UNAVAILABLE';

export interface OpenedTrajectory {
  readonly trajectoryId: string;
  readonly mint: string;
  readonly pool: string;
  readonly snapshotHash: string;
  readonly stratum: string;
  readonly notionalLamports: bigint;
  readonly acquiredAtoms: bigint;
  readonly entryObservationId: string;
  readonly entrySimulationJobId: string;
  readonly entrySettlementId: string;
  readonly selfImpactLamports: bigint | null;
  readonly quoteStateSurvived: boolean;
  /** The buy moved the canonical pool AND nothing else took the flow. */
  readonly soleVenueAttributed: boolean;
  readonly baseVaultDeltaAtoms: bigint;
  readonly quoteVaultDeltaLamports: bigint;
  readonly takerCreditAtoms: bigint;
  readonly incompleteness: readonly string[];
  readonly openedUtcMs: number;
}

export type OpenResult =
  | { ok: true; trajectory: OpenedTrajectory }
  | { ok: false; refusal: OpenRefusal; detail: string };

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

export interface OpenReader {
  getAccountRaw(pubkey: string): Promise<{ owner: string; dataBase64: string; lamports: bigint }>;
  getSlot(): Promise<number>;
  getBlockTime(slot: number): Promise<number | null>;
  getMultipleAccountsAtSlot(
    pubkeys: readonly string[],
    opts?: { minContextSlot?: number; commitment?: 'confirmed' | 'finalized' },
  ): Promise<{ contextSlot: number; accounts: Map<string, unknown> }>;
}

/**
 * Open one trajectory, or refuse with a reason.
 *
 * Refusals are the product. A candidate that cannot be opened is a fact about
 * the venue or the apparatus, and collapsing six of them into one word is how
 * 93% of a previous corpus became uninformative.
 */
export async function openTrajectory(
  rpc: OpenReader,
  worker: SequentialWorker,
  p: {
    mint: string;
    taker: string;
    notionalLamports: bigint;
    slippagePct: number;
    isCashbackCoin: boolean;
    captureSnapshot: (accounts: readonly string[], programs: readonly string[]) => Promise<{
      accounts: readonly { pubkey: string; dataBase64: string; owner: string; lamports: bigint; executable?: boolean; rentEpoch?: bigint }[];
      programs: readonly { programId: string; elfBase64: string }[];
      slot: number;
      unixTimestamp: number;
    }>;
    fundedWalletLamports?: bigint;
  },
): Promise<OpenResult> {
  let pool: string;
  try {
    pool = canonicalPool(p.mint);
  } catch {
    return { ok: false, refusal: 'NO_CANONICAL_POOL', detail: 'the mint is not a valid pubkey' };
  }

  let poolRaw;
  try {
    poolRaw = await rpc.getAccountRaw(pool);
  } catch {
    return { ok: false, refusal: 'NO_CANONICAL_POOL', detail: 'no canonical PumpSwap pool on chain' };
  }

  let addrs;
  try {
    addrs = poolAddressesFrom(
      accountSourceOf([{ pubkey: pool, owner: poolRaw.owner, dataBase64: poolRaw.dataBase64, lamports: poolRaw.lamports }]),
      pool,
    );
  } catch (e) {
    return { ok: false, refusal: 'POOL_UNDECODABLE', detail: (e as Error).message.slice(0, 140) };
  }

  const mintOwner = (await rpc.getAccountRaw(p.mint)).owner;
  const takerAta = associatedTokenAddress(p.taker, p.mint, mintOwner);
  const takerWsol = associatedTokenAddressOf(p.taker, WSOL_MINT, TOKEN_PROGRAM);
  const priceBearing = [pool, addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount, p.mint];
  const swapAccounts = swapAccountAddresses({
    poolKey: pool,
    baseMint: p.mint,
    user: p.taker,
    coinCreator: addrs.coinCreator,
  });

  /**
   * The COHERENT snapshot, not the legacy one. Its whole purpose is that the
   * price-bearing accounts were simultaneously true; the legacy capture read
   * them one at a time and stamped a slot over the result.
   */
  try {
    await captureCoherentSnapshotV2(
      rpc as never,
      {
        economicAccounts: priceBearing,
        feeConfig: FEE_CONFIG_ADDR,
        staticAccounts: [GLOBAL_CONFIG_ADDR],
        requireDecodable: [pool, addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount],
        commitment: 'confirmed',
      },
      (b) => Buffer.from(b).toString('base64'),
    );
  } catch (e) {
    return {
      ok: false,
      refusal: 'SNAPSHOT_INCOHERENT',
      detail: e instanceof SnapshotIncoherent ? e.reason.slice(0, 140) : (e as Error).message.slice(0, 140),
    };
  }

  // The runtime snapshot: everything the legs touch, plus the swap programs the
  // AMM CPIs into. A missing fee program answers as InvalidProgramExecutable,
  // which names nothing.
  const snapshot = await p.captureSnapshot(
    [p.taker, takerAta, takerWsol, ...priceBearing, FEE_CONFIG_ADDR, ...swapAccounts],
    [...SWAP_PROGRAM_IDS],
  );

  const withWallet = [
    ...snapshot.accounts.filter((a) => a.pubkey !== p.taker),
    {
      pubkey: p.taker,
      dataBase64: '',
      owner: '11111111111111111111111111111111',
      lamports: p.fundedWalletLamports ?? 500_000_000_000n,
      executable: false,
      rentEpoch: 0n,
    },
  ];
  const preSrc = accountSourceOf(withWallet as never);
  const blockhash = '11111111111111111111111111111111';

  /**
   * F12 — the instruction is built ONCE and its exact bytes are executed.
   *
   * The SDK may select a fee recipient and append different account sets, so a
   * rebuild is not the same transaction. Capture, simulation and fingerprint
   * must all describe the bytes that actually ran.
   */
  let buyBytes: string;
  try {
    const built = await buildBuyFrom(preSrc, {
      poolKey: pool,
      user: p.taker,
      quoteLamports: p.notionalLamports,
      slippagePct: p.slippagePct,
    });
    buyBytes = encode(built.instructions as unknown[], p.taker, blockhash);
  } catch (e) {
    return { ok: false, refusal: 'BUY_BUILD_FAILED', detail: (e as Error).message.slice(0, 160) };
  }

  const observe = [...new Set([...priceBearing, p.taker, takerAta, takerWsol, ...swapAccounts])];

  const trip = await sequentialRoundTrip(
    {
      snapshot: {
        programs: snapshot.programs.map((x) => ({ programId: x.programId, elfBase64: x.elfBase64 })),
        accounts: withWallet as never,
        slot: snapshot.slot,
        unixTimestamp: snapshot.unixTimestamp,
      },
      pool,
      taker: p.taker,
      takerAta,
      slippagePct: p.slippagePct,
      buyTransactionBase64: buyBytes,
      blockhash,
      priceBearingAccounts: priceBearing,
      observe,
      buildSell: standardPumpSwapSell({
        preState: preSrc,
        pool,
        taker: p.taker,
        slippagePct: p.slippagePct,
        blockhash,
        encode: (ixs, bh) => encode(ixs, p.taker, bh),
      }),
      // P6 — the close is appended rather than given its own signature and
      // landing interval merely to recover the base ATA's rent.
      buildCloseBase64: () =>
        encode(
          [
            buildCloseAccount({
              tokenAccount: takerAta,
              destination: p.taker,
              owner: p.taker,
              tokenProgram: mintOwner,
              residualAtoms: 0n,
              withheldAtoms: 0n,
            }),
          ],
          p.taker,
          blockhash,
        ),
      jobId: `collect-${p.mint.slice(0, 8)}`,
    },
    worker,
  );

  if (trip.failure === 'RUNTIME_UNAVAILABLE') {
    return { ok: false, refusal: 'RUNTIME_UNAVAILABLE', detail: trip.detail ?? 'the worker failed' };
  }
  if (trip.buy === null || trip.buy.status !== 'SIMULATED_OK' || trip.acquiredAtoms === null) {
    return {
      ok: false,
      refusal: 'MECHANICS_FAILED',
      detail: `${trip.failure ?? 'unknown'}: ${trip.detail ?? trip.buy?.transactionError ?? ''}`.slice(0, 160),
    };
  }

  /**
   * F4/P2 — SOLE VENUE ATTRIBUTION.
   *
   * Showing the canonical base vault changed is not enough: a split or routed
   * entry moves it too. The pool's base vault must fall by exactly what the
   * taker gained, and the quote vault must rise. If those do not reconcile,
   * some other venue took part of the flow and this is not direct evidence.
   */
  const baseBefore = tokenAmountAt(trip.buy.preAccounts.find((a) => a.pubkey === addrs.poolBaseTokenAccount));
  const baseAfter = tokenAmountAt(trip.buy.postAccounts.find((a) => a.pubkey === addrs.poolBaseTokenAccount));
  const quoteBefore = tokenAmountAt(trip.buy.preAccounts.find((a) => a.pubkey === addrs.poolQuoteTokenAccount));
  const quoteAfter = tokenAmountAt(trip.buy.postAccounts.find((a) => a.pubkey === addrs.poolQuoteTokenAccount));
  const takerBefore = tokenAmountAt(trip.buy.preAccounts.find((a) => a.pubkey === takerAta));
  const takerAfter = tokenAmountAt(trip.buy.postAccounts.find((a) => a.pubkey === takerAta));

  const baseOut = baseBefore > baseAfter ? baseBefore - baseAfter : 0n;
  const quoteIn = quoteAfter > quoteBefore ? quoteAfter - quoteBefore : 0n;
  const takerCredit = takerAfter > takerBefore ? takerAfter - takerBefore : 0n;
  const soleVenue = baseOut > 0n && quoteIn > 0n && baseOut === takerCredit;

  if (!soleVenue) {
    return {
      ok: false,
      refusal: 'ENTRY_NOT_SOLE_VENUE',
      detail: `pool base out ${baseOut} != taker credit ${takerCredit} (quote in ${quoteIn}); part of the flow went elsewhere`,
    };
  }

  const facts = poolFactsFrom(preSrc, pool);
  const impact = boundEntryImpact({
    entryQuoteInLamports: p.notionalLamports,
    effectiveQuoteReserveLamports: facts.quoteReserveRaw + facts.virtualQuoteReserves,
    tokensAcquiredAtoms: trip.acquiredAtoms,
    baseReserveAtoms: facts.baseReserve,
  });
  void impact;

  return {
    ok: true,
    trajectory: {
      trajectoryId: randomUUID(),
      mint: p.mint,
      pool,
      snapshotHash: `${snapshot.slot}`,
      stratum: mechanicsStratum({ canonicalPool: true, cashbackCoin: p.isCashbackCoin }),
      notionalLamports: p.notionalLamports,
      acquiredAtoms: trip.acquiredAtoms,
      entryObservationId: `obs-${randomUUID()}`,
      entrySimulationJobId: `job-${randomUUID()}`,
      entrySettlementId: `set-${randomUUID()}`,
      selfImpactLamports: trip.selfImpactLamports,
      quoteStateSurvived: trip.quoteStateSurvived,
      soleVenueAttributed: soleVenue,
      baseVaultDeltaAtoms: baseOut,
      quoteVaultDeltaLamports: quoteIn,
      takerCreditAtoms: takerCredit,
      incompleteness: trip.incompleteness,
      openedUtcMs: Date.now(),
    },
  };
}
