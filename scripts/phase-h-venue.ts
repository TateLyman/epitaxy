/**
 * Phase H — locate the 82%.
 *
 * §1 classifies every holdout position's entry-leg venue by program ID, §2 re-cuts the
 * Phase B / Phase F trigger table by that classification, and §3 runs the thin-data
 * checks. The decision rules for all three were written to
 * docs/MULTIPLE_TESTING_LEDGER.csv as MT097 and MT098 before the first query was created.
 *
 * SOURCES, and why there are two. `ops/dune/results/q16-venue-*.json` is
 * `dex_solana.trades`: a curated venue name and program per trade, and NO ROW AT ALL for
 * 933 of the 2,056 conditional-trigger mints. `ops/dune/results/q17-program-*.json` is
 * `tokens_solana.transfers`: every token movement with the program that executed it,
 * curating nothing. Q17 decides the venue; Q16 names it and cross-checks it. The reason
 * is recorded in packages/research/src/venue-classify.ts and in the report: the first
 * split off Q16 alone put the entire positive return in the mints Q16 could not see,
 * which was a fact about Dune's coverage masquerading as a fact about the tokens.
 *
 * WHAT IS AND IS NOT CLASSIFIED. Q17 covers all 2,056 mints that fired a conditional
 * trigger — the population the +234.2% to +394.2% figures are computed over — in full.
 * For the 36,746 mints that fired only T0, one chunk of six was read: the transfers scan
 * costs about 31 credits a chunk and the phase's target is 150. So the T0 baseline is
 * exact on the conditional mints, which is the within-mint contrast that matters, and a
 * 16.7% sample on the rest. Both are labelled everywhere they appear.
 *
 * Usage: pnpm venue:classify
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  assignVenue,
  assignVenueExcludingInfrastructure,
  costFloorKind,
  programFact,
  stateOf,
  thinVerdict,
  windowActivity,
  type ActivityBucket,
  type ProgramKind,
} from '../packages/research/src/venue-classify.js';
import { clusterBootstrap, type MintOutcome } from '../packages/research/src/robust-stats.js';

const NEWLINE = String.fromCharCode(10);
const TRIGGERS = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'] as const;

/*
   THE ONLY TWO COST FLOORS THIS PROGRAMME HAS DECODED.

   PumpSwap: the fee schedule decoded in Phase B, read from the same artifact Phase B
   read, at the same 0.01 SOL notional. A tier with no measured pool in the corpus falls
   back to the nearest measured tier at or below it and the fallback is recorded — the
   identical rule Phase B used, not a new one.

   pump.fun bonding curve: 2.50% flat, which is the figure the directive names.

   Every other venue is UNKNOWN and stays UNKNOWN. §4 forbids inventing a floor by
   analogy, and forbids omitting one so that a gross figure reads as net.
*/
const FLOOR_NOTIONAL_SOL = 0.01;
const CURVE_FLOOR_PCT = 2.5;
interface TierSurface {
  readonly strata: readonly {
    readonly tierIndex: number;
    readonly scheduleRoundTripBps: number | null;
    readonly grid: readonly { readonly notionalSol: number; readonly totalCostPct: number | null }[];
  }[];
}
const tierSurface = JSON.parse(readFileSync('artifacts/cost-surface-by-tier.json', 'utf8')) as TierSurface;
const pumpswapFloorPct = (tierIndex: number): { pct: number | null; fromTier: number | null; exact: boolean } => {
  const at = (s: TierSurface['strata'][number]): number | null =>
    s.grid.find((g) => Math.abs(g.notionalSol - FLOOR_NOTIONAL_SOL) < 1e-9)?.totalCostPct ?? null;
  const exact = tierSurface.strata.find((s) => s.tierIndex === tierIndex);
  if (exact !== undefined) {
    const v = at(exact);
    if (v !== null) return { pct: v, fromTier: tierIndex, exact: true };
  }
  const below = [...tierSurface.strata]
    .filter((s) => s.tierIndex <= tierIndex)
    .sort((a, b) => b.tierIndex - a.tierIndex)
    .find((s) => at(s) !== null);
  if (below !== undefined) return { pct: at(below), fromTier: below.tierIndex, exact: false };
  return { pct: null, fromTier: null, exact: false };
};

// ---------------------------------------------------------------------------
// 1 — THE POSITIONS
// ---------------------------------------------------------------------------

interface Position {
  readonly trigger: string;
  readonly mint: string;
  readonly day: string;
  readonly entryS: number;
  readonly exitS: number;
  readonly censored: boolean;
  readonly tierIndex: number;
  readonly migratedAtEntry: boolean;
  readonly grossReturn: number | null;
  readonly carryForward: number | null;
}

const csv = readFileSync('artifacts/phase-b-fired-targets.csv', 'utf8').trim().split(NEWLINE);
const head = (csv.shift() ?? '').split(',');
const col = (name: string): number => {
  const i = head.indexOf(name);
  if (i < 0) throw new Error(`artifacts/phase-b-fired-targets.csv has no column ${name}`);
  return i;
};
const cTrigger = col('trigger');
const cMint = col('mint');
const cDay = col('day');
const cEntry = col('entry_utc_ms');
const cExit = col('exit_target_utc_ms');
const cCensored = col('censored');
const cTier = col('tier_index');
const cMigrated = col('migrated_at_entry');
const cGross = col('gross_return_sol');
const cCarry = col('carry_forward_return_sol');

