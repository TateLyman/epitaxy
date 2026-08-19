/**
 * `pnpm trigger:cells` — event-triggered entry, and whether any cell is decidable.
 *
 * §2 to §4 of the Phase B directive. Age-banded entry is replaced by seven
 * triggers; every (trigger × tier × notional) cell is reported with the number of
 * calendar days a confirmatory window on it would take; and the whole thing is
 * fitted on the earlier half of the corpus and reported on the later half.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is a search over a large family — 7 triggers, 5 tier buckets, 9 notionals —
 * on a corpus of 112,584 mints, and a search that size manufactures winners from
 * noise if it is read naively. Three things are therefore load-bearing and are
 * reported before any conditional mean:
 *
 *   the CHRONOLOGICAL SPLIT   thresholds frozen on the earlier days, results read
 *                             off the later ones;
 *   the HOLDOUT INTERVAL      a day-clustered 95% lower bound, not a point
 *                             estimate. A cell whose lower bound does not clear
 *                             its own tier cost floor is NOT decidable;
 *   the FALSE-POSITIVE COUNT  cells × α, stated, so a reader can see how many of
 *                             the passing cells are expected to pass by accident.
 *
 * And the returns themselves are provider MID prices the system never traded at.
 * D70B4A9A's precedent applies exactly: four of 36 cells cleared on point
 * estimates there and zero cleared on lower bounds.
 *
 * WHY THE SELECTIVITY DENOMINATOR IS NOT THE RETURN DENOMINATOR
 *
 * `days` needs an arrival rate, and the arrival rate is a property of the LIVE
 * collector: of the mints it observes in the entry window, how many fire? That is
 * measured over every mint with a tier in the window. The return distribution is
 * measured over the subset that also has a usable exit price, which is a
 * limitation of the SNAPSHOT corpus and not of a collector that marks its own
 * positions. Using the smaller denominator for both would understate throughput
 * by the censoring rate and turn decidable cells into undecidable ones for a
 * reason that has nothing to do with the market. Censoring is reported per cell.
 *
 * Read-only, offline. No network call, nothing signed, nothing funded.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { EvidenceStore } from '../packages/storage/src/evidence-repo.js';
import { feeTiersOf, selectFeeTier } from '../packages/solana/src/fee-tiers.js';
import { deriveSolUsd, solUsdAt } from '../packages/research/src/sol-usd.js';
import { clusterBootstrap, type MintOutcome } from '../packages/research/src/robust-stats.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

// ---------------------------------------------------------------------------
// FROZEN BEFORE FITTING
// ---------------------------------------------------------------------------

/** §3's own constants. 7.84 = (1.96 + 0.84)²; 79 is the measured settle rate. */
const POWER_CONSTANT = 7.84;
const SETTLED_MINTS_PER_DAY = 79;
const CONFIRMATORY_FLOOR_N = 300;
const MAX_DECIDABLE_DAYS = 120;
/** One-sided, on the holdout lower bound. Used to state the expected false positives. */
const ALPHA = 0.05;

/** The entry window: the trigger must fire early enough that a 60m exit exists. */
const ENTRY_LO_MS = 2 * 60_000;
const ENTRY_HI_MS = 45 * 60_000;
/** The exit rule, UNCHANGED from D70B4A9A §1.2. */
const EXIT_LO_MS = 0.75 * 60 * 60_000;
const EXIT_HI_MS = 1.25 * 60 * 60_000;
const EXIT_TARGET_MS = 60 * 60_000;

/** T4/T5's clocks, measured from the mint's FIRST stored observation. */
const T4_WITHIN_MS = 600_000;
const T5_WITHIN_MS = 1_800_000;

/**
 * T6 and T7 exist as CONTROLS, so their thresholds are set to match T1's
 * selectivity rather than to maximise anything.
 *
 * If a momentum trigger with the same throughput as the tier trigger produces
 * the same conditional mean, the lift is momentum and not tier — and that
 * changes what to build next. Matching on selectivity is the only way that
 * comparison isolates one from the other, and selectivity is computed without
 * looking at a single return.
 */
const CONTROL_MATCH_SELECTIVITY_TO = 'T1';

const GRID_SOL = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 1.0] as const;
const TIER_BUCKETS = ['any', 'tier0', 'tier1', 'tier2', 'tier3+'] as const;
type TierBucket = (typeof TIER_BUCKETS)[number];

/**
 * THE POPULATION SPLIT THAT DECIDES THIS PHASE.
 *
 * A fee tier is a property of a PumpSwap POOL. A mint with no pool has no tier,
 * and this apparatus cannot enter it at all — the collector's production path is
 * a direct PumpSwap buy against a canonical pool, and there is no bonding-curve
 * builder. So a trigger firing on a pre-migration token is a counterfactual
 * twice over: the tier it is assigned is the tier a pool WOULD be in, and the
 * entry is one this system could not have made.
 *
 * 276 mints in the whole corpus ever migrated, against 158,085 snapshotted. The
 * primary population is therefore mints whose migration is CONFIRMED and whose
 * block time precedes the entry — migrated at entry, not migrated eventually —
 * and the all-snapshotted population is reported beside it as the comparison it
 * is, not as a result.
 */
const POPULATIONS = ['migrated-at-entry', 'all-snapshotted'] as const;
type Population = (typeof POPULATIONS)[number];

/** A hold measured from the entry, for the cells whose entry is late in the window. */
const FIXED_HOLD_MS = 60 * 60_000;

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const evidence = new EvidenceStore(db, 'data/evidence-blobs');
const sdk = new PumpAmmSdk();

// ---------------------------------------------------------------------------
// 1 — THE SCHEDULE AND THE PER-TIER COST FLOORS
// ---------------------------------------------------------------------------

const oneSnapshot = db
  .prepare(`SELECT pool, manifest_blob_sha256 AS manifest FROM coherent_snapshots ORDER BY captured_utc_ms DESC LIMIT 1`)
  .get() as { pool: string; manifest: string } | undefined;
