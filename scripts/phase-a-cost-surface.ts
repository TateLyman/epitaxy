/**
 * `pnpm cost:floor` — the corrected cost surface, from STORED state only.
 *
 * §1.1 of the measurement-power directive: round-trip cost as a fraction of
 * notional at 0.02 / 0.05 / 0.10 / 0.20 / 0.35 / 0.50 / 1.00 SOL, with
 * `notional_min_cost` and `cost_floor_pct` identified.
 *
 * WHY THIS IS NOT `scripts/cost-surface.ts`
 *
 * That script builds live Jupiter routes and prices them from their own bytes,
 * which is the right instrument for "what does the router charge today" and the
 * wrong one here twice over: Phase A forbids new collection, and a live route
 * cannot be built at 1.00 SOL against a pool that no longer exists. Every
 * number below comes out of the corpus — stored coherent snapshots, stored
 * simulation steps, stored settlements, stored created-account rows — so the
 * whole surface is reproducible from the database at any later date.
 *
 * WHAT IS MEASURED VERSUS WHAT IS MODELLED
 *
 * Measured, from the corpus:
 *   - base signature fee per leg (`leg_settlements`, 5,000 on every row);
 *   - compute units consumed per leg (`simulation_steps.units_consumed`);
 *   - the router's unit PRICE and explicit limit (stored `/swap/v2/build` bodies);
 *   - rent created, recovered and its economic scope (`created_accounts`);
 *   - transfer fees (`leg_settlements.transfer_fee_status`, MEASURED on 824/824);
 *   - pool reserves, virtual reserves, fee config and mint supply (stored
 *     coherent snapshots, 9 accounts each — the economic set).
 *
 * Modelled, and labelled as such in the artifact:
 *   - the venue drag at a notional the corpus never traded. The SDK's own
 *     `buyQuoteInput`/`sellBaseInput` price the entry and the exit against the
 *     stored reserves. No AMM arithmetic is written here.
 *
 * THE ONE MODELLING CHOICE THAT MATTERS
 *
 * The exit is priced against the PRE-BUY reserves, not against the state the
 * buy would leave. That is deliberate and it is the difference between two
 * different experiments:
 *
 *   - priced against the POST-buy state, a round trip is a fee round trip. A
 *     constant-product pool returns the entry exactly, so first-order impact
 *     cancels and the drag is flat in size — which is precisely why the
 *     measured `medianAmmDragBps` was 241.5 bps at every size in the P13 grid.
 *   - priced against the PRE-buy state, the entry pays above the mid and the
 *     exit sells below a mid of the same depth. Nothing cancels, and the drag
 *     carries the 2·N/R term.
 *
 * The strategy holds for minutes to days. Its exit meets a pool whose depth is
 * whatever the market left, not a pool still carrying its own entry, so the
 * cancellation is an artifact of same-transaction accounting and the
 * non-cancelling form is the honest one. Both are reported: `feeFloorBps` is
 * the size-independent limit (measured at a probe notional) and `impactBps` is
 * the remainder.
 *
 * Read-only. Nothing is signed, submitted, or funded. No network call.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { EvidenceStore } from '../packages/storage/src/evidence-repo.js';
import {
  accountSourceOf,
  poolFactsFrom,
  quoteBuyFrom,
  quoteSellFrom,
  type AccountBytesSource,
} from '../packages/solana/src/pumpswap-offline.js';
import { decodeTransaction, readComputeBudget } from '../packages/solana/src/transaction.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { appliedComputeLimit, instructionProgramIds } from '../packages/solana/src/computebudget.js';
import { BuildResponseSchema } from '../packages/adapters/src/jupiter/schemas.js';
import { base58Encode } from '../packages/solana/src/base58.js';
import { frozenComputeLimit, FROZEN_CU_MARGIN_PCT } from '../packages/solana/src/cu-budget.js';
import { entryCashOut, exitCashIn, expectedFailureCost, costBps } from '../packages/domain/src/accounting.js';
import { FROZEN_SIZE_BOUNDS } from '../packages/strategy/src/size-rule.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

/** Preregistered by the directive. Not chosen here and not revised after a result. */
const GRID: readonly bigint[] = [
  20_000_000n, // 0.02 SOL — the current development notional
  50_000_000n, // 0.05
  100_000_000n, // 0.10
  200_000_000n, // 0.20
  350_000_000n, // 0.35
  500_000_000n, // 0.50
  1_000_000_000n, // 1.00
];

/**
 * The probe that isolates the size-INDEPENDENT part of the venue drag.
 *
 * 0.0002 SOL against a ~18 SOL effective reserve carries about 0.1 bps of its
 * own impact, so the drag it measures is the fee tier plus a rounding, and the
 * difference between it and a grid point is that grid point's impact.
 */
const FEE_FLOOR_PROBE_LAMPORTS = 200_000n;
const SLIPPAGE_PCT = 3;

/** Landed-failure rates to price, since the measured rate does not exist yet. */
const FAILURE_SCENARIOS: readonly { label: string; rate: number }[] = [
  { label: 'observed', rate: 0 },
  { label: 'stress-5pct', rate: 0.05 },
  { label: 'stress-20pct', rate: 0.2 },
];

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const evidence = new EvidenceStore(db, 'data/evidence-blobs');

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : (((s[m - 1] as number) + (s[m] as number)) / 2);
};
const quantile = (xs: readonly number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] as number;
};
const medianBig = (xs: readonly bigint[]): bigint | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)] as bigint;
};
/** bps of a over b, rounded UP, never through a float. */
const bpsOf = (a: bigint, b: bigint): number | null => (b <= 0n ? null : Number((a * 10_000n + b - 1n) / b));

