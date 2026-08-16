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
  swapAccountRoles,
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
import { observedTokenAtoms, RENT_EXEMPT_EPOCH } from '../../simulator/src/sequential-runtime.js';
import {
  mechanicsStratum,
  expectedRemainingTail,
  remainingTailRefusal,
  legCashbackDeltas,
  type LegCashbackDeltas,
} from '../../solana/src/cashback.js';
import { AMM_PROGRAM_ID } from '../../solana/src/pumpswap-offline.js';
import { boundEntryImpact } from '../../domain/src/trajectory-evidence.js';
import type { RawInstruction } from '../../solana/src/instructionpolicy.js';
import { freezeAccountPlan, planAccountsNotCaptured, type AccountPlan } from '../../solana/src/account-plan.js';
import { frozenComputeLimit, type ComputeBudgetPlan } from '../../solana/src/cu-budget.js';
import {
  classifyCreatedAccount,
  summariseSetup,
  requiresSharedAccountCreation,
  type CreatedAccount,
  type SetupEconomics,
} from '../../solana/src/created-accounts.js';
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
  /**
   * P7/F14 — the pool is cashback-enabled and the built leg does not carry the
   * remaining accounts in the exact positions the program reads.
   *
   * A refusal rather than a note, because the failure is SILENT: the
   * transaction lands, the trade executes normally, and the creator fee simply
   * goes to the creator. Nothing distinguishes it afterwards from a leg that
   * claimed the cashback, and the difference at the bottom canonical tier is 30
   * bps per leg.
   */
  | 'CASHBACK_ACCOUNTS_MISPLACED'
  /**
   * P2 — the built instruction touches an account the snapshot never fetched.
   *
   * A refusal rather than a warning, because the runtime would execute against
   * an uninitialised account and answer with something that reads as a fact
   * about the token.
   */
  | 'PLAN_ACCOUNT_UNCAPTURED'
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
  /**
   * P6 — the base token account was gone after the sell, so its rent came back
   * inside the exit rather than costing a third signature and landing interval.
   *
   * Measured from the sell's post-state, never inferred from having appended
   * the instruction.
   */
  readonly baseAtaClosedInSell: boolean | null;
  /**
   * P6 — what each leg actually consumed, and the limit a live leg should
   * therefore request.
   *
   * Solana charges the priority fee against the REQUESTED limit, so a leg that
   * omits `SetComputeUnitLimit` pays against the derived 200,000-per-instruction
   * allocation rather than against what it used. Development legs run in an
   * isolated runtime and pay no priority fee, which is exactly why the figure
   * has to be measured here — there is nowhere else it can come from before a
   * live path exists.
   */
  readonly buyComputeUnits: number | null;
  readonly sellComputeUnits: number | null;
  readonly computeBudget: ComputeBudgetPlan | null;
  /** The buy moved the canonical pool AND nothing else took the flow. */
  readonly soleVenueAttributed: boolean;
  readonly baseVaultDeltaAtoms: bigint;
  readonly quoteVaultDeltaLamports: bigint;
  readonly takerCreditAtoms: bigint;
  /**
   * P2/F12 — the exact plan of the bytes that ran.
   *
   * Ordered account metas, instruction data and the fee recipient the SDK
   * actually selected. Persisted so a replay compares against what happened
   * rather than against what a rebuild would probably produce.
   */
  readonly entryPlan: AccountPlan;
  /**
   * P2/P7 — the exit's exact plan, frozen from the bytes the sell executed.
   *
   * Null only when the builder reported no instructions. The sell is built
   * inside the runtime from post-buy state, so this is the only place its plan
   * can come from — and it is the plan the cashback tail was verified against.
   */
  readonly exitPlan: AccountPlan | null;
  /**
   * P6 — every account the entry brought into existence, and who benefits.
   *
   * The size surface reported ZERO created-account rent on every row while
   * total drag ran to 0.010–0.012 SOL, because the accounts the transaction
   * created were not in anyone's observe list. An account nobody observed
   * reports identically to one that cost nothing.
   */
  readonly createdAccounts: readonly CreatedAccount[];
  readonly setup: SetupEconomics;
  /**
   * P7 — what each leg moved through the cashback accounts, kept per leg.
   *
   * BOTH legs accrue. The repository asserted for two commits that `sell`
   * carries no volume accumulator, and modelling one leg instead of two
   * understated the retained round trip by roughly half. One summed number
   * cannot show whether the second leg accrued, so they are never summed here.
   */
  readonly cashbackLegs: readonly LegCashbackDeltas[];
  /** The exact remaining-account tail the built legs were verified against. */
  readonly cashbackVerified: boolean;
  /**
   * True when the entry had to open an account another trader's organic
   * transaction would have opened anyway — or one we could not classify.
   *
   * P6's stratum boundary. A candidate like this is COLD and does not belong in
   * the same average as a warm one, because most of its cost is a one-time
   * payment on behalf of everyone who trades the pool afterwards.
   */
  readonly requiresSharedSetup: boolean;
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