const positions: Position[] = csv.map((line) => {
  const f = line.split(',');
  const num = (i: number): number | null => (f[i] === '' ? null : Number(f[i]));
  return {
    trigger: f[cTrigger] as string,
    mint: f[cMint] as string,
    day: f[cDay] as string,
    entryS: Number(f[cEntry]) / 1000,
    exitS: Number(f[cExit]) / 1000,
    censored: f[cCensored] === 'true',
    tierIndex: Number(f[cTier]),
    migratedAtEntry: f[cMigrated] === 'true',
    grossReturn: num(cGross),
    carryForward: num(cCarry),
  };
});

// ---------------------------------------------------------------------------
// 2 — THE TWO READS
// ---------------------------------------------------------------------------

interface Q17Row {
  g: number;
  mint: string;
  program: string | null;
  action: string | null;
  bucket: number | null;
  n_moves: number;
  n_tx: number;
  n_signers: number;
  first_s: number;
  last_s: number;
  n_tx_holdout: number;
  n_signers_holdout: number;
  n_moves_before: number;
}

interface Q16Row {
  g: number;
  mint: string;
  project: string | null;
  project_main_id: string | null;
  version_name: string | null;
  bucket: number | null;
  n_trades: number;
  n_traders: number;
  first_s: number;
  last_s: number;
}

/** Activity buckets per mint, from transfers. Only movements: a mint or burn is not a trade. */
const activity = new Map<string, ActivityBucket[]>();
/** The per-mint summary row from transfers: exact distinct signers over the holdout days. */
const signersOf = new Map<string, number>();
const txHoldoutOf = new Map<string, number>();
const movedBefore = new Map<string, number>();
/** Which program minted the token. The load-bearing fact this phase did not expect. */
const originOf = new Map<string, string>();
/** Which mints a transfers read covers at all, so "unread" never reads as "no activity". */
const readByQ17 = new Set<string>();

const loadQ17 = (path: string, label: string): void => {
  if (!existsSync(path)) {
    console.log(`  ${label}: NOT PRESENT (${path})`);
    return;
  }
  const rows = JSON.parse(readFileSync(path, 'utf8')).rows as Q17Row[];
  let mints = 0;
  for (const r of rows) {
    if (r.g === 7) {
      readByQ17.add(r.mint);
      signersOf.set(r.mint, r.n_signers_holdout);
      txHoldoutOf.set(r.mint, r.n_tx_holdout);
      movedBefore.set(r.mint, r.n_moves_before);
      mints += 1;
      continue;
    }
    if (r.program === null || r.bucket === null) continue;
    if (r.action === 'mint') {
      originOf.set(r.mint, r.program);
      continue;
    }
    if (r.action !== 'transfer') continue;
    const list = activity.get(r.mint) ?? [];
    list.push({
      program: r.program,
      bucket: r.bucket,
      nTx: r.n_tx,
      nMoves: r.n_moves,
      firstS: r.first_s,
      lastS: r.last_s,
    });
    activity.set(r.mint, list);
  }
  console.log(`  ${label}: ${rows.length} rows, ${mints} mints`);
};

/** Curated venue activity per mint, used for naming and for the coverage cross-check. */
const curated = new Map<string, ActivityBucket[]>();
const curatedName = new Map<string, string>();
const seenByQ16 = new Set<string>();

const loadQ16 = (path: string, label: string): void => {
  if (!existsSync(path)) {
    console.log(`  ${label}: NOT PRESENT (${path})`);
    return;
  }
  const rows = JSON.parse(readFileSync(path, 'utf8')).rows as Q16Row[];
  let mints = 0;
  for (const r of rows) {
    if (r.g === 15) {
      seenByQ16.add(r.mint);
      mints += 1;
      continue;
    }
    if (r.project_main_id === null || r.bucket === null) continue;
    curatedName.set(
      r.project_main_id,
      `${r.project ?? 'unnamed'}${r.version_name === null ? '' : ` ${r.version_name}`}`,
    );
    const list = curated.get(r.mint) ?? [];
    list.push({
      program: r.project_main_id,
      bucket: r.bucket,
      nTx: r.n_trades,
      nMoves: r.n_trades,
      firstS: r.first_s,
      lastS: r.last_s,
    });
    curated.set(r.mint, list);
  }
  console.log(`  ${label}: ${rows.length} rows, ${mints} mints`);
};

console.log('reads:');
loadQ17('ops/dune/results/q17-program-conditional.json', 'Q17 transfers, conditional mints');
loadQ17('ops/dune/results/q17-program-baseline-1.json', 'Q17 transfers, baseline chunk 1');
loadQ16('ops/dune/results/q16-venue-conditional.json', 'Q16 curated dex, conditional mints');