// ---------------------------------------------------------------------------
// 1 — THE FIXED COSTS, EACH FROM ITS OWN MEASUREMENT
// ---------------------------------------------------------------------------

interface FixedCosts {
  readonly baseFeePerLegLamports: bigint;
  readonly baseFeeSource: string;
  readonly baseFeeLegsMeasured: number;
  /** The router's own price, from the bytes of stored builds. */
  readonly unitPriceMicroLamportsMedian: bigint | null;
  readonly unitPriceMicroLamportsP90: bigint | null;
  readonly unitPriceBuildsRead: number;
  readonly unitPriceBuildsWithPrice: number;
  readonly unitPriceBuildsUnreadable: number;
  readonly unitPriceBuildsPlaceholderBlockhash: number;
  readonly explicitLimitBuilds: number;
  /** The limit the runtime applies when the router omits one. */
  readonly derivedDefaultLimitMedian: number | null;
  readonly unitsConsumedP50: number | null;
  readonly unitsConsumedP90: number | null;
  readonly unitsConsumedMax: number | null;
  readonly unitsConsumedLegs: number;
  readonly frozenRequestedLimit: number | null;
  readonly frozenMarginPct: number;
  /** ceil(price × limit / 1e6) with the limit the current builds actually apply. */
  readonly priorityFeeAsBuiltLamports: bigint | null;
  /** ceil(price × limit / 1e6) with the limit a two-pass rebuild would request. */
  readonly priorityFeeWithFrozenLimitLamports: bigint | null;
  readonly rentPerTradeRecoverableLamports: bigint;
  readonly rentPerTradeUnrecoverableLamports: bigint;
  readonly rentOneTimePerWalletLamports: bigint;
  readonly rentRecoveredMeasuredLamports: bigint | null;
  readonly rentClasses: readonly {
    leg: string;
    scope: string;
    recoverability: string;
    accounts: number;
    trajectories: number;
    rentLamports: string;
  }[];
  readonly transferFeeStatuses: Readonly<Record<string, number>>;
  readonly submittedAttempts: number;
  readonly landedFailures: number;
}

