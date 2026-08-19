/**
 * `pnpm edge:distribution` — the gross edge distribution, per age cohort.
 *
 * §1.2 of the measurement-power directive. For each of the four cohorts:
 * n, mean, SD, CV, skew, kurtosis, the required n at 80% power (7.84 × CV²),
 * and the share of the total gross return carried by the top 1/3/5/10 outcomes.
 *
 * THIS IS NOT EVIDENCE. Every row is labelled `DEVELOPMENT_RECONSTRUCTED` and
 * its only purpose is estimating distribution SHAPE, which is what sets the
 * sample size the confirmatory window needs. It is reconstructed from provider
 * mid prices stored in `decision_snapshots.features_json`, which is a price the
 * system never traded at: no fill, no route, no depth, no cost. The cost
 * surface is the other half of that comparison and it is measured separately.
 *
 * THE THREE RULES THAT ARE FROZEN BEFORE ANY RESULT
 *
 *   1. ENTRY is the FIRST snapshot at or after the cohort's lower age bound,
 *      within a quarter of the band's width. First, never best.
 *   2. EXIT is the snapshot NEAREST the cohort's upper bound, within ±25% of it.
 *      Nearest in TIME, never nearest to a return.
 *   3. The sampling unit is the MINT. One observation per mint per cohort.
 *
 * WHAT CENSORING DOES HERE, AND WHY IT IS REPORTED RATHER THAN AVOIDED
 *
 * A token that stopped being snapshotted has no exit price. Dropping it makes
 * the sample conditional on continued observation, which is survivorship, and
 * it is the single largest bias available in this dataset. So the censored
 * fraction is a headline number, and the primary estimate is accompanied by a
 * carry-forward variant in which a mint's last observed price becomes its exit.
 * Neither variant treats a disappearance as -100%: absence of a provider field
 * is a fact about the provider, not about the token.
 *
 * DENOMINATION
 *
 * The provider quotes USD. The bankroll is SOL. Over a 2m-60m horizon the
 * difference is noise; over 24h-7d it is not, so a SOL/USD series is derived
 * from the stored buy quotes (SOL in, atoms out, against the same mint's stored
 * USD price at the same moment) and both denominations are reported. The derived
 * series carries the buy leg's own fee inside it, which biases the level by
 * about a percent and cancels almost exactly in a ratio of two of them.
 *
 * Read-only. No network call. Nothing is signed, submitted, or funded.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { clusterBootstrap, medianOfMeans, type MintOutcome } from '../packages/research/src/robust-stats.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';
import {
  deriveSolUsd,
  solUsdAt,
  SOL_USD_BUCKET_MS,
  SOL_USD_PAIR_MAX_GAP_MS,
} from '../packages/research/src/sol-usd.js';

interface Cohort {
  readonly key: string;
  readonly loMs: number;
  readonly hiMs: number;
}

/** §16 of 4890af0. Not chosen here, and not revised after a result. */
const COHORTS: readonly Cohort[] = [
  { key: '2m-60m', loMs: 2 * 60_000, hiMs: 60 * 60_000 },
  { key: '1h-5h', loMs: 3_600_000, hiMs: 5 * 3_600_000 },
  { key: '5h-24h', loMs: 5 * 3_600_000, hiMs: 24 * 3_600_000 },
  { key: '24h-7d', loMs: 24 * 3_600_000, hiMs: 7 * 24 * 3_600_000 },
];

/** Frozen tolerances. Registered in the ledger with the cohort definitions. */
const ENTRY_TOLERANCE_OF_BAND = 0.25;
const EXIT_TOLERANCE_OF_BOUND = 0.25;
/** The power constant the directive supplies: 7.84 = (1.96 + 0.84)². */
const POWER_CONSTANT = 7.84;

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });

/**
 * The measured cost floor, read from the §1.1 surface rather than restated.
 *
 * It is used for two things: the net mean the §1.3 decision compares, and a
 * SECOND required-n figure whose effect size is a target rather than whatever
 * this sample's mean happened to be. `7.84 × CV²` sizes a test for the observed
 * effect, so when the observed mean is near zero the required n runs to
 * millions — which is a true statement about that particular estimate and a
 * useless one for planning. The target version asks the question a window
 * actually has to answer: how many positions to detect an edge as large as the
 * cost of trading.
 */
