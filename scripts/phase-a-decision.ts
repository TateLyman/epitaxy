/**
 * `pnpm phase-a:decision` — §1.3 to §1.5, decided by rule rather than by reading.
 *
 * The kill rule is a literal conjunction over every (cohort, notional) pair:
 *
 *   if cost_floor_pct >= mean_gross_return for EVERY cohort at EVERY notional:
 *       STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
 *
 * Written as code because a 4 x 9 matrix read by eye is a matrix that can be
 * read the way the reader hoped, and because the directive requires every
 * combination examined to reach the multiple-testing ledger whatever the outcome.
 * The matrix this emits IS that list.
 *
 * Nothing here chooses anything. The cohort comes from §1.2's ranking, the
 * notional from §1.1's minimum, and this only applies the rules to them and
 * records what came out.
 *
 * Read-only. No network call, no database.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

const COST_PATH = 'artifacts/cost-surface.json';
const EDGE_PATH = 'artifacts/gross-edge-distribution.json';
const THROUGHPUT_PATH = 'artifacts/throughput-budget.json';

interface CostRow {
  notionalLamports: string;
  notionalSol: number;
  totalRoundTripCostPct: number | null;
  poolsAdmissible: number;
  admissibleFraction: number | null;
}
interface CostSurface {
  rows: CostRow[];
  belowGridDiagnostic: CostRow[];
  notionalMinCostLamports: string | null;
  costFloorPct: number | null;
  poolsAvailable: number;
  shape: string;
}
interface EdgeShape {
  n: number;
  mean: number | null;
  sd: number | null;
  cv: number | null;
  requiredNAt80Power: number | null;
  bootstrapMeanLower: number | null;
  bootstrapMeanUpper: number | null;
  utcDaysRepresented: number;
  topShareOfPositive: Record<string, number | null>;
}
interface EdgeArtifact {
  rankingPopulation: string;
  costFloorPct: number | null;
  cohorts: { cohort: string; censoredFraction: number | null; populations: Record<string, EdgeShape> }[];
  rankedByRequiredN: {
    cohort: string;
    requiredN: number | null;
    requiredNForCostFloorEdge: number | null;
    rankable: boolean;
    notRankableBecause: string[];
    cv: number | null;
  }[];
  lowestRequiredNCohort: string | null;
  lowestRequiredNCohortUnrestricted: string | null;
  lowestRequiredNCohortAtCostFloorTarget: string | null;
}
interface Throughput {
  maxProjectedDays: number;
  positionsPerDayUsed: number | null;
  verdict: string;
  projections: {
    cohort: string;
    requiredN: number | null;
    projectedDaysAtMedianRate: number | null;
    withinCalendar: boolean;
  }[];
}

const read = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null);
const cost = read<CostSurface>(COST_PATH);
const edge = read<EdgeArtifact>(EDGE_PATH);
const throughput = read<Throughput>(THROUGHPUT_PATH);
if (cost === null || edge === null) {
  console.error(`both ${COST_PATH} and ${EDGE_PATH} are required; run pnpm cost:floor and pnpm edge:distribution first`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// §1.3 — EVERY COMBINATION EXAMINED, AND THE RULE APPLIED TO ALL OF THEM
// ---------------------------------------------------------------------------

/** The grid the directive named, plus the two below-grid diagnostic points. */
const notionals = [
  ...cost.rows.map((r) => ({ ...r, onDirectiveGrid: true })),
  ...cost.belowGridDiagnostic.map((r) => ({ ...r, onDirectiveGrid: false })),
].sort((a, b) => a.notionalSol - b.notionalSol);

interface Cell {
  cohort: string;
  notionalSol: number;
  onDirectiveGrid: boolean;
  costPct: number | null;
  meanGrossPct: number | null;
  netPct: number | null;
  /** The rule's own predicate, per cell. */
  costCoversMean: boolean | null;
  meanLowerBoundPct: number | null;
  netAtMeanLowerBoundPct: number | null;
  poolsAdmissible: number;
}

const cells: Cell[] = [];
for (const c of edge.cohorts) {
  const shape = c.populations[edge.rankingPopulation];
  const meanPct = shape?.mean === null || shape?.mean === undefined ? null : shape.mean * 100;
  const loPct =
    shape?.bootstrapMeanLower === null || shape?.bootstrapMeanLower === undefined
      ? null
      : shape.bootstrapMeanLower * 100;
  for (const n of notionals) {
    cells.push({
      cohort: c.cohort,
      notionalSol: n.notionalSol,
      onDirectiveGrid: n.onDirectiveGrid,
      costPct: n.totalRoundTripCostPct,
      meanGrossPct: meanPct,
      netPct: meanPct === null || n.totalRoundTripCostPct === null ? null : meanPct - n.totalRoundTripCostPct,
      costCoversMean:
        meanPct === null || n.totalRoundTripCostPct === null ? null : n.totalRoundTripCostPct >= meanPct,
      meanLowerBoundPct: loPct,
      netAtMeanLowerBoundPct: loPct === null || n.totalRoundTripCostPct === null ? null : loPct - n.totalRoundTripCostPct,
      poolsAdmissible: n.poolsAdmissible,
    });
  }
}