function measureFixedCosts(): FixedCosts {
  // -- base signature fee ---------------------------------------------------
  const baseRows = db
    .prepare(
      `SELECT base_fee_lamports AS fee, COUNT(*) AS n FROM leg_settlements GROUP BY base_fee_lamports ORDER BY n DESC`,
    )
    .all() as { fee: string; n: number }[];
  const legsMeasured = baseRows.reduce((a, r) => a + r.n, 0);
  const baseFee = baseRows.length === 0 ? 5_000n : BigInt(baseRows[0]?.fee ?? '5000');
  const baseFeeSource =
    baseRows.length === 1
      ? `leg_settlements, ${legsMeasured} legs, all ${baseFee.toString()}`
      : `leg_settlements, ${legsMeasured} legs, ${baseRows.length} distinct values (modal ${baseFee.toString()})`;

  // -- the router's unit price, out of the STORED /build responses ----------
  //
  // Not out of the stored exact-transaction blobs: those are this system's own
  // PumpSwap legs, built for an isolated runtime that charges no priority fee
  // at all, so their unit price is legitimately absent. The router's price is a
  // fact about the router, and it lives in the stored `/swap/v2/build` bodies.
  // Assembled in the client's own instruction order and read through the same
  // decoder, so this is the figure `pnpm cost:surface` reports from live routes.
  const buildRows = db
    .prepare(`SELECT body FROM raw_payloads WHERE endpoint LIKE '%build%'`)
    .all() as { body: string }[];
  const prices: bigint[] = [];
  const derivedLimits: number[] = [];
  let explicitLimits = 0;
  let read = 0;
  let unreadable = 0;
  let placeholderBlockhash = 0;
  for (const r of buildRows) {
    let parsed: ReturnType<typeof BuildResponseSchema.parse>;
    try {
      parsed = BuildResponseSchema.parse(JSON.parse(r.body));
    } catch {
      unreadable += 1;
      continue;
    }
    const instructions = [
      ...(parsed.computeBudgetInstructions ?? []),
      ...(parsed.setupInstructions ?? []),
      ...(parsed.swapInstruction ? [parsed.swapInstruction] : []),
      ...(parsed.otherInstructions ?? []),
      ...(parsed.cleanupInstruction ? [parsed.cleanupInstruction] : []),
      ...(parsed.tipInstruction ? [parsed.tipInstruction] : []),
    ].map((ix) => ({
      programId: ix.programId,
      accounts: (ix.accounts ?? []).map((a) => ({
        pubkey: a.pubkey,
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: ix.data ?? '',
    }));
    // The taker is whoever the router marked as a signer. Read off the route
    // rather than out of config, so a build made by another wallet still reads.
    const signer = instructions.flatMap((ix) => ix.accounts).find((a) => a.isSigner)?.pubkey;
    if (instructions.length === 0 || signer === undefined) {
      unreadable += 1;
      continue;
    }
    const rawBlockhash = parsed.blockhashWithMetadata?.blockhash ?? null;
    let blockhash: string;
    if (typeof rawBlockhash === 'string' && rawBlockhash.length > 0) {
      blockhash = rawBlockhash;
    } else if (Array.isArray(rawBlockhash)) {
      blockhash = base58Encode(Uint8Array.from(rawBlockhash));
    } else {
      // Only the compute-budget instructions are read below and the blockhash
      // does not enter them. Counted, so the substitution is never silent.
      blockhash = '11111111111111111111111111111111';
      placeholderBlockhash += 1;
    }
    const tables: Record<string, string[]> = {};
    for (const [table, addrs] of Object.entries(parsed.addressesByLookupTableAddress ?? {})) {
      if (Array.isArray(addrs)) tables[table] = addrs.filter((a): a is string => typeof a === 'string');
    }
    let tx: ReturnType<typeof decodeTransaction>;
    try {
      tx = decodeTransaction(encodeUnsignedTransaction(compileMessage(instructions, signer, blockhash, tables)));
    } catch {
      // An oversized route is a fact about the route. It contributes no price.
      unreadable += 1;
      continue;
    }
    read += 1;
    const cb = readComputeBudget(tx);
    if (cb.unitPriceMicroLamports !== null && cb.unitPriceMicroLamports > 0n) prices.push(cb.unitPriceMicroLamports);
    if (cb.unitLimit !== null) explicitLimits += 1;
    derivedLimits.push(appliedComputeLimit(instructionProgramIds(tx), cb.unitLimit).units);
  }

  // -- what the legs actually consumed -------------------------------------
  const units = (
    db
      .prepare(`SELECT units_consumed AS u FROM simulation_steps WHERE units_consumed IS NOT NULL`)
      .all() as { u: number }[]
  ).map((r) => r.u);
  const unitsP90 = quantile(units, 0.9);
  const frozen = unitsP90 === null ? null : frozenComputeLimit(unitsP90);

  const priceMedian = medianBig(prices);
  const priceP90 = prices.length === 0 ? null : BigInt(quantile(prices.map(Number), 0.9) ?? 0);
  const derivedMedian = median(derivedLimits);

  const feeFor = (price: bigint | null, limit: number | null): bigint | null => {
    if (price === null || limit === null || limit <= 0) return null;
    // CEILING, per §10.1. A model that floors is optimistic on every leg.
    return (price * BigInt(limit) + 999_999n) / 1_000_000n;
  };

  // -- rent, by the scope the corpus recorded ------------------------------
  const rentRows = db
    .prepare(
      `SELECT leg, economic_scope AS scope, recoverability, COUNT(*) AS accounts,
              COUNT(DISTINCT trajectory_id) AS trajectories,
              CAST(SUM(CAST(rent_exempt_min AS INTEGER)) AS TEXT) AS rent
         FROM created_accounts
        GROUP BY leg, economic_scope, recoverability`,
    )
    .all() as { leg: string; scope: string; recoverability: string; accounts: number; trajectories: number; rent: string }[];
  const trajectoriesWithAccounts = (
    db.prepare(`SELECT COUNT(DISTINCT trajectory_id) AS n FROM created_accounts`).get() as { n: number }
  ).n;
  const perTrajectory = (predicate: (r: (typeof rentRows)[number]) => boolean): bigint => {
    if (trajectoriesWithAccounts === 0) return 0n;
    let total = 0n;
    for (const r of rentRows) if (predicate(r)) total += BigInt(r.rent);
    return total / BigInt(trajectoriesWithAccounts);
  };
  // Per TRADE: the accounts a trade of its own opens and closes. Per WALLET:
  // the accounts the first trade ever opens and no later trade pays for again.
  const perTradeRecoverable = perTrajectory((r) => r.recoverability === 'RECOVERABLE_BY_US');
  // ONE account per class, not a per-trajectory average. Each of these opens
  // once per wallet and no later trade pays for it again, so dividing the
  // corpus total by the number of trajectories would amortise a one-time cost
  // across exactly the trades that never pay it.
  let perWalletOneTime = 0n;
  for (const r of rentRows) {
    if (r.recoverability === 'RECOVERABLE_BY_US') continue;
    if (!r.scope.startsWith('WALLET_') || r.scope === 'WALLET_TOKEN_MINT') continue;
    if (r.accounts === 0) continue;
    perWalletOneTime += BigInt(r.rent) / BigInt(r.accounts);
  }
  const perTradeUnrecoverable = perTrajectory(
    (r) => r.recoverability !== 'RECOVERABLE_BY_US' && r.scope === 'WALLET_TOKEN_MINT',
  );

  const recovered = db
    .prepare(`SELECT CAST(SUM(CAST(rent_recovered_lamports AS INTEGER)) AS TEXT) AS r, COUNT(*) AS n FROM leg_settlements WHERE leg = 'sell'`)
    .get() as { r: string | null; n: number };
  const rentRecoveredPerSell = recovered.r === null || recovered.n === 0 ? null : BigInt(recovered.r) / BigInt(recovered.n);

  const transferRows = db
    .prepare(`SELECT transfer_fee_status AS s, COUNT(*) AS n FROM leg_settlements GROUP BY transfer_fee_status`)
    .all() as { s: string; n: number }[];
  const transferFeeStatuses: Record<string, number> = {};
  for (const r of transferRows) transferFeeStatuses[r.s] = r.n;

  const attempts = (db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts`).get() as { n: number }).n;
  const landedFailures = (
    db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts WHERE outcome NOT IN ('LANDED','landed')`).get() as {
      n: number;
    }
  ).n;

  return {
    baseFeePerLegLamports: baseFee,
    baseFeeSource,
    baseFeeLegsMeasured: legsMeasured,
    unitPriceMicroLamportsMedian: priceMedian,
    unitPriceMicroLamportsP90: priceP90,
    unitPriceBuildsRead: read,
    unitPriceBuildsWithPrice: prices.length,
    unitPriceBuildsUnreadable: unreadable,
    unitPriceBuildsPlaceholderBlockhash: placeholderBlockhash,
    explicitLimitBuilds: explicitLimits,
    derivedDefaultLimitMedian: derivedMedian,
    unitsConsumedP50: quantile(units, 0.5),
    unitsConsumedP90: unitsP90,
    unitsConsumedMax: units.length === 0 ? null : Math.max(...units),
    unitsConsumedLegs: units.length,
    frozenRequestedLimit: frozen?.requestedUnits ?? null,
    frozenMarginPct: FROZEN_CU_MARGIN_PCT,
    priorityFeeAsBuiltLamports: feeFor(priceMedian, derivedMedian === null ? null : Math.round(derivedMedian)),
    priorityFeeWithFrozenLimitLamports: feeFor(priceMedian, frozen?.requestedUnits ?? null),
    rentPerTradeRecoverableLamports: perTradeRecoverable,
    rentPerTradeUnrecoverableLamports: perTradeUnrecoverable,
    rentOneTimePerWalletLamports: perWalletOneTime,
    rentRecoveredMeasuredLamports: rentRecoveredPerSell,
    rentClasses: rentRows.map((r) => ({
      leg: r.leg,
      scope: r.scope,
      recoverability: r.recoverability,
      accounts: r.accounts,
      trajectories: r.trajectories,
      rentLamports: r.rent,
    })),
    transferFeeStatuses,
    submittedAttempts: attempts,
    landedFailures,
  };
}

// ---------------------------------------------------------------------------
// 2 — THE VENUE DRAG, PRICED OFFLINE AGAINST EVERY STORED POOL
// ---------------------------------------------------------------------------

interface PoolState {
  readonly mint: string;
  readonly pool: string;
  readonly capturedUtcMs: number;
  readonly src: AccountBytesSource;
  readonly baseReserve: bigint;
  readonly effectiveQuoteReserve: bigint;
}

function loadPools(): { pools: PoolState[]; skipped: Record<string, number> } {
  const rows = db
    .prepare(
      `SELECT c.mint AS mint, c.pool AS pool, c.captured_utc_ms AS captured, c.manifest_blob_sha256 AS manifest
         FROM coherent_snapshots c
         JOIN (SELECT pool, MAX(captured_utc_ms) AS m FROM coherent_snapshots GROUP BY pool) latest
           ON latest.pool = c.pool AND latest.m = c.captured_utc_ms
        ORDER BY c.captured_utc_ms DESC`,
    )
    .all() as { mint: string; pool: string; captured: number; manifest: string }[];

  const pools: PoolState[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.pool)) continue;
    seen.add(r.pool);
    try {
      const accounts = evidence.get<
        { pubkey: string; owner: string; dataBase64: string | null; lamports: string | number }[]
      >(r.manifest);
      const src = accountSourceOf(
        accounts.map((a) => ({
          pubkey: a.pubkey,
          owner: a.owner,
          dataBase64: a.dataBase64,
          lamports: typeof a.lamports === 'string' ? BigInt(a.lamports) : BigInt(Math.trunc(a.lamports)),
        })),
      );
      const facts = poolFactsFrom(src, r.pool);
      pools.push({
        mint: r.mint,
        pool: r.pool,
        capturedUtcMs: r.captured,
        src,
        baseReserve: facts.baseReserve,
        effectiveQuoteReserve: facts.quoteReserveRaw + facts.virtualQuoteReserves,
      });
    } catch (e) {
      const name = (e as Error).name === 'Error' ? (e as Error).message.slice(0, 60) : (e as Error).name;
      skipped[name] = (skipped[name] ?? 0) + 1;
    }
  }
  return { pools, skipped };
}

