/**
 * MT095 — Phase G addendum §A.3 validation 2 and §A.4, the curve-priced cells.
 *
 * The pump program emits its curve state at every trade, so an exit price for a
 * censored position is READ rather than reconstructed: it is the state the program
 * reported at the last trade at or before the target instant, and a curve's reserves
 * change only when someone trades, so between trades it is exact.
 *
 * WHAT §A.3's FIRST VALIDATION FOUND (query 8383494, 93M events over 892,607 mints):
 * rolling `virtualTokenReserves` forward on token amounts alone reproduces what the
 * program reported at p50 1.00000 with 97.9%–99.5% inside 1% across every trade-count
 * bucket — FLAT, no drift. That is the test of "reserves do not move without a trade".
 * The invariant-derived SOL side FAILED at 58.5%–80.0% within 1%, so k is not constant
 * over a curve's life and nothing here derives SOL from it.
 *
 * WHAT THIS SCRIPT ADDS: §A.3's second validation — the curve price against the traded
 * price on the positions Phase B could already mark — and §A.4, the curve-priced cells.
 *
 * THE POPULATION RESTRICTION IS THE HEADLINE, NOT A FOOTNOTE. Of the 5,598 T1–T7
 * holdout positions, only 999 (17.8%) are on a pump.fun bonding curve at all; the rest
 * are other launchpads and unaffiliated tokens that Jupiter discovery admitted. The
 * addendum calls this "the pre-migration bonding-curve branch", and for 82% of it there
 * is no bonding curve. Curve pricing can therefore remove the censoring for at most
 * that 18%, and every figure below is over the subpopulation where the curve is
 * actually the venue.
 *
 * Usage: pnpm curve:reprice
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { clusterBootstrap, type MintOutcome } from '../packages/research/src/robust-stats.js';

const NEWLINE = String.fromCharCode(10);
/** §A.4: the flat curve floor. 1.25% a leg, no tier relief. Impact is EXTRA (§A.5). */
const CURVE_FLOOR = 0.025;

interface Target {
  trigger: string;
  mint: string;
  day: string;
  entryUtcMs: number;
  exitTargetUtcMs: number;
  censored: boolean;
  carryForwardMarked: boolean;
  tierIndex: number;
  migratedAtEntry: boolean;
  grossReturnSol: number | null;
}

const csv = readFileSync('artifacts/phase-b-fired-targets.csv', 'utf8').trim().split(NEWLINE);
const head = (csv.shift() ?? '').split(',');
const col = (name: string): number => head.indexOf(name);
const targets: Target[] = csv.map((line) => {
  const f = line.split(',');
  return {
    trigger: f[col('trigger')] as string,
    mint: f[col('mint')] as string,
    day: f[col('day')] as string,
    entryUtcMs: Number(f[col('entry_utc_ms')]),
    exitTargetUtcMs: Number(f[col('exit_target_utc_ms')]),
    censored: f[col('censored')] === 'true',
    carryForwardMarked: f[col('carry_forward_marked')] === 'true',
    tierIndex: Number(f[col('tier_index')]),
    migratedAtEntry: f[col('migrated_at_entry')] === 'true',
    grossReturnSol: f[col('gross_return_sol')] === '' ? null : Number(f[col('gross_return_sol')]),
  };
});

interface Priced {
  trigger: string;
  mint: string;
  entry_price: number | null;
  exit_price: number | null;
  entry_lag_ms: number | null;
  exit_lag_ms: number | null;
  n_trades_between: number | null;
}
const priced: Priced[] = [];
for (const q of [8383544, 8383546, 8383548]) {
  const d = JSON.parse(readFileSync(`ops/dune/results/q15-curve-${q}.json`, 'utf8')) as {
    result: { rows: Priced[] };
  };
  priced.push(...d.result.rows);
}
const key = (t: string, m: string): string => `${t}|${m}`;
const priceOf = new Map(priced.map((p) => [key(p.trigger, p.mint), p]));

const isCurveMint = (m: string): boolean => m.endsWith('pump');
const t17 = targets.filter((t) => t.trigger !== 'T0');
const curveMints = t17.filter((t) => isCurveMint(t.mint));