// ---------------------------------------------------------------------------
// 3 — §1: CLASSIFY
// ---------------------------------------------------------------------------

/** A venue key: a program ID, or one of the two ways a position can fail to have one. */
const UNREAD = 'UNREAD_NO_TRANSFERS_QUERY';
const NO_ACTIVITY = 'UNRESOLVED_NO_ACTIVITY';

interface Classified extends Position {
  /** MT097's rule, whatever kind of program wins. */
  readonly venue: string;
  readonly venueBasis: string;
  readonly venueTied: boolean;
  /** The refinement: the same rule over programs that can hold a pool. */
  readonly poolVenue: string;
  /** The curated table's answer, or null where it has no row. */
  readonly curatedVenue: string | null;
  readonly nTxWindow: number;
  readonly nTxWindowStrict: number;
  readonly sameTrade: boolean;
  readonly signersUpperBound: number | null;
  readonly origin: string | null;
}

const classified: Classified[] = positions.map((p) => {
  const buckets = activity.get(p.mint) ?? [];
  const w = { entryS: p.entryS, exitS: p.exitS };
  if (!readByQ17.has(p.mint)) {
    return {
      ...p,
      venue: UNREAD,
      venueBasis: 'UNREAD',
      venueTied: false,
      poolVenue: UNREAD,
      curatedVenue: null,
      nTxWindow: 0,
      nTxWindowStrict: 0,
      sameTrade: false,
      signersUpperBound: null,
      origin: null,
    };
  }
  const a = assignVenue(buckets, w);
  const pool = assignVenueExcludingInfrastructure(buckets, w);
  const act = windowActivity(buckets, w);
  const cur = assignVenue(curated.get(p.mint) ?? [], w);
  return {
    ...p,
    venue: a.program ?? NO_ACTIVITY,
    venueBasis: a.basis,
    venueTied: a.tied,
    poolVenue: pool.program ?? NO_ACTIVITY,
    curatedVenue: cur.program,
    nTxWindow: act.nTxGenerous,
    nTxWindowStrict: act.nTxStrict,
    sameTrade: act.sameTradeCertain,
    signersUpperBound: signersOf.get(p.mint) ?? null,
    origin: originOf.get(p.mint) ?? null,
  };
});

const conditional = classified.filter((c) => c.trigger !== 'T0');
const readConditional = conditional.filter((c) => c.venue !== UNREAD);

const fmt = (x: number | null, digits = 2): string =>
  x === null || Number.isNaN(x) ? '—' : x.toFixed(digits);