interface VenuePoint {
  /** 1 − (lamports recovered by a same-depth exit) / notional, in bps. */
  readonly venueDragBps: number;
  /** The same quantity in lamports, so the total never round-trips through a float. */
  readonly venueCostLamports: bigint;
  readonly entryDragBps: number;
  readonly exitDragBps: number;
  readonly reserveShareBps: number;
  readonly positionOverBaseReserveBps: number;
  /**
   * Entry drag with this pool's own fee tier removed: the part that is IMPACT.
   *
   * The frozen bound `maxPriceImpactBps` is 50, and the fee tier alone is about
   * 124 bps one way. Comparing the fee-inclusive drag against an impact bound
   * refuses every size on every pool and reads as a depth verdict, which is the
   * mistake the P13 report found in the previous size surface.
   */
  readonly entryImpactBps: number;
}

/**
 * Price one notional against one stored pool. Throws exactly what the SDK throws.
 *
 * `entryFeeOnlyBps` is this pool's entry drag at the probe notional, which is
 * fee plus a tenth of a basis point of impact. Passing it in rather than
 * recomputing it keeps the fee tier per-pool: the tier is a step function of
 * market cap, so one median across pools would misprice both ends.
 */
function priceRoundTrip(p: PoolState, notional: bigint, entryFeeOnlyBps: number | null): VenuePoint {
  const buy = quoteBuyFrom(p.src, p.pool, notional, SLIPPAGE_PCT);
  const sell = quoteSellFrom(p.src, p.pool, buy.baseOutAtoms, SLIPPAGE_PCT);
  // Mid value of the acquired atoms, at the pre-trade marginal price. The
  // benchmark the reconstructed gross return is measured against.
  const midValue = (buy.baseOutAtoms * p.effectiveQuoteReserve) / p.baseReserve;
  const entryDragBps = bpsOf(notional - midValue, notional) ?? 0;
  return {
    venueDragBps: bpsOf(notional - sell.quoteOutLamports, notional) ?? 0,
    venueCostLamports: notional - sell.quoteOutLamports,
    entryDragBps,
    exitDragBps: bpsOf(midValue - sell.quoteOutLamports, midValue === 0n ? 1n : midValue) ?? 0,
    reserveShareBps: bpsOf(notional, p.effectiveQuoteReserve) ?? 0,
    positionOverBaseReserveBps: bpsOf(buy.baseOutAtoms, p.baseReserve) ?? 0,
    entryImpactBps: entryFeeOnlyBps === null ? entryDragBps : Math.max(0, entryDragBps - entryFeeOnlyBps),
  };
}