console.log('MT095 — Phase G addendum: curve-state pricing for the pre-migration branch\n');
console.log('  THE POPULATION, before any price');
console.log(`    T1-T7 holdout positions                 ${t17.length}`);
console.log(
  `    on a pump.fun bonding curve at all      ${curveMints.length} (${((curveMints.length / t17.length) * 100).toFixed(1)}%)`,
);
const withBoth = curveMints.filter((t) => {
  const p = priceOf.get(key(t.trigger, t.mint));
  return p?.entry_price != null && p?.exit_price != null;
});
console.log(
  `    curve-priced at BOTH legs               ${withBoth.length} (${((withBoth.length / Math.max(curveMints.length, 1)) * 100).toFixed(1)}% of curve mints)`,
);
console.log('    The other 82% are other launchpads and unaffiliated tokens that Jupiter');
console.log('    discovery admitted. For them there is no bonding curve to price, and the');
console.log('    addendum\'s premise does not reach them.');

// -------------------------------------------------------------------------
// §A.3 validation 2 — the curve price against the price Phase B could observe
// -------------------------------------------------------------------------
const curveReturn = (t: Target): number | null => {
  const p = priceOf.get(key(t.trigger, t.mint));
  if (p?.entry_price == null || p?.exit_price == null || p.entry_price <= 0) return null;
  return p.exit_price / p.entry_price - 1;
};

const markable = withBoth.filter((t) => !t.censored && t.grossReturnSol !== null);
console.log(`\n  §A.3 VALIDATION 2 — curve price against the traded price, on the ${markable.length} positions`);
console.log('  Phase B could already mark. This is the test the addendum asked for.');
const pairs = markable
  .map((t) => ({ curve: curveReturn(t) as number, observed: t.grossReturnSol as number }))
  .filter((x) => Number.isFinite(x.curve));
if (pairs.length > 0) {
  const ratios = pairs
    .map((x) => (1 + x.curve) / (1 + x.observed))
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);
  const q = (p: number): number => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))] as number;
  const within = ratios.filter((r) => Math.abs(r - 1) <= 0.01).length;
  console.log(`    n=${ratios.length}  p10 ${q(0.1).toFixed(5)}  p50 ${q(0.5).toFixed(5)}  p90 ${q(0.9).toFixed(5)}`);
  console.log(
    `    within 1%: ${within} (${((within / ratios.length) * 100).toFixed(1)}%)  ` +
      `-> the conjunctive bar (p50 within 1% AND agreement above 95%) ` +
      `${Math.abs(q(0.5) - 1) <= 0.01 && within / ratios.length > 0.95 ? 'PASSES' : 'FAILS'}`,
  );
  const mc = pairs.reduce((a, x) => a + x.curve, 0) / pairs.length;
  const mo = pairs.reduce((a, x) => a + x.observed, 0) / pairs.length;
  console.log(`    mean curve-priced return ${(mc * 100).toFixed(2)}%  against observed ${(mo * 100).toFixed(2)}%`);
}

