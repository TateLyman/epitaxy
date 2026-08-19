/**
 * Phase H — venue of a position, resolved by program ID.
 *
 * PR #64 established that only 999 of 5,598 T1–T7 holdout positions are pump.fun
 * bonding-curve mints, and that on that subset T1's as-reported mean is −32.47% rather
 * than the +234.2% the branch is named for. The positive figures therefore belong to a
 * population that had never been identified. This module identifies it.
 *
 * TWO SOURCES, BECAUSE THE FIRST ONE LIED BY OMISSION. `dex_solana.trades` carries a
 * curated venue name and a program ID, and it had NO ROW AT ALL for 933 of the 2,056
 * conditional-trigger mints. On that split the entire positive return sat with the 933,
 * which looks like an answer until you check it: Jupiter's own stored snapshot fields
 * report a completed trade for 98.5% of those same mints, at a median of 106 distinct
 * traders in five minutes and $7,073 of liquidity. An absence from a curated table is a
 * fact about the curation. So venue is resolved from `tokens_solana.transfers`, which
 * curates nothing and names the program that executed every token movement, and the
 * curated table is kept only for naming and as a cross-check.
 *
 * WHAT THE EXECUTING PROGRAM IS, stated precisely because it is easy to overclaim. It is
 * the program of the OUTER instruction. Sent straight to an AMM it is the AMM. Routed
 * through an aggregator it is the AGGREGATOR, and the pool is one level below where the
 * transfers table reaches. So `assignVenue` reports the preregistered answer — the
 * program with the most transactions in the holding window, whatever kind of program
 * that is — and `assignVenueExcludingInfrastructure` reports the same rule restricted to
 * programs that can actually hold a pool. Both are reported. The first is what MT097
 * fixed before the query ran; the second is a refinement and is labelled as one.
 */

/** What a program is. `UNKNOWN` is a program no source has named, and it is reported by ID. */
export type ProgramKind = 'CURVE' | 'AMM' | 'LAUNCHPAD' | 'ROUTER' | 'TOKEN' | 'UNKNOWN';

export interface ProgramFact {
  readonly id: string;
  /** The name and its source. A program nobody named has a null name, never a guess. */
  readonly name: string | null;
  readonly kind: ProgramKind;
  /** Where the name comes from, so a reader can weigh it. */
  readonly source: 'dune_project' | 'solana_program_registry' | null;
}

/**
 * Programs named by a source, not by inference.
 *
 * The nine venue programs and their names come from `dex_solana.trades.project` and
 * `version_name` paired with `project_main_id` in the Phase H read — that is Dune's own
 * labelling of rows it decoded, observed in this corpus rather than looked up. The two
 * token programs and the Jupiter aggregator are fixed, publicly documented program IDs.
 * Every other program stays `UNKNOWN` and is reported by its ID with its counts, which
 * is what the directive asks for: an unrecognised program with meaningful volume is a
 * finding, not a residual.
 */
