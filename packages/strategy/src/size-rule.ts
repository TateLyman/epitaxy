/**
 * P7 — SIZE IS A RULE, NOT A CONSTANT.
 *
 * The collector opened every trajectory at a flat 0.02 SOL. On a shallow pool
 * that notional is an absurd fraction of the reserve, so the depth gate refused
 * — correctly — and the candidate was lost. But the refusal was about the
 * ARBITRARY RESEARCH NOTIONAL, not about the token: a 0.0025 SOL position in
 * the same pool would have been perfectly ordinary.
 *
 * Every one of those refusals removed a real market observation from the corpus
 * for a reason that had nothing to do with the market.
 *
 * The goal is emphatically NOT to lower the safety standards. Every bound below
 * is the same bound the fixed notional had to clear. The change is that the
 * rule now asks "what size fits this pool?" instead of "does this pool fit my
 * number?".
 *
 * ---
 *
 * OUTCOME-BLIND, AND STRUCTURALLY SO
 *
 * `chooseSize` takes no return, no mark, no PnL, and no future state — the type
 * makes that a compile-time property rather than a promise. It sees one
 * coherent snapshot and a set of mechanical bounds. A rule that could see the
 * outcome would pick the size that made the outcome look best, and there is no
 * amount of discipline that reliably prevents that once the data is in scope.
 *
 * All four candidate sizes are evaluated and ALL FOUR are persisted with the
 * condition that bound them. Storing only the winner makes the rule
 * unfalsifiable: nobody could tell afterwards whether a refusal was a shallow
 * pool or a bad rule.
 */

/** Frozen. Registered in docs/MULTIPLE_TESTING_LEDGER.csv before the window. */
export const CANDIDATE_SIZES_LAMPORTS: readonly bigint[] = [
  2_500_000n, // 0.0025 SOL
  5_000_000n, // 0.005
  10_000_000n, // 0.01
  20_000_000n, // 0.02  — the previous fixed notional, now the ceiling
];

export interface SizeBounds {
  /** Position as a share of the effective quote reserve, in basis points. */
  readonly maxReserveShareBps: number;
  /** Local immediate price impact of the entry, in basis points. */
  readonly maxPriceImpactBps: number;
  /** Bounded-counterfactual entry impact, when bounded mode is in use. */
  readonly maxCounterfactualImpactBps: number;
  /** Warm recurring round-trip mechanics drag, in basis points. */
  readonly maxRoundTripDragBps: number;
}

/**
 * Frozen bounds.
 *
 * These are the SAME limits the fixed notional was already required to clear —
 * this phase moved the size, not the safety. Raising any of them would be a
 * reviewed change to a risk cap, which this directive explicitly does not
 * authorise.
 */
export const FROZEN_SIZE_BOUNDS: SizeBounds = {
  maxReserveShareBps: 50,
  maxPriceImpactBps: 50,
  maxCounterfactualImpactBps: 10,
  maxRoundTripDragBps: 400,
};

/**
 * The mechanics of ONE candidate size, measured from one coherent snapshot.
 *
 * Every field nullable: a quantity that could not be computed is not a
 * quantity that passed. `mechanicsComplete` is separate from the numbers
 * because a size whose entry simulated and whose exit did not is not a size
 * with a good impact figure — it is a size we cannot leave.
 */
export interface SizeMechanics {
  readonly candidateLamports: bigint;
  readonly mechanicsComplete: boolean;
  readonly reserveShareBps: number | null;
  readonly priceImpactBps: number | null;
  readonly counterfactualImpactBps: number | null;
  readonly roundTripDragBps: number | null;
  /** Whether the pool held enough token/reserve to fill both legs at all. */
  readonly capacitySufficient: boolean;
}

export type BindingCondition =
  | 'MECHANICS_INCOMPLETE'
  | 'RESERVE_SHARE'
  | 'PRICE_IMPACT'
  | 'COUNTERFACTUAL_IMPACT'
  | 'ROUND_TRIP_DRAG'
  | 'CAPACITY'
  | 'UNMEASURED';

export interface SizeEvaluation {
  readonly candidateLamports: bigint;
  readonly admissible: boolean;
  /** Null when admissible; otherwise the FIRST condition that refused. */
  readonly boundBy: BindingCondition | null;
  readonly mechanics: SizeMechanics;
}

export interface SizeChoice {
  readonly chosenLamports: bigint | null;
  readonly evaluations: readonly SizeEvaluation[];
  /** Why nothing was chosen, when nothing was. */
  readonly refusal: string | null;
}

/**
 * Evaluate one size against the frozen bounds.
 *
 * An UNMEASURED bound refuses. That is the repository's fail-closed rule: a
 * price impact that could not be computed is not a small one, and the size that
 * would benefit most from that misreading is the largest.
 */
