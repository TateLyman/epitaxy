import { randomUUID } from 'node:crypto';
import { captureCoherentSnapshotV2, SnapshotIncoherent, CLOCK_SYSVAR } from '../../solana/src/coherent-snapshot.js';
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
  namedQuoteDestinations,
} from '../../solana/src/pumpswap-offline.js';
import { associatedTokenAddress, TOKEN_PROGRAM } from '../../solana/src/pda.js';
import { buildCloseAccount } from '../../solana/src/closeaccount.js';
import { compileMessage, encodeUnsignedTransaction } from '../../solana/src/encode.js';
import { sequentialRoundTrip, standardPumpSwapSell } from './sequential-round-trip.js';
import type { ReplayStep } from './event-replay.js';
import type { AccountBytesSource } from '../../solana/src/pumpswap-offline.js';
import type { SequentialWorker } from '../../simulator/src/sequential-worker.js';
import { observedTokenAtoms, RENT_EXEMPT_EPOCH } from '../../simulator/src/sequential-runtime.js';
import {
  mechanicsStratum,
  expectedRemainingTail,
  remainingTailRefusal,
  legCashbackDeltas,
  selectedTrailingAccounts,
  type LegCashbackDeltas,
} from '../../solana/src/cashback.js';
import { AMM_PROGRAM_ID } from '../../solana/src/pumpswap-offline.js';
import { boundEntryImpact, attributeSoleVenue } from '../../domain/src/trajectory-evidence.js';
import type { RawInstruction } from '../../solana/src/instructionpolicy.js';
import {
  freezeAccountPlan,
  planAccountsNotCaptured,
  planFromEncodedTransaction,
  assertPlanMatchesBytes,
  assertPlanUnchanged,
  AccountPlanIncomplete,
  type AccountPlan,
} from '../../solana/src/account-plan.js';
import {
  observationId,
  workerJobId,
  settlementIdFor,
  capabilityFingerprintOf,
  assertIsHash,
} from '../../domain/src/evidence-identity.js';
import { frozenComputeLimit, type ComputeBudgetPlan } from '../../solana/src/cu-budget.js';
import { feeTiersOf, tierForPool, type FeeTier } from '../../solana/src/fee-tiers.js';
import { SIMULATION_PROTOCOL_VERSION } from '../../simulator/src/protocol.js';
import {
  version as PUMP_SDK_VERSION,
  swapVersion as PUMP_SWAP_SDK_VERSION,
} from '../../domain/src/sdk-versions.js';
import { legSettlementFromRuntime, coverageGap, type ObservedAccount } from './leg-settlement.js';
import {
  buildTrajectorySettlement,
  checkIdentities,
  type TrajectorySettlement,
  type CashbackFacts,
} from '../../domain/src/trajectory-settlement.js';
import type { MeasuredLegSettlement } from '../../domain/src/settlement.js';
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
  /**
   * P2.2 — deterministic, content-bound and RESOLVABLE.
   *
   * These were three independent `randomUUID()` values in namespaces disjoint
   * from `execution_observations` and `simulation_jobs`. 0 of 292 resolved and
   * none could. Each is now derived from content the reader also holds.
   */
  readonly entryObservationId: string;
  readonly entrySimulationJobId: string;
  readonly entryStepIndex: number;
  readonly entrySettlementId: string;
  /** Null while the trajectory is open. The exit half had no column at all. */
  readonly exitObservationId: string | null;
  readonly exitSimulationJobId: string | null;
  readonly exitStepIndex: number | null;
  readonly exitSettlementId: string | null;
  /**
   * P3.3 — a sha256 over named capability fields, NEVER the slot number and
   * never equal to `snapshotHash`.
   */
  readonly capabilityFingerprint: string;
  /** P6.4 — the fee table this trajectory was priced against. */
  readonly feeConfigHash: string | null;
  readonly selectedTier: string | null;
  readonly selectedTierRefusal: string | null;
  readonly marketCapLamports: bigint | null;
  readonly creatorFeeBps: number | null;
  readonly protocolFeeBps: number | null;
  readonly lpFeeBps: number | null;
  /**
   * P3.1/P3.2 — the raw pre/post state, carried out so it can be persisted.
   *
   * C-4: this lived only inside the worker process and was reduced to aggregate
   * columns before anything was written, so every economic amount was recorded
   * exactly once and was unfalsifiable from the database.
   */
  readonly rawEvidence: {
    readonly buyPre: readonly ObservedAccount[];
    readonly buyPost: readonly ObservedAccount[];
    readonly buyUnobserved: readonly string[];
    readonly sellPre: readonly ObservedAccount[] | null;
    readonly sellPost: readonly ObservedAccount[] | null;
    readonly sellUnobserved: readonly string[] | null;
    readonly buyTransactionBase64: string;
    readonly snapshotManifest: readonly unknown[];
    readonly workerIdentity: unknown;
  };
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
   * P5 — the ONE canonical settlement, for the IMMEDIATE MECHANICS.
   *
   * The buy and the sell that actually executed, in one runtime, against exact
   * captured state. NOT the policy exit, which is a mark on a later path and
   * therefore a counterfactual — conflating the two would let a hypothetical
   * exit price wear the label of a measured one.
   *
   * `buildTrajectorySettlement` was correct and unreachable for several
   * commits: its only caller was the trajectory kernel, which the collector
   * never reaches, and no table existed to store a result. Net PnL was UNKNOWN
   * BY CONSTRUCTION rather than for want of a sample.
   */
  readonly settlement: TrajectorySettlement;
  /**
   * P2.5 — everything `buildTrajectorySettlement` needs, so the collector can
   * re-derive after the raw evidence is durable. `settlement` above is built
   * before anything is written and is therefore provisional.
   */
  readonly settlementInputs: {
    readonly entry: MeasuredLegSettlement;
    readonly exit: MeasuredLegSettlement | null;
    readonly cashback: CashbackFacts;
    readonly rentStillLockedLamports: bigint;
  };
  /** Empty when the settlement's own identities hold. Never silently dropped. */
  readonly identityViolations: readonly string[];
  /**
   * How much of the pool this entry actually is.
   *
   * `withinSmallImpactBound` false means the exit price is dominated by our own
   * footprint, so the trajectory measures the instrument rather than the market.
   * Recorded rather than refused: the sampling design is frozen, and a corpus
   * that silently dropped its deepest-impact rows would misreport what the
   * notional does to this population.
   */
  readonly impact: ReturnType<typeof boundEntryImpact>;
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