const pct = (x: number | null): string => (x === null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(2)}%`);
const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const meanOf = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

interface VenueRow {
  readonly venue: string;
  readonly name: string | null;
  readonly kind: ProgramKind | 'UNREAD' | 'NONE';
  readonly nPositions: number;
  readonly sharePositions: number;
  readonly nPriced: number;
  readonly summedReturn: number;
  readonly shareSummedReturn: number;
  readonly mean: number | null;
  readonly medianTradesPerMint: number;
  readonly medianTradersPerMint: number;
  readonly sameTradeFraction: number;
  readonly nMints: number;
  readonly costFloor: string;
  readonly curatedAgrees: number;
  readonly curatedAbsent: number;
}

const kindOf = (venue: string): ProgramKind | 'UNREAD' | 'NONE' => {
  if (venue === UNREAD) return 'UNREAD';
  if (venue === NO_ACTIVITY) return 'NONE';
  return programFact(venue).kind;
};

const venueTable = (rows: readonly Classified[], key: (c: Classified) => string): VenueRow[] => {
  const groups = new Map<string, Classified[]>();
  for (const r of rows) {
    const k = key(r);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [r]);
    else list.push(r);
  }
  const totalPositions = rows.length;
  const totalReturn = rows.reduce((a, r) => a + (r.grossReturn ?? 0), 0);
  const out: VenueRow[] = [];
  for (const [venue, list] of groups) {
    const priced = list.filter((r) => r.grossReturn !== null);
    const summed = priced.reduce((a, r) => a + (r.grossReturn as number), 0);
    const mints = [...new Set(list.map((r) => r.mint))];
    out.push({
      venue,
      name: venue === UNREAD || venue === NO_ACTIVITY ? null : programFact(venue).name,
      kind: kindOf(venue),
      nPositions: list.length,
      sharePositions: list.length / totalPositions,
      nPriced: priced.length,
      summedReturn: summed,
      shareSummedReturn: totalReturn === 0 ? Number.NaN : summed / totalReturn,
      mean: meanOf(priced.map((r) => r.grossReturn as number)),
      medianTradesPerMint: median(
        mints.map((m) => median(list.filter((r) => r.mint === m).map((r) => r.nTxWindow))),
      ),
      medianTradersPerMint: median(
        mints.map((m) => signersOf.get(m) ?? Number.NaN).filter((v) => !Number.isNaN(v)),
      ),
      sameTradeFraction: list.filter((r) => r.sameTrade).length / list.length,
      nMints: mints.length,
      costFloor: costFloorKind(venue === UNREAD || venue === NO_ACTIVITY ? null : venue),
      curatedAgrees: list.filter((r) => r.curatedVenue === venue).length,
      curatedAbsent: list.filter((r) => r.curatedVenue === null).length,
    });
  }
  return out.sort((a, b) => b.shareSummedReturn - a.shareSummedReturn || b.nPositions - a.nPositions);
};

console.log(`${NEWLINE}================ §1 CLASSIFICATION, CONDITIONAL TRIGGERS T1-T7 ================`);
console.log(`${readConditional.length} of ${conditional.length} positions have a transfers read${NEWLINE}`);
const primary = venueTable(readConditional, (c) => c.venue);
const hdr =
  'venue / program'.padEnd(46) +
  'kind'.padStart(10) +
  'n'.padStart(7) +
  'share'.padStart(8) +
  'priced'.padStart(7) +
  'ret share'.padStart(11) +
  'mean'.padStart(11) +
  'floor'.padStart(24);
console.log(hdr);
for (const r of primary) {
  console.log(
    `${(r.name ?? r.venue).padEnd(46)}${String(r.kind).padStart(10)}${String(r.nPositions).padStart(7)}` +
      `${pct(r.sharePositions).padStart(8)}${String(r.nPriced).padStart(7)}${pct(r.shareSummedReturn).padStart(11)}` +
      `${pct(r.mean).padStart(11)}${r.costFloor.padStart(24)}`,
  );
}
console.log(`${NEWLINE}program IDs, in the same order:`);
for (const r of primary) console.log(`  ${r.venue}  ${r.name ?? 'UNRECOGNISED — reported by ID'}`);

console.log(`${NEWLINE}the same rule restricted to programs that can hold a pool (a refinement, not MT097):`);
const refined = venueTable(readConditional, (c) => c.poolVenue);
for (const r of refined) {
  console.log(
    `  ${(r.name ?? r.venue).padEnd(46)}${String(r.nPositions).padStart(7)}${pct(r.shareSummedReturn).padStart(11)}` +
      `${pct(r.mean).padStart(11)}`,
  );
}

console.log(`${NEWLINE}================ ORIGIN: WHICH PROGRAM MINTED THE TOKEN ================`);
const originRows = venueTable(readConditional, (c) => c.origin ?? 'NO_MINT_EVENT_IN_READ');
console.log(hdr);
for (const r of originRows) {
  console.log(
    `${(r.name ?? r.venue).padEnd(46)}${String(r.kind).padStart(10)}${String(r.nPositions).padStart(7)}` +
      `${pct(r.sharePositions).padStart(8)}${String(r.nPriced).padStart(7)}${pct(r.shareSummedReturn).padStart(11)}` +
      `${pct(r.mean).padStart(11)}${r.costFloor.padStart(24)}`,
  );
}

// ---------------------------------------------------------------------------
// 4 — §2: THE TRIGGER TABLE, RE-CUT BY VENUE
// ---------------------------------------------------------------------------

interface Cell {
  readonly trigger: string;
  readonly venue: string;
  readonly venueName: string | null;
  readonly n: number;
  readonly nMints: number;
  readonly nDays: number;
  readonly asReportedN: number;
  readonly asReported: number | null;
  readonly asReportedLower: number;
  readonly asReportedUpper: number;
  readonly carryForwardN: number;
  readonly carryForward: number | null;
  readonly carryForwardLower: number;
  readonly carryForwardUpper: number;
  readonly residualAtZero: number | null;
  readonly residualLower: number;
  readonly residualUpper: number;
  readonly censoredFraction: number;
  readonly costFloor: string;
  /** The floor as a percentage where it is decoded, and null where it is UNKNOWN. */
  readonly costFloorPct: number | null;
  readonly costFloorNote: string;
  readonly medianTradesPerMint: number;
  readonly medianTradersPerMint: number;
  readonly sameTradeFraction: number;
}

/** The decoded floor for a venue, or null with the reason. */
const floorOf = (venue: string, tiers: readonly number[]): { pct: number | null; note: string } => {
  if (venue === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') {
    return { pct: CURVE_FLOOR_PCT, note: 'flat 2.50% curve fee, the figure the directive names' };
  }
  if (venue !== 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') {
    return { pct: null, note: 'UNKNOWN — this venue fee schedule has not been decoded' };
  }
  const counts = new Map<number, number>();
  for (const t of tiers) counts.set(t, (counts.get(t) ?? 0) + 1);
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  if (modal === undefined) return { pct: null, note: 'UNKNOWN — no tier observed' };
  const f = pumpswapFloorPct(modal[0]);
  return {
    pct: f.pct,
    note:
      `PumpSwap schedule at ${FLOOR_NOTIONAL_SOL} SOL, modal tier ${modal[0]}` +
      `${f.exact ? '' : ` measured at tier ${f.fromTier} and carried up`}`,
  };
};

const interval = (rows: readonly { mint: string; day: string; v: number }[]): {
  point: number | null;
  lower: number;
  upper: number;
} => {
  /*
     netPnlLamports, catastrophic and blockedExit exist on MintOutcome for the profit-factor
     and CVaR paths, which clusterBootstrap does not read. Phase B fills them the same way
     for the same reason: the shape is the real one, so a stub cannot drift from it.
  */
  const outcomes: MintOutcome[] = rows.map((r) => ({
    mint: r.mint,
    utcDay: r.day,
    logReturn: r.v,
    netPnlLamports: 0n,
    catastrophic: false,
    blockedExit: false,
  }));
  const ci = clusterBootstrap(outcomes, 'UTC_DAY');
  return { point: ci.point, lower: ci.lower, upper: ci.upper };
};

const cells: Cell[] = [];
const venuesPresent = [...new Set(classified.filter((c) => c.venue !== UNREAD).map((c) => c.venue))];
for (const trigger of TRIGGERS) {
  for (const venue of venuesPresent) {
    const rows = classified.filter((c) => c.trigger === trigger && c.venue === venue);
    if (rows.length === 0) continue;
    const asReported = rows.filter((r) => r.grossReturn !== null);
    const carried = rows
      .map((r) => (r.grossReturn !== null ? r.grossReturn : r.carryForward))
      .filter((v): v is number => v !== null);
    const carriedRows = rows
      .map((r) => ({ mint: r.mint, day: r.day, v: r.grossReturn !== null ? r.grossReturn : r.carryForward }))
      .filter((r): r is { mint: string; day: string; v: number } => r.v !== null);
    const residualRows = rows.map((r) => ({ mint: r.mint, day: r.day, v: r.grossReturn ?? -1 }));
    const ar = interval(asReported.map((r) => ({ mint: r.mint, day: r.day, v: r.grossReturn as number })));
    const cf = interval(carriedRows);
    const rz = interval(residualRows);
    const mints = [...new Set(rows.map((r) => r.mint))];
    const floor = floorOf(venue, rows.map((r) => r.tierIndex));
    cells.push({
      trigger,
      venue,
      venueName: venue === NO_ACTIVITY ? null : programFact(venue).name,
      n: rows.length,
      nMints: mints.length,
      nDays: new Set(rows.map((r) => r.day)).size,
      asReportedN: asReported.length,
      asReported: ar.point,
      asReportedLower: ar.lower,
      asReportedUpper: ar.upper,
      carryForwardN: carried.length,
      carryForward: cf.point,
      carryForwardLower: cf.lower,
      carryForwardUpper: cf.upper,
      residualAtZero: rz.point,
      residualLower: rz.lower,
      residualUpper: rz.upper,
      censoredFraction: rows.filter((r) => r.censored).length / rows.length,
      costFloor: costFloorKind(venue === NO_ACTIVITY ? null : venue),
      costFloorPct: floor.pct,
      costFloorNote: floor.note,
      medianTradesPerMint: median(
        mints.map((m) => median(rows.filter((r) => r.mint === m).map((r) => r.nTxWindow))),
      ),
      medianTradersPerMint: median(
        mints.map((m) => signersOf.get(m) ?? Number.NaN).filter((v) => !Number.isNaN(v)),
      ),
      sameTradeFraction: rows.filter((r) => r.sameTrade).length / rows.length,
    });
  }
}

console.log(`${NEWLINE}================ §2 TRIGGER MEANS BY VENUE ================`);
console.log('cells with at least 8 positions. A cell on fewer than 3 UTC days is marked !: its');
console.log('day-clustered interval is drawn from 1 or 2 clusters and is not inference.');
console.log(
  `${NEWLINE}${'trig'.padEnd(5)}${'venue'.padEnd(26)}${'n'.padStart(6)}${'day'.padStart(4)}` +
    `${'as-reported'.padStart(13)}${'95% (day)'.padStart(24)}${'carry-fwd'.padStart(12)}` +
    `${'resid@0'.padStart(11)}${'cens'.padStart(8)}${'floor'.padStart(10)}`,
);
for (const c of cells) {
  if (c.n < 8) continue;
  const label = (c.venueName ?? c.venue).slice(0, 25);
  console.log(
    `${c.trigger.padEnd(5)}${label.padEnd(26)}${String(c.n).padStart(6)}` +
      `${`${c.nDays}${c.nDays < 3 ? '!' : ' '}`.padStart(4)}` +
      `${pct(c.asReported).padStart(13)}${`[${pct(c.asReportedLower)}, ${pct(c.asReportedUpper)}]`.padStart(24)}` +
      `${pct(c.carryForward).padStart(12)}${pct(c.residualAtZero).padStart(11)}` +
      `${pct(c.censoredFraction).padStart(8)}` +
      `${(c.costFloorPct === null ? 'UNKNOWN' : `${c.costFloorPct.toFixed(3)}%`).padStart(10)}`,
  );
}

// ---------------------------------------------------------------------------
// 4b — IS THE TRIGGER'S ADVANTAGE WITHIN A VENUE, OR IS IT THE VENUE MIX?
// ---------------------------------------------------------------------------

/*
   The re-cut only means something if this question gets asked. A trigger can beat the
   unconditional baseline two ways: by picking better positions inside a venue, or by
   picking a different mix of venues. The first is an effect. The second is a relabelling
   of the same tokens: it carries no information the venue label did not already have, and
   it is not tradable on any venue whose fee schedule is UNKNOWN.

   THE WITHIN-MINT BASELINE IS DEGENERATE AND THAT IS ITSELF A FINDING. T0 restricted to
   the mints a trigger fired on reproduces the trigger's mean to the last digit — T1 gives
   234.18% and so does T0 on T1's mints. Phase B's triggers select WHICH MINT to enter,
   not when: the entry snapshot is the same one either way, so the two are the same
   position. There is no within-mint contrast to be had, and the only real baseline is T0
   over the whole discovery population.

   That baseline is REWEIGHTED, because the transfers read covers all 2,056 mints that
   fired a conditional trigger but only 6,125 of the 36,746 that fired T0 alone. A T0-only
   position therefore counts 36,746/6,125 = 6.0 times, and a T0 position on a conditional
   mint counts once. The reweighting is stated rather than hidden, and the unweighted
   figures are in the artifact next to it.

     total  = mean(trigger) - weighted mean(T0)
     mix    = SUM_v [w_trigger(v) - w_T0(v)] * mean_T0(v)
     within = SUM_v w_trigger(v) * [mean_trigger(v) - mean_T0(v)]
     rest   = total - mix - within, from venues present on only one side
*/
/** Every mint that fired at least one conditional trigger. All of these were read. */
const CONDITIONAL_MINTS = new Set(classified.filter((c) => c.trigger !== 'T0').map((c) => c.mint));
const T0_SAMPLE_CHUNKS = 6;
const weightOf = (c: Classified): number =>
  c.trigger === 'T0' && !CONDITIONAL_MINTS.has(c.mint) ? T0_SAMPLE_CHUNKS : 1;
const wMean = (rows: readonly Classified[]): number | null => {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    if (r.grossReturn === null) continue;
    const w = weightOf(r);
    num += w * r.grossReturn;
    den += w;
  }
  return den === 0 ? null : num / den;
};
const wShare = (rows: readonly Classified[], venue: string): number => {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const w = weightOf(r);
    den += w;
    if (r.venue === venue) num += w;
  }
  return den === 0 ? 0 : num / den;
};

console.log(`${NEWLINE}================ §2b MIX OR EFFECT ================`);
console.log('T0 on the trigger own mints reproduces the trigger mean exactly: Phase B triggers');
console.log('select WHICH mint, not when, so there is no within-mint contrast. The baseline is');
console.log('T0 over the read population, reweighted 6.0x for the sampled T0-only mints.');
console.log(
  `${NEWLINE}${'trig'.padEnd(6)}${'venues'.padStart(7)}${'mean(trig)'.padStart(12)}${'mean(T0)'.padStart(11)}` +
    `${'total'.padStart(11)}${'venue mix'.padStart(12)}${'within'.padStart(11)}${'rest'.padStart(10)}` +
    `${'mix share'.padStart(11)}`,
);
const baseline = classified.filter((c) => c.trigger === 'T0' && c.venue !== UNREAD);
const decomposition: Record<string, unknown>[] = [];
for (const trigger of TRIGGERS) {
  if (trigger === 'T0') continue;
  const trig = classified.filter((c) => c.trigger === trigger && c.venue !== UNREAD);
  if (trig.filter((c) => c.grossReturn !== null).length === 0) continue;
  const shared = [...new Set(trig.map((c) => c.venue))].filter(
    (v) =>
      baseline.some((b) => b.venue === v && b.grossReturn !== null) &&
      trig.some((t) => t.venue === v && t.grossReturn !== null),
  );
  let mix = 0;
  let within = 0;
  for (const v of shared) {
    const m0 = wMean(baseline.filter((b) => b.venue === v));
    const m1 = wMean(trig.filter((t) => t.venue === v));
    if (m0 === null || m1 === null) continue;
    mix += (wShare(trig, v) - wShare(baseline, v)) * m0;
    within += wShare(trig, v) * (m1 - m0);
  }
  const mTrig = wMean(trig) ?? 0;
  const mBase = wMean(baseline) ?? 0;
  const total = mTrig - mBase;
  const row = {
    trigger,
    venuesShared: shared.length,
    meanTrigger: mTrig,
    meanBaselineReweighted: mBase,
    total,
    mix,
    within,
    rest: total - mix - within,
    mixShareOfExplained:
      Math.abs(mix) + Math.abs(within) === 0 ? null : Math.abs(mix) / (Math.abs(mix) + Math.abs(within)),
  };
  decomposition.push(row);
  console.log(
    `${trigger.padEnd(6)}${String(shared.length).padStart(7)}${pct(mTrig).padStart(12)}` +
      `${pct(mBase).padStart(11)}${pct(total).padStart(11)}${pct(mix).padStart(12)}` +
      `${pct(within).padStart(11)}${pct(row.rest).padStart(10)}${pct(row.mixShareOfExplained).padStart(11)}`,
  );
}

// ---------------------------------------------------------------------------
// 4c — TWO CROSS-CHECKS THAT DO NOT DEPEND ON ANY OF THE ABOVE
// ---------------------------------------------------------------------------

const PUMP_CURVE = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const curveMinted = readConditional.filter((c) => c.origin === PUMP_CURVE);
console.log(`${NEWLINE}================ CROSS-CHECKS ================`);
console.log(
  `PR #64 found 999 of 5,598 conditional positions on a pump.fun curve, by membership in` +
    `${NEWLINE}pumpdotfun_solana.pump_evt_tradeevent. This phase finds ${curveMinted.length} by a different route` +
    `${NEWLINE}entirely — the program that executed the mint action in tokens_solana.transfers.` +
    `${NEWLINE}Agreement: ${((Math.min(curveMinted.length, 999) / Math.max(curveMinted.length, 999)) * 100).toFixed(1)}%.`,
);
const t2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const t2022Positions = readConditional.filter((c) => c.origin === t2022);
console.log(
  `${NEWLINE}Of the ${t2022Positions.length} positions whose token was minted by Token-2022, ` +
    `${t2022Positions.filter((c) => !c.migratedAtEntry).length} are labelled` +
    `${NEWLINE}pre-migration by Phase B. There was no migration to see: the token was never on a curve.`,
);