// ---------------------------------------------------------------------------
// 3 — ASSEMBLE, THROUGH THE ONE ACCOUNTING MODULE
// ---------------------------------------------------------------------------

const fixed = measureFixedCosts();
const { pools, skipped } = loadPools();
console.log(`priced against ${pools.length} stored pools; ${Object.keys(skipped).length} skip reasons`);

// The fee floor: the same round trip at a notional small enough that its own
// impact is a rounding. What is left after subtracting it is impact.
const feeFloorByPool = new Map<string, number>();
const entryFeeFloorByPool = new Map<string, number>();
for (const p of pools) {
  try {
    const probe = priceRoundTrip(p, FEE_FLOOR_PROBE_LAMPORTS, null);
    feeFloorByPool.set(p.pool, probe.venueDragBps);
    entryFeeFloorByPool.set(p.pool, probe.entryDragBps);
  } catch {
    /* a pool that cannot price the probe cannot contribute a floor */
  }
}
const feeFloorMedianBps = median([...feeFloorByPool.values()]);
const entryFeeFloorMedianBps = median([...entryFeeFloorByPool.values()]);

const priorityPerLeg = fixed.priorityFeeWithFrozenLimitLamports ?? fixed.priorityFeeAsBuiltLamports ?? 0n;
const priorityBasis =
  fixed.priorityFeeWithFrozenLimitLamports !== null
    ? 'two-pass frozen limit against the measured median unit price'
    : fixed.priorityFeeAsBuiltLamports !== null
      ? 'the limit the current builds apply, against the measured median unit price'
      : 'NO STORED BUILD CARRIED A UNIT PRICE';

interface Row {
  readonly notionalLamports: string;
  readonly notionalSol: number;
  readonly poolsPriced: number;
  readonly poolsRefused: number;
  readonly refusalReasons: Readonly<Record<string, number>>;
  readonly poolsAdmissible: number;
  readonly admissibleFraction: number | null;
  readonly medianReserveShareBps: number | null;
  readonly medianEntryDragBps: number | null;
  readonly medianEntryImpactBps: number | null;
  readonly medianExitDragBps: number | null;
  readonly medianVenueDragBps: number | null;
  readonly medianImpactBps: number | null;
  readonly feeFloorBps: number | null;
  readonly baseSignatureCostLamports: string;
  readonly priorityFeeLamports: string;
  readonly expectedFailedAttemptLamports: Readonly<Record<string, string>>;
  readonly ataRentLockedLamports: string;
  readonly ataRentRecoveredLamports: string;
  readonly ataRentNotRecoveredLamports: string;
  readonly fixedCostLamports: string;
  readonly fixedCostBps: number | null;
  readonly venueCostLamports: string | null;
  readonly totalRoundTripCostBps: number | null;
  readonly totalRoundTripCostPct: number | null;
  readonly totalRoundTripCostPctStress20: number | null;
  readonly accountingComplete: boolean;
  readonly accountingMissing: readonly string[];
}