const COST_SURFACE_PATH = 'artifacts/cost-surface.json';
const costFloorPct: number | null = existsSync(COST_SURFACE_PATH)
  ? ((JSON.parse(readFileSync(COST_SURFACE_PATH, 'utf8')) as { costFloorPct: number | null }).costFloorPct ?? null)
  : null;
const costFloorFraction = costFloorPct === null ? null : costFloorPct / 100;

const entryWindow = (c: Cohort): [number, number] => [c.loMs, c.loMs + ENTRY_TOLERANCE_OF_BAND * (c.hiMs - c.loMs)];
const exitWindow = (c: Cohort): [number, number] => [
  c.hiMs * (1 - EXIT_TOLERANCE_OF_BOUND),
  c.hiMs * (1 + EXIT_TOLERANCE_OF_BOUND),
];

// ---------------------------------------------------------------------------
// 1 — SOL/USD, DERIVED FROM STORED QUOTES
// ---------------------------------------------------------------------------
//
// The derivation moved to packages/research/src/sol-usd.ts when Phase B needed
// the same series. Two copies of one derivation is two chances for the two
// numbers to disagree, and nobody would be able to say which was the rate.

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : (((s[m - 1] as number) + (s[m] as number)) / 2);
};

const solUsd = deriveSolUsd(db);
const solUsdAtMs = (t: number): number | null => solUsdAt(solUsd, t);

// ---------------------------------------------------------------------------
// 2 — THE SNAPSHOTS THAT CAN CARRY AN ENTRY OR AN EXIT
// ---------------------------------------------------------------------------

interface Snap {
  readonly age: number;
  readonly t: number;
  readonly usd: number;
  readonly eligible: number;
}

/**
 * Only the age bands the cohorts can use are read.
 *
 * The corpus holds 837,876 snapshots. Selecting the eight windows in SQL rather
 * than filtering in the loop keeps the whole reconstruction inside one pass and
 * makes the inclusion rule a literal part of the query the artifact records.
 */
const bands: [number, number][] = [];
for (const c of COHORTS) {
  bands.push(entryWindow(c));
  bands.push(exitWindow(c));
}
const bandClause = bands
  .map(([lo, hi]) => `(d.token_age_ms >= ${Math.floor(lo)} AND d.token_age_ms <= ${Math.ceil(hi)})`)
  .join(' OR ');
const inclusionQuery =
  `SELECT s.mint, d.token_age_ms, d.taken_utc_ms, json_extract(d.features_json,'$.usdPrice'), s.eligible ` +
  `FROM screenings s JOIN decision_snapshots d ON d.snapshot_id = s.snapshot_id ` +
  `WHERE d.token_age_ms IS NOT NULL AND (${bandClause})`;

const byMint = new Map<string, Snap[]>();
let rowsRead = 0;
let rowsWithoutPrice = 0;
for (const row of db
  .prepare(
    `SELECT s.mint AS mint, d.token_age_ms AS age, d.taken_utc_ms AS t,
            json_extract(d.features_json, '$.usdPrice') AS usd, s.eligible AS eligible
       FROM screenings s
       JOIN decision_snapshots d ON d.snapshot_id = s.snapshot_id
      WHERE d.token_age_ms IS NOT NULL AND (${bandClause})`,
  )
  .iterate() as Iterable<{ mint: string; age: number; t: number; usd: number | null; eligible: number }>) {
  rowsRead += 1;
  if (row.usd === null || !(row.usd > 0)) {
    rowsWithoutPrice += 1;
    continue;
  }
  const list = byMint.get(row.mint);
  const snap: Snap = { age: row.age, t: row.t, usd: row.usd, eligible: row.eligible };
  if (list === undefined) byMint.set(row.mint, [snap]);
  else list.push(snap);
}
for (const list of byMint.values()) list.sort((a, b) => a.age - b.age);

/** The last observed price for a mint, for the carry-forward variant. */
const lastObserved = new Map<string, Snap>();
for (const [mint, list] of byMint) {
  const last = list[list.length - 1];
  if (last !== undefined) lastObserved.set(mint, last);
}

console.log(
  `read ${rowsRead} in-band snapshots over ${byMint.size} mints (${rowsWithoutPrice} carried no usdPrice)`,
);
console.log(
  `SOL/USD: ${solUsd.pairsTotal} quote-snapshot pairs over ${solUsd.buckets.length} hourly buckets, median ${solUsd.medianSolUsd?.toFixed(2) ?? 'none'}`,
);