/**
 * Exported for item 49's replay builder, which has to encode a transaction for
 * the replay actor rather than for the taker.
 *
 * The SDK returns `TransactionInstruction`s and the compiler wants raw metas;
 * `toRaw` is the conversion. A caller that reimplemented it would eventually
 * differ in account ordering, and account order is the thing a frozen plan and
 * a replay both depend on being identical.
 */
export const encodeForPayer = (ixs: unknown[], payer: string, bh: string): string => encode(ixs, payer, bh);

const encode = (ixs: unknown[], taker: string, bh: string): string =>
  Buffer.from(
    encodeUnsignedTransaction(
      compileMessage((ixs as (TransactionInstruction | RawInstruction)[]).map(toRaw), taker, bh, {}),
    ),
  ).toString('base64');

const tokenAmountAt = observedTokenAtoms;

/**
 * The settlement algebra's version, part of every settlement id.
 *
 * A change to how a settlement is derived produces a DIFFERENT settlement for
 * the same observation and job, and it must not silently replace the old one.
 * Putting the version inside the id makes that a new row rather than an
 * overwrite, which is what "append-only" has to mean for a derived quantity.
 */
export const SETTLEMENT_VERSION = 'trajectory-settlement-v1';

/**
 * The SDK versions the capability fingerprint commits to.
 *
 * P6.3 pins these. Read from the manifest rather than hardcoded twice: a
 * fingerprint that claims a version the process is not running is worse than no
 * fingerprint, because it makes two different builds look identical.
 */
export const SDK_VERSIONS: Readonly<Record<string, string>> = {
  '@pump-fun/pump-sdk': PUMP_SDK_VERSION,
  '@pump-fun/pump-swap-sdk': PUMP_SWAP_SDK_VERSION,
};

/**
 * The fee tier table, decoded from the CAPTURED fee config account.
 *
 * Returns null when the account is absent or does not decode — never an empty
 * table, because an empty table is indistinguishable from "this venue charges
 * nothing" and `tierForPool` would refuse it with a different reason.
 */