function buildRow(notional: bigint): Row {
  const points: VenuePoint[] = [];
  const refusals: Record<string, number> = {};
  for (const p of pools) {
    try {
      points.push(priceRoundTrip(p, notional, entryFeeFloorByPool.get(p.pool) ?? null));
    } catch (e) {
      const err = e as Error;
      const key = err.name === 'Error' ? err.message.slice(0, 70) : err.name;
      refusals[key] = (refusals[key] ?? 0) + 1;
    }
  }

  // The FROZEN bounds, unchanged. A refusal here is a fact about the pool at
  // this size, and no bound is widened to make a larger notional admissible.
  const admissible = points.filter(
    (pt) =>
      pt.reserveShareBps <= FROZEN_SIZE_BOUNDS.maxReserveShareBps &&
      pt.entryImpactBps <= FROZEN_SIZE_BOUNDS.maxPriceImpactBps &&
      pt.venueDragBps <= FROZEN_SIZE_BOUNDS.maxRoundTripDragBps,
  );

  const venueBps = median(points.map((pt) => pt.venueDragBps));
  const impactBps = venueBps === null || feeFloorMedianBps === null ? null : venueBps - feeFloorMedianBps;

  // Every scenario priced; the primary total uses the observed (zero) rate and
  // carries `complete: false`, because zero submitted attempts is not a rate.
  const failureBasis: 'observed' | 'unknown' = fixed.submittedAttempts === 0 ? 'unknown' : 'observed';
  const conditional = fixed.baseFeePerLegLamports + priorityPerLeg;
  const failureByScenario: Record<string, string> = {};
  for (const s of FAILURE_SCENARIOS) {
    const f =
      s.rate === 0
        ? expectedFailureCost({ landedFailures: 0, total: fixed.submittedAttempts }, conditional, failureBasis)
        : expectedFailureCost(
            { landedFailures: Math.round(s.rate * 1000), total: 1000 },
            conditional,
            'upper-confidence-bound',
          );
    failureByScenario[s.label] = f.expectedLamports.toString();
  }
  const failure = expectedFailureCost(
    { landedFailures: 0, total: fixed.submittedAttempts },
    conditional,
    failureBasis,
  );
  const failureStress = expectedFailureCost(
    { landedFailures: 200, total: 1000 },
    conditional,
    'upper-confidence-bound',
  );

  // The venue drag applies to the notional; the exit's proceeds are what the
  // accounting module receives as `outputLamports`.
  const venueCost = medianBig(points.map((pt) => pt.venueCostLamports));
  const proceeds = venueCost === null ? null : notional - venueCost;

  const assemble = (
    f: ReturnType<typeof expectedFailureCost>,
  ): { costLamports: bigint | null; complete: boolean; missing: readonly string[] } => {
    const out = entryCashOut({
      inputLamports: notional,
      baseFeeLamports: fixed.baseFeePerLegLamports,
      priorityFeeLamports: priorityPerLeg,
      routeTipLamports: 0n,
      rentCreatedLamports: fixed.rentPerTradeRecoverableLamports + fixed.rentPerTradeUnrecoverableLamports,
      transferFeeLamports: 0n,
      platformFeeLamports: 0n,
      failure: f,
    });
    if (proceeds === null) return { costLamports: null, complete: false, missing: ['no pool priced this notional'] };
    const back = exitCashIn({
      outputLamports: proceeds,
      baseFeeLamports: fixed.baseFeePerLegLamports,
      priorityFeeLamports: priorityPerLeg,
      routeTipLamports: 0n,
      transferFeeLamports: 0n,
      // The base ATA closes in the SAME transaction as the exit swap, which is
      // what production does and what §10.4 says costs no second signature.
      separateCloseTransaction: false,
      rentRecoveredLamports: fixed.rentPerTradeRecoverableLamports,
      failure: f,
    });
    return {
      costLamports: out.cashLamports - back.cashLamports,
      complete: out.complete && back.complete,
      missing: [...out.missing, ...back.missing],
    };
  };

  const primary = assemble(failure);
  const stressed = assemble(failureStress);

  const fixedOnly =
    2n * (fixed.baseFeePerLegLamports + priorityPerLeg) +
    failure.expectedLamports * 2n +
    fixed.rentPerTradeUnrecoverableLamports;

  return {
    notionalLamports: notional.toString(),
    notionalSol: Number(notional) / 1e9,
    poolsPriced: points.length,
    poolsRefused: Object.values(refusals).reduce((a, b) => a + b, 0),
    refusalReasons: refusals,
    poolsAdmissible: admissible.length,
    admissibleFraction: pools.length === 0 ? null : admissible.length / pools.length,
    medianReserveShareBps: median(points.map((pt) => pt.reserveShareBps)),
    medianEntryDragBps: median(points.map((pt) => pt.entryDragBps)),
    medianEntryImpactBps: median(points.map((pt) => pt.entryImpactBps)),
    medianExitDragBps: median(points.map((pt) => pt.exitDragBps)),
    medianVenueDragBps: venueBps,
    medianImpactBps: impactBps,
    feeFloorBps: feeFloorMedianBps,
    baseSignatureCostLamports: (2n * fixed.baseFeePerLegLamports).toString(),
    priorityFeeLamports: (2n * priorityPerLeg).toString(),
    expectedFailedAttemptLamports: failureByScenario,
    ataRentLockedLamports: fixed.rentPerTradeRecoverableLamports.toString(),
    ataRentRecoveredLamports: fixed.rentPerTradeRecoverableLamports.toString(),
    ataRentNotRecoveredLamports: fixed.rentPerTradeUnrecoverableLamports.toString(),
    fixedCostLamports: fixedOnly.toString(),
    fixedCostBps: bpsOf(fixedOnly, notional),
    venueCostLamports: venueCost === null ? null : venueCost.toString(),
    totalRoundTripCostBps: primary.costLamports === null ? null : costBps(primary.costLamports, notional),
    totalRoundTripCostPct:
      primary.costLamports === null ? null : Number((primary.costLamports * 1_000_000n) / notional) / 10_000,
    totalRoundTripCostPctStress20:
      stressed.costLamports === null ? null : Number((stressed.costLamports * 1_000_000n) / notional) / 10_000,
    accountingComplete: primary.complete,
    accountingMissing: [...new Set(primary.missing)],
  };
}

const rows: Row[] = GRID.map(buildRow);
/**
 * BELOW the directive's grid, and labelled as a diagnostic rather than a result.
 *
 * The seven grid notionals come out MONOTONE INCREASING, which locates the
 * U-curve minimum at or below 0.02 SOL and does not say where. These two points
 * say where, and they are recorded in the multiple-testing ledger alongside the
 * grid because "every notional examined in this step" includes the ones that
 * were examined to establish that the smallest grid point is near-optimal.
 */
const BELOW_GRID: readonly bigint[] = [5_000_000n, 10_000_000n];
const belowGridDiagnostic: Row[] = BELOW_GRID.map(buildRow);

// ---------------------------------------------------------------------------
// 4 — THE MINIMUM, AND THE ONE THAT SURVIVES THE FROZEN DEPTH BOUND
// ---------------------------------------------------------------------------