if (oneSnapshot === undefined) {
  console.error('no coherent snapshot is stored, so no fee schedule can be decoded');
  process.exit(1);
}
const feeAddr = PUMP_AMM_FEE_CONFIG_PDA.toBase58();
const scheduleAccounts = evidence.get<{ pubkey: string; owner: string; dataBase64: string | null; lamports: string | number }[]>(
  oneSnapshot.manifest,
);
const rawFee = scheduleAccounts.find((a) => a.pubkey === feeAddr);
if (rawFee?.dataBase64 == null) {
  console.error('the stored snapshot carries no fee config');
  process.exit(1);
}
const tiers = feeTiersOf(
  sdk.decodeFeeConfig({
    owner: new PublicKey(rawFee.owner),
    data: Buffer.from(rawFee.dataBase64, 'base64'),
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  }),
);
const tierIndexOfCapSol = (capSol: number): number | null => {
  const t = selectFeeTier(tiers, BigInt(Math.round(capSol * 1e9)));
  if (t === null) return null;
  return tiers.findIndex((x) => x.marketCapLamportsThreshold === t.marketCapLamportsThreshold);
};
const thresholdSol = (i: number): number => Number((tiers[i]?.marketCapLamportsThreshold ?? 0n) / 1_000_000_000n);

interface TierSurface {
  strata: {
    tierIndex: number;
    scheduleRoundTripBps: number | null;
    grid: { notionalSol: number; totalCostPct: number | null }[];
  }[];
}
const TIER_SURFACE = 'artifacts/cost-surface-by-tier.json';
if (!existsSync(TIER_SURFACE)) {
  console.error(`${TIER_SURFACE} is required; run pnpm cost:by-tier first`);
  process.exit(1);
}
const tierSurface = JSON.parse(readFileSync(TIER_SURFACE, 'utf8')) as TierSurface;

/**
 * The cost floor for a tier at a notional.
 *
 * Only 5 of 25 tiers have a pool in the corpus, so a tier with no stratum falls
 * back to the NEAREST measured tier at or below it, and the fallback is recorded
 * per cell. The alternative — dropping those cells — would silently remove
 * exactly the high-tier cells the phase exists to examine.
 */
function costFloorPct(tierIndex: number, notionalSol: number): { pct: number | null; fromTier: number | null; exact: boolean } {
  const exact = tierSurface.strata.find((s) => s.tierIndex === tierIndex);
  const pick = (s: TierSurface['strata'][number]): number | null =>
    s.grid.find((g) => Math.abs(g.notionalSol - notionalSol) < 1e-9)?.totalCostPct ?? null;
  if (exact !== undefined) {
    const v = pick(exact);
    if (v !== null) return { pct: v, fromTier: tierIndex, exact: true };
  }
  const below = tierSurface.strata
    .filter((s) => s.tierIndex <= tierIndex)
    .sort((a, b) => b.tierIndex - a.tierIndex)
    .find((s) => pick(s) !== null);
  if (below !== undefined) return { pct: pick(below), fromTier: below.tierIndex, exact: false };
  return { pct: null, fromTier: null, exact: false };
}

// ---------------------------------------------------------------------------
// 2 — THE CORPUS, ONE PASS
// ---------------------------------------------------------------------------

const solUsd = deriveSolUsd(db);

/** The earliest confirmed migration per mint, in ms. Null-safe by construction. */
const migratedAtMs = new Map<string, number>();
for (const r of db
  .prepare(
    `SELECT mint, MIN(block_time) * 1000 AS ms FROM confirmed_migrations WHERE block_time IS NOT NULL GROUP BY mint`,
  )
  .all() as { mint: string; ms: number }[]) {
  migratedAtMs.set(r.mint, r.ms);
}

interface Snap {
  readonly age: number;
  readonly t: number;
  readonly usdPrice: number;
  readonly priceSol: number | null;
  readonly mcapSol: number | null;
  readonly netInflowSol: number | null;
  readonly holderChange5m: number | null;
}

const byMint = new Map<string, Snap[]>();
let snapshotsRead = 0;
for (const r of db
  .prepare(
    `SELECT mint, token_age_ms AS age, taken_utc_ms AS t,
            json_extract(features_json, '$.usdPrice') AS usdPrice,
            json_extract(features_json, '$.mcap') AS mcap,
            json_extract(features_json, '$.buyVolume5m') AS buyVol,
            json_extract(features_json, '$.sellVolume5m') AS sellVol,
            json_extract(features_json, '$.holderChange5m') AS holderChange
       FROM decision_snapshots
      WHERE token_age_ms IS NOT NULL AND token_age_ms <= ${Math.ceil(EXIT_HI_MS)}`,
  )
  .iterate() as Iterable<{
  mint: string;
  age: number;
  t: number;
  usdPrice: number | null;
  mcap: number | null;
  buyVol: number | null;
  sellVol: number | null;
  holderChange: number | null;
}>) {
  snapshotsRead += 1;
  if (r.usdPrice === null || !(r.usdPrice > 0)) continue;
  const rate = solUsdAt(solUsd, r.t);
  const list = byMint.get(r.mint) ?? [];
  list.push({
    age: r.age,
    t: r.t,
    usdPrice: r.usdPrice,
    priceSol: rate === null ? null : r.usdPrice / rate,
    mcapSol: r.mcap === null || rate === null ? null : r.mcap / rate,
    netInflowSol:
      r.buyVol === null || r.sellVol === null || rate === null ? null : (r.buyVol - r.sellVol) / rate,
    holderChange5m: r.holderChange,
  });
  byMint.set(r.mint, list);
}
for (const list of byMint.values()) list.sort((a, b) => a.age - b.age);

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * The chronological split, computed ONCE over the whole corpus so every cell
 * uses the same boundary. Distinct UTC days of each mint's first in-window
 * snapshot; the earlier half fits, the later half reports.
 */
const firstInWindowDay = new Map<string, string>();
for (const [mint, snaps] of byMint) {
  const first = snaps.find((s) => s.age >= ENTRY_LO_MS && s.age <= ENTRY_HI_MS);
  if (first !== undefined) firstInWindowDay.set(mint, utcDay(first.t));
}
const allDays = [...new Set(firstInWindowDay.values())].sort();
const fitDays = new Set(allDays.slice(0, Math.ceil(allDays.length / 2)));
const holdoutDays = new Set(allDays.slice(Math.ceil(allDays.length / 2)));
const halfOf = (mint: string): 'fit' | 'holdout' | null => {
  const d = firstInWindowDay.get(mint);
  if (d === undefined) return null;
  return fitDays.has(d) ? 'fit' : holdoutDays.has(d) ? 'holdout' : null;
};

