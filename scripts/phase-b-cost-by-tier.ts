/**
 * `pnpm cost:by-tier` — the §1.1 cost surface, re-cut along the fee tier.
 *
 * §1.3 of the Phase B directive. Same stored pools, same offline SDK pricing,
 * same `exitPricedAgainst: PRE_BUY_RESERVES` — that choice was correct and is
 * unchanged. What changes is the stratification: pools are grouped by the tier
 * the program would charge them, and the grid is priced inside each group.
 *
 * WHY THE STRATIFICATION IS NOT JUST A REGROUPING
 *
 * The SDK selects the tier from each pool's own market cap, so pricing pool P at
 * notional N already charges P's tier. Nothing is modelled here and no tier's
 * fee is substituted into another tier's pool. The strata differ in TWO ways at
 * once, and the artifact separates them:
 *
 *   the FEE      exact, from the decoded schedule: 250 bps round trip at tier 0
 *                down to 60 at tier 24;
 *   the DEPTH    measured, and correlated with the tier — median effective quote
 *                reserve is 24.6 SOL at tier 0 and 185 SOL at tier 2 — which is
 *                what decides whether a larger notional is admissible at all.
 *
 * A reader who takes only the fee saving away from this has taken the smaller
 * half. At 0.02 SOL the whole impact term is 15 bps, so the fee is nearly all of
 * the cost; at 1.00 SOL a tier-0 pool is not enterable under the frozen depth
 * bound and a tier-7 pool is.
 *
 * Read-only, offline. No network call, nothing signed, nothing funded.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { EvidenceStore } from '../packages/storage/src/evidence-repo.js';
import { feeTiersOf, selectFeeTier, poolMarketCapLamports } from '../packages/solana/src/fee-tiers.js';
import {
  accountSourceOf,
  poolFactsFrom,
  quoteBuyFrom,
  quoteSellFrom,
  type AccountBytesSource,
} from '../packages/solana/src/pumpswap-offline.js';
import { entryCashOut, exitCashIn, expectedFailureCost, costBps } from '../packages/domain/src/accounting.js';
import { FROZEN_SIZE_BOUNDS } from '../packages/strategy/src/size-rule.js';
import { deriveSolUsd, solUsdAt } from '../packages/research/src/sol-usd.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

/** §1.3's grid: the directive's seven notionals plus the two below-grid points. */
const GRID: readonly bigint[] = [
  5_000_000n,
  10_000_000n,
  20_000_000n,
  50_000_000n,
  100_000_000n,
  200_000_000n,
  350_000_000n,
  500_000_000n,
  1_000_000_000n,
];
const FEE_FLOOR_PROBE_LAMPORTS = 200_000n;
const SLIPPAGE_PCT = 3;
/** The 2m-60m entry and exit rules, unchanged from D70B4A9A §1.2. */
const ENTRY_LO_MS = 2 * 60_000;
const ENTRY_HI_MS = ENTRY_LO_MS + 0.25 * (60 * 60_000 - ENTRY_LO_MS);
const EXIT_LO_MS = 0.75 * 60 * 60_000;
const EXIT_HI_MS = 1.25 * 60 * 60_000;
const EXIT_TARGET_MS = 60 * 60_000;

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const evidence = new EvidenceStore(db, 'data/evidence-blobs');
const sdk = new PumpAmmSdk();
const feeAddr = PUMP_AMM_FEE_CONFIG_PDA.toBase58();

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : (((s[m - 1] as number) + (s[m] as number)) / 2);
};
const medianBig = (xs: readonly bigint[]): bigint | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)] as bigint;
};
/** The accounting module's own bps, so this file does not carry a second one. */
const bpsOf = costBps;

// ---------------------------------------------------------------------------
// 1 — FIXED COSTS, TAKEN FROM §1.1's SURFACE RATHER THAN RE-MEASURED
// ---------------------------------------------------------------------------