const tokenAmountAt = observedTokenAtoms;

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
   * P6/P7 — the same addresses, NAMED.
   *
   * `swapAccountAddresses` returns a bag, and a bag is what a classifier cannot
   * use: every account the buy created came back `UNKNOWN`, which the warm gate
   * treats as shared. Correct but uninformative — an entry that opened only its
   * own recoverable ATAs was indistinguishable from one that paid a creator
   * vault's rent, which is the exact distinction P6 exists to draw.
   */
  const roles = swapAccountRoles({
    user: p.taker,
    baseMint: p.mint,
    coinCreator: addrs.coinCreator,
    quoteMint: WSOL_MINT,
    quoteTokenProgram: TOKEN_PROGRAM,
  });

  /**
   * The COHERENT snapshot, not the legacy one. Its whole purpose is that the
   * price-bearing accounts were simultaneously true; the legacy capture read
   * them one at a time and stamped a slot over the result.
   */
  let coherent;
  try {
    coherent = await captureCoherentSnapshotV2(
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
      // Exempt, like every funded system account on mainnet. Rent epoch 0
      // restores it as rent-PAYING, which is a different account.
      rentEpoch: RENT_EXEMPT_EPOCH,
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
  let buyPlan: AccountPlan;
  try {
    const built = await buildBuyFrom(preSrc, {
      poolKey: pool,
      user: p.taker,
      quoteLamports: p.notionalLamports,
      slippagePct: p.slippagePct,
    });
    const raw = (built.instructions as (TransactionInstruction | RawInstruction)[]).map(toRaw);
    // Frozen from the SAME array that is encoded on the next line. Not a
    // rebuild, not a re-derivation: the plan describes these bytes.
    buyPlan = freezeAccountPlan('buy', raw);
    buyBytes = encode(built.instructions as unknown[], p.taker, blockhash);
  } catch (e) {
    return { ok: false, refusal: 'BUY_BUILD_FAILED', detail: (e as Error).message.slice(0, 160) };
  }

  /**
   * P7/F14 — does the built BUY actually carry the cashback account?
   *
   * `buildBuyFrom` calls the SDK, and the SDK appends the accumulator ATA
   * whenever the decoded pool reports `isCashbackCoin`. So it probably works —
   * and "probably works, and nothing checks" is the exact shape of defect this
   * project keeps rediscovering. Here it is worth 30 bps per leg, and it fails
   * SILENTLY: the transaction lands, the trade executes normally, and the
   * creator fee goes to the creator.
   *
   * Checked against the FROZEN plan, so what is verified is what will run.
   */
  // `PublicKey.default` is how the pool says "no coin creator", and it is the
  // same branch the SDK takes when deciding whether to append the pool-v2 PDA.
  const hasCoinCreator = addrs.coinCreator !== '11111111111111111111111111111111';
  /**
   * The DECODED pool, not the caller's belief about it.
   *
   * The collector reads `is_cashback_coin` off a `confirmed_migrations` row
   * that may be hours old, while the SDK appends the account based on what the
   * pool says right now. Verifying against the stale value would check the
   * builder against a different question than the one it answered.
   */
  const isCashback = addrs.isCashbackCoin ?? p.isCashbackCoin;
  const buyTail = expectedRemainingTail({
    leg: 'buy',
    isCashbackCoin: isCashback,
    hasCoinCreator,
    accumulatorWsolAta: roles.accumulatorWsolAta,
    userVolumeAccumulator: roles.userVolumeAccumulator,
    poolV2: roles.poolV2,
  });
  const buySwap = buyPlan.instructions.find((i) => i.programId === AMM_PROGRAM_ID);
  if (buySwap === undefined) {
    return {
      ok: false,
      refusal: 'CASHBACK_ACCOUNTS_MISPLACED',
      detail: 'the built buy contains no PumpSwap AMM instruction, so its remaining accounts cannot be located',
    };
  }
  const buyTailRefusal = remainingTailRefusal({
    leg: 'buy',
    swapInstructionAccounts: buySwap.accounts.map((a) => a.pubkey),
    expected: buyTail,
  });
  if (buyTailRefusal !== null) {
    return { ok: false, refusal: 'CASHBACK_ACCOUNTS_MISPLACED', detail: buyTailRefusal.slice(0, 200) };
  }

  /**
   * P2 — every account the BUILT instruction touches is in the captured state.
   *
   * The snapshot was assembled from `swapAccountAddresses`, which RE-DERIVES
   * what it believes the leg will use. The plan says what it actually uses, and
   * on live pools the two differ by fifteen accounts: the SDK selects a fee
   * recipient from a list, derives ATAs under whichever token program the mint
   * uses, appends remaining accounts when cashback applies, and names the
   * builtin programs the instruction invokes. None of that is predictable from
   * a pool address, which is the whole of F12.
   *
   * An account missing from the runtime does not fail loudly. It executes as
   * uninitialised and answers with an error that reads as a fact about the
   * token, which is the substitution this module exists to prevent.
   *
   * So they are FETCHED, not guessed at a second time. This is a second read
   * rather than a second capture: the price-bearing accounts from the coherent
   * snapshot are untouched, and only accounts the plan named are added. Those
   * are fee recipients, ATAs and programs — none of them bear price, which is
   * the same boundary the coherent snapshot's drift bound already draws.
   */
  const capturedKeys = withWallet.map((a) => a.pubkey);
  let planAccounts = withWallet;
  let extraPrograms: typeof snapshot.programs = [];
  const missing = planAccountsNotCaptured(buyPlan, [...capturedKeys, p.taker]);
  const stillAbsent: string[] = [];

  if (missing.length > 0) {
    try {
      const probe = await p.captureSnapshot(missing, []);
      // An executable account restored through `set_account` populates no
      // program cache, and every route through it then fails with an invalid
      // program error. Programs go back through the program path.
      const execs = probe.accounts.filter((a) => a.executable === true).map((a) => a.pubkey);
      const extra = execs.length > 0 ? await p.captureSnapshot(missing, execs) : probe;

      const have = new Set(capturedKeys);
      planAccounts = [
        ...withWallet,
        ...extra.accounts.filter((a) => !have.has(a.pubkey)).map((a) => ({ ...a, rentEpoch: a.rentEpoch ?? RENT_EXEMPT_EPOCH })),
      ];
      extraPrograms = extra.programs.filter((x) => !snapshot.programs.some((y) => y.programId === x.programId));

      // Whatever is STILL missing does not exist on chain. That is a fact, not
      // a failure: the transaction is about to create it, and an account the
      // chain does not have cannot be captured from it.
      stillAbsent.push(...planAccountsNotCaptured(buyPlan, [...planAccounts.map((a) => a.pubkey), p.taker]));
    } catch (e) {
      return {
        ok: false,
        refusal: 'PLAN_ACCOUNT_UNCAPTURED',
        detail: `the built buy touches ${missing.length} uncaptured account(s) and the fetch failed: ${(e as Error).message.slice(0, 90)}`,
      };
    }
  }

  /**
   * P6/P7 — the accounts whose EXISTENCE and BALANCE the economics depend on.
   *
   * `swapAccounts` covers what the SDK names, but not the two the cashback path
   * actually moves money through: the accumulator's WSOL ATA (where cashback
   * lands) and the `pool-v2` PDA. An account absent from `observe` reports as
   * neither created nor credited, which is how the size surface came to report
   * zero created-account rent on every row.
   */
  const cashbackAccounts = [roles.accumulatorWsolAta, roles.poolV2, roles.userVolumeAccumulator].filter(
    (a): a is string => a !== null,
  );
  const observe = [...new Set([...priceBearing, p.taker, takerAta, takerWsol, ...swapAccounts, ...cashbackAccounts])];

  const trip = await sequentialRoundTrip(
    {
      snapshot: {
        programs: [...snapshot.programs, ...extraPrograms].map((x) => ({
          programId: x.programId,
          elfBase64: x.elfBase64,
        })),
        accounts: planAccounts as never,
        slot: snapshot.slot,
        unixTimestamp: snapshot.unixTimestamp,
        /**
         * F9 — the sysvars the COHERENT snapshot actually decoded.
         *
         * These were computed and discarded: the coherent capture ran purely as
         * a drift check and its clock, rent and epoch schedule went nowhere,
         * while the runtime derived `epoch = slot / 432_000` and left Rent at a
         * default. That is wrong by five epochs at today's slot, and a program
         * sizing an account it creates got a rent answer mainnet never gave.
         *
         * Required rather than optional: this caller DID capture exact state,
         * so accepting a derived clock would be an approximation wearing the
         * label of a capture.
         */
        clock: coherent.clock,
        rent: coherent.rent,
        epochSchedule: coherent.epochSchedule,
        requireExactSysvars: true,
        // Without the pool and its vaults this runtime is not the one we asked
        // for, and the failure would read as a fact about the token.
        requiredAccounts: priceBearing,
        requiredPrograms: [...SWAP_PROGRAM_IDS],
      },
      pool,
      taker: p.taker,
      takerAta,
      slippagePct: p.slippagePct,
      buyTransactionBase64: buyBytes,
      blockhash,
      priceBearingAccounts: priceBearing,
      /**
       * F8 — every account whose BYTES something downstream decodes.
       *
       * The pool and its vaults because the sell is built from them; the two
       * token accounts because the acquired amount and the residual WSOL are
       * read out of them. The rest of `observe` — global config, fee
       * recipients, creator vaults, the wallet — is watched for its balance,
       * its owner and whether the transaction created it, and none of that
       * needs a payload.
       *
       * Getting this set wrong REFUSES by name rather than silently reading an
       * empty account as an empty balance. That is the only reason scoping the
       * output is safe to do at all.
       */
      economicAccounts: [...priceBearing, takerAta, takerWsol],
      observe,
      buildSell: standardPumpSwapSell({
        preState: preSrc,
        pool,
        taker: p.taker,
        slippagePct: p.slippagePct,
        blockhash,
        encode: (ixs, bh) => encode(ixs, p.taker, bh),
        /**
         * P6 — the close rides IN the sell, not after it.
         *
         * It used to be a third step with its own signature and its own landing
         * interval, spent purely to recover the base ATA's ~2,039,280 lamports
         * of rent. The lamports are worth the 5,000 lamport signature; the
         * interval is the expensive part, and a separate transaction is one
         * more thing that can fail once the position is already flat.
         *
         * The sell has just emptied the account, so `residualAtoms` is zero by
         * construction — and if it is not, `buildCloseAccount` refuses here
         * rather than producing an instruction the runtime rejects.
         */
        appendInstructions: () => [
          buildCloseAccount({
            tokenAccount: takerAta,
            destination: p.taker,
            owner: p.taker,
            tokenProgram: mintOwner,
            residualAtoms: 0n,
            withheldAtoms: 0n,
          }),
        ],
        /**
         * P7/F13 — the SELL's tail, which is TWO accounts, not one.
         *
         * This is the correction. The repository asserted that `sell` carries
         * no volume accumulator, because the IDL names it only on the
         * instructions that manage it directly. It carries two of them as
         * optional positional remaining accounts, and modelling one leg's
         * creator-fee recovery instead of two understated the retained round
         * trip by roughly half.
         *
         * Verified BEFORE the sell executes. A sell with the accounts missing
         * lands and trades normally, so there is nothing to catch afterwards.
         */
        verify: (ixs) => {
          const raw = (ixs as (TransactionInstruction | RawInstruction)[]).map(toRaw);
          const swap = raw.find((i) => i.programId === AMM_PROGRAM_ID);
          if (swap === undefined) {
            return 'the built sell contains no PumpSwap AMM instruction, so its remaining accounts cannot be located';
          }
          return remainingTailRefusal({
            leg: 'sell',
            swapInstructionAccounts: (swap.accounts ?? []).map((a) => a.pubkey),
            expected: expectedRemainingTail({
              leg: 'sell',
              isCashbackCoin: isCashback,
              hasCoinCreator,
              accumulatorWsolAta: roles.accumulatorWsolAta,
              userVolumeAccumulator: roles.userVolumeAccumulator,
              poolV2: roles.poolV2,
            }),
          });
        },
      }),
      // Checked against the sell's own post-state, so "appended a close" is
      // never mistaken for "the account is gone".
      takerBaseAtaToClose: takerAta,
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

  /**
   * P6 — classify what the buy actually created.
   *
   * Present-and-absent are read from the step's own pre/post observation, so
   * this measures the transaction rather than re-deriving what it "should"
   * have done. `dataLen` is reported even for accounts whose bytes were
   * withheld, which is why scoping the worker output did not cost this.
   */
  const preByKey = new Map(trip.buy.preAccounts.map((a) => [a.pubkey, a]));
  const createdAccounts: CreatedAccount[] = [];
  for (const post of trip.buy.postAccounts) {
    const prior = preByKey.get(post.pubkey);
    const existed = prior !== undefined && (prior.lamports > 0n || prior.dataLen > 0);
    if (existed || post.lamports <= 0n) continue;
    createdAccounts.push(
      classifyCreatedAccount(
        { pubkey: post.pubkey, owner: post.owner, space: post.dataLen, lamports: post.lamports },
        {
          taker: p.taker,
          takerBaseAta: takerAta,
          takerQuoteAta: takerWsol,
          pool,
          poolBaseVault: addrs.poolBaseTokenAccount,
          poolQuoteVault: addrs.poolQuoteTokenAccount,
          baseMint: p.mint,
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
  }
  const setup = summariseSetup(createdAccounts);

  /**
   * P7/F14 — what each leg MOVED through the cashback accounts.
   *
   * Measured per leg and stored per leg. The whole F13 correction is that both
   * legs accrue, so a model that reports one summed number cannot show whether
   * the second one did — which is precisely the evidence the correction needs.
   *
   * `accruedToUs` is the discriminating fact: the creator fee goes either to the
   * accumulator or to the creator's vault, never both. Both moving, or neither,
   * means something other than the modelled path happened and the leg is not
   * evidence for either.
   */
  const balanceIn = (accounts: readonly { pubkey: string; lamports: bigint }[]) => (key: string): bigint | null =>
    accounts.find((a) => a.pubkey === key)?.lamports ?? null;

  const feeRecipient = buySwap.accounts.map((a) => a.pubkey).find((a) => a === roles.coinCreatorVaultAta) ?? null;
  const cashbackLegs: LegCashbackDeltas[] = [
    legCashbackDeltas({
      leg: 'buy',
      before: balanceIn(trip.buy.preAccounts),
      after: balanceIn(trip.buy.postAccounts),
      accumulatorWsolAta: roles.accumulatorWsolAta,
      userVolumeAccumulator: roles.userVolumeAccumulator,
      coinCreatorVaultAta: roles.coinCreatorVaultAta,
      feeRecipient,
    }),
    ...(trip.sell === null
      ? []
      : [
          legCashbackDeltas({
            leg: 'sell',
            before: balanceIn(trip.sell.preAccounts),
            after: balanceIn(trip.sell.postAccounts),
            accumulatorWsolAta: roles.accumulatorWsolAta,
            userVolumeAccumulator: roles.userVolumeAccumulator,
            coinCreatorVaultAta: roles.coinCreatorVaultAta,
            feeRecipient,
          }),
        ]),
  ];

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
      baseAtaClosedInSell: trip.baseAtaClosedInSell,
      buyComputeUnits: trip.buy.computeUnitsConsumed,
      sellComputeUnits: trip.sell?.computeUnitsConsumed ?? null,
      // The limit is set from the LARGER leg. One limit is requested per
      // transaction, and sizing it to the buy would fail every sell that costs
      // more — which the appended close makes likely, not hypothetical.
      computeBudget: frozenComputeLimit(
        Math.max(trip.buy.computeUnitsConsumed ?? 0, trip.sell?.computeUnitsConsumed ?? 0) || null,
      ),
      soleVenueAttributed: soleVenue,
      baseVaultDeltaAtoms: baseOut,
      quoteVaultDeltaLamports: quoteIn,
      takerCreditAtoms: takerCredit,
      // P2 — the exact plan of the bytes that ran, not a description of what a
      // rebuild would probably produce.
      entryPlan: buyPlan,
      // Frozen from the instructions the builder returned, not from a rebuild.
      // A rebuilt sell would price against different state and could select a
      // different fee recipient, which is the whole of F12.
      exitPlan:
        trip.sellInstructions === null
          ? null
          : freezeAccountPlan(
              'sell',
              (trip.sellInstructions as (TransactionInstruction | RawInstruction)[]).map(toRaw),
            ),
      createdAccounts,
      setup,
      cashbackLegs,
      // Both tails were checked against the frozen plans before either leg ran.
      // A trajectory that reached here on a cashback coin carries the accounts.
      cashbackVerified: isCashback,
      requiresSharedSetup: requiresSharedAccountCreation(createdAccounts),
      incompleteness: [
        ...trip.incompleteness,
        // Named rather than dropped. An account the chain does not have is
        // correctly absent from the runtime, and the transaction creating it is
        // exactly the cold-setup cost P6 is trying to measure.
        ...stillAbsent.map((a) => `plan account absent on chain, created by the leg: ${a}`),
        // This SDK build has no `isCashbackCoin` field at all, which is a fact
        // about the build and not about the pool. Named rather than read as
        // "not a cashback coin", because the two produce different economics
        // and only one of them is something the pool said.
        ...(addrs.isCashbackCoin === null
          ? ['the decoded pool carries no isCashbackCoin field, so the cashback regime is the caller-supplied belief']
          : []),
      ],
      openedUtcMs: Date.now(),
    },
  };
}