// ---------------------------------------------------------------------------
// 3 — THE CONTROL THRESHOLDS, MATCHED ON SELECTIVITY IN THE FIT HALF
// ---------------------------------------------------------------------------

/** Mints eligible at all: they have an in-window snapshot with a market cap. */
const eligible: string[] = [];
for (const [mint, snaps] of byMint) {
  if (snaps.some((s) => s.age >= ENTRY_LO_MS && s.age <= ENTRY_HI_MS && s.mcapSol !== null)) eligible.push(mint);
}
const eligibleFit = eligible.filter((m) => halfOf(m) === 'fit');
const eligibleHoldout = eligible.filter((m) => halfOf(m) === 'holdout');

const firesTier = (snaps: readonly Snap[], capSol: number, withinMs: number | null): Snap | null => {
  const first = snaps[0];
  for (const s of snaps) {
    if (s.age < ENTRY_LO_MS || s.age > ENTRY_HI_MS) continue;
    if (s.mcapSol === null || s.mcapSol < capSol) continue;
    if (withinMs !== null && first !== undefined && s.t - first.t > withinMs) continue;
    return s;
  }
  return null;
};

/** T1's selectivity in the fit half, which the controls are matched to. */
const t1FitFires = eligibleFit.filter((m) => firesTier(byMint.get(m) as Snap[], thresholdSol(1), null) !== null).length;
const targetSelectivity = eligibleFit.length === 0 ? 0 : t1FitFires / eligibleFit.length;

/** The value of a field at its first in-window occurrence, for threshold fitting. */
const firstFieldValue = (snaps: readonly Snap[], pick: (s: Snap) => number | null): number | null => {
  let best: number | null = null;
  for (const s of snaps) {
    if (s.age < ENTRY_LO_MS || s.age > ENTRY_HI_MS) continue;
    const v = pick(s);
    if (v === null) continue;
    if (best === null || v > best) best = v;
  }
  return best;
};

function thresholdForSelectivity(pick: (s: Snap) => number | null): { threshold: number | null; coverage: number } {
  const values: number[] = [];
  let withField = 0;
  for (const m of eligibleFit) {
    const v = firstFieldValue(byMint.get(m) as Snap[], pick);
    if (v === null) continue;
    withField += 1;
    values.push(v);
  }
  if (values.length === 0) return { threshold: null, coverage: 0 };
  values.sort((a, b) => a - b);
  // The threshold that makes this trigger fire on the same FRACTION OF THE
  // ELIGIBLE POPULATION as T1 does. Not the same fraction of the covered
  // subset: a field present on 15% of mints cannot fire on 4% of the whole
  // population unless it fires on a quarter of the ones it can see.
  const wanted = Math.round(targetSelectivity * eligibleFit.length);
  if (wanted <= 0 || wanted > values.length) {
    return { threshold: values[0] ?? null, coverage: withField / Math.max(1, eligibleFit.length) };
  }
  const idx = values.length - wanted;
  return { threshold: values[idx] ?? null, coverage: withField / Math.max(1, eligibleFit.length) };
}

const t6 = thresholdForSelectivity((s) => s.netInflowSol);
const t7 = thresholdForSelectivity((s) => s.holderChange5m);

// ---------------------------------------------------------------------------
// 4 — THE TRIGGERS
// ---------------------------------------------------------------------------

interface Trigger {
  readonly key: string;
  readonly description: string;
  readonly frozenThreshold: string;
  readonly evaluable: boolean;
  readonly notEvaluableBecause: string | null;
  readonly coverage: number | null;
  fire(snaps: readonly Snap[]): Snap | null;
}

const TRIGGERS: Trigger[] = [
  {
    /**
     * THE BASELINE, and it is not optional.
     *
     * Without it, a negative conditional mean on the tradable population cannot
     * be told apart from a population that is negative anyway. T0 fires on every
     * eligible mint at the first in-window snapshot, which is exactly the
     * age-banded entry the seven triggers are meant to replace.
     */
    key: 'T0',
    description: 'no condition: entry at the first snapshot in the window (the age-banded baseline)',
    frozenThreshold: 'none — this is the control the others are read against',
    evaluable: true,
    notEvaluableBecause: null,
    coverage: null,
    fire: (snaps) => snaps.find((s) => s.age >= ENTRY_LO_MS && s.age <= ENTRY_HI_MS && s.mcapSol !== null) ?? null,
  },
  {
    key: 'T1',
    description: 'market cap crosses 420 SOL',
    frozenThreshold: '420 SOL — the tier 1 threshold from the decoded schedule',
    evaluable: true,
    notEvaluableBecause: null,
    coverage: null,
    fire: (s) => firesTier(s, thresholdSol(1), null),
  },
  {
    key: 'T2',
    description: 'market cap crosses 1,470 SOL',
    frozenThreshold: '1,470 SOL — the tier 2 threshold',
    evaluable: true,
    notEvaluableBecause: null,
    coverage: null,
    fire: (s) => firesTier(s, thresholdSol(2), null),
  },
  {
    key: 'T3',
    description: 'market cap crosses 2,460 SOL',
    frozenThreshold: '2,460 SOL — the tier 3 threshold',
    evaluable: true,
    notEvaluableBecause: null,
    coverage: null,
    fire: (s) => firesTier(s, thresholdSol(3), null),
  },
  {
    key: 'T4',
    description: 'market cap crosses 420 SOL within 600s of first observation',
    frozenThreshold: '420 SOL within 600,000 ms',
    evaluable: true,
    notEvaluableBecause: null,
    coverage: null,
    fire: (s) => firesTier(s, thresholdSol(1), T4_WITHIN_MS),
  },
  {
    key: 'T5',
    description: 'market cap crosses 1,470 SOL within 1,800s of first observation',
    frozenThreshold: '1,470 SOL within 1,800,000 ms',
    evaluable: true,
    notEvaluableBecause: null,
    coverage: null,
    fire: (s) => firesTier(s, thresholdSol(2), T5_WITHIN_MS),
  },
  {
    key: 'T6',
    description: 'net SOL inflow over the trailing 300s exceeds a frozen threshold',
    frozenThreshold:
      t6.threshold === null
        ? 'not set: the provider populated no 5-minute volume in the fit half'
        : `${t6.threshold.toFixed(3)} SOL net over 300s, set to match ${CONTROL_MATCH_SELECTIVITY_TO}'s selectivity in the fit half`,
    evaluable: t6.threshold !== null,
    notEvaluableBecause:
      t6.threshold === null ? 'buyVolume5m/sellVolume5m are absent from the fit half entirely' : null,
    coverage: t6.coverage,
    fire: (snaps) => {
      if (t6.threshold === null) return null;
      for (const s of snaps) {
        if (s.age < ENTRY_LO_MS || s.age > ENTRY_HI_MS) continue;
        if (s.netInflowSol === null) continue;
        if (s.netInflowSol >= t6.threshold) return s;
      }
      return null;
    },
  },
  {
    key: 'T7',
    description: 'holder count growth over the trailing 300s exceeds a frozen threshold',
    frozenThreshold:
      t7.threshold === null
        ? 'not set: the provider populated no 5-minute holder change in the fit half'
        : `${t7.threshold.toFixed(3)} holders per 300s, set to match ${CONTROL_MATCH_SELECTIVITY_TO}'s selectivity in the fit half`,
    evaluable: t7.threshold !== null,
    notEvaluableBecause: t7.threshold === null ? 'holderChange5m is absent from the fit half entirely' : null,
    coverage: t7.coverage,
    fire: (snaps) => {
      if (t7.threshold === null) return null;
      for (const s of snaps) {
        if (s.age < ENTRY_LO_MS || s.age > ENTRY_HI_MS) continue;
        if (s.holderChange5m === null) continue;
        if (s.holderChange5m >= t7.threshold) return s;
      }
      return null;
    },
  },
];