interface PhaseACostSurface {
  fixedCosts: {
    baseFeePerLegLamports: string;
    priorityFeeWithFrozenLimitLamports: string | null;
    priorityFeeAsBuiltLamports: string | null;
    rentPerTradeRecoverableLamports: string;
    rentPerTradeUnrecoverableLamports: string;
    submittedAttempts: number;
  };
}
const PHASE_A = 'artifacts/cost-surface.json';
if (!existsSync(PHASE_A)) {
  console.error(`${PHASE_A} is required; run pnpm cost:floor first`);
  process.exit(1);
}
const phaseA = JSON.parse(readFileSync(PHASE_A, 'utf8')) as PhaseACostSurface;
const baseFeePerLeg = BigInt(phaseA.fixedCosts.baseFeePerLegLamports);
const priorityPerLeg = BigInt(
  phaseA.fixedCosts.priorityFeeWithFrozenLimitLamports ?? phaseA.fixedCosts.priorityFeeAsBuiltLamports ?? '0',
);
const rentRecoverable = BigInt(phaseA.fixedCosts.rentPerTradeRecoverableLamports);
const rentUnrecoverable = BigInt(phaseA.fixedCosts.rentPerTradeUnrecoverableLamports);
const submittedAttempts = phaseA.fixedCosts.submittedAttempts;

// ---------------------------------------------------------------------------
// 2 — THE POOLS, EACH WITH ITS OWN TIER
// ---------------------------------------------------------------------------

interface Pool {
  mint: string;
  pool: string;
  capturedUtcMs: number;
  src: AccountBytesSource;
  baseReserve: bigint;
  effectiveQuoteReserve: bigint;
  marketCapSol: number;
  tierIndex: number;
  tierOneWayBps: number;
}

const snapshotRows = db
  .prepare(
    `SELECT c.mint AS mint, c.pool AS pool, c.captured_utc_ms AS captured, c.manifest_blob_sha256 AS manifest
       FROM coherent_snapshots c
       JOIN (SELECT pool, MAX(captured_utc_ms) AS m FROM coherent_snapshots GROUP BY pool) latest
         ON latest.pool = c.pool AND latest.m = c.captured_utc_ms`,
  )
  .all() as { mint: string; pool: string; captured: number; manifest: string }[];

let tiers: ReturnType<typeof feeTiersOf> = [];
const pools: Pool[] = [];
const skipped: Record<string, number> = {};
const seenPools = new Set<string>();