// ---------------------------------------------------------------------------
// 3 — ONE OBSERVATION PER MINT PER COHORT
// ---------------------------------------------------------------------------

interface Observation {
  readonly mint: string;
  readonly entryT: number;
  readonly exitT: number;
  readonly entryAge: number;
  readonly exitAge: number;
  readonly eligible: boolean;
  readonly grossUsd: number;
  readonly grossSol: number | null;
  readonly carriedForward: boolean;
}

function observe(c: Cohort): {
  observations: Observation[];
  entriesFound: number;
  censored: number;
  carriedForward: number;
} {
  const [entryLo, entryHi] = entryWindow(c);
  const [exitLo, exitHi] = exitWindow(c);
  const observations: Observation[] = [];
  let entriesFound = 0;
  let censored = 0;
  let carriedForward = 0;

  for (const [mint, list] of byMint) {
    // RULE 1 — the first snapshot in the entry window. Never the best one.
    const entry = list.find((s) => s.age >= entryLo && s.age <= entryHi);
    if (entry === undefined) continue;
    entriesFound += 1;

    // RULE 2 — the snapshot nearest the upper bound, inside the tolerance.
    let exit: Snap | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const s of list) {
      if (s.age <= entry.age) continue;
      if (s.age < exitLo || s.age > exitHi) continue;
      const gap = Math.abs(s.age - c.hiMs);
      if (gap < bestGap) {
        bestGap = gap;
        exit = s;
      }
    }

    let carried = false;
    if (exit === undefined) {
      censored += 1;
      const last = lastObserved.get(mint);
      // Carry-forward: the last price this mint was ever observed at. NOT
      // -100%, and NOT the entry price either — both would be inventions.
      if (last === undefined || last.age <= entry.age) continue;
      exit = last;
      carried = true;
      carriedForward += 1;
    }

    const grossUsd = exit.usd / entry.usd - 1;
    const solEntry = solUsdAtMs(entry.t);
    const solExit = solUsdAtMs(exit.t);
    const grossSol =
      solEntry === null || solExit === null ? null : (exit.usd / solExit) / (entry.usd / solEntry) - 1;

    observations.push({
      mint,
      entryT: entry.t,
      exitT: exit.t,
      entryAge: entry.age,
      exitAge: exit.age,
      eligible: entry.eligible === 1,
      grossUsd,
      grossSol,
      carriedForward: carried,
    });
  }
  return { observations, entriesFound, censored, carriedForward };
}

// ---------------------------------------------------------------------------
// 4 — THE SHAPE STATISTICS, AND THE SAMPLE SIZE THEY IMPLY
// ---------------------------------------------------------------------------

interface Shape {
  readonly n: number;
  readonly mean: number | null;
  readonly sd: number | null;
  readonly cv: number | null;
  readonly skew: number | null;
  readonly excessKurtosis: number | null;
  readonly requiredNAt80Power: number | null;
  /** 7.84 × (SD / cost_floor)²: the n to detect an edge the size of the cost. */
  readonly requiredNForCostFloorEdge: number | null;
  /** mean − cost_floor: what the §1.3 comparison actually turns on. */
  readonly netMeanAfterCostFloor: number | null;
  /**
   * Share of the SUM of returns carried by the top k.
   *
   * Meaningless when the sum is near zero — a ratio to nothing produces 2.84 and
   * 6.38, which are not shares of anything. `topShareInterpretable` says whether
   * to read it, and `topShareOfPositive` is the figure that always means what it
   * says: of all the gain in the sample, how much came from k mints.
   */
  readonly topShare: Readonly<Record<string, number | null>>;
  readonly topShareOfPositive: Readonly<Record<string, number | null>>;
  readonly topShareInterpretable: boolean;
  readonly positiveFraction: number | null;
  readonly medianReturn: number | null;
  readonly medianOfMeans: number | null;
  readonly totalReturn: number | null;
  readonly sumOfPositiveReturns: number | null;
  readonly maxReturn: number | null;
  readonly minReturn: number | null;
  readonly bootstrapMeanLower: number | null;
  readonly bootstrapMeanUpper: number | null;
  /**
   * Distinct UTC entry days.
   *
   * One day is not a market condition, and a day-clustered bootstrap over a
   * single cluster returns the point estimate as its own interval. A cohort with
   * one day has no estimable uncertainty however many mints it holds.
   */
  readonly utcDaysRepresented: number;
}