interface Observation {
  mint: string;
  half: 'fit' | 'holdout';
  day: string;
  entryAgeMs: number;
  tierIndex: number;
  grossReturnSol: number | null;
  /** The same entry held a fixed hour instead of exiting at 60m of AGE. */
  fixedHoldReturnSol: number | null;
  censored: boolean;
  migratedAtEntry: boolean;
}

function observe(trigger: Trigger): { fired: Observation[]; firedFit: number; firedHoldout: number } {
  const fired: Observation[] = [];
  let firedFit = 0;
  let firedHoldout = 0;
  for (const mint of eligible) {
    const half = halfOf(mint);
    if (half === null) continue;
    const snaps = byMint.get(mint) as Snap[];
    const entry = trigger.fire(snaps);
    if (entry === null) continue;
    if (half === 'fit') firedFit += 1;
    else firedHoldout += 1;

    const tier = entry.mcapSol === null ? null : tierIndexOfCapSol(entry.mcapSol);
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
    const gross =
      exit === undefined || entry.priceSol === null || exit.priceSol === null || entry.priceSol <= 0
        ? null
        : exit.priceSol / entry.priceSol - 1;

    // The fixed-hold variant. The unchanged exit rule is at 60m of AGE, so an
    // entry at 40m holds for 20 minutes and one at 3m holds for 57; a cell whose
    // trigger fires late is not measuring the same holding period as one whose
    // trigger fires early, and this says by how much that matters.
    let fixedExit: Snap | undefined;
    let fixedGap = Number.POSITIVE_INFINITY;
    for (const sn of snaps) {
      if (sn.age <= entry.age) continue;
      const gap = Math.abs(sn.t - (entry.t + FIXED_HOLD_MS));
      if (gap < fixedGap) {
        fixedGap = gap;
        fixedExit = sn;
      }
    }
    const fixedHold =
      fixedExit === undefined ||
      fixedGap > 0.25 * FIXED_HOLD_MS ||
      entry.priceSol === null ||
      fixedExit.priceSol === null ||
      entry.priceSol <= 0
        ? null
        : fixedExit.priceSol / entry.priceSol - 1;

    const migratedAt = migratedAtMs.get(mint);
    fired.push({
      mint,
      half,
      day: firstInWindowDay.get(mint) as string,
      entryAgeMs: entry.age,
      tierIndex: tier ?? 0,
      grossReturnSol: gross,
      fixedHoldReturnSol: fixedHold,
      censored: exit === undefined,
      migratedAtEntry: migratedAt !== undefined && migratedAt <= entry.t,
    });
  }
  return { fired, firedFit, firedHoldout };
}

// ---------------------------------------------------------------------------
// 5 — THE CELLS
// ---------------------------------------------------------------------------