// ---------------------------------------------------------------------------
// 5 — §3: THE DISCOVERY-ARTIFACT CHECK
// ---------------------------------------------------------------------------

console.log(`${NEWLINE}================ §3 THIN-DATA DIAGNOSTICS ================`);
console.log(
  `${'venue'.padEnd(30)}${'mints'.padStart(7)}${'med trades/mint'.padStart(17)}` +
    `${'med traders/mint'.padStart(18)}${'same-trade'.padStart(12)}${'verdict'.padStart(10)}`,
);
for (const r of primary) {
  const v = thinVerdict({
    medianTradesPerMint: r.medianTradesPerMint,
    medianTradersPerMint: r.medianTradersPerMint,
    sameTradeFraction: r.sameTradeFraction,
  });
  console.log(
    `${(r.name ?? r.venue.slice(0, 28)).padEnd(30)}${String(r.nMints).padStart(7)}` +
      `${fmt(r.medianTradesPerMint, 1).padStart(17)}${fmt(r.medianTradersPerMint, 1).padStart(18)}` +
      `${pct(r.sameTradeFraction).padStart(12)}${(v.thin ? 'THIN' : 'not thin').padStart(10)}`,
  );
  if (v.thin) for (const why of v.reasons) console.log(`      ${why}`);
}