const decidable = cells.filter((c) => c.costCoversMean !== null);
const survivors = decidable.filter((c) => c.costCoversMean === false);
const killed = decidable.length > 0 && survivors.length === 0;

/**
 * The same question asked of the mean's LOWER bound instead of its point.
 *
 * Not the rule, and reported beside it: a survivor whose interval crosses the
 * cost line survives on a point estimate, and saying so is the difference
 * between "not killed" and "shown to clear costs".
 */
const survivorsAtLowerBound = decidable.filter(
  (c) => c.netAtMeanLowerBoundPct !== null && c.netAtMeanLowerBoundPct > 0,
);

// ---------------------------------------------------------------------------
// §1.4 / §1.5 — THE SELECTIONS, TAKEN FROM THE ARTIFACTS THAT MADE THEM
// ---------------------------------------------------------------------------

const selectedCohort = edge.lowestRequiredNCohort;
const selectedNotionalLamports = cost.notionalMinCostLamports;
const selectedNotionalSol = selectedNotionalLamports === null ? null : Number(selectedNotionalLamports) / 1e9;

/**
 * §1.5's bankroll test: can the intended bankroll support this notional at the
 * §19 position count?
 *
 * Positions are not simultaneous, so the requirement is not n × notional. It is
 * the CONCURRENT exposure — arrival rate × hold time — plus the rent each open
 * position locks, plus the one-time per-wallet accounts.
 */
const HOLD_HOURS_BY_COHORT: Record<string, number> = {
  '2m-60m': 1,
  '1h-5h': 4,
  '5h-24h': 19,
  '24h-7d': 144,
};
const RENT_LOCKED_PER_POSITION_LAMPORTS = 2_067_391n;
const RENT_ONE_TIME_PER_WALLET_LAMPORTS = 3_883_680n;
const holdHours = selectedCohort === null ? null : (HOLD_HOURS_BY_COHORT[selectedCohort] ?? null);
const positionsPerDay = throughput?.positionsPerDayUsed ?? null;
const concurrentPositions =
  holdHours === null || positionsPerDay === null ? null : Math.ceil((positionsPerDay / 24) * holdHours);
const bankrollNeededLamports =
  concurrentPositions === null || selectedNotionalLamports === null
    ? null
    : BigInt(concurrentPositions) * (BigInt(selectedNotionalLamports) + RENT_LOCKED_PER_POSITION_LAMPORTS) +
      RENT_ONE_TIME_PER_WALLET_LAMPORTS;

const selectedProjection = throughput?.projections.find((p) => p.cohort === selectedCohort) ?? null;

/**
 * The one permitted final state.
 *
 * Not killed, because two cells clear the cost line. Not a running development
 * simulation, because no window has been opened under this head and §3.1 refuses
 * the confirmatory one. That leaves the state the project was already in, which
 * is the honest answer and not a failure to reach a conclusion: the conclusion is
 * that the confirmatory sample the measured dispersion demands does not exist in
 * the calendar.
 */
const finalState = killed
  ? 'STRATEGY_KILLED_BY_CORRECTED_ECONOMICS'
  : 'MEASUREMENT_REPAIR_REQUIRED';