const inBucket = (tierIndex: number, bucket: TierBucket): boolean => {
  if (bucket === 'any') return true;
  if (bucket === 'tier0') return tierIndex === 0;
  if (bucket === 'tier1') return tierIndex === 1;
  if (bucket === 'tier2') return tierIndex === 2;
  return tierIndex >= 3;
};
const representativeTier = (bucket: TierBucket, observations: readonly Observation[]): number => {
  if (bucket === 'tier0') return 0;
  if (bucket === 'tier1') return 1;
  if (bucket === 'tier2') return 2;
  if (bucket === 'tier3+') {
    const tiersSeen = observations.map((o) => o.tierIndex).sort((a, b) => a - b);
    return tiersSeen[0] ?? 3;
  }
  // 'any': the most conservative tier present, since a mixed cell pays the
  // dearest floor among the entries it actually contains.
  const tiersSeen = observations.map((o) => o.tierIndex).sort((a, b) => a - b);
  return tiersSeen[0] ?? 0;
};

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const sd = (xs: readonly number[]): number | null => {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

interface Cell {
  trigger: string;
  population: Population;
  tierBucket: TierBucket;
  notionalSol: number;
  costFloorPct: number | null;
  costFloorFromTier: number | null;
  costFloorExact: boolean;
  firedEligibleHoldout: number;
  selectivityHoldout: number | null;
  arrivalsPerDay: number | null;
  nHoldout: number;
  nFit: number;
  censoredHoldout: number;
  utcDaysHoldout: number;
  grossMeanHoldout: number | null;
  grossMeanFit: number | null;
  sdHoldout: number | null;
  netMeanHoldout: number | null;
  cvNet: number | null;
  requiredN: number | null;
  days: number | null;
  decidableOnPointEstimate: boolean;
  holdoutLower: number | null;
  holdoutUpper: number | null;
  netLowerBound: number | null;
  decidableOnHoldoutLowerBound: boolean;
}

const cells: Cell[] = [];
const triggerSummaries: {
  trigger: string;
  description: string;
  frozenThreshold: string;
  evaluable: boolean;
  notEvaluableBecause: string | null;
  fieldCoverageFitHalf: number | null;
  firedFit: number;
  firedHoldout: number;
  selectivityFit: number | null;
  selectivityHoldout: number | null;
  withExitHoldout: number;
  withExitFit: number;
  censoredFractionHoldout: number | null;
  censoredFractionFit: number | null;
  /**
   * The same trigger's arrival rate on each half.
   *
   * Reported because the verdict turns on it: T1 fires on 4.90% of the fit half
   * and 2.94% of the holdout, and 79 x that difference is 78 days against 130.
   * A 9-day corpus does not pin an arrival rate to better than that, and saying
   * so is the difference between a measurement and a coin flip with a decimal.
   */
  daysAtFitSelectivity: number | null;
  daysAtHoldoutSelectivity: number | null;
  tierMixHoldout: Record<string, number>;
  /** How much of the fired population this apparatus could actually have entered. */
  firedMigratedAtEntry: number;
  firedMigratedFraction: number | null;
  withExitMigrated: number;
  grossMeanMigrated: number | null;
  grossMeanAllSnapshotted: number | null;
  fixedHoldMeanMigrated: number | null;
  fixedHoldMeanAllSnapshotted: number | null;
}[] = [];

for (const trigger of TRIGGERS) {
  const { fired, firedFit, firedHoldout } = observe(trigger);
  const holdout = fired.filter((o) => o.half === 'holdout');
  const fitFired = fired.filter((o) => o.half === 'fit');
  const withExit = holdout.filter((o) => !o.censored);
  const withExitFit = fitFired.filter((o) => !o.censored);
  const tierMix: Record<string, number> = {};
  for (const o of holdout) tierMix[String(o.tierIndex)] = (tierMix[String(o.tierIndex)] ?? 0) + 1;
  const firedMigrated = fired.filter((o) => o.migratedAtEntry);
  const migratedWithExit = firedMigrated.filter((o) => o.grossReturnSol !== null);
  const allWithExit = fired.filter((o) => o.grossReturnSol !== null);
  triggerSummaries.push({
    trigger: trigger.key,
    description: trigger.description,
    frozenThreshold: trigger.frozenThreshold,
    evaluable: trigger.evaluable,
    notEvaluableBecause: trigger.notEvaluableBecause,
    fieldCoverageFitHalf: trigger.coverage,
    firedMigratedAtEntry: firedMigrated.length,
    firedMigratedFraction: fired.length === 0 ? null : firedMigrated.length / fired.length,
    withExitMigrated: migratedWithExit.length,
    grossMeanMigrated: mean(migratedWithExit.map((o) => o.grossReturnSol as number)),
    grossMeanAllSnapshotted: mean(allWithExit.map((o) => o.grossReturnSol as number)),
    fixedHoldMeanMigrated: mean(
      firedMigrated.map((o) => o.fixedHoldReturnSol).filter((v): v is number => v !== null),
    ),
    fixedHoldMeanAllSnapshotted: mean(
      fired.map((o) => o.fixedHoldReturnSol).filter((v): v is number => v !== null),
    ),
    firedFit,
    firedHoldout,
    selectivityFit: eligibleFit.length === 0 ? null : firedFit / eligibleFit.length,
    selectivityHoldout: eligibleHoldout.length === 0 ? null : firedHoldout / eligibleHoldout.length,
    withExitHoldout: withExit.length,
    withExitFit: withExitFit.length,
    censoredFractionHoldout: holdout.length === 0 ? null : (holdout.length - withExit.length) / holdout.length,
    censoredFractionFit: fitFired.length === 0 ? null : (fitFired.length - withExitFit.length) / fitFired.length,
    daysAtFitSelectivity:
      eligibleFit.length === 0 || firedFit === 0
        ? null
        : Math.ceil(CONFIRMATORY_FLOOR_N / (SETTLED_MINTS_PER_DAY * (firedFit / eligibleFit.length))),
    daysAtHoldoutSelectivity:
      eligibleHoldout.length === 0 || firedHoldout === 0
        ? null
        : Math.ceil(CONFIRMATORY_FLOOR_N / (SETTLED_MINTS_PER_DAY * (firedHoldout / eligibleHoldout.length))),
    tierMixHoldout: tierMix,
  });

  for (const population of POPULATIONS) {
  const inPopulation = (o: Observation): boolean =>
    population === 'all-snapshotted' ? true : o.migratedAtEntry;
  const eligibleHoldoutForPopulation =
    population === 'all-snapshotted'
      ? eligibleHoldout.length
      : eligibleHoldout.filter((m) => {
          const at = migratedAtMs.get(m);
          if (at === undefined) return false;
          const snaps = byMint.get(m) as Snap[];
          return snaps.some((sn) => sn.age >= ENTRY_LO_MS && sn.age <= ENTRY_HI_MS && sn.t >= at);
        }).length;

  for (const bucket of TIER_BUCKETS) {
    const bucketHoldout = holdout.filter((o) => inPopulation(o) && inBucket(o.tierIndex, bucket));
    const bucketFit = fired.filter((o) => o.half === 'fit' && inPopulation(o) && inBucket(o.tierIndex, bucket));
    const returnsHoldout = bucketHoldout.map((o) => o.grossReturnSol).filter((v): v is number => v !== null);
    const returnsFit = bucketFit.map((o) => o.grossReturnSol).filter((v): v is number => v !== null);
    const tierForFloor = representativeTier(bucket, bucketHoldout);
    const daysSeen = new Set(bucketHoldout.map((o) => o.day)).size;

    const outcomes: MintOutcome[] = bucketHoldout
      .filter((o) => o.grossReturnSol !== null)
      .map((o) => ({
        mint: o.mint,
        utcDay: o.day,
        logReturn: o.grossReturnSol as number,
        netPnlLamports: 0n,
        catastrophic: false,
        blockedExit: false,
      }));
    const boot = outcomes.length > 0 ? clusterBootstrap(outcomes, 'UTC_DAY', 1_000) : null;

    for (const notionalSol of GRID_SOL) {
      const floor = costFloorPct(tierForFloor, notionalSol);
      const grossMean = mean(returnsHoldout);
      const s = sd(returnsHoldout);
      const netMean = grossMean === null || floor.pct === null ? null : grossMean - floor.pct / 100;
      const cvNet = netMean === null || s === null || netMean === 0 ? null : s / Math.abs(netMean);
      const requiredN = cvNet === null ? null : Math.max(CONFIRMATORY_FLOOR_N, Math.ceil(POWER_CONSTANT * cvNet ** 2));
      const selectivity =
        eligibleHoldoutForPopulation === 0
          ? null
          : bucketHoldout.length === 0
            ? 0
            : // The cell's own arrival rate: firing AND landing in this bucket,
              // out of the mints of THIS population the collector would see.
              bucketHoldout.length / eligibleHoldoutForPopulation;
      const arrivals = selectivity === null ? null : SETTLED_MINTS_PER_DAY * selectivity;
      const days = requiredN === null || arrivals === null || arrivals <= 0 ? null : Math.ceil(requiredN / arrivals);
      const lower = boot === null || daysSeen < 2 ? null : boot.lower;
      const netLower = lower === null || floor.pct === null ? null : lower - floor.pct / 100;
      cells.push({
        trigger: trigger.key,
        population,
        tierBucket: bucket,
        notionalSol,
        costFloorPct: floor.pct,
        costFloorFromTier: floor.fromTier,
        costFloorExact: floor.exact,
        firedEligibleHoldout: bucketHoldout.length,
        selectivityHoldout: selectivity,
        arrivalsPerDay: arrivals,
        nHoldout: returnsHoldout.length,
        nFit: returnsFit.length,
        censoredHoldout: bucketHoldout.filter((o) => o.censored).length,
        utcDaysHoldout: daysSeen,
        grossMeanHoldout: grossMean,
        grossMeanFit: mean(returnsFit),
        sdHoldout: s,
        netMeanHoldout: netMean,
        cvNet,
        requiredN,
        days,
        decidableOnPointEstimate: days !== null && days <= MAX_DECIDABLE_DAYS && (netMean ?? -1) > 0,
        holdoutLower: lower,
        holdoutUpper: boot === null || daysSeen < 2 ? null : boot.upper,
        netLowerBound: netLower,
        decidableOnHoldoutLowerBound:
          netLower !== null && netLower > 0 && days !== null && days <= MAX_DECIDABLE_DAYS,
      });
    }
  }
  }
}

// ---------------------------------------------------------------------------
// 6 — VERDICT
// ---------------------------------------------------------------------------

const evaluableCells = cells.filter((c) => c.nHoldout > 0);
const passOnPoint = cells.filter((c) => c.decidableOnPointEstimate);
const passOnHoldout = cells.filter((c) => c.decidableOnHoldoutLowerBound);
/**
 * The verdict is taken from the TRADABLE population alone.
 *
 * A cell in `all-snapshotted` that passed would be a cell this apparatus cannot
 * enter, and calling that a decidable cell would be the largest single error
 * available in this phase.
 */
const tradableCells = cells.filter((c) => c.population === 'migrated-at-entry');
const tradableEvaluable = tradableCells.filter((c) => c.nHoldout > 0);
const tradablePassOnPoint = tradableCells.filter((c) => c.decidableOnPointEstimate);
const tradablePassOnHoldout = tradableCells.filter((c) => c.decidableOnHoldoutLowerBound);
const expectedFalsePositives = evaluableCells.length * ALPHA;
const expectedFalsePositivesTradable = tradableEvaluable.length * ALPHA;
const finalState = tradablePassOnHoldout.length === 0 ? 'NO_DECIDABLE_CELL' : 'DECIDABLE_CELL_IDENTIFIED';

/**
 * THE ONE CROSS-CHECK THAT DOES NOT USE A MID PRICE.
 *
 * Every return above is `usdPrice` at one snapshot over `usdPrice` at another —
 * a price the system never traded at. The collector's own marks are different in
 * kind: `executable_lamports` is what the position could realise at that moment,
 * computed by the pool's own arithmetic on the position's own size, with the exit
 * fee and impact already inside it.
 *
 * If the reconstruction says the post-migration hour is negative and the
 * executable marks say it is positive, the reconstruction is wrong and this phase
 * has no result. So it is computed here, from the corpus, and reported.
 */
const markRows = db
  .prepare(
    `SELECT m.offset_ms AS offsetMs, m.executable_lamports AS executable, t.notional_lamports AS notional
       FROM trajectory_marks m
       JOIN development_trajectories t ON t.trajectory_id = m.trajectory_id
      WHERE m.executable_lamports IS NOT NULL`,
  )
  .all() as { offsetMs: number; executable: string; notional: string }[];
const marksByOffset = new Map<number, number[]>();
for (const r of markRows) {
  const notional = BigInt(r.notional);
  if (notional <= 0n) continue;
  const ret = Number(BigInt(r.executable)) / Number(notional) - 1;
  const list = marksByOffset.get(r.offsetMs) ?? [];
  list.push(ret);
  marksByOffset.set(r.offsetMs, list);
}
const executableMarkCheck = [...marksByOffset.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([offsetMs, xs]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] as number;
    return {
      offsetMs,
      n: sorted.length,
      mean: mean(sorted),
      median: pick(0.5),
      p10: pick(0.1),
      p90: pick(0.9),
    };
  });