function shapeOf(returns: readonly number[], days: readonly string[]): Shape {
  const n = returns.length;
  if (n === 0) {
    return {
      n: 0,
      mean: null,
      sd: null,
      cv: null,
      skew: null,
      excessKurtosis: null,
      requiredNAt80Power: null,
      requiredNForCostFloorEdge: null,
      netMeanAfterCostFloor: null,
      topShare: {},
      topShareOfPositive: {},
      topShareInterpretable: false,
      positiveFraction: null,
      medianReturn: null,
      medianOfMeans: null,
      totalReturn: null,
      sumOfPositiveReturns: null,
      maxReturn: null,
      minReturn: null,
      bootstrapMeanLower: null,
      bootstrapMeanUpper: null,
      utcDaysRepresented: 0,
    };
  }
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const m2 = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const m3 = returns.reduce((a, b) => a + (b - mean) ** 3, 0) / n;
  const m4 = returns.reduce((a, b) => a + (b - mean) ** 4, 0) / n;
  // Sample SD (n-1), which is the estimator the power formula assumes.
  const sd = n > 1 ? Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
  const skew = m2 > 0 ? m3 / m2 ** 1.5 : null;
  const excessKurtosis = m2 > 0 ? m4 / m2 ** 2 - 3 : null;
  // CV against the ABSOLUTE mean: a negative mean has the same dispersion
  // problem as a positive one, and a signed CV makes the required n negative.
  const cv = sd !== null && mean !== 0 ? sd / Math.abs(mean) : null;
  const total = returns.reduce((a, b) => a + b, 0);
  const absTotal = returns.reduce((a, b) => a + Math.abs(b), 0);
  const positiveSum = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const sorted = [...returns].sort((a, b) => b - a);
  const topShare: Record<string, number | null> = {};
  const topShareOfPositive: Record<string, number | null> = {};
  // A sum of returns that is small next to the sum of their magnitudes is a
  // cancellation, not a total, and a share of it says nothing.
  const interpretable = absTotal > 0 && Math.abs(total) / absTotal >= 0.05;
  for (const k of [1, 3, 5, 10]) {
    if (n < k) {
      topShare[`top${k}`] = null;
      topShareOfPositive[`top${k}`] = null;
      continue;
    }
    const head = sorted.slice(0, k).reduce((a, b) => a + b, 0);
    topShare[`top${k}`] = interpretable ? head / total : null;
    topShareOfPositive[`top${k}`] = positiveSum > 0 ? head / positiveSum : null;
  }
  const outcomes: MintOutcome[] = returns.map((r, i) => ({
    mint: `r${i}`,
    utcDay: days[i] ?? 'unknown',
    logReturn: r,
    netPnlLamports: 0n,
    catastrophic: false,
    blockedExit: false,
  }));
  const boot = clusterBootstrap(outcomes, 'UTC_DAY', 1_000);
  const med = median(returns);
  const distinctDays = new Set(outcomes.map((o) => o.utcDay)).size;
  return {
    n,
    mean,
    sd,
    cv,
    skew,
    excessKurtosis,
    requiredNAt80Power: cv === null ? null : Math.ceil(POWER_CONSTANT * cv ** 2),
    requiredNForCostFloorEdge:
      sd === null || costFloorFraction === null || costFloorFraction <= 0
        ? null
        : Math.ceil(POWER_CONSTANT * (sd / costFloorFraction) ** 2),
    netMeanAfterCostFloor: costFloorFraction === null ? null : mean - costFloorFraction,
    topShare,
    topShareOfPositive,
    topShareInterpretable: interpretable,
    positiveFraction: returns.filter((r) => r > 0).length / n,
    medianReturn: med,
    medianOfMeans: medianOfMeans(returns),
    totalReturn: total,
    sumOfPositiveReturns: positiveSum,
    maxReturn: sorted[0] ?? null,
    minReturn: sorted[sorted.length - 1] ?? null,
    // A single-cluster bootstrap resamples the same cluster every time and
    // returns the point estimate as its own interval. Reported as absent.
    bootstrapMeanLower: distinctDays >= 2 ? boot.lower : null,
    bootstrapMeanUpper: distinctDays >= 2 ? boot.upper : null,
    utcDaysRepresented: distinctDays,
  };
}

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