// -------------------------------------------------------------------------
// §A.4 — the curve-priced cells, on the curve subpopulation
// -------------------------------------------------------------------------
console.log('\n  §A.4 — CURVE-PRICED CELLS, pump-curve subpopulation only, net of the 2.50% flat floor');
console.log('    trig  fired  as-reported n  curve-priced n  as-reported  curve-priced  95% CI                net');
interface Row {
  trigger: string;
  fired: number;
  nReported: number;
  nCurve: number;
  asReported: number | null;
  curveMean: number | null;
  lower: number | null;
  upper: number | null;
  netCurve: number | null;
  netLower: number | null;
  previouslyUnmarkableMean: number | null;
  nPreviouslyUnmarkable: number;
}
const out: Row[] = [];
for (const trig of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']) {
  const fired = curveMints.filter((t) => t.trigger === trig);
  const reported = fired.filter((t) => t.grossReturnSol !== null);
  const curved = fired.map((t) => ({ t, r: curveReturn(t) })).filter((x) => x.r !== null) as {
    t: Target;
    r: number;
  }[];
  const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  const outcomes: MintOutcome[] = curved.map((x) => ({
    mint: x.t.mint,
    utcDay: x.t.day,
    logReturn: x.r,
    netPnlLamports: 0n,
    catastrophic: false,
    blockedExit: false,
  }));
  const boot = outcomes.length > 1 ? clusterBootstrap(outcomes, 'UTC_DAY', 2_000) : null;
  // THE QUANTITY THE BRANCH HAS BEEN UNDECIDABLE OVER: what the positions Phase B
  // could not mark are actually worth.
  const newlyPriced = curved.filter((x) => x.t.censored);
  const cm = mean(curved.map((x) => x.r));
  out.push({
    trigger: trig,
    fired: fired.length,
    nReported: reported.length,
    nCurve: curved.length,
    asReported: mean(reported.map((t) => t.grossReturnSol as number)),
    curveMean: cm,
    lower: boot?.lower ?? null,
    upper: boot?.upper ?? null,
    netCurve: cm === null ? null : cm - CURVE_FLOOR,
    netLower: boot === null ? null : boot.lower - CURVE_FLOOR,
    previouslyUnmarkableMean: mean(newlyPriced.map((x) => x.r)),
    nPreviouslyUnmarkable: newlyPriced.length,
  });
}
const pct = (v: number | null): string => (v === null ? '     n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
for (const r of out) {
  console.log(
    `    ${r.trigger}  ${String(r.fired).padStart(5)} ${String(r.nReported).padStart(14)} ${String(r.nCurve).padStart(15)}` +
      `  ${pct(r.asReported).padStart(11)}  ${pct(r.curveMean).padStart(12)}` +
      `  [${pct(r.lower)}, ${pct(r.upper)}]  ${pct(r.netCurve)}`,
  );
}

console.log('\n  THE PREVIOUSLY UNMARKABLE POSITIONS, stated explicitly as §A.4 requires');
console.log('    trig   n newly priced   their mean   the survivors\' mean   difference');
for (const r of out) {
  const diff =
    r.previouslyUnmarkableMean === null || r.asReported === null ? null : r.previouslyUnmarkableMean - r.asReported;
  console.log(
    `    ${r.trigger}  ${String(r.nPreviouslyUnmarkable).padStart(14)}  ${pct(r.previouslyUnmarkableMean).padStart(11)}` +
      `  ${pct(r.asReported).padStart(19)}  ${pct(diff).padStart(11)}`,
  );
}

const allNewly = curveMints
  .filter((t) => t.censored)
  .map((t) => curveReturn(t))
  .filter((r): r is number => r !== null);
const allSurv = curveMints
  .filter((t) => !t.censored && t.grossReturnSol !== null)
  .map((t) => t.grossReturnSol as number);
const m = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
console.log(
  `\n    POOLED across T1-T7: ${allNewly.length} previously unmarkable positions average ${pct(m(allNewly))},` +
    ` against ${pct(m(allSurv))} for the ${allSurv.length} survivors.`,
);

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/phase-g-curve-reprice.json',
  `${JSON.stringify(
    {
      label: 'DEVELOPMENT_RECONSTRUCTED',
      isEvidence: false,
      directive: 'Phase G addendum §A.3 validation 2 and §A.4',
      rule: 'MT095',
      curveFloor: CURVE_FLOOR,
      population: {
        t1t7HoldoutPositions: t17.length,
        onACurve: curveMints.length,
        curvePricedBothLegs: withBoth.length,
        t0Excluded: targets.filter((t) => t.trigger === 'T0').length,
        t0ExcludedReason:
          'T0 fired on 38,802 mints, whose inline target list is about 2.5 MB of SQL and Dune refuses ' +
          'a query that size. T0 is the baseline, so no re-priced trigger here can be compared against ' +
          'a re-priced baseline.',
      },
      validation2: {
        n: pairs.length,
        note: 'curve-priced return against the return Phase B observed, on positions it could already mark',
      },
      cells: out,
      pooled: {
        nPreviouslyUnmarkable: allNewly.length,
        previouslyUnmarkableMean: m(allNewly),
        nSurvivors: allSurv.length,
        survivorMean: m(allSurv),
      },
    },
    null,
    2,
  )}${NEWLINE}`,
);
console.log('\n  artifact           artifacts/phase-g-curve-reprice.json');