const artifact = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'phase-b-triggers-v1',
    sampleInclusionQuery:
      'decision_snapshots with a token age at or under the exit window, grouped by mint; entry is the first ' +
      'snapshot at or after the trigger fires inside [2m, 45m]; exit is the snapshot nearest 60m age within +/-25%',
  }),
  label: 'DEVELOPMENT_RECONSTRUCTED',
  isEvidence: false,
  directive: 'Phase B §2-§4',
  frozen: {
    powerConstant: POWER_CONSTANT,
    settledMintsPerDay: SETTLED_MINTS_PER_DAY,
    confirmatoryFloorN: CONFIRMATORY_FLOOR_N,
    maxDecidableDays: MAX_DECIDABLE_DAYS,
    alpha: ALPHA,
    entryWindowMs: [ENTRY_LO_MS, ENTRY_HI_MS],
    exitWindowMs: [EXIT_LO_MS, EXIT_HI_MS],
    exitTargetMs: EXIT_TARGET_MS,
    controlsMatchedTo: CONTROL_MATCH_SELECTIVITY_TO,
    t6Threshold: t6.threshold,
    t7Threshold: t7.threshold,
  },
  chronologicalSplit: {
    allDays,
    fitDays: [...fitDays],
    holdoutDays: [...holdoutDays],
    eligibleFit: eligibleFit.length,
    eligibleHoldout: eligibleHoldout.length,
    rule: 'distinct UTC days of each mint FIRST in-window snapshot; the earlier half fits, the later half reports',
  },
  snapshotsRead,
  mintsRead: byMint.size,
  eligibleMints: eligible.length,
  targetSelectivityFromT1: targetSelectivity,
  triggers: triggerSummaries,
  cells,
  cellCount: cells.length,
  evaluableCellCount: evaluableCells.length,
  passOnPointEstimate: passOnPoint.length,
  passOnHoldoutLowerBound: passOnHoldout.length,
  expectedFalsePositives,
  tradablePopulation: {
    cells: tradableCells.length,
    evaluable: tradableEvaluable.length,
    passOnPointEstimate: tradablePassOnPoint.length,
    passOnHoldoutLowerBound: tradablePassOnHoldout.length,
    expectedFalsePositives: expectedFalsePositivesTradable,
    migratedMintsInCorpus: migratedAtMs.size,
    snapshottedMints: byMint.size,
  },
  decidableCells: tradablePassOnHoldout.map((c) => ({
    trigger: c.trigger,
    population: c.population,
    tierBucket: c.tierBucket,
    notionalSol: c.notionalSol,
    days: c.days,
    netLowerBound: c.netLowerBound,
  })),
  cellsPassingInTheUntradablePopulation: cells
    .filter((c) => c.population === 'all-snapshotted' && c.decidableOnHoldoutLowerBound)
    .map((c) => ({ trigger: c.trigger, tierBucket: c.tierBucket, notionalSol: c.notionalSol, days: c.days })),
  executableMarkCheck: {
    rows: executableMarkCheck,
    note:
      'the collector own marks, on the trajectories its risk gates ADMITTED, at 0.02 SOL. Not mid prices: ' +
      'executable_lamports is what the position could realise, exit fee and impact included. At the 60-minute ' +
      'offset the median is almost exactly the measured cost floor and the mean is dragged well below it by the ' +
      'left tail, which is the same shape the reconstruction reports on a wider and unfiltered population.',
  },
  finalState,
  /**
   * §3's reference table, RECOMPUTED from the stated formula.
   *
   *     days = required_n / (79 x s),  required_n = max(300, 7.84 x (sigma/m)^2)
   *
   * so the mean a cell needs to be decidable in 120 days is
   *
   *     m = sigma x sqrt(7.84 / (120 x 79 x s))
   *
   * The directive's own printed table gives 8.4 / 13.6 / 20.2 / 11.3 percent for
   * its four (s, sigma) rows. This computes 8.6 / 12.8 / 18.0 / 8.9. Rows 3 and 4
   * of the printed table are also inconsistent with each other under any pure
   * scaling in sigma, so the disagreement is most likely the same PDF text-layer
   * corruption that lost two blocks of the previous directive. The formula is
   * used; the printed numbers are not.
   */
  referenceTargets: [
    { s: 0.66, sigma: 2.43 },
    { s: 0.3, sigma: 2.43 },
    { s: 0.15, sigma: 2.43 },
    { s: 0.15, sigma: 1.2 },
  ].map((r) => ({
    ...r,
    meanNeededFor120Days: r.sigma * Math.sqrt(POWER_CONSTANT / (MAX_DECIDABLE_DAYS * SETTLED_MINTS_PER_DAY * r.s)),
    directivePrinted: null as number | null,
  })),
  unmodelledCosts: {
    quoteToLandSlippage: 'UNKNOWN',
    crowding: 'UNKNOWN',
    statement:
      'the floor excludes both, so every figure here is an UPPER BOUND on what a live version would earn. ' +
      'Both bite hardest exactly where this phase is looking: a momentum trigger fires when the pool is ' +
      'moving fast and against you, and momentum entry on Solana memecoins is the most contested strategy on the chain.',
  },
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/trigger-cells.json', JSON.stringify(artifact, null, 2) + '\n');