async function decodeFeeTiers(src: AccountBytesSource, feeConfigAddr: string): Promise<FeeTier[] | null> {
  const row = src.get(feeConfigAddr);
  if (row === null || row.dataBase64.length === 0) return null;
  try {
    const [{ PumpAmmSdk }, { PublicKey }] = await Promise.all([
      import('@pump-fun/pump-swap-sdk'),
      import('@solana/web3.js'),
    ]);
    const decoded = new PumpAmmSdk().decodeFeeConfig({
      owner: new PublicKey(row.owner),
      data: Buffer.from(row.dataBase64, 'base64'),
      lamports: 1,
      executable: false,
      rentEpoch: 0,
    });
    const tiers = feeTiersOf(decoded);
    return tiers.length === 0 ? null : tiers;
  } catch {
    return null;
  }
}

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
    /**
     * Item 49 — `FULL_EVENT_REPLAY_TRAJECTORY`.
     *
     * The intervening mainnet trades, pushed through the local post-entry pool
     * before the exit is priced. Omitted — which is every routine cycle — the
     * exit is priced immediately after the entry and the trip measures
     * MECHANICS, not a holding period.
     *
     * Supplied, the exit is priced against a pool that contains both our entry
     * and everything that happened after it. The seed accounts the actor needs
     * come in through `captureSnapshot`, so nothing here modifies the capture.
     */
    intervening?: {
      steps: readonly ReplayStep[];
      build: (step: ReplayStep, state: AccountBytesSource) => Promise<string>;
    };
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
  /**
   * G-1 — THE SET THE QUOTE-STATE EQUALITY CHECK COMPARES OVER.
   *
   * `assertQuoteStateSurvived` compares a full `accountHash` — owner, lamports,
   * executable, rentEpoch and data — which is right. The defect the 8f73cef
   * audit found was the SET it compares over:
   *
   *     pool data          covered
   *     base vault data    covered
   *     quote vault data   covered
   *     fee config         NOT COVERED — fetched into the runtime, not quoted
   *     Clock              NOT COVERED — not in the observe set at all
   *
   * A fee config swapped between the quote and the sell changes the TIER the
   * sell is charged, and the equality check would not notice. At the tier step
   * this repository itself measured, that is up to 200 bps of round trip,
   * attributed to the market rather than to the mutation.
   *
   * The fee config is a price-bearing input in exactly the sense that matters:
   * the sell's proceeds depend on it. So it belongs in the QUOTE-STATE EQUALITY
   * set, not in a separate "fetched into the runtime" category.
   *
   * It does NOT belong in the coherent snapshot's economic batch, and the two
   * are different sets for a reason this module already documented:
   *
   *   - `coherenceEconomic` must fit ONE `getMultipleAccounts`, because the
   *     whole guarantee is that every per-slot price input came from one call
   *     at one slot. QuickNode's discover plan caps that at five accounts and
   *     answers a sixth with HTTP 413. The fee config is a protocol-wide
   *     GOVERNANCE account that changes on an admin action, not per slot with
   *     trading, so reading it one slot later cannot pair a stale price with a
   *     fresh reserve — the failure the batch exists to prevent. It stays
   *     REQUIRED, and `captureCoherentSnapshotV2` reads it in the second batch.
   *
   *   - `quoteStateBearing` is what `assertQuoteStateSurvived` compares between
   *     the quote and the sell INSIDE the runtime. No provider is involved and
   *     no ceiling applies, and a fee config swapped between the two changes the
   *     tier the sell is charged — up to 200 bps of round trip, attributed to
   *     the market rather than to the mutation.
   *
   * Conflating them cost six refused candidates: adding the fee config to the
   * coherence batch made it six accounts and every capture refused
   * SNAPSHOT_INCOHERENT, which reads as a market fault and was an apparatus one.
   *
   * The CLOCK is handled separately, below: it is a sysvar the runtime owns, and
   * requiring byte equality on it would refuse every trajectory whose runtime
   * advanced a slot between the two legs. What must hold is that a MUTATION of
   * it is detected, which is what observing it on both sides gives.
   */
  const coherenceEconomic = [pool, addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount, p.mint];
  const priceBearing = [...coherenceEconomic, FEE_CONFIG_ADDR];
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
        // The four PER-SLOT price inputs, in one batch at one slot. The fee
        // config is required and read separately; see `coherenceEconomic`.
        economicAccounts: coherenceEconomic,
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
  /** Frozen inside `verify`, checked against the executed sell at the bottom. */
  let verifiedSellPlan: AccountPlan | null = null;
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

    /**
     * E-3 — BUILD-ONCE GETS A PRODUCTION ASSERTION.
     *
     * The 8f73cef audit found `assertPlanUnchanged` had zero production
     * callers, so build-once rested entirely on the freeze and the encode being
     * adjacent expressions. Nothing would fail if an edit inserted a rebuild
     * between them.
     *
     * Re-freezing `raw` would be a tautology. Decoding `buyBytes` is not: it
     * reads the transaction the way the runtime will, so a second build between
     * these two lines produces different bytes and this throws.
     */
    assertPlanMatchesBytes(buyPlan, planFromEncodedTransaction('buy', buyBytes));
  } catch (e) {
    if (e instanceof AccountPlanIncomplete) {
      return { ok: false, refusal: 'BUY_BUILD_FAILED', detail: `build-once violated: ${e.message}`.slice(0, 200) };
    }
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
  /**
   * The SDK-SELECTED buyback pair, observed because it cannot be derived.
   *
   * `swapAccountAddresses` cannot name these — the recipient comes from a list
   * in the global config — so without adding them here their balance movement
   * reports as null and the protocol's share of the fee is unattributed. Read
   * off the frozen plan, which is the only place they exist.
   */
  const selectedTail = [...selectedTrailingAccounts(buySwap.accounts.map((a) => a.pubkey))];

  /**
   * D-2 — where the entry's quote goes, other than the pool's quote vault.
   *
   * The protocol/buyback recipients the SDK SELECTED, the creator vault and the
   * cashback accumulator. Derived from the FROZEN PLAN rather than re-derived,
   * so an account the SDK picked and we did not predict is present here for the
   * same reason it is present in the transaction.
   *
   * Hoisted above the round trip because these must be in its ECONOMIC set: the
   * conservation check reads a token amount out of each, and a token amount
   * lives in the account's data.
   */
  /**
   * The PROTOCOL FEE RECIPIENT's token account, read off the frozen plan.
   *
   * It is SELECTED BY THE SDK from a list in the global config, so it cannot be
   * derived — only read. `namedQuoteDestinations` verifies the layout by
   * checking that the accounts we CAN derive land where the layout says, and
   * returns null rather than reading whatever happens to sit at index 10.
   *
   * Its absence cost 46 bps of unattributed quote on every entry.
   */
  const named = namedQuoteDestinations(
    buySwap.accounts.map((a) => a.pubkey),
    { poolQuoteTokenAccount: addrs.poolQuoteTokenAccount, globalConfig: GLOBAL_CONFIG_ADDR },
  );
  if (named === null) {
    return {
      ok: false,
      refusal: 'BUY_BUILD_FAILED',
      detail:
        'the built swap does not match the known PumpSwap account layout, so the protocol fee recipient ' +
        'cannot be located and the quote side cannot be conserved. Refusing rather than reading index 10 blind.',
    };
  }
  const feeDestinations = [
    ...new Set([
      named.protocolFeeRecipientTokenAccount,
      named.coinCreatorVaultAta,
      roles.coinCreatorVaultAta,
      roles.accumulatorWsolAta,
      ...selectedTail,
    ]),
  ].filter((a): a is string => typeof a === 'string' && a.length > 0 && a !== addrs.poolQuoteTokenAccount);
  /**
   * EVERY account the built plan touches. The plan is authoritative.
   *
   * The observe set was a DERIVED guess, and F12's whole lesson is that a
   * derivation is not the transaction. It omits the protocol fee recipient and
   * the buyback recipient — both SELECTED by the SDK from a list in the global
   * config — and both receive lamports on every leg.
   *
   * The cost of the gap was not subtle: `fullAccountCoverage` was false on
   * every leg, so `buildTrajectorySettlement` refused to produce a net PnL and
   * named the unobserved writable. Capture already used the plan
   * (`planAccountsNotCaptured`); observation did not. Same rule, both sides.
   */
  const planAccountKeys = buyPlan.instructions.flatMap((i) => i.accounts.map((a) => a.pubkey));
  const observe = [
    ...new Set([
      ...priceBearing,
      p.taker,
      takerAta,
      takerWsol,
      ...swapAccounts,
      ...cashbackAccounts,
      ...selectedTail,
      ...planAccountKeys,
    ]),
  ];

  /**
   * P2.2 / P2.4 — THE IDENTITIES, DERIVED BEFORE THE WORKER IS INVOKED.
   *
   * The directive requires the exact ids passed to the worker to be the ids
   * inserted, and requires them persisted BEFORE execution. Both are only
   * possible if they are functions of content that already exists here: the
   * trajectory id, the snapshot the state was captured at, and the exact bytes
   * that will run.
   *
   * `snapshotHash` is `coherent.snapshotHash` — a sha256 over the ordered
   * account manifest and the decoded sysvars — NOT `snapshot.slot`. The audit
   * found the slot number stored on 292 of 292 rows, with the capability
   * fingerprint equal to it, and only 290 distinct values across 292 rows.
   */
  const snapshotHashValue = assertIsHash('snapshot_hash', coherent.snapshotHash);
  const trajectoryIdValue = randomUUID();
  const entryJobId = workerJobId({
    trajectoryId: trajectoryIdValue,
    leg: 'buy',
    pool,
    taker: p.taker,
    mint: p.mint,
    notionalLamports: p.notionalLamports.toString(),
    slippagePct: p.slippagePct,
    snapshotHash: snapshotHashValue,
    accountPlanHash: buyPlan.fingerprint,
    transactionBase64: buyBytes,
    blockhash,
  });
  const entryObservationId = observationId({
    trajectoryId: trajectoryIdValue,
    leg: 'buy',
    purpose: 'DIRECT_VENUE_ENTRY',
    transactionHash: buyPlan.fingerprint,
    snapshotHash: snapshotHashValue,
  });

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
      /**
       * G-1 — the Clock joins the ECONOMIC set, so its bytes exist on both
       * sides and a mutation is detectable.
       *
       * It is deliberately NOT in `priceBearingAccounts`. Byte equality on a
       * sysvar the runtime owns would refuse every trajectory whose runtime
       * advanced a slot between the two legs — an apparatus property reported
       * as a market fact, which is the substitution this module exists to
       * prevent. What is required is that a SWAPPED clock is visible, and
       * observing it on both sides is what makes that true.
       */
      /**
       * Every account whose BYTES something downstream decodes.
       *
       * The four price-bearing accounts and the two token accounts, plus:
       *
       *   CLOCK_SYSVAR      G-1 — observed on both sides so a swap is visible.
       *   the FEE FLOWS     D-2 — the quote-side conservation check reads token
       *                     amounts out of the creator vault, the cashback
       *                     accumulator and the SDK-selected fee recipients. A
       *                     balance is not enough: these are token accounts and
       *                     the amount is at offset 64 of their DATA.
       *
       * Naming them here is the whole reason the runtime can refuse by name.
       * Without it `observedTokenAtoms` throws `ObservedBytesNotRequested` —
       * which is the correct behaviour and exactly what it did, rather than
       * reading an unobserved account as a zero balance and silently
       * attributing a 20,000,000 lamport entry to a pool that received nothing.
       */
      economicAccounts: [
        ...new Set([
          ...priceBearing,
          takerAta,
          takerWsol,
          CLOCK_SYSVAR,
          ...feeDestinations,
          /**
           * D-2 — every account the FROZEN PLAN names.
           *
           * A quote-side conservation failure has to be able to say WHERE the
           * money went, not only how much is missing. Measured 2026-08-17: the
           * payer spent 20,000,000, the pool's quote vault plus the named fee
           * flows accounted for 19,908,147, and 91,853 lamports (46 bps) landed
           * somewhere the observe set could not see — so the refusal was
           * correct and unactionable at the same time.
           *
           * Observing the plan's accounts costs worker output, which is
           * job-scoped and bounded, and buys a refusal that names the account.
           * The conservation SET is still the named fee destinations: summing
           * every account that gained would make the check tautological, which
           * is a different way of learning nothing.
           */
          ...planAccountKeys,
        ]),
      ],
      observe,
      // Item 49 — absent on every routine cycle, which is why the trip's
      // `replayed` field is null rather than empty there.
      ...(p.intervening === undefined ? {} : { intervening: p.intervening }),
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
        accountsOf: (ixs) =>
          (ixs as (TransactionInstruction | RawInstruction)[])
            .map(toRaw)
            .flatMap((i) => (i.accounts ?? []).map((a) => a.pubkey)),
        verify: (ixs) => {
          const raw = (ixs as (TransactionInstruction | RawInstruction)[]).map(toRaw);
          /**
           * E-3, the exit half. The plan is frozen HERE, at the instant the
           * cashback tail is verified, and compared at the bottom of this
           * function against the plan frozen from `trip.sellInstructions`.
           *
           * That is a real gap: the instructions travel out of this callback,
           * through the round-trip module, into the runtime and back. If what
           * came back is not what was verified, the cashback check was
           * performed on a different transaction than the one that ran — which
           * fails SILENTLY, because a sell with the tail missing lands and
           * trades normally.
           */
          verifiedSellPlan = freezeAccountPlan('sell', raw);
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
      /**
       * P2.2 — the job id IS the hash of the canonical request.
       *
       * It used to be `collect-<first 8 chars of the mint>`, which is not
       * unique across cycles and is not derivable by a reader. Separately,
       * the TRAJECTORY row was written with `job-${randomUUID()}`, in a
       * namespace disjoint from `simulation_jobs.job_id`, so 0 of 292
       * trajectories could ever join to the worker job that produced them
       * (audit C-2).
       *
       * One value now, derived from the request itself. The id passed to the
       * worker is the id inserted, and a reader holding the request can
       * recompute it rather than trusting the link.
       */
      jobId: entryJobId,
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

  /**
   * D-2 — THE QUOTE SIDE MUST CONSERVE, NOT MERELY BE POSITIVE.
   *
   * The audit constructed this exactly:
   *
   *     quote in -> 0            attributed = false   correct
   *     quote in -> 1 lamport    attributed = TRUE    against a 20,000,000 entry
   *
   * "The canonical pool accounts for all named deltas" was true of the base
   * vault and false of the quote vault, because the notional was never compared
   * to what the pool actually received. A one-lamport credit is not a rounding
   * artefact; it is a different trade.
   *
   * The named destinations of the entry's quote are the pool's quote vault plus
   * the fee accounts the FROZEN PLAN names — protocol, creator vault, buyback
   * and the cashback accumulator. Each delta is MEASURED from this leg's own
   * pre/post state; an account the plan does not name contributes nothing and
   * therefore shows up as residue, which is the intended behaviour.
   */
  const buyStep = trip.buy;
  const wsolDelta = (pubkey: string): bigint => {
    const before = tokenAmountAt(buyStep.preAccounts.find((a) => a.pubkey === pubkey)) ?? 0n;
    const after = tokenAmountAt(buyStep.postAccounts.find((a) => a.pubkey === pubkey)) ?? 0n;
    return after > before ? after - before : 0n;
  };
  const feeFlows = feeDestinations.reduce((n, a) => n + wsolDelta(a), 0n);

  const attribution = attributeSoleVenue({
    baseOutAtoms: baseOut,
    quoteInLamports: quoteIn,
    takerCreditAtoms: takerCredit,
    entryQuoteOutLamports: p.notionalLamports,
    feeFlowsLamports: feeFlows,
    /**
     * The venue model's documented rounding.
     *
     * PumpSwap computes each fee component with integer division, so a
     * component can round down by at most one lamport. Four components gives a
     * four-lamport bound. It is NOT a slack parameter: at 20,000,000 lamports
     * it is 0.00002%, and the case it has to refuse is off by 19,999,999.
     */
    toleranceLamports: 4n,
  });
  const soleVenue = attribution.attributed;

  if (!soleVenue) {
    /**
     * NAME THE ACCOUNT, not only the amount.
     *
     * A residue tells you the model is incomplete; it does not tell you which
     * flow the model is missing. Every plan account's bytes are observed for
     * exactly this, so the refusal can list the unnamed accounts that GAINED
     * quote — which is the difference between "0.46% went somewhere" and "the
     * protocol fee recipient's token account took 91,853".
     */
    const named = new Set([...feeDestinations, addrs.poolQuoteTokenAccount, takerAta, takerWsol]);
    const gainers = [...new Set(planAccountKeys)]
      .filter((a) => !named.has(a))
      .map((a) => {
        let delta = 0n;
        try {
          delta = wsolDelta(a);
        } catch {
          delta = -1n; // bytes absent: reported as unknown rather than as zero
        }
        return { account: a, delta };
      })
      .filter((x) => x.delta !== 0n)
      .sort((a, b) => (b.delta > a.delta ? 1 : -1))
      .slice(0, 4);

    const where =
      gainers.length === 0
        ? ' No unnamed plan account gained quote, so the residue is not a fee flow this plan names.'
        : ` Unnamed plan accounts that GAINED quote: ${gainers
            .map((g) => `${g.account}=${g.delta === -1n ? 'bytes not observed' : g.delta.toString()}`)
            .join(', ')}.`;

    return {
      ok: false,
      refusal: 'ENTRY_NOT_SOLE_VENUE',
      detail: `${attribution.refusal ?? 'not sole venue'}.${where}`,
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
  // `trajectoryIdValue` is minted BEFORE the round trip now, because the
  // deterministic observation and job ids are derived from it and must be the
  // values handed to the worker (P2.2/P2.4).
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
  /**
   * What the SELL created, which nothing measured.
   *
   * `createdAccounts` covered the buy only, so a fee recipient the sell had to
   * open contributed its rent to the payer's outflow and to nothing in the
   * accounting. The sell selects its own recipients — F12 — so this is not a
   * rare case.
   */
  const sellPreByKey = new Map((trip.sell?.preAccounts ?? []).map((a) => [a.pubkey, a]));
  const sellCreatedAccounts: CreatedAccount[] = [];
  for (const post of trip.sell?.postAccounts ?? []) {
    const prior = sellPreByKey.get(post.pubkey);
    const existed = prior !== undefined && (prior.lamports > 0n || prior.dataLen > 0);
    if (existed || post.lamports <= 0n) continue;
    sellCreatedAccounts.push(
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
          protocolFeeAccounts: selectedTail,
        },
      ),
    );
  }

  const setup = summariseSetup([...createdAccounts, ...sellCreatedAccounts]);

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

  /**
   * The buyback fee recipient the SDK SELECTED, read off the built instruction.
   *
   * PumpSwap appends `[buybackFeeRecipient, buybackFeeRecipientTokenAccount]`
   * to every leg's remaining accounts, and the recipient comes from a list in
   * the global config rather than from the pool — F12's exact concern. It is
   * observed here, never derived, and its balance delta is what shows where the
   * protocol's share of the fee actually went.
   */
  const buybackPair = selectedTrailingAccounts(buySwap.accounts.map((a) => a.pubkey));
  const feeRecipient = buybackPair[1] ?? null;

  /**
   * What a leg's newly created account received beyond its rent.
   *
   * The buy CREATES the accumulator ATA on a wallet's first cashback trade, so
   * without this the accrual that lands in it reports as unmeasured — the
   * original F13 error reproduced by the instrument built to correct it.
   */
  const createdExcess = (pubkey: string): bigint | null =>
    createdAccounts.find((a) => a.pubkey === pubkey)?.excessLamports ?? null;
  const cashbackLegs: LegCashbackDeltas[] = [
    legCashbackDeltas({
      leg: 'buy',
      before: balanceIn(trip.buy.preAccounts),
      after: balanceIn(trip.buy.postAccounts),
      accumulatorWsolAta: roles.accumulatorWsolAta,
      userVolumeAccumulator: roles.userVolumeAccumulator,
      coinCreatorVaultAta: roles.coinCreatorVaultAta,
      feeRecipient,
      createdExcess,
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

  /**
   * P5 - settle the immediate mechanics, from the legs that actually ran.
   *
   * Both legs are turned into `MeasuredLegSettlement` from their own pre/post
   * observations, then combined by the canonical builder. Every figure derives
   * from the payer native delta, the one quantity that cannot disagree with
   * itself, and `unexplained` is DERIVED rather than assumed zero.
   */
  const closedInSell = trip.baseAtaClosedInSell === true ? [takerAta] : [];
  /**
   * Accounts whose gain is NOT a cost to us: our own wrapped-SOL account, and
   * the pool's base vault, which receives tokens rather than value we paid.
   */
  const notSkimAccounts = [takerWsol, addrs.poolBaseTokenAccount];

  /**
   * An account that DID NOT EXIST is not a coverage failure.
   *
   * The worker reports `unobserved` for anything it was asked to read and could
   * not find. Once the observe set became the full frozen plan, that list began
   * including every account the transaction was about to CREATE — which are
   * unobservable before execution by definition.
   *
   * Treating those as missing coverage made `fullAccountCoverage` false on
   * every leg, so `buildTrajectorySettlement` refused a net PnL for a run where
   * nothing was actually unmeasured. Coverage is about writables that EXISTED
   * and were not looked at; the ones the leg brought into existence are
   * measured by `createdAccounts` and by `stillAbsent`.
   */
  /**
   * A writable is a coverage gap only if it EXISTED and was not read.
   *
   * Three kinds of account end up in the worker's `unobserved` list once the
   * observe set is the full frozen plan, and only one of them is a defect:
   *
   *   - accounts the leg CREATES, absent before execution by definition;
   *   - accounts created AND CLOSED inside the same transaction — the SDK wraps
   *     and unwraps the taker WSOL ATA on every leg, so it exists in neither
   *     the pre nor the post observation;
   *   - a writable that was there all along and nobody looked at. THIS one.
   *
   * The first two were making `fullAccountCoverage` false on every leg, so
   * `buildTrajectorySettlement` refused a net PnL for runs where nothing was
   * actually unmeasured. An account that did not exist cannot be observed, and
   * calling that missing coverage confuses an impossibility with an omission.
   */
  /**
   * E-3 — the sell that RAN is the sell that was VERIFIED.
   *
   * `assertPlanUnchanged` gets its production caller here, over a real gap:
   * `verifiedSellPlan` was frozen inside the cashback verification callback,
   * and this one is frozen from the instructions the round trip reports having
   * executed. A divergence means the tail was checked on a different
   * transaction than the one the runtime ran, and that failure is silent —
   * the sell lands, trades normally, and the creator fee simply goes to the
   * creator.
   */
  const exitPlanFrozen =
    trip.sellInstructions === null
      ? null
      : freezeAccountPlan('sell', (trip.sellInstructions as (TransactionInstruction | RawInstruction)[]).map(toRaw));
  if (exitPlanFrozen !== null && verifiedSellPlan !== null) {
    assertPlanUnchanged(verifiedSellPlan, exitPlanFrozen);
  }

  const facts = poolFactsFrom(preSrc, pool);

  /**
   * J-3 — THE FEE TABLE THIS TRAJECTORY WAS PRICED AGAINST.
   *
   * `tierForPool` was called only in `direct-mark.ts` and its result was
   * DISCARDED before the mark was stored; no `fee_config_hash` and no
   * `selected_tier` column existed on either table. Pump has already changed
   * fee behaviour once, and a row that does not record the table it was priced
   * against cannot distinguish "the tier changed" from "Pump republished the
   * table". The tier step this repository itself measured is worth up to 200
   * bps of round trip.
   *
   * Refuses by name rather than defaulting to the bottom tier. A tier nobody
   * could select is an unknown.
   */
  const feeTiers = await decodeFeeTiers(preSrc, FEE_CONFIG_ADDR);
  const selectedTier =
    feeTiers === null
      ? {
          tier: null,
          marketCapLamports: null,
          /**
           * P6.4 — FAIL CLOSED when the fee config is present but undecodable.
           *
           * Not "the bottom tier". A tier nobody could select is an unknown,
           * and the difference between the bottom tier and the one the program
           * actually charges is up to 200 bps of round trip.
           */
          refusal: 'the fee config is present but did not decode, so no tier can be selected',
        }
      : tierForPool(feeTiers, {
          quoteReserveLamports: facts.quoteReserveRaw + facts.virtualQuoteReserves,
          baseReserveAtoms: facts.baseReserve,
          baseMintSupplyAtoms: facts.baseMintSupplyAtoms,
        });

  /**
   * C-3 — the capability fingerprint over NAMED CAPABILITY FIELDS.
   *
   * Distinct from the snapshot hash by construction: this one does not move
   * when the pool trades, and it does move when the venue's rules or the tools
   * measuring them change.
   */
  const capabilityFingerprintValue = capabilityFingerprintOf({
    venue: 'PUMPSWAP_DIRECT',
    programId: AMM_PROGRAM_ID,
    programDataHash: coherent.programDataHashes[AMM_PROGRAM_ID] ?? null,
    tokenProgram: mintOwner,
    feeConfigHash: coherent.feeConfigHash,
    selectedTier: selectedTier.tier === null ? null : `${selectedTier.tier.marketCapLamportsThreshold}`,
    cashbackEnabled: isCashback,
    workerBinaryHash:
      typeof (trip.runtimeIdentity as { binarySha256?: unknown } | null)?.binarySha256 === 'string'
        ? ((trip.runtimeIdentity as { binarySha256: string }).binarySha256)
        : null,
    sdkVersions: SDK_VERSIONS,
    protocolVersion: SIMULATION_PROTOCOL_VERSION,
  });

  /**
   * C-2, the exit half — which had NO COLUMN AT ALL.
   *
   * The audit's trace table records `exit worker job/step: no column exists`.
   * The sell executes as step 1 of the same worker job as the buy, so its
   * identifiers are derivable from the same content.
   */
  const exitIds =
    trip.sell === null || exitPlanFrozen === null
      ? null
      : (() => {
          const obs = observationId({
            trajectoryId: trajectoryIdValue,
            leg: 'sell',
            purpose: 'DIRECT_VENUE_EXIT',
            transactionHash: exitPlanFrozen.fingerprint,
            snapshotHash: snapshotHashValue,
          });
          return {
            observationId: obs,
            jobId: entryJobId,
            settlementId: settlementIdFor({
              observationId: obs,
              jobId: entryJobId,
              stepIndex: 1,
              settlementVersion: SETTLEMENT_VERSION,
            }),
          };
        })();

  const buyGap = coverageGap(trip.buy.unobserved, trip.buy.preAccounts);
  const sellGap = trip.sell === null ? [] : coverageGap(trip.sell.unobserved, trip.sell.preAccounts);
  const entryLeg = legSettlementFromRuntime({
    // The SAME ids the trajectory row carries and the collector inserts. These
    // were `obs-buy-<8 chars of the mint>` and `job-buy-<8 chars>` — a third
    // namespace, distinct from both the trajectory's random UUIDs and the
    // worker's request hash, so a settlement could not be joined to either.
    observationId: entryObservationId,
    simulationJobId: entryJobId,
    side: 'buy',
    capabilityFingerprint: buyPlan.fingerprint,
    taker: p.taker,
    takerBaseAta: takerAta,
    mint: p.mint,
    baseTokenProgram: mintOwner,
    poolQuoteVault: addrs.poolQuoteTokenAccount,
    requested: p.notionalLamports,
    minimumOut: 0n,
    pre: trip.buy.preAccounts as unknown as ObservedAccount[],
    post: trip.buy.postAccounts as unknown as ObservedAccount[],
    createdAccounts,
    closedAccounts: [],
    notSkimAccounts,
    runtimeOk: trip.buy.status === 'SIMULATED_OK',
    incompleteness: buyGap.map((u) => `unobserved on buy: ${u}`),
    fullAccountCoverage: buyGap.length === 0,
    snapshotManifestHash: null,
  });

  const exitLeg =
    trip.sell === null
      ? null
      : legSettlementFromRuntime({
          observationId:
            exitIds?.observationId ??
            observationId({
              trajectoryId: trajectoryIdValue,
              leg: 'sell',
              purpose: 'DIRECT_VENUE_EXIT',
              transactionHash: buyPlan.fingerprint,
              snapshotHash: snapshotHashValue,
            }),
          simulationJobId: entryJobId,
          side: 'sell',
          capabilityFingerprint: buyPlan.fingerprint,
          taker: p.taker,
          takerBaseAta: takerAta,
          mint: p.mint,
          baseTokenProgram: mintOwner,
          poolQuoteVault: addrs.poolQuoteTokenAccount,
          requested: trip.acquiredAtoms,
          minimumOut: 0n,
          pre: trip.sell.preAccounts as unknown as ObservedAccount[],
          post: trip.sell.postAccounts as unknown as ObservedAccount[],
          createdAccounts: sellCreatedAccounts,
          closedAccounts: closedInSell,
          // The base ATA was opened by the BUY. Without this the sell finds no
          // source for the rent it recovered and reports zero.
          rentSourceAccounts: createdAccounts,
          notSkimAccounts,
          runtimeOk: trip.sell.status === 'SIMULATED_OK',
          incompleteness: sellGap.map((u) => `unobserved on sell: ${u}`),
          fullAccountCoverage: sellGap.length === 0,
          snapshotManifestHash: null,
        });

  // Rent on accounts we opened and did NOT close is still locked. Counting it
  // as recovered is how an earlier version flattered every sell.
  const stillLocked = setup.totalRentLamports - (trip.baseAtaClosedInSell === true ? setup.recoverableLamports : 0n);

  /**
   * I-3 — the standing cashback receivable, READ FROM THE ACCUMULATOR ATA.
   *
   * `claimable` was the literal `0n`. It is the balance the accumulator WSOL
   * account holds after the round trip — what `claim_cashback` would release if
   * it were called now. Null-safe rather than zero-defaulted: an accumulator
   * whose bytes were not observed is UNKNOWN, and reporting unknown as zero is
   * the same defect one layer down.
   */
  const accumulatorAta = roles.accumulatorWsolAta;
  const accumulatorAfter =
    accumulatorAta === null || accumulatorAta === undefined
      ? null
      : (tokenAmountAt((trip.sell?.postAccounts ?? trip.buy.postAccounts).find((a) => a.pubkey === accumulatorAta)) ??
        tokenAmountAt(trip.buy.postAccounts.find((a) => a.pubkey === accumulatorAta)));
  const claimableFromAccumulator = accumulatorAfter ?? 0n;

  /**
   * P4.1 — is the raw pre/post state COMPLETE enough to be persisted?
   *
   * A property of what the worker returned, checked rather than assumed: every
   * leg that ran must have reported both sides. The collector re-derives this
   * settlement after the blobs have actually been written and read back, and
   * THAT value is the one the stored row carries. This one governs the
   * in-memory settlement only.
   */
  const rawEvidenceDurable =
    trip.buy.preAccounts.length > 0 &&
    trip.buy.postAccounts.length > 0 &&
    (trip.sell === null || (trip.sell.preAccounts.length > 0 && trip.sell.postAccounts.length > 0));

  const settlement = buildTrajectorySettlement({
    trajectoryId: trajectoryIdValue,
    entry: entryLeg,
    exit: exitLeg,
    cashback: {
      // ACCRUED, not claimed. `claim_cashback` has never been called, so only
      // the receivable exists and realized cashback PnL is zero.
      accruedLamports: cashbackLegs.reduce(
        (n, l) => n + (l.accumulatorWsolDeltaLamports !== null && l.accumulatorWsolDeltaLamports > 0n ? l.accumulatorWsolDeltaLamports : 0n),
        0n,
      ),
      /**
       * I-3 — MEASURED FROM THE ACCUMULATOR, not hardcoded `0n`.
       *
       * The audit: "`claimable` is hardcoded `0n` at `open-trajectory.ts:1012`
       * rather than read from the accumulator account state, so the receivable
       * this system has built up is invisible to every surface." The corpus
       * carried 28 settlements with a non-zero accrual and the accumulator had
       * gained 10,489,020 lamports — none of which any surface could see.
       *
       * This is the accumulator ATA's balance AFTER the round trip: the total
       * standing receivable, not this trajectory's contribution to it. That is
       * the correct quantity for `claimable` — what the account would release
       * if `claim_cashback` were called now.
       *
       * `claimable` is still NOT cash and still does not enter PnL. Measuring
       * a receivable and booking it as revenue are different mistakes, and this
       * fixes only the first.
       */
      claimableLamports: claimableFromAccumulator,
      claimedLamports: 0n,
      claimCostLamports: 0n,
    },
    rentStillLockedLamports: stillLocked < 0n ? 0n : stillLocked,
    venueFeeDecompositionKnown: false,
    /**
     * P4.1 — the durability half of PnL eligibility.
     *
     * Stated rather than defaulted. The collector persists the raw pre/post
     * manifests and the evidence links BEFORE it calls this, and re-derives
     * the settlement afterwards; what this call can honestly claim is that the
     * legs it holds came out of a worker round trip whose state it is about to
     * write. `linksResolve` is asserted by the collector against the database,
     * not here — so it is passed through rather than assumed.
     */
    legEvidence: {
      entry: {
        rawStateDurable: rawEvidenceDurable,
        linksResolve: true,
        residualSemanticsKnown: true,
      },
      ...(exitLeg === null
        ? {}
        : {
            exit: {
              rawStateDurable: rawEvidenceDurable,
              linksResolve: exitIds !== null,
              residualSemanticsKnown: true,
            },
          }),
    },
  });
  const identity = checkIdentities(settlement);

  const impact = boundEntryImpact({
    entryQuoteInLamports: p.notionalLamports,
    effectiveQuoteReserveLamports: facts.quoteReserveRaw + facts.virtualQuoteReserves,
    tokensAcquiredAtoms: trip.acquiredAtoms,
    baseReserveAtoms: facts.baseReserve,
  });
  /**
   * NOT discarded. This was `void impact;` and the collector then wrote
   * hardcoded zeros with `withinSmallImpactBound: true` into every row.
   *
   * Measured on the first live surface: pools with 0.018 SOL of quote reserve
   * taking a 0.02 SOL entry — an impact ratio above 1.0, stored as 0. The rows
   * asserted the entry was inside a 50 bps bound while it was over a hundred
   * times outside it, which makes every counterfactual exit built on them a
   * measurement of our own footprint.
   *
   * A computed value that reaches nothing is the defect class this whole
   * directive is about, and it was sitting in the open path.
   */

  return {
    ok: true,
    trajectory: {
      trajectoryId: trajectoryIdValue,
      mint: p.mint,
      pool,
      /**
       * C-3 — the real hash, not the slot number.
       *
       * `coherent.snapshotHash` was already computed by the coherent capture
       * and discarded here. It is a sha256 over the ordered account manifest
       * (pubkey + account hash for each) plus the decoded clock, rent and epoch
       * schedule, so it commits to every byte the legs price against.
       */
      snapshotHash: snapshotHashValue,
      /**
       * C-3 — and the capability fingerprint is a DIFFERENT question.
       *
       * It was identical to `snapshot_hash` on 292 of 292 rows, which made it
       * unable to answer the only question it exists for: did the venue's
       * capabilities change between two trajectories priced at different slots?
       * It moves with the fee config, the programdata, the token program, the
       * cashback flag, the worker binary and the SDK versions — and with
       * nothing else.
       */
      capabilityFingerprint: capabilityFingerprintValue,
      feeConfigHash: coherent.feeConfigHash,
      selectedTier: selectedTier.tier === null ? null : `${selectedTier.tier.marketCapLamportsThreshold}`,
      selectedTierRefusal: selectedTier.refusal,
      marketCapLamports: selectedTier.marketCapLamports,
      creatorFeeBps: selectedTier.tier?.fees.creatorFeeBps ?? null,
      protocolFeeBps: selectedTier.tier?.fees.protocolFeeBps ?? null,
      lpFeeBps: selectedTier.tier?.fees.lpFeeBps ?? null,
      stratum: mechanicsStratum({ canonicalPool: true, cashbackCoin: p.isCashbackCoin }),
      notionalLamports: p.notionalLamports,
      acquiredAtoms: trip.acquiredAtoms,
      /**
       * C-2 — identities that RESOLVE.
       *
       * These were three independent `randomUUID()` values written to no other
       * table, in namespaces disjoint from the ones the worker and the
       * settlement writer actually use. 0 of 292 joined, and none could.
       *
       * Each is now a function of content the caller also holds, so the
       * collector inserts rows under exactly these keys and a reader can
       * recompute them.
       */
      entryObservationId,
      entrySimulationJobId: entryJobId,
      entryStepIndex: 0,
      entrySettlementId: settlementIdFor({
        observationId: entryObservationId,
        jobId: entryJobId,
        stepIndex: 0,
        settlementVersion: SETTLEMENT_VERSION,
      }),
      exitObservationId: exitIds?.observationId ?? null,
      exitSimulationJobId: exitIds?.jobId ?? null,
      exitStepIndex: exitIds === null ? null : 1,
      exitSettlementId: exitIds?.settlementId ?? null,
      /**
       * P3.1 — the raw pre/post account state, carried out for persistence.
       *
       * C-4: this existed only inside the worker process and was reduced to the
       * aggregate columns of `trajectory_settlements` before anything was
       * written, so every economic amount was recorded exactly once and was
       * unfalsifiable from the database. The collector writes these to the
       * content-addressed blob store and links them by job and step.
       */
      rawEvidence: {
        buyPre: trip.buy.preAccounts,
        buyPost: trip.buy.postAccounts,
        buyUnobserved: trip.buy.unobserved,
        sellPre: trip.sell?.preAccounts ?? null,
        sellPost: trip.sell?.postAccounts ?? null,
        sellUnobserved: trip.sell?.unobserved ?? null,
        buyTransactionBase64: buyBytes,
        snapshotManifest: coherent.accounts,
        workerIdentity: trip.runtimeIdentity,
      },
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
      exitPlan: exitPlanFrozen,
      createdAccounts,
      setup,
      cashbackLegs,
      // Both tails were checked against the frozen plans before either leg ran.
      // A trajectory that reached here on a cashback coin carries the accounts.
      cashbackVerified: isCashback,
      settlement,
      /**
       * P2.5 — the inputs, so the settlement can be RE-DERIVED after the raw
       * evidence is durable.
       *
       * The settlement above is provisional: it is built before anything has
       * been written to disk, so its `rawStateDurable` is a claim about process
       * memory. The collector persists the blobs, reads them back, verifies the
       * links resolve, and rebuilds from these same inputs with the real
       * durability. The stored row is that second one.
       *
       * Two settlements from one set of inputs is not a duplication: it is the
       * difference between "the worker returned this" and "the corpus can prove
       * this", and the directive requires the second.
       */
      settlementInputs: {
        entry: entryLeg,
        exit: exitLeg,
        cashback: {
          accruedLamports: cashbackLegs.reduce(
            (n, l) =>
              n +
              (l.accumulatorWsolDeltaLamports !== null && l.accumulatorWsolDeltaLamports > 0n
                ? l.accumulatorWsolDeltaLamports
                : 0n),
            0n,
          ),
          claimableLamports: claimableFromAccumulator,
          claimedLamports: 0n,
          claimCostLamports: 0n,
        },
        rentStillLockedLamports: stillLocked < 0n ? 0n : stillLocked,
      },
      identityViolations: identity.violations,
      impact,
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