/*
   CONCENTRATION. A venue can carry most of the summed return and still not be about
   anything, if one mint carries most of the venue. §3 asks whether the figure is about
   anything nameable; this is the same question asked of the mints rather than the venues,
   and it is free to ask.
*/
console.log(`${NEWLINE}================ §3b HOW MANY MINTS IS THE FIGURE MADE OF ================`);
/*
   Shares are of the venue's ABSOLUTE summed return, not its signed sum. A venue whose
   positives and negatives nearly cancel has a signed sum near zero, and a share of a
   number near zero is a number over 100% that means nothing — the first run of this block
   printed 1580% for exactly that reason.
*/
console.log('shares are of the ABSOLUTE summed return, so a venue that nearly cancels still reads.');
console.log(
  `${NEWLINE}${'venue'.padEnd(30)}${'priced'.padStart(7)}${'mints priced'.padStart(13)}` +
    `${'signed sum'.padStart(12)}${'top mint'.padStart(10)}${'top 3'.padStart(9)}${'top 10'.padStart(9)}`,
);
const concentration: Record<string, unknown>[] = [];
for (const r of primary.slice(0, 6)) {
  const rows = readConditional.filter((c) => c.venue === r.venue && c.grossReturn !== null);
  const byMint = new Map<string, number>();
  for (const c of rows) byMint.set(c.mint, (byMint.get(c.mint) ?? 0) + (c.grossReturn as number));
  const signed = [...byMint.values()].reduce((a, b) => a + b, 0);
  const sorted = [...byMint.values()].sort((a, b) => Math.abs(b) - Math.abs(a));
  const absTotal = sorted.reduce((a, b) => a + Math.abs(b), 0);
  const share = (k: number): number =>
    absTotal === 0 ? Number.NaN : sorted.slice(0, k).reduce((a, b) => a + Math.abs(b), 0) / absTotal;
  concentration.push({
    venue: r.venue,
    name: r.name,
    nPriced: rows.length,
    mintsPriced: byMint.size,
    signedSum: signed,
    absTop1: share(1),
    absTop3: share(3),
    absTop10: share(10),
  });
  console.log(
    `${(r.name ?? r.venue.slice(0, 28)).padEnd(30)}${String(rows.length).padStart(7)}` +
      `${String(byMint.size).padStart(13)}${fmt(signed, 2).padStart(12)}${pct(share(1)).padStart(10)}` +
      `${pct(share(3)).padStart(9)}${pct(share(10)).padStart(9)}`,
  );
}