const priced = rows.filter((r) => r.totalRoundTripCostPct !== null);
const cheapest = priced.reduce<Row | null>(
  (best, r) => (best === null || (r.totalRoundTripCostPct as number) < (best.totalRoundTripCostPct as number) ? r : best),
  null,
);
/** The same minimum, restricted to notionals a majority of pools can actually take. */
const OPERABLE_ADMISSIBLE_FRACTION = 0.5;
const operable = priced.filter((r) => (r.admissibleFraction ?? 0) >= OPERABLE_ADMISSIBLE_FRACTION);
const cheapestOperable = operable.reduce<Row | null>(
  (best, r) => (best === null || (r.totalRoundTripCostPct as number) < (best.totalRoundTripCostPct as number) ? r : best),
  null,
);
const monotone = priced.every(
  (r, i) => i === 0 || (r.totalRoundTripCostPct as number) >= (priced[i - 1]?.totalRoundTripCostPct as number),
);

const surface = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'phase-a-cost-surface-v1',
    sampleInclusionQuery:
      'latest coherent_snapshots per pool, priced offline through the pinned PumpSwap SDK; fixed costs from ' +
      'leg_settlements, simulation_steps, created_accounts and stored exact transactions',
  }),
  label: 'DEVELOPMENT_MEASURED_FIXED_COSTS_WITH_MODELLED_VENUE_DRAG',
  directive: 'd70b4a9a §1.1',
  slippagePct: SLIPPAGE_PCT,
  feeFloorProbeLamports: FEE_FLOOR_PROBE_LAMPORTS.toString(),
  feeFloorMedianBps,
  entryFeeFloorMedianBps,
  exitPricedAgainst: 'PRE_BUY_RESERVES',
  exitPricedAgainstRationale:
    'a position held for minutes to days exits into a pool of some depth, not into the state its own entry left; ' +
    'pricing the exit against the post-buy state cancels first-order impact and reports a fee-only round trip',
  poolsAvailable: pools.length,
  poolSkipReasons: skipped,
  frozenSizeBounds: FROZEN_SIZE_BOUNDS,
  priorityFeeBasis: priorityBasis,
  fixedCosts: {
    ...fixed,
    baseFeePerLegLamports: fixed.baseFeePerLegLamports.toString(),
    unitPriceMicroLamportsMedian: fixed.unitPriceMicroLamportsMedian?.toString() ?? null,
    unitPriceMicroLamportsP90: fixed.unitPriceMicroLamportsP90?.toString() ?? null,
    priorityFeeAsBuiltLamports: fixed.priorityFeeAsBuiltLamports?.toString() ?? null,
    priorityFeeWithFrozenLimitLamports: fixed.priorityFeeWithFrozenLimitLamports?.toString() ?? null,
    rentPerTradeRecoverableLamports: fixed.rentPerTradeRecoverableLamports.toString(),
    rentPerTradeUnrecoverableLamports: fixed.rentPerTradeUnrecoverableLamports.toString(),
    rentOneTimePerWalletLamports: fixed.rentOneTimePerWalletLamports.toString(),
    rentRecoveredMeasuredLamports: fixed.rentRecoveredMeasuredLamports?.toString() ?? null,
  },
  rows,
  belowGridDiagnostic,
  notionalMinCostLamports: cheapest?.notionalLamports ?? null,
  costFloorPct: cheapest?.totalRoundTripCostPct ?? null,
  notionalMinCostOperableLamports: cheapestOperable?.notionalLamports ?? null,
  costFloorPctOperable: cheapestOperable?.totalRoundTripCostPct ?? null,
  operableAdmissibleFraction: OPERABLE_ADMISSIBLE_FRACTION,
  shape: monotone
    ? 'MONOTONE_INCREASING — the minimum is the smallest notional on the grid, so the U-curve minimum is at or below it'
    : 'INTERIOR_MINIMUM',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/cost-surface.json', JSON.stringify(surface, null, 2) + '\n');

// ---------------------------------------------------------------------------
// 5 — THE PLOT. Self-contained SVG; no plotting dependency exists here.
// ---------------------------------------------------------------------------