interface CohortReport {
  readonly cohort: string;
  readonly entryWindowMs: [number, number];
  readonly exitWindowMs: [number, number];
  readonly mintsWithEntry: number;
  readonly censoredNoExit: number;
  readonly censoredFraction: number | null;
  readonly carriedForwardUsed: number;
  readonly populations: Readonly<Record<string, Shape>>;
}

const reports: CohortReport[] = [];
for (const c of COHORTS) {
  const { observations, entriesFound, censored, carriedForward } = observe(c);
  const observed = observations.filter((o) => !o.carriedForward);
  const eligibleObserved = observed.filter((o) => o.eligible);
  const withSol = observed.filter((o) => o.grossSol !== null);
  const eligibleWithSol = eligibleObserved.filter((o) => o.grossSol !== null);

  const populations: Record<string, Shape> = {
    // The primary: every screened mint with an observed exit, USD.
    ALL_SCREENED_USD_OBSERVED_EXIT: shapeOf(
      observed.map((o) => o.grossUsd),
      observed.map((o) => utcDay(o.entryT)),
    ),
    // The population the strategy is actually defined over.
    ELIGIBLE_USD_OBSERVED_EXIT: shapeOf(
      eligibleObserved.map((o) => o.grossUsd),
      eligibleObserved.map((o) => utcDay(o.entryT)),
    ),
    // The bankroll's own denomination.
    ALL_SCREENED_SOL_OBSERVED_EXIT: shapeOf(
      withSol.map((o) => o.grossSol as number),
      withSol.map((o) => utcDay(o.entryT)),
    ),
    ELIGIBLE_SOL_OBSERVED_EXIT: shapeOf(
      eligibleWithSol.map((o) => o.grossSol as number),
      eligibleWithSol.map((o) => utcDay(o.entryT)),
    ),
    // With the censored mints carried forward at their last observed price.
    ALL_SCREENED_USD_CARRY_FORWARD: shapeOf(
      observations.map((o) => o.grossUsd),
      observations.map((o) => utcDay(o.entryT)),
    ),
  };

  reports.push({
    cohort: c.key,
    entryWindowMs: entryWindow(c),
    exitWindowMs: exitWindow(c),
    mintsWithEntry: entriesFound,
    censoredNoExit: censored,
    censoredFraction: entriesFound === 0 ? null : censored / entriesFound,
    carriedForwardUsed: carriedForward,
    populations,
  });
}

// ---------------------------------------------------------------------------
// 5 — WHICH COHORT NEEDS THE FEWEST OBSERVATIONS
// ---------------------------------------------------------------------------

/**
 * ONE population, for all four cohorts, chosen before the numbers were seen.
 *
 * The eligible subsamples are 45, 1, 3 and 0 mints. Ranking on them would rank
 * four different populations against each other, and one of the four does not
 * exist at all — a comparison that cannot be made, not a comparison that came
 * out badly. They are reported as diagnostics and cannot select the cohort.
 *
 * The SOL denomination is primary because the bankroll is SOL: the 5h-24h cohort
 * differs by 1.3 percentage points of mean return between the two denominations,
 * which is half the measured cost floor.
 */
const RANKING_POPULATION = 'ALL_SCREENED_SOL_OBSERVED_EXIT';
const DIAGNOSTIC_POPULATION = 'ELIGIBLE_SOL_OBSERVED_EXIT';
/** A CV estimated on fewer than this many mints is not a CV. */
const MIN_N_FOR_RANKING = 1_000;
/** One entry day is one market condition, and its dispersion is not estimable. */
const MIN_UTC_DAYS_FOR_RANKING = 2;