const top = primary[0];
if (top === undefined) throw new Error('no venue rows: the reads produced nothing');
const verdict = thinVerdict({
  medianTradesPerMint: top.medianTradesPerMint,
  medianTradersPerMint: top.medianTradersPerMint,
  sameTradeFraction: top.sameTradeFraction,
});
const state = stateOf({
  topShareOfSummedReturn: top.shareSummedReturn,
  topIsNamed: top.name !== null,
  topThin: verdict,
});

console.log(`${NEWLINE}================ FINAL STATE ================`);
console.log(`largest single venue by summed return: ${top.name ?? top.venue} (${pct(top.shareSummedReturn)})`);
console.log(`${state.state}: ${state.why}`);

// ---------------------------------------------------------------------------
// 6 — ARTIFACTS
// ---------------------------------------------------------------------------

const ledger: string[] = [
  'trigger,venue_program,venue_name,kind,n,n_mints,n_days,as_reported_n,as_reported_mean,as_reported_lower,' +
    'as_reported_upper,carry_forward_n,carry_forward_mean,carry_forward_lower,carry_forward_upper,' +
    'residual_at_zero_mean,residual_lower,residual_upper,censored_fraction,cost_floor,cost_floor_pct,' +
    'cost_floor_note,median_trades_per_mint,median_traders_per_mint,same_trade_fraction',
];
for (const c of cells) {
  ledger.push(
    [
      c.trigger,
      c.venue,
      (c.venueName ?? '').replace(/,/g, ' '),
      kindOf(c.venue),
      c.n,
      c.nMints,
      c.nDays,
      c.asReportedN,
      c.asReported ?? '',
      c.asReportedLower,
      c.asReportedUpper,
      c.carryForwardN,
      c.carryForward ?? '',
      c.carryForwardLower,
      c.carryForwardUpper,
      c.residualAtZero ?? '',
      c.residualLower,
      c.residualUpper,
      c.censoredFraction,
      c.costFloor,
      c.costFloorPct ?? '',
      c.costFloorNote.replace(/,/g, ' '),
      c.medianTradesPerMint,
      c.medianTradersPerMint,
      c.sameTradeFraction,
    ].join(','),
  );
}
writeFileSync('docs/PHASE_H_CELL_LEDGER.csv', ledger.join(NEWLINE) + NEWLINE);