/** One row per cell examined, per §4.4. */
const csv: string[] = [
  'trigger,population,tier_bucket,notional_sol,cost_floor_pct,cost_floor_from_tier,cost_floor_exact,fired_holdout,selectivity_holdout,arrivals_per_day,n_holdout,n_fit,censored_holdout,utc_days_holdout,gross_mean_holdout,gross_mean_fit,sd_holdout,net_mean_holdout,cv_net,required_n,days,decidable_point,holdout_lower,holdout_upper,net_lower_bound,decidable_holdout',
];
const f = (v: number | null): string => (v === null ? '' : String(v));
for (const c of cells) {
  csv.push(
    [
      c.trigger,
      c.population,
      c.tierBucket,
      c.notionalSol,
      f(c.costFloorPct),
      f(c.costFloorFromTier),
      c.costFloorExact,
      c.firedEligibleHoldout,
      f(c.selectivityHoldout),
      f(c.arrivalsPerDay),
      c.nHoldout,
      c.nFit,
      c.censoredHoldout,
      c.utcDaysHoldout,
      f(c.grossMeanHoldout),
      f(c.grossMeanFit),
      f(c.sdHoldout),
      f(c.netMeanHoldout),
      f(c.cvNet),
      f(c.requiredN),
      f(c.days),
      c.decidableOnPointEstimate,
      f(c.holdoutLower),
      f(c.holdoutUpper),
      f(c.netLowerBound),
      c.decidableOnHoldoutLowerBound,
    ].join(','),
  );
}
mkdirSync('docs', { recursive: true });
writeFileSync('docs/PHASE_B_CELL_LEDGER.csv', csv.join('\n') + '\n');