const rank = reports
  .map((r) => {
    const shape = r.populations[RANKING_POPULATION];
    const reasons: string[] = [];
    if (shape === undefined || shape.n < MIN_N_FOR_RANKING) {
      reasons.push(`n below ${MIN_N_FOR_RANKING}`);
    }
    if (shape !== undefined && shape.utcDaysRepresented < MIN_UTC_DAYS_FOR_RANKING) {
      reasons.push(`only ${shape.utcDaysRepresented} distinct UTC entry day(s)`);
    }
    if (shape !== undefined && shape.requiredNAt80Power === null) {
      reasons.push('CV not estimable: the mean is zero');
    }
    /**
     * IS THE REQUIRED N EVEN IDENTIFIED?
     *
     * `7.84 × CV²` divides by the observed mean. When the mean's 95% interval
     * contains zero, CV = infinity is inside that interval too, and so is a
     * required n of infinity. Ranking such cohorts against each other ranks the
     * noise in their point estimates.
     *
     * Added after seeing that three of the four intervals contain zero. It is an
     * availability restriction, not an outcome one — an estimate that is not
     * identified cannot be ranked, whichever direction it points — and it does
     * select the cohort with the largest positive mean, which the report says
     * plainly alongside the ranking the unrestricted rule would have produced.
     */
    const lo = shape?.bootstrapMeanLower ?? null;
    const hi = shape?.bootstrapMeanUpper ?? null;
    const identified = lo !== null && hi !== null && (lo > 0 || hi < 0);
    if (shape !== undefined && !identified) {
      reasons.push(
        lo === null || hi === null
          ? 'the mean has no estimable interval'
          : `the mean 95% interval [${lo.toFixed(4)}, ${hi.toFixed(4)}] contains zero, so CV is unbounded`,
      );
    }
    return {
      cohort: r.cohort,
      populationUsed: RANKING_POPULATION,
      n: shape?.n ?? 0,
      utcDays: shape?.utcDaysRepresented ?? 0,
      cv: shape?.cv ?? null,
      requiredN: shape?.requiredNAt80Power ?? null,
      requiredNForCostFloorEdge: shape?.requiredNForCostFloorEdge ?? null,
      sd: shape?.sd ?? null,
      mean: shape?.mean ?? null,
      netMeanAfterCostFloor: shape?.netMeanAfterCostFloor ?? null,
      meanCi:
        shape?.bootstrapMeanLower === null || shape?.bootstrapMeanLower === undefined
          ? null
          : [shape.bootstrapMeanLower, shape.bootstrapMeanUpper],
      censoredFraction: r.censoredFraction,
      meanDistinguishableFromZero: identified,
      rankable: reasons.length === 0,
      notRankableBecause: reasons,
      diagnosticEligibleN: r.populations[DIAGNOSTIC_POPULATION]?.n ?? 0,
      diagnosticEligibleRequiredN: r.populations[DIAGNOSTIC_POPULATION]?.requiredNAt80Power ?? null,
    };
  })
  .sort((a, b) => {
    if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
    return (a.requiredN ?? Number.POSITIVE_INFINITY) - (b.requiredN ?? Number.POSITIVE_INFINITY);
  });

const artifact = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'phase-a-gross-edge-v1',
    sampleInclusionQuery: inclusionQuery,
  }),
  label: 'DEVELOPMENT_RECONSTRUCTED',
  isEvidence: false,
  notEvidenceBecause:
    'reconstructed from provider MID prices the system never traded at; no fill, no route, no depth and no cost. ' +
    'Its only sanctioned use is estimating distribution shape to size a later window.',
  directive: 'd70b4a9a §1.2',
  powerConstant: POWER_CONSTANT,
  entryToleranceOfBand: ENTRY_TOLERANCE_OF_BAND,
  exitToleranceOfBound: EXIT_TOLERANCE_OF_BOUND,
  snapshotsRead: rowsRead,
  snapshotsWithoutPrice: rowsWithoutPrice,
  mintsInBand: byMint.size,
  solUsd: {
    quotesConsidered: solUsd.quotesConsidered,
    pairsTotal: solUsd.pairsTotal,
    buckets: solUsd.buckets.length,
    medianSolUsd: solUsd.medianSolUsd,
    bucketMs: SOL_USD_BUCKET_MS,
    pairMaxGapMs: SOL_USD_PAIR_MAX_GAP_MS,
    derivation:
      'stored buy quotes (SOL in, atoms out) against the same mint stored USD price within 5 minutes; ' +
      'hourly median. Carries the buy leg fee, which cancels in a ratio of two.',
  },
  costFloorPct,
  costFloorSource: COST_SURFACE_PATH,
  cohorts: reports,
  rankingPopulation: RANKING_POPULATION,
  minNForRanking: MIN_N_FOR_RANKING,
  minUtcDaysForRanking: MIN_UTC_DAYS_FOR_RANKING,
  rankedByRequiredN: rank,
  lowestRequiredNCohort: rank.find((r) => r.rankable)?.cohort ?? null,
  /** What the rule selects if the identification restriction is dropped. */
  lowestRequiredNCohortUnrestricted: [...rank]
    .filter((r) => r.requiredN !== null && r.n >= MIN_N_FOR_RANKING && r.utcDays >= MIN_UTC_DAYS_FOR_RANKING)
    .sort((a, b) => (a.requiredN as number) - (b.requiredN as number))[0]?.cohort ?? null,
  /** And what a target-sized test would select, which is a different cohort again. */
  lowestRequiredNCohortAtCostFloorTarget: [...rank]
    .filter((r) => r.requiredNForCostFloorEdge !== null)
    .sort((a, b) => (a.requiredNForCostFloorEdge as number) - (b.requiredNForCostFloorEdge as number))[0]?.cohort ?? null,
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/gross-edge-distribution.json', JSON.stringify(artifact, null, 2) + '\n');