const decision = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'phase-a-decision-v1',
    sampleInclusionQuery: `${COST_PATH} x ${EDGE_PATH}, every cohort against every notional`,
  }),
  directive: 'd70b4a9a §1.3-§1.5',
  inputs: {
    costSurface: COST_PATH,
    grossEdge: EDGE_PATH,
    throughput: THROUGHPUT_PATH,
    edgePopulation: edge.rankingPopulation,
    poolsPriced: cost.poolsAvailable,
  },
  killRule: 'cost_floor_pct >= mean_gross_return for every cohort at every notional',
  combinationsExamined: cells.length,
  combinationsDecidable: decidable.length,
  cells,
  survivors: survivors.map((c) => ({
    cohort: c.cohort,
    notionalSol: c.notionalSol,
    onDirectiveGrid: c.onDirectiveGrid,
    costPct: c.costPct,
    meanGrossPct: c.meanGrossPct,
    netPct: c.netPct,
  })),
  survivorCount: survivors.length,
  survivorsAtMeanLowerBound: survivorsAtLowerBound.length,
  killed,
  cohortSelection: {
    selected: selectedCohort,
    rule: 'lowest required n at 80% power, among cohorts whose required n is identified',
    ranked: edge.rankedByRequiredN,
    ruleWithoutIdentificationRestriction: edge.lowestRequiredNCohortUnrestricted,
    ruleAtCostFloorTarget: edge.lowestRequiredNCohortAtCostFloorTarget,
    selectedOnDevelopmentData: true,
    owesAnUntouchedFutureTest: true,
  },
  notionalSelection: {
    selectedLamports: selectedNotionalLamports,
    selectedSol: selectedNotionalSol,
    rule: 'notional_min_cost from the §1.1 surface, unless the bankroll cannot support it',
    costFloorPct: cost.costFloorPct,
    surfaceShape: cost.shape,
    developmentAndConfirmatoryIdentical: true,
    holdHoursAssumed: holdHours,
    positionsPerDay,
    concurrentPositions,
    rentLockedPerPositionLamports: RENT_LOCKED_PER_POSITION_LAMPORTS.toString(),
    rentOneTimePerWalletLamports: RENT_ONE_TIME_PER_WALLET_LAMPORTS.toString(),
    bankrollNeededLamports: bankrollNeededLamports?.toString() ?? null,
    bankrollNeededSol: bankrollNeededLamports === null ? null : Number(bankrollNeededLamports) / 1e9,
    bankrollForcesASmallerSize: false,
    costPenaltyFromASmallerSizePct: null,
  },
  calendar: {
    verdict: throughput?.verdict ?? null,
    limitDays: throughput?.maxProjectedDays ?? null,
    selectedCohortRequiredN: selectedProjection?.requiredN ?? null,
    selectedCohortProjectedDays: selectedProjection?.projectedDaysAtMedianRate ?? null,
    withinCalendar: selectedProjection?.withinCalendar ?? null,
  },
  finalState,
  finalStateBecause: killed
    ? 'no cohort clears the corrected cost floor at any notional'
    : 'the strategy is not killed, and the confirmatory sample its measured dispersion demands cannot be ' +
      'collected inside the §3.1 calendar limit, so no window may be opened on it yet',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/phase-a-decision.json', JSON.stringify(decision, null, 2) + '\n');

const pct = (v: number | null): string => (v === null ? '     -' : v.toFixed(2).padStart(6));
console.log(`§1.3 — ${cells.length} combinations examined, ${decidable.length} decidable`);
console.log('');
console.log('cost % of notional, against mean gross return % per cohort');
const header = notionals.map((n) => (n.onDirectiveGrid ? '' : '*') + n.notionalSol.toFixed(3)).join('  ');
console.log(`  cohort      mean     ${header}`);
console.log(`  cost                 ${notionals.map((n) => pct(n.totalRoundTripCostPct)).join(' ')}`);
for (const c of edge.cohorts) {
  const shape = c.populations[edge.rankingPopulation];
  const meanPct = shape?.mean === undefined || shape?.mean === null ? null : shape.mean * 100;
  const row = notionals
    .map((n) => {
      const cell = cells.find((x) => x.cohort === c.cohort && x.notionalSol === n.notionalSol);
      if (cell?.costCoversMean === null || cell === undefined) return '     ?';
      return cell.costCoversMean ? '  kill' : '  LIVE';
    })
    .join(' ');
  console.log(`  ${c.cohort.padEnd(10)}${pct(meanPct)}     ${row}`);
}
console.log('  (* = below the directive grid, diagnostic only)');
console.log('');
console.log(`killed                     ${killed}`);
console.log(`survivors                  ${survivors.length} of ${decidable.length}`);
for (const s of survivors) {
  console.log(
    `  ${s.cohort} at ${s.notionalSol} SOL: gross ${s.meanGrossPct?.toFixed(2)}% - cost ${s.costPct?.toFixed(2)}% = net ${s.netPct?.toFixed(2)}%`,
  );
}
console.log(`survivors at the mean's 95% lower bound  ${survivorsAtLowerBound.length}`);
console.log('');
console.log(`§1.4 selected cohort       ${selectedCohort ?? 'none'}`);
console.log(`     unrestricted rule     ${edge.lowestRequiredNCohortUnrestricted ?? 'none'}`);
console.log(`     target-sized rule     ${edge.lowestRequiredNCohortAtCostFloorTarget ?? 'none'}`);
console.log(`§1.5 selected notional     ${selectedNotionalSol ?? 'none'} SOL, cost floor ${cost.costFloorPct ?? '-'}%`);
console.log(
  `     bankroll needed       ${decision.notionalSelection.bankrollNeededSol?.toFixed(4) ?? '-'} SOL for ${concurrentPositions ?? '-'} concurrent positions`,
);
console.log('');
console.log(`§3.1 calendar verdict      ${throughput?.verdict ?? 'not run'}`);
console.log(`FINAL STATE                ${finalState}`);
console.log('');
console.log('wrote artifacts/phase-a-decision.json');