console.log(`${snapshotsRead} snapshots, ${byMint.size} mints, ${eligible.length} eligible`);
console.log(`split: fit ${[...fitDays].join(',')} (${eligibleFit.length} mints) | holdout ${[...holdoutDays].join(',')} (${eligibleHoldout.length} mints)`);
console.log(`T1 fit selectivity ${(targetSelectivity * 100).toFixed(2)}% — the controls are matched to it`);
console.log('');
console.log('trigger  frozen threshold                                       firedFit  firedHold  sel%   withExit  censored%  days@fit  days@hold');
for (const t of triggerSummaries) {
  console.log(
    `${t.trigger.padEnd(8)} ${t.frozenThreshold.slice(0, 52).padEnd(53)} ${String(t.firedFit).padStart(8)}  ${String(t.firedHoldout).padStart(9)}  ${((t.selectivityHoldout ?? 0) * 100).toFixed(2).padStart(5)}  ${String(t.withExitHoldout).padStart(8)}  ${((t.censoredFractionHoldout ?? 0) * 100).toFixed(1).padStart(8)}  ${String(t.daysAtFitSelectivity ?? '-').padStart(8)}  ${String(t.daysAtHoldoutSelectivity ?? '-').padStart(9)}`,
  );
  if (!t.evaluable) console.log(`         NOT EVALUABLE: ${t.notEvaluableBecause}`);
}
console.log('');
console.log('THE POPULATION SPLIT — a fee tier belongs to a pool, and 276 of 158,085 mints ever migrated');
console.log('trig  firedAll  firedMigratedAtEntry  migrated%  withExitMigr  meanMigrated%  meanAll%   fixedHoldMigr%  fixedHoldAll%');
for (const t of triggerSummaries) {
  console.log(
    `${t.trigger.padEnd(5)} ${String(t.firedFit + t.firedHoldout).padStart(9)} ${String(t.firedMigratedAtEntry).padStart(21)} ${((t.firedMigratedFraction ?? 0) * 100).toFixed(2).padStart(10)} ${String(t.withExitMigrated).padStart(13)} ${t.grossMeanMigrated === null ? '            -' : (t.grossMeanMigrated * 100).toFixed(1).padStart(13)} ${t.grossMeanAllSnapshotted === null ? '        -' : (t.grossMeanAllSnapshotted * 100).toFixed(1).padStart(9)} ${t.fixedHoldMeanMigrated === null ? '               -' : (t.fixedHoldMeanMigrated * 100).toFixed(1).padStart(16)} ${t.fixedHoldMeanAllSnapshotted === null ? '              -' : (t.fixedHoldMeanAllSnapshotted * 100).toFixed(1).padStart(15)}`,
  );
}
console.log('');
console.log('cells at 0.02 SOL (the frozen notional), MIGRATED-AT-ENTRY population');
console.log('trig  bucket   n_hold  days_hold  gross%   sd     net%    CV    reqN   arr/day   days  point  holdoutLower%  decidable');
for (const c of cells) {
  if (Math.abs(c.notionalSol - 0.02) > 1e-9) continue;
  if (c.population !== 'migrated-at-entry') continue;
  if (c.firedEligibleHoldout === 0) continue;
  console.log(
    `${c.trigger.padEnd(5)} ${c.tierBucket.padEnd(8)} ${String(c.nHoldout).padStart(6)} ${String(c.utcDaysHoldout).padStart(10)} ${((c.grossMeanHoldout ?? 0) * 100).toFixed(1).padStart(7)} ${(c.sdHoldout ?? 0).toFixed(2).padStart(6)} ${((c.netMeanHoldout ?? 0) * 100).toFixed(1).padStart(7)} ${(c.cvNet ?? 0).toFixed(2).padStart(6)} ${String(c.requiredN ?? '-').padStart(6)} ${(c.arrivalsPerDay ?? 0).toFixed(2).padStart(8)} ${String(c.days ?? '-').padStart(6)}  ${c.decidableOnPointEstimate ? 'YES' : ' no'}  ${c.holdoutLower === null ? '           -' : ((c.holdoutLower - (c.costFloorPct ?? 0) / 100) * 100).toFixed(1).padStart(12)}  ${c.decidableOnHoldoutLowerBound ? 'YES' : 'no'}`,
  );
}
console.log('');
console.log(`cells examined ${cells.length} (${tradableCells.length} tradable), evaluable ${evaluableCells.length} (${tradableEvaluable.length} tradable)`);
console.log(`tradable: pass on point ${tradablePassOnPoint.length}; pass on holdout lower bound ${tradablePassOnHoldout.length}`);
console.log(`all-snapshotted (NOT enterable by this apparatus): pass on point ${passOnPoint.length - tradablePassOnPoint.length}; on holdout ${passOnHoldout.length - tradablePassOnHoldout.length}`);
console.log(`expected false positives at alpha ${ALPHA}: ${expectedFalsePositivesTradable.toFixed(1)} tradable, ${expectedFalsePositives.toFixed(1)} over all cells`);
console.log('');
console.log('cross-check, the collector OWN executable marks at 0.02 SOL (not mid prices)');
console.log('  offset      n     mean    median      p10      p90');
for (const r of executableMarkCheck) {
  console.log(
    `  ${String(r.offsetMs / 1000).padStart(6)}s ${String(r.n).padStart(6)} ${((r.mean ?? 0) * 100).toFixed(1).padStart(8)}% ${(r.median * 100).toFixed(1).padStart(8)}% ${(r.p10 * 100).toFixed(1).padStart(8)}% ${(r.p90 * 100).toFixed(1).padStart(8)}%`,
  );
}
console.log('');
console.log(`FINAL STATE ${finalState}`);
console.log('');
console.log('wrote artifacts/trigger-cells.json and docs/PHASE_B_CELL_LEDGER.csv');