for (const r of snapshotRows) {
  if (seenPools.has(r.pool)) continue;
  seenPools.add(r.pool);
  try {
    const accounts = evidence.get<{ pubkey: string; owner: string; dataBase64: string | null; lamports: string | number }[]>(
      r.manifest,
    );
    if (tiers.length === 0) {
      const raw = accounts.find((a) => a.pubkey === feeAddr);
      if (raw?.dataBase64 == null) throw new Error('no fee config in the snapshot');
      tiers = feeTiersOf(
        sdk.decodeFeeConfig({
          owner: new PublicKey(raw.owner),
          data: Buffer.from(raw.dataBase64, 'base64'),
          lamports: 1,
          executable: false,
          rentEpoch: 0,
        }),
      );
    }
    const src = accountSourceOf(
      accounts.map((a) => ({
        pubkey: a.pubkey,
        owner: a.owner,
        dataBase64: a.dataBase64,
        lamports: typeof a.lamports === 'string' ? BigInt(a.lamports) : BigInt(Math.trunc(a.lamports)),
      })),
    );
    const facts = poolFactsFrom(src, r.pool);
    if (facts.baseMintSupplyAtoms === null) throw new Error('base mint supply was not read');
    const eff = facts.quoteReserveRaw + facts.virtualQuoteReserves;
    const cap = poolMarketCapLamports({
      quoteReserveLamports: eff,
      baseReserveAtoms: facts.baseReserve,
      baseMintSupplyAtoms: facts.baseMintSupplyAtoms,
    });
    const t = selectFeeTier(tiers, cap);
    if (t === null) throw new Error('no tier could be selected');
    const idx = tiers.findIndex((x) => x.marketCapLamportsThreshold === t.marketCapLamportsThreshold);
    pools.push({
      mint: r.mint,
      pool: r.pool,
      capturedUtcMs: r.captured,
      src,
      baseReserve: facts.baseReserve,
      effectiveQuoteReserve: eff,
      marketCapSol: Number(cap) / 1e9,
      tierIndex: idx,
      tierOneWayBps: t.roundTripBps / 2,
    });
  } catch (e) {
    const key = (e as Error).message.slice(0, 60);
    skipped[key] = (skipped[key] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// 3 — PRICE THE GRID INSIDE EACH TIER
// ---------------------------------------------------------------------------

interface Point {
  venueDragBps: number;
  venueCostLamports: bigint;
  entryDragBps: number;
  entryImpactBps: number;
  reserveShareBps: number;
}

const probeEntryDrag = new Map<string, number>();
const probeVenueDrag = new Map<string, number>();
for (const p of pools) {
  try {
    const buy = quoteBuyFrom(p.src, p.pool, FEE_FLOOR_PROBE_LAMPORTS, SLIPPAGE_PCT);
    const sell = quoteSellFrom(p.src, p.pool, buy.baseOutAtoms, SLIPPAGE_PCT);
    const mid = (buy.baseOutAtoms * p.effectiveQuoteReserve) / p.baseReserve;
    probeEntryDrag.set(p.pool, bpsOf(FEE_FLOOR_PROBE_LAMPORTS - mid, FEE_FLOOR_PROBE_LAMPORTS) ?? 0);
    probeVenueDrag.set(p.pool, bpsOf(FEE_FLOOR_PROBE_LAMPORTS - sell.quoteOutLamports, FEE_FLOOR_PROBE_LAMPORTS) ?? 0);
  } catch {
    /* a pool that cannot price the probe contributes no floor */
  }
}

function price(p: Pool, notional: bigint): Point {
  const buy = quoteBuyFrom(p.src, p.pool, notional, SLIPPAGE_PCT);
  const sell = quoteSellFrom(p.src, p.pool, buy.baseOutAtoms, SLIPPAGE_PCT);
  const mid = (buy.baseOutAtoms * p.effectiveQuoteReserve) / p.baseReserve;
  const entryDragBps = bpsOf(notional - mid, notional) ?? 0;
  const feeOnly = probeEntryDrag.get(p.pool) ?? null;
  return {
    venueDragBps: bpsOf(notional - sell.quoteOutLamports, notional) ?? 0,
    venueCostLamports: notional - sell.quoteOutLamports,
    entryDragBps,
    entryImpactBps: feeOnly === null ? entryDragBps : Math.max(0, entryDragBps - feeOnly),
    reserveShareBps: bpsOf(notional, p.effectiveQuoteReserve) ?? 0,
  };
}

const failureBasis: 'observed' | 'unknown' = submittedAttempts === 0 ? 'unknown' : 'observed';
const conditional = baseFeePerLeg + priorityPerLeg;
const failure = expectedFailureCost({ landedFailures: 0, total: submittedAttempts }, conditional, failureBasis);

function assemble(notional: bigint, venueCost: bigint): { costLamports: bigint; complete: boolean } {
  const out = entryCashOut({
    inputLamports: notional,
    baseFeeLamports: baseFeePerLeg,
    priorityFeeLamports: priorityPerLeg,
    routeTipLamports: 0n,
    rentCreatedLamports: rentRecoverable + rentUnrecoverable,
    transferFeeLamports: 0n,
    platformFeeLamports: 0n,
    failure,
  });
  const back = exitCashIn({
    outputLamports: notional - venueCost,
    baseFeeLamports: baseFeePerLeg,
    priorityFeeLamports: priorityPerLeg,
    routeTipLamports: 0n,
    transferFeeLamports: 0n,
    separateCloseTransaction: false,
    rentRecoveredLamports: rentRecoverable,
    failure,
  });
  return { costLamports: out.cashLamports - back.cashLamports, complete: out.complete && back.complete };
}

// ---------------------------------------------------------------------------
// 4 — EACH TIER'S OWN OBSERVED GROSS MEAN, FOR THE CROSSOVER
// ---------------------------------------------------------------------------

const solUsd = deriveSolUsd(db);

/**
 * The earliest confirmed migration per mint.
 *
 * A fee tier belongs to a POOL, and 276 of 158,085 snapshotted mints ever
 * migrated. A "tier" assigned to a pre-migration token is the tier a pool WOULD
 * be in, and this apparatus cannot enter it — so each stratum's gross mean is
 * reported twice, once over every snapshotted mint and once over the mints that
 * had already migrated when the entry was taken. The two have opposite signs.
 */
const migratedAtMs = new Map<string, number>();
for (const r of db
  .prepare(
    `SELECT mint, MIN(block_time) * 1000 AS ms FROM confirmed_migrations WHERE block_time IS NOT NULL GROUP BY mint`,
  )
  .all() as { mint: string; ms: number }[]) {
  migratedAtMs.set(r.mint, r.ms);
}

interface Snap {
  age: number;
  t: number;
  usd: number;
  mcapSol: number | null;
}
const byMint = new Map<string, Snap[]>();
for (const r of db
  .prepare(
    `SELECT mint, token_age_ms AS age, taken_utc_ms AS t,
            json_extract(features_json, '$.usdPrice') AS usd,
            json_extract(features_json, '$.mcap') AS mcap
       FROM decision_snapshots
      WHERE token_age_ms IS NOT NULL AND token_age_ms <= ${Math.ceil(EXIT_HI_MS)}`,
  )
  .iterate() as Iterable<{ mint: string; age: number; t: number; usd: number | null; mcap: number | null }>) {
  if (r.usd === null || !(r.usd > 0)) continue;
  const rate = solUsdAt(solUsd, r.t);
  const list = byMint.get(r.mint) ?? [];
  list.push({
    age: r.age,
    t: r.t,
    usd: r.usd,
    mcapSol: r.mcap === null || rate === null ? null : r.mcap / rate,
  });
  byMint.set(r.mint, list);
}

const tierIndexOfCapSol = (capSol: number): number | null => {
  const t = selectFeeTier(tiers, BigInt(Math.round(capSol * 1e9)));
  if (t === null) return null;
  return tiers.findIndex((x) => x.marketCapLamportsThreshold === t.marketCapLamportsThreshold);
};

const returnsByTier = new Map<number, number[]>();
const returnsByTierMigrated = new Map<number, number[]>();
let mintsWithEntry = 0;
let mintsCensored = 0;
let mintsMigratedAtEntry = 0;
for (const [mint, snaps] of byMint) {
  snaps.sort((a, b) => a.age - b.age);
  const entry = snaps.find((s) => s.age >= ENTRY_LO_MS && s.age <= ENTRY_HI_MS && s.mcapSol !== null);
  if (entry === undefined) continue;
  mintsWithEntry += 1;
  let exit: Snap | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const s of snaps) {
    if (s.age <= entry.age || s.age < EXIT_LO_MS || s.age > EXIT_HI_MS) continue;
    const gap = Math.abs(s.age - EXIT_TARGET_MS);
    if (gap < bestGap) {
      bestGap = gap;
      exit = s;
    }
  }
  if (exit === undefined) {
    mintsCensored += 1;
    continue;
  }
  const tier = tierIndexOfCapSol(entry.mcapSol as number);
  if (tier === null) continue;
  const list = returnsByTier.get(tier) ?? [];
  // SOL-denominated: the bankroll's own unit.
  const rEntry = solUsdAt(solUsd, entry.t);
  const rExit = solUsdAt(solUsd, exit.t);
  if (rEntry === null || rExit === null) continue;
  const ret = (exit.usd / rExit) / (entry.usd / rEntry) - 1;
  list.push(ret);
  returnsByTier.set(tier, list);
  const migratedAt = migratedAtMs.get(mint);
  if (migratedAt !== undefined && migratedAt <= entry.t) {
    mintsMigratedAtEntry += 1;
    const m = returnsByTierMigrated.get(tier) ?? [];
    m.push(ret);
    returnsByTierMigrated.set(tier, m);
  }
}

const meanOf = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

// ---------------------------------------------------------------------------
// 5 — ASSEMBLE
// ---------------------------------------------------------------------------

const tierStrata = [...new Set(pools.map((p) => p.tierIndex))].sort((a, b) => a - b);

interface StratumRow {
  notionalSol: number;
  poolsPriced: number;
  poolsRefused: number;
  poolsAdmissible: number;
  medianVenueDragBps: number | null;
  medianImpactBps: number | null;
  medianReserveShareBps: number | null;
  feeFloorBps: number | null;
  fixedCostBps: number | null;
  totalCostPct: number | null;
  accountingComplete: boolean;
}

const strata = tierStrata.map((tierIndex) => {
  const inTier = pools.filter((p) => p.tierIndex === tierIndex);
  const feeFloor = median(inTier.map((p) => probeVenueDrag.get(p.pool)).filter((v): v is number => v !== undefined));
  const rows: StratumRow[] = [];
  for (const notional of GRID) {
    const points: Point[] = [];
    let refused = 0;
    for (const p of inTier) {
      try {
        points.push(price(p, notional));
      } catch {
        refused += 1;
      }
    }
    const venueCost = medianBig(points.map((pt) => pt.venueCostLamports));
    const assembled = venueCost === null ? null : assemble(notional, venueCost);
    const fixedOnly = 2n * (baseFeePerLeg + priorityPerLeg) + 2n * failure.expectedLamports + rentUnrecoverable;
    rows.push({
      notionalSol: Number(notional) / 1e9,
      poolsPriced: points.length,
      poolsRefused: refused,
      poolsAdmissible: points.filter(
        (pt) =>
          pt.reserveShareBps <= FROZEN_SIZE_BOUNDS.maxReserveShareBps &&
          pt.entryImpactBps <= FROZEN_SIZE_BOUNDS.maxPriceImpactBps &&
          pt.venueDragBps <= FROZEN_SIZE_BOUNDS.maxRoundTripDragBps,
      ).length,
      medianVenueDragBps: median(points.map((pt) => pt.venueDragBps)),
      medianImpactBps: median(points.map((pt) => pt.entryImpactBps)),
      medianReserveShareBps: median(points.map((pt) => pt.reserveShareBps)),
      feeFloorBps: feeFloor,
      fixedCostBps: bpsOf(fixedOnly, notional),
      totalCostPct:
        assembled === null ? null : Number((assembled.costLamports * 1_000_000n) / notional) / 10_000,
      accountingComplete: assembled?.complete ?? false,
    });
  }
  const priced = rows.filter((r) => r.totalCostPct !== null);
  const cheapest = priced.reduce<StratumRow | null>(
    (best, r) => (best === null || (r.totalCostPct as number) < (best.totalCostPct as number) ? r : best),
    null,
  );
  const grossReturns = returnsByTier.get(tierIndex) ?? [];
  const grossMean = meanOf(grossReturns);
  const migratedReturns = returnsByTierMigrated.get(tierIndex) ?? [];
  const migratedMean = meanOf(migratedReturns);
  /** The notional at which this tier's cost overtakes this tier's gross mean. */
  const crossover =
    grossMean === null
      ? null
      : (priced.find((r) => (r.totalCostPct as number) / 100 >= grossMean)?.notionalSol ??
        (priced.length > 0 ? null : null));
  const reserves = inTier.map((p) => Number(p.effectiveQuoteReserve) / 1e9).sort((a, b) => a - b);
  const caps = inTier.map((p) => p.marketCapSol).sort((a, b) => a - b);
  return {
    tierIndex,
    thresholdSol: Number((tiers[tierIndex]?.marketCapLamportsThreshold ?? 0n) / 1_000_000_000n),
    scheduleOneWayBps: tiers[tierIndex]?.roundTripBps === undefined ? null : (tiers[tierIndex] as { roundTripBps: number }).roundTripBps / 2,
    scheduleRoundTripBps: tiers[tierIndex]?.roundTripBps ?? null,
    pools: inTier.length,
    marketCapSol: { min: caps[0] ?? null, p50: caps[Math.floor(caps.length / 2)] ?? null, max: caps[caps.length - 1] ?? null },
    effectiveQuoteReserveSol: {
      min: reserves[0] ?? null,
      p50: reserves[Math.floor(reserves.length / 2)] ?? null,
      max: reserves[reserves.length - 1] ?? null,
    },
    costFloorPct: cheapest?.totalCostPct ?? null,
    costFloorNotionalSol: cheapest?.notionalSol ?? null,
    observedGrossMean: grossMean,
    observedGrossN: grossReturns.length,
    observedGrossMeanPopulation:
      'all snapshotted mints; 99.4% of the mints firing a market-cap trigger have no PumpSwap pool and cannot be entered',
    observedGrossMeanMigratedAtEntry: migratedMean,
    observedGrossNMigratedAtEntry: migratedReturns.length,
    crossoverNotionalSol: crossover,
    crossoverMeaning:
      grossMean === null
        ? 'no mint entered in this tier had a usable exit, so there is no gross mean to cross'
        : crossover === null
          ? 'this tier cost stays below its own gross mean across the whole grid'
          : 'the smallest grid notional at which this tier cost reaches its own gross mean',
    grid: rows,
  };
});

const artifact = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'phase-b-cost-by-tier-v1',
    sampleInclusionQuery:
      'latest coherent_snapshots per pool, stratified by the tier selectFeeTier assigns from each pool own ' +
      'market cap, priced offline through the pinned PumpSwap SDK',
  }),
  label: 'DEVELOPMENT_MEASURED_FIXED_COSTS_WITH_MODELLED_VENUE_DRAG',
  isEvidence: false,
  directive: 'Phase B §1.3',
  exitPricedAgainst: 'PRE_BUY_RESERVES',
  exitPricedAgainstRationale: 'unchanged from D70B4A9A §1.1; a position held for minutes exits into a pool of some depth',
  fixedCostsFrom: PHASE_A,
  fixedCosts: {
    baseFeePerLegLamports: baseFeePerLeg.toString(),
    priorityFeePerLegLamports: priorityPerLeg.toString(),
    rentRecoverableLamports: rentRecoverable.toString(),
    rentUnrecoverableLamports: rentUnrecoverable.toString(),
    failedAttemptBasis: failure.basis,
  },
  poolsClassified: pools.length,
  poolSkipReasons: skipped,
  frozenSizeBounds: FROZEN_SIZE_BOUNDS,
  entryExitRule: {
    entryWindowMs: [ENTRY_LO_MS, ENTRY_HI_MS],
    exitWindowMs: [EXIT_LO_MS, EXIT_HI_MS],
    exitTargetMs: EXIT_TARGET_MS,
    note: 'unchanged from D70B4A9A §1.2: entry is the FIRST snapshot in the window, exit the NEAREST to the bound',
  },
  grossMeanPopulation: {
    mintsWithEntry: mintsWithEntry,
    mintsCensored: mintsCensored,
    mintsMigratedAtEntry: mintsMigratedAtEntry,
    censoredFraction: mintsWithEntry === 0 ? null : mintsCensored / mintsWithEntry,
    denomination: 'SOL',
  },
  strata,
  unmodelledCosts: {
    quoteToLandSlippage: 'UNKNOWN',
    crowding: 'UNKNOWN',
    note: 'the floor here excludes both; see §5 of the directive',
  },
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/cost-surface-by-tier.json', JSON.stringify(artifact, null, 2) + '\n');