const plot = (): string => {
  const W = 720;
  const H = 420;
  const L = 70;
  const R = 20;
  const T = 30;
  const B = 60;
  const xs = priced.map((r) => Math.log10(r.notionalSol));
  const totals = priced.map((r) => r.totalRoundTripCostPct as number);
  const fixedPct = priced.map((r) => (r.fixedCostBps ?? 0) / 100);
  const venuePct = priced.map((r) => (r.medianVenueDragBps ?? 0) / 100);
  const yMax = Math.max(...totals, ...venuePct, 1) * 1.15;
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const px = (x: number): number => L + ((x - xMin) / (xMax - xMin || 1)) * (W - L - R);
  const py = (y: number): number => H - B - (y / yMax) * (H - T - B);
  const path = (ys: readonly number[]): string =>
    ys.map((y, i) => `${i === 0 ? 'M' : 'L'}${px(xs[i] as number).toFixed(1)},${py(y).toFixed(1)}`).join(' ');
  const ticks = priced
    .map(
      (r, i) =>
        `<text x="${px(xs[i] as number).toFixed(1)}" y="${H - B + 18}" font-size="11" text-anchor="middle" fill="#444">${r.notionalSol}</text>`,
    )
    .join('');
  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = py(f * yMax);
      return `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" stroke="#e5e5e5"/><text x="${L - 8}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#444">${(f * yMax).toFixed(1)}%</text>`;
    })
    .join('');
  const dots = priced
    .map((r, i) => `<circle cx="${px(xs[i] as number).toFixed(1)}" cy="${py(r.totalRoundTripCostPct as number).toFixed(1)}" r="3.5" fill="#1f77b4"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${L}" y="18" font-size="13" fill="#111">round-trip cost as % of notional — stored pools, offline SDK pricing (n=${pools.length})</text>
${gridLines}
<line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#888"/>
<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#888"/>
${ticks}
<text x="${(W / 2).toFixed(0)}" y="${H - 12}" font-size="12" text-anchor="middle" fill="#111">notional (SOL, log scale)</text>
<path d="${path(venuePct)}" fill="none" stroke="#ff7f0e" stroke-width="2" stroke-dasharray="5,4"/>
<path d="${path(fixedPct)}" fill="none" stroke="#2ca02c" stroke-width="2" stroke-dasharray="2,3"/>
<path d="${path(totals)}" fill="none" stroke="#1f77b4" stroke-width="2.5"/>
${dots}
<g font-size="11">
<rect x="${W - R - 210}" y="${T + 4}" width="200" height="54" fill="#fff" stroke="#ddd"/>
<line x1="${W - R - 200}" y1="${T + 20}" x2="${W - R - 170}" y2="${T + 20}" stroke="#1f77b4" stroke-width="2.5"/><text x="${W - R - 164}" y="${T + 24}" fill="#111">total round-trip cost</text>
<line x1="${W - R - 200}" y1="${T + 36}" x2="${W - R - 170}" y2="${T + 36}" stroke="#ff7f0e" stroke-width="2" stroke-dasharray="5,4"/><text x="${W - R - 164}" y="${T + 40}" fill="#111">venue drag (fee + impact)</text>
<line x1="${W - R - 200}" y1="${T + 50}" x2="${W - R - 170}" y2="${T + 50}" stroke="#2ca02c" stroke-width="2" stroke-dasharray="2,3"/><text x="${W - R - 164}" y="${T + 54}" fill="#111">fixed cost / notional</text>
</g>
</svg>
`;
};
writeFileSync('artifacts/cost-surface.svg', plot());

// ---------------------------------------------------------------------------
// 6 — WHAT IT SAYS, ON STDOUT
// ---------------------------------------------------------------------------

console.log('');
console.log('fixed costs, each from its own measurement');
console.log(`  base fee per leg          ${fixed.baseFeePerLegLamports} (${fixed.baseFeeSource})`);
console.log(
  `  router unit price         median ${fixed.unitPriceMicroLamportsMedian ?? 'none'} µlamports/CU over ${fixed.unitPriceBuildsWithPrice}/${fixed.unitPriceBuildsRead} stored builds`,
);
console.log(
  `  units consumed            p50 ${fixed.unitsConsumedP50} p90 ${fixed.unitsConsumedP90} max ${fixed.unitsConsumedMax} over ${fixed.unitsConsumedLegs} legs`,
);
console.log(
  `  applied limit             derived-default median ${fixed.derivedDefaultLimitMedian}, two-pass frozen ${fixed.frozenRequestedLimit} (+${fixed.frozenMarginPct}%)`,
);
console.log(
  `  priority fee per leg      as built ${fixed.priorityFeeAsBuiltLamports ?? 'unknown'}, with frozen limit ${fixed.priorityFeeWithFrozenLimitLamports ?? 'unknown'}`,
);
console.log(
  `  rent per trade            recoverable ${fixed.rentPerTradeRecoverableLamports} (measured recovery ${fixed.rentRecoveredMeasuredLamports ?? 'none'} per sell), unrecoverable ${fixed.rentPerTradeUnrecoverableLamports}`,
);
console.log(`  rent once per wallet      ${fixed.rentOneTimePerWalletLamports}`);
console.log(`  submitted attempts        ${fixed.submittedAttempts} (landed failures ${fixed.landedFailures})`);
console.log(`  fee floor (probe)         ${feeFloorMedianBps ?? 'none'} bps over ${feeFloorByPool.size} pools`);
console.log('');
console.log('notional  priced  admissible  fixed%  venue%  impact%  TOTAL%  stress20%');
for (const r of rows) {
  const pct = (v: number | null): string => (v === null ? '     -' : v.toFixed(2).padStart(6));
  console.log(
    `${r.notionalSol.toFixed(2).padStart(5)}  ${String(r.poolsPriced).padStart(6)}  ${String(r.poolsAdmissible).padStart(10)}  ${pct((r.fixedCostBps ?? 0) / 100)}  ${pct((r.medianVenueDragBps ?? 0) / 100)}  ${pct((r.medianImpactBps ?? 0) / 100)}  ${pct(r.totalRoundTripCostPct)}  ${pct(r.totalRoundTripCostPctStress20)}`,
  );
}
console.log('');
console.log(`notional_min_cost         ${cheapest?.notionalSol ?? 'none'} SOL`);
console.log(`cost_floor_pct            ${cheapest?.totalRoundTripCostPct ?? 'none'} %`);
console.log(`shape                     ${surface.shape}`);
console.log(
  `operable minimum          ${cheapestOperable?.notionalSol ?? 'none'} SOL at ${cheapestOperable?.totalRoundTripCostPct ?? 'none'} % (>=${OPERABLE_ADMISSIBLE_FRACTION * 100}% of pools admissible)`,
);
console.log('');
console.log('wrote artifacts/cost-surface.json and artifacts/cost-surface.svg');