export function evaluateSize(m: SizeMechanics, bounds: SizeBounds = FROZEN_SIZE_BOUNDS): SizeEvaluation {
  const refuse = (boundBy: BindingCondition): SizeEvaluation => ({
    candidateLamports: m.candidateLamports,
    admissible: false,
    boundBy,
    mechanics: m,
  });

  if (!m.mechanicsComplete) return refuse('MECHANICS_INCOMPLETE');
  if (!m.capacitySufficient) return refuse('CAPACITY');
  if (m.reserveShareBps === null) return refuse('UNMEASURED');
  if (m.reserveShareBps > bounds.maxReserveShareBps) return refuse('RESERVE_SHARE');
  if (m.priceImpactBps === null) return refuse('UNMEASURED');
  if (m.priceImpactBps > bounds.maxPriceImpactBps) return refuse('PRICE_IMPACT');
  if (m.counterfactualImpactBps === null) return refuse('UNMEASURED');
  if (m.counterfactualImpactBps > bounds.maxCounterfactualImpactBps) return refuse('COUNTERFACTUAL_IMPACT');
  if (m.roundTripDragBps === null) return refuse('UNMEASURED');
  if (m.roundTripDragBps > bounds.maxRoundTripDragBps) return refuse('ROUND_TRIP_DRAG');

  return { candidateLamports: m.candidateLamports, admissible: true, boundBy: null, mechanics: m };
}

/**
 * The LARGEST admissible size, or none.
 *
 * Largest rather than smallest because the research position should be as close
 * as it can be to something a real wallet would take: an 0.0025 SOL position
 * whose costs are dominated by base fees measures the fee schedule, not the
 * market. The bounds are what keep "largest" honest.
 *
 * Takes `readonly SizeMechanics[]` and nothing else. There is deliberately no
 * parameter through which an outcome could arrive.
 */
export function chooseSize(
  candidates: readonly SizeMechanics[],
  bounds: SizeBounds = FROZEN_SIZE_BOUNDS,
): SizeChoice {
  const evaluations = candidates
    .map((m) => evaluateSize(m, bounds))
    .sort((a, b) => (a.candidateLamports < b.candidateLamports ? -1 : a.candidateLamports > b.candidateLamports ? 1 : 0));

  const admissible = evaluations.filter((e) => e.admissible);
  if (admissible.length === 0) {
    const smallest = evaluations[0];
    return {
      chosenLamports: null,
      evaluations,
      refusal:
        smallest === undefined
          ? 'no candidate size was evaluated'
          : `even ${smallest.candidateLamports} lamports was refused by ${smallest.boundBy}`,
    };
  }

  const chosen = admissible[admissible.length - 1] as SizeEvaluation;
  return {
    chosenLamports: chosen.candidateLamports,
    evaluations: evaluations.map((e) =>
      e.candidateLamports === chosen.candidateLamports ? { ...e } : e,
    ),
    refusal: null,
  };
}

/**
 * P7 — cold versus recurring economics, kept apart.
 *
 * A real production wallet pays global setup ONCE. Charging it to every
 * hypothetical trajectory makes every trajectory look worse than the strategy
 * is, and a research corpus that systematically understates its own returns is
 * as wrong as one that overstates them — it kills arms that work.
 *
 * The opposite error is worse and more tempting: ignoring setup entirely, so
 * the canary's first day arrives with an unbudgeted cost. The canary startup
 * budget pays it once, and these four classes are what keep the two facts
 * separable.
 */
export type SetupClass = 'FIRST_EVER_WALLET_SETUP' | 'WARM_WALLET_GLOBAL' | 'NEW_MINT_RECURRING' | 'REPEAT_MINT';

export interface SetupEconomics {
  readonly setupClass: SetupClass;
  /** Paid once per wallet, ever. Never charged to a recurring trajectory. */
  readonly globalOneTimeLamports: bigint;
  /** Paid per new mint: the base ATA that this token needs and no other does. */
  readonly perMintLamports: bigint;
  /** Recovered when the base ATA is closed in the sell transaction. */
  readonly recoverableLamports: bigint;
}

export class SetupPoolingError extends Error {}

/**
 * Refuse to pool a first-ever setup with recurring economics.
 *
 * These are different populations and averaging them produces a number that
 * describes no wallet that will ever exist. The refusal is a throw rather than
 * a warning because the pooled average is not obviously wrong on inspection —
 * it just quietly biases every cost comparison in the corpus.
 */
export function pooledSetupCost(items: readonly SetupEconomics[]): bigint {
  const classes = new Set(items.map((i) => i.setupClass));
  if (classes.has('FIRST_EVER_WALLET_SETUP') && classes.size > 1) {
    throw new SetupPoolingError(
      'FIRST_EVER_WALLET_SETUP cannot be pooled with recurring economics: a global cost paid once is not a per-trajectory cost',
    );
  }
  return items.reduce((a, i) => a + i.globalOneTimeLamports + i.perMintLamports - i.recoverableLamports, 0n);
}