console.log(`${pools.length} pools classified into ${tierStrata.length} tiers`);
console.log('');
for (const s of strata) {
  console.log(
    `tier ${String(s.tierIndex).padStart(2)}  threshold ${String(s.thresholdSol).padStart(6)} SOL  schedule ${String(s.scheduleRoundTripBps).padStart(3)} bps round trip  pools ${String(s.pools).padStart(3)}  reserve p50 ${s.effectiveQuoteReserveSol.p50?.toFixed(1)} SOL  gross mean ${s.observedGrossMean === null ? 'none' : (s.observedGrossMean * 100).toFixed(2) + '%'} (n=${s.observedGrossN}) | MIGRATED-at-entry ${s.observedGrossMeanMigratedAtEntry === null ? 'none' : (s.observedGrossMeanMigratedAtEntry * 100).toFixed(2) + '%'} (n=${s.observedGrossNMigratedAtEntry})`,
  );
  console.log('      notional   priced  admissible  venue%  impact%  fixed%  TOTAL%');
  for (const r of s.grid) {
    console.log(
      `      ${r.notionalSol.toFixed(3).padStart(8)}  ${String(r.poolsPriced).padStart(6)}  ${String(r.poolsAdmissible).padStart(10)}  ${((r.medianVenueDragBps ?? 0) / 100).toFixed(2).padStart(6)}  ${((r.medianImpactBps ?? 0) / 100).toFixed(2).padStart(7)}  ${((r.fixedCostBps ?? 0) / 100).toFixed(2).padStart(6)}  ${r.totalCostPct === null ? '     -' : r.totalCostPct.toFixed(2).padStart(6)}`,
    );
  }
  console.log(
    `      cost floor ${s.costFloorPct?.toFixed(4) ?? 'none'}% at ${s.costFloorNotionalSol ?? '-'} SOL; crossover ${s.crossoverNotionalSol ?? 'none on the grid'} — ${s.crossoverMeaning}`,
  );
  console.log('');
}
console.log('wrote artifacts/cost-surface-by-tier.json');