export const KNOWN_PROGRAMS: readonly ProgramFact[] = [
  { id: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', name: 'pump.fun bonding curve', kind: 'CURVE', source: 'dune_project' },
  { id: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', name: 'pumpswap', kind: 'AMM', source: 'dune_project' },
  { id: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', name: 'meteora cpamm', kind: 'AMM', source: 'dune_project' },
  { id: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', name: 'meteora dlmm', kind: 'AMM', source: 'dune_project' },
  { id: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', name: 'meteora amm', kind: 'AMM', source: 'dune_project' },
  { id: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', name: 'meteora dbc', kind: 'LAUNCHPAD', source: 'dune_project' },
  { id: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', name: 'raydium launchlab', kind: 'LAUNCHPAD', source: 'dune_project' },
  { id: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', name: 'raydium cpmm', kind: 'AMM', source: 'dune_project' },
  { id: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', name: 'raydium clmm', kind: 'AMM', source: 'dune_project' },
  { id: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', name: 'orca whirlpool', kind: 'AMM', source: 'dune_project' },
  { id: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', name: 'spl token', kind: 'TOKEN', source: 'solana_program_registry' },
  { id: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', name: 'token-2022', kind: 'TOKEN', source: 'solana_program_registry' },
  { id: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', name: 'jupiter aggregator v6', kind: 'ROUTER', source: 'solana_program_registry' },
];

const BY_ID = new Map(KNOWN_PROGRAMS.map((p) => [p.id, p]));

/** What we know about a program. Never invents a name. */
export function programFact(id: string): ProgramFact {
  return BY_ID.get(id) ?? { id, name: null, kind: 'UNKNOWN', source: null };
}

/** A program that can hold a pool. Token programs and routers cannot. */
export function canHoldAPool(kind: ProgramKind): boolean {
  return kind === 'CURVE' || kind === 'AMM' || kind === 'LAUNCHPAD' || kind === 'UNKNOWN';
}

/**
 * One (program, 5-minute bucket) row of activity for one mint.
 *
 * `firstS` and `lastS` are the first and last activity in the bucket, in epoch seconds,
 * so a bucket that straddles a window edge can be told from one that does not.
 */
export interface ActivityBucket {
  readonly program: string;
  readonly bucket: number;
  readonly nTx: number;
  readonly nMoves: number;
  readonly firstS: number;
  readonly lastS: number;
}

/** A half-open holding window in epoch seconds: entry exclusive of nothing, exit inclusive. */
export interface Window {
  readonly entryS: number;
  readonly exitS: number;
}

/** Does the bucket's activity range touch the window at all? */
export function bucketIntersects(b: ActivityBucket, w: Window): boolean {
  return b.lastS >= w.entryS && b.firstS <= w.exitS;
}

/** Is the bucket's activity range entirely inside the window? */
export function bucketContained(b: ActivityBucket, w: Window): boolean {
  return b.firstS >= w.entryS && b.lastS <= w.exitS;
}

export interface VenueAssignment {
  /** The winning program, or null when nothing at all touched the window. */
  readonly program: string | null;
  /** Transactions the winner had inside the window. */
  readonly nTx: number;
  /** Every program that touched the window, most active first. */
  readonly candidates: readonly { readonly program: string; readonly nTx: number; readonly nMoves: number }[];
  /** True when the top two programs tie on transactions AND on moves. */
  readonly tied: boolean;
  /** How the winner was chosen. */
  readonly basis: 'IN_WINDOW' | 'LAST_BEFORE_ENTRY' | 'FIRST_AFTER_EXIT' | 'NO_ACTIVITY';
}

const rank = (
  totals: Map<string, { nTx: number; nMoves: number }>,
): { readonly program: string; readonly nTx: number; readonly nMoves: number }[] =>
  [...totals.entries()]
    .map(([program, v]) => ({ program, nTx: v.nTx, nMoves: v.nMoves }))
    .sort((a, b) => b.nTx - a.nTx || b.nMoves - a.nMoves || (a.program < b.program ? -1 : 1));

const accumulate = (
  buckets: readonly ActivityBucket[],
  keep: (b: ActivityBucket) => boolean,
): Map<string, { nTx: number; nMoves: number }> => {
  const totals = new Map<string, { nTx: number; nMoves: number }>();
  for (const b of buckets) {
    if (!keep(b)) continue;
    const cur = totals.get(b.program) ?? { nTx: 0, nMoves: 0 };
    totals.set(b.program, { nTx: cur.nTx + b.nTx, nMoves: cur.nMoves + b.nMoves });
  }
  return totals;
};

/**
 * THE PREREGISTERED RULE, MT097, unchanged after seeing any result.
 *
 * The venue is the program with the most transactions in [entry, exit], ties broken by
 * moves and then by program ID so the answer never depends on row order. With nothing in
 * the window, fall back to the last activity at or before entry, then to the first
 * activity after exit. With nothing anywhere, the position is unresolved.
 */
export function assignVenue(
  buckets: readonly ActivityBucket[],
  w: Window,
  eligible: (program: string) => boolean = () => true,
): VenueAssignment {
  const usable = buckets.filter((b) => eligible(b.program));
  const inWindow = rank(accumulate(usable, (b) => bucketIntersects(b, w)));
  if (inWindow.length > 0) {
    const top = inWindow[0] as { program: string; nTx: number; nMoves: number };
    const second = inWindow[1];
    return {
      program: top.program,
      nTx: top.nTx,
      candidates: inWindow,
      tied: second !== undefined && second.nTx === top.nTx && second.nMoves === top.nMoves,
      basis: 'IN_WINDOW',
    };
  }
  const before = usable.filter((b) => b.lastS < w.entryS).sort((a, b) => b.lastS - a.lastS);
  const last = before[0];
  if (last !== undefined) {
    return { program: last.program, nTx: 0, candidates: [], tied: false, basis: 'LAST_BEFORE_ENTRY' };
  }
  const after = usable.filter((b) => b.firstS > w.exitS).sort((a, b) => a.firstS - b.firstS);
  const first = after[0];
  if (first !== undefined) {
    return { program: first.program, nTx: 0, candidates: [], tied: false, basis: 'FIRST_AFTER_EXIT' };
  }
  return { program: null, nTx: 0, candidates: [], tied: false, basis: 'NO_ACTIVITY' };
}

/**
 * The same rule restricted to programs that can hold a pool.
 *
 * A REFINEMENT, NOT THE PREREGISTERED RULE. Where a position's most active program is a
 * router or a token program, the preregistered answer names infrastructure rather than a
 * venue; this variant answers "which venue, then", and both are reported.
 */
export function assignVenueExcludingInfrastructure(
  buckets: readonly ActivityBucket[],
  w: Window,
): VenueAssignment {
  return assignVenue(buckets, w, (p) => canHoldAPool(programFact(p).kind));
}

export interface WindowActivity {
  /** Transactions in every bucket that touches the window. Generous by construction. */
  readonly nTxGenerous: number;
  /** Transactions only in buckets wholly inside the window. Conservative. */
  readonly nTxStrict: number;
  /**
   * True when NO activity touches the open interval after entry, so the entry and exit
   * price can only have come from the same trade. Exact in the direction that matters:
   * it is claimed only when not one bucket intersects.
   */
  readonly sameTradeCertain: boolean;
}

/**
 * How much trading a position's own window actually contains.
 *
 * The generous count is the one the thin-data test uses. A test that calls a population
 * thin even when its trades are over-counted has established thinness robustly; the
 * reverse — declaring a population thick on an over-count — is the mistake.
 */
export function windowActivity(buckets: readonly ActivityBucket[], w: Window): WindowActivity {
  let generous = 0;
  let strict = 0;
  let touchesAfterEntry = false;
  for (const b of buckets) {
    if (bucketIntersects(b, w)) {
      generous += b.nTx;
      if (bucketContained(b, w)) strict += b.nTx;
    }
    if (b.lastS > w.entryS && b.firstS <= w.exitS) touchesAfterEntry = true;
  }
  return { nTxGenerous: generous, nTxStrict: strict, sameTradeCertain: !touchesAfterEntry };
}

/** MT098's bar, fixed before the first query ran. */
export const THIN_MEDIAN_TRADES = 3;
export const THIN_MEDIAN_TRADERS = 3;
export const THIN_SAME_TRADE_FRACTION = 0.5;

export interface ThinInput {
  readonly medianTradesPerMint: number;
  readonly medianTradersPerMint: number;
  readonly sameTradeFraction: number;
}

export interface ThinVerdict {
  readonly thin: boolean;
  /** Every clause that fired, so the verdict is never a bare boolean. */
  readonly reasons: readonly string[];
}

/**
 * THE PREREGISTERED THIN-DATA BAR, MT098.
 *
 * Thin if the median trades per mint over the holding period is at most 3, OR the median
 * distinct traders per mint is at most 3, OR at least half the positions take entry and
 * exit price from the same trade. The first two bars come from the directive's own prose
 * — two or three trades per mint is named there as the failure. The third is mine and is
 * recorded as mine in the ledger.
 */
export function thinVerdict(input: ThinInput): ThinVerdict {
  const reasons: string[] = [];
  if (input.medianTradesPerMint <= THIN_MEDIAN_TRADES) {
    reasons.push(`median trades per mint ${input.medianTradesPerMint} <= ${THIN_MEDIAN_TRADES}`);
  }
  if (input.medianTradersPerMint <= THIN_MEDIAN_TRADERS) {
    reasons.push(`median traders per mint ${input.medianTradersPerMint} <= ${THIN_MEDIAN_TRADERS}`);
  }
  if (input.sameTradeFraction >= THIN_SAME_TRADE_FRACTION) {
    reasons.push(
      `${(input.sameTradeFraction * 100).toFixed(1)}% of positions price both legs off one trade ` +
        `>= ${THIN_SAME_TRADE_FRACTION * 100}%`,
    );
  }
  return { thin: reasons.length > 0, reasons };
}

/** The share of summed return above which one venue is said to carry the figure. */
export const CONCENTRATION_MAJORITY = 0.5;

export type PhaseHState = 'VENUE_LOCATED' | 'DISCOVERY_ARTIFACT' | 'DIFFUSE_NO_VENUE';

export interface StateInput {
  /** Share of the summed return held by the single largest venue. */
  readonly topShareOfSummedReturn: number;
  /** Whether that venue is a named program rather than an unnamed one. */
  readonly topIsNamed: boolean;
  /** The thin-data verdict for that venue. */
  readonly topThin: ThinVerdict;
}

export interface StateOutcome {
  readonly state: PhaseHState;
  readonly why: string;
}

/**
 * The three states are mutually exclusive and one must be chosen. Order matters and was
 * fixed in MT098: thinness is tested first, because a concentrated figure computed from
 * three trades per mint is an artifact whether or not it concentrates.
 */
export function stateOf(input: StateInput): StateOutcome {
  if (input.topThin.thin) {
    return {
      state: 'DISCOVERY_ARTIFACT',
      why: `the venue carrying ${(input.topShareOfSummedReturn * 100).toFixed(1)}% of the summed return is thin: ${input.topThin.reasons.join('; ')}`,
    };
  }
  if (input.topShareOfSummedReturn > CONCENTRATION_MAJORITY) {
    return {
      state: 'VENUE_LOCATED',
      why:
        `one ${input.topIsNamed ? 'named' : 'unnamed but identified'} program carries ` +
        `${(input.topShareOfSummedReturn * 100).toFixed(1)}% of the summed return on non-thin data`,
    };
  }
  return {
    state: 'DIFFUSE_NO_VENUE',
    why: `the largest single venue carries only ${(input.topShareOfSummedReturn * 100).toFixed(1)}% of the summed return`,
  };
}

/** The two venues whose fee schedule this programme has decoded. Everything else is UNKNOWN. */
export const DECODED_FEE_VENUES: Readonly<Record<string, string>> = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'FLAT_2_50_PCT',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PUMPSWAP_TIER_SCHEDULE',
};

/**
 * The applicable cost floor for a venue, or the string `UNKNOWN`.
 *
 * §4 of the directive forbids inventing a floor for a venue whose fee schedule has not
 * been decoded, and forbids omitting it so that a gross figure reads as net. `UNKNOWN` is
 * the correct output for every venue but two, and it is never defaulted to a neighbour's
 * number.
 */
export function costFloorKind(program: string | null): string {
  if (program === null) return 'UNKNOWN';
  return DECODED_FEE_VENUES[program] ?? 'UNKNOWN';
}