const f = (v: number | null, d = 4): string => (v === null ? '     -' : v.toFixed(d).padStart(9));
for (const r of reports) {
  console.log('');
  console.log(
    `${r.cohort}  entries ${r.mintsWithEntry}  censored ${r.censoredNoExit} (${((r.censoredFraction ?? 0) * 100).toFixed(1)}%)`,
  );
  console.log('  population                             n      mean        sd        cv      skew      kurt   requiredN');
  for (const [name, s] of Object.entries(r.populations)) {
    console.log(
      `  ${name.padEnd(34)}${String(s.n).padStart(6)} ${f(s.mean)} ${f(s.sd)} ${f(s.cv, 2)} ${f(s.skew, 2)} ${f(s.excessKurtosis, 1)} ${String(s.requiredNAt80Power ?? '-').padStart(11)}`,
    );
  }
  const p = r.populations[RANKING_POPULATION];
  if (p !== undefined && p.n > 0) {
    console.log(
      `  share of TOTAL   top1 ${f(p.topShare['top1'] ?? null, 3)} top3 ${f(p.topShare['top3'] ?? null, 3)} top5 ${f(p.topShare['top5'] ?? null, 3)} top10 ${f(p.topShare['top10'] ?? null, 3)}  ${p.topShareInterpretable ? '' : '(NOT INTERPRETABLE: the total is a cancellation)'}`,
    );
    console.log(
      `  share of GAIN    top1 ${f(p.topShareOfPositive['top1'] ?? null, 3)} top3 ${f(p.topShareOfPositive['top3'] ?? null, 3)} top5 ${f(p.topShareOfPositive['top5'] ?? null, 3)} top10 ${f(p.topShareOfPositive['top10'] ?? null, 3)}`,
    );
    console.log(
      `  positive ${f(p.positiveFraction, 3)}  median ${f(p.medianReturn)}  medianOfMeans ${f(p.medianOfMeans)}  max ${f(p.maxReturn, 1)}  min ${f(p.minReturn)}  utcDays ${p.utcDaysRepresented}`,
    );
  }
}
console.log('');
console.log(`cost floor read from ${COST_SURFACE_PATH}: ${costFloorPct ?? 'unavailable'} %`);
console.log('ranked by required n at 80% power (the directive selects on this, not on mean return)');
for (const r of rank) {
  console.log(
    `  ${r.cohort.padEnd(8)} n=${String(r.n).padStart(6)} days=${String(r.utcDays).padStart(3)}  CV=${r.cv === null ? '-' : r.cv.toFixed(2).padStart(7)}  requiredN=${String(r.requiredN ?? '-').padStart(9)}  mean=${f(r.mean)}  censored=${((r.censoredFraction ?? 0) * 100).toFixed(0)}%  ${r.rankable ? 'RANKABLE' : 'NOT RANKABLE: ' + r.notRankableBecause.join('; ')}`,
  );
}
console.log('');
console.log('the same cohorts, sized against a TARGET edge equal to the cost floor (diagnostic, not the selector)');
for (const r of [...rank].sort(
  (a, b) => (a.requiredNForCostFloorEdge ?? Number.POSITIVE_INFINITY) - (b.requiredNForCostFloorEdge ?? Number.POSITIVE_INFINITY),
)) {
  console.log(
    `  ${r.cohort.padEnd(8)} sd=${f(r.sd, 4)}  requiredN=${String(r.requiredNForCostFloorEdge ?? '-').padStart(9)}  netMean=${f(r.netMeanAfterCostFloor)}  ${r.rankable ? '' : '(not rankable)'}`,
  );
}
console.log('');
console.log('wrote artifacts/gross-edge-distribution.json');