/*
   THE PER-MINT CLASSIFICATION, as a compact CSV.

   The two Dune results this phase rests on are 89 MB and 37 MB, which is not a thing to
   put in a repository. They are regenerable — the SQL is committed under
   ops/dune/generated/ and the execution IDs are in the report — at a measured cost of
   30.96 and 99.60 credits. What a later reader actually needs is this: one row per mint
   with the program that minted it, the program it traded on, and how much trading its
   own holding window contained. That is 8,181 rows and about half a megabyte.
*/
const perMint: string[] = [
  'mint,fired_conditional,origin_program,origin_name,venue_program,venue_name,venue_kind,' +
    'pool_venue_program,curated_dex_has_rows,signers_holdout,tx_holdout,moves_before_holdout',
];
const seenMint = new Set<string>();
for (const c of classified) {
  if (c.venue === UNREAD || seenMint.has(c.mint)) continue;
  seenMint.add(c.mint);
  perMint.push(
    [
      c.mint,
      CONDITIONAL_MINTS.has(c.mint),
      c.origin ?? '',
      c.origin === null ? '' : (programFact(c.origin).name ?? ''),
      c.venue,
      programFact(c.venue).name ?? '',
      kindOf(c.venue),
      c.poolVenue,
      seenByQ16.has(c.mint),
      signersOf.get(c.mint) ?? '',
      txHoldoutOf.get(c.mint) ?? '',
      movedBefore.get(c.mint) ?? '',
    ].join(','),
  );
}
writeFileSync('artifacts/phase-h-mint-venues.csv', perMint.join(NEWLINE) + NEWLINE);

writeFileSync(
  'artifacts/phase-h-venue.json',
  `${JSON.stringify(
    {
      generatedBy: 'pnpm venue:classify',
      preregistered: ['MT097', 'MT098'],
      reads: {
        q17Conditional: 'ops/dune/results/q17-program-conditional.json',
        q17Baseline1of6: 'ops/dune/results/q17-program-baseline-1.json',
        q16Conditional: 'ops/dune/results/q16-venue-conditional.json',
      },
      coverage: {
        positions: positions.length,
        conditionalPositions: conditional.length,
        conditionalWithTransfersRead: readConditional.length,
        mintsReadByTransfers: readByQ17.size,
        mintsSeenByCuratedDex: seenByQ16.size,
        conditionalMintsMissingFromCuratedDex: [...new Set(conditional.map((c) => c.mint))].filter(
          (m) => readByQ17.has(m) && !seenByQ16.has(m),
        ).length,
      },
      classification: primary,
      classificationExcludingInfrastructure: refined,
      origin: originRows,
      cells,
      decomposition,
      concentration,
      state,
      topVenue: top,
      thinVerdict: verdict,
    },
    null,
    2,
  )}${NEWLINE}`,
);
console.log(
  `${NEWLINE}wrote artifacts/phase-h-venue.json, artifacts/phase-h-mint-venues.csv and ` +
    'docs/PHASE_H_CELL_LEDGER.csv',
);
