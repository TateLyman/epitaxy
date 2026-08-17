import type { Db } from '../../storage/src/db.js';
import { expectRows } from '../../storage/src/evidence-repo.js';

/**
 * P8 — VALID COUNTERFACTUAL FUTURE PATHS.
 *
 * A hypothetical entry did not happen on mainnet. The pool that exists fifteen
 * minutes later never contained our 0.02 SOL, so a later mainnet quote is not
 * an exact future exit for a position that was never taken.
 *
 * The 8f73cef audit's M-1/M-2:
 *
 *     evidence grades in the corpus:  SIMULATED_EXECUTION = 292
 *     BOUNDED_COUNTERFACTUAL = 0      FULL_EVENT_REPLAY = 0
 *     545 policy outcomes rest on later mainnet quotes with NO contract
 *
 * and worse: the haircut columns on those rows came from the ENTRY impact
 * bound, not from any contract over the exit. The gross delta the tournament
 * reports is built entirely from marks that carry no grade saying what they are.
 *
 * Two admissible classes, and nothing else:
 *
 *   BOUNDED_COUNTERFACTUAL_V1   fast, development-only, valid only at or under
 *                               a frozen impact bound, with a frozen
 *                               conservative haircut
 *   RESERVE_DELTA_REPLAY_V1     exact: every confirmed pool-touching
 *                               transaction between entry and mark, applied in
 *                               order to the local post-entry state
 *
 * `SIMULATED_EXECUTION` is NEVER admissible for a holding-period outcome. It
 * describes the immediate mechanics — the buy and the sell in one runtime
 * instant — which is a real and useful measurement of something else.
 */

export const COUNTERFACTUAL_CONTRACT_VERSION = 'counterfactual-v1';

/**
 * FROZEN BEFORE OUTCOMES. 10 bps, per the directive.
 *
 * Above this, our own entry moved the pool enough that the later state is not
 * approximately the state our position would have faced, and no haircut makes
 * it so. The row is refused rather than haircut harder: a bound that stretches
 * to cover any impact is not a bound.
 */
export const BOUNDED_IMPACT_CAP_BPS = 10;

/**
 * FROZEN BEFORE OUTCOMES.
 *
 * The adverse adjustment applied to the later reserves before the
 * counterfactual exit is priced. It is deliberately conservative in ONE
 * direction: it can only make the exit worse. A haircut that could flatter an
 * exit is not a haircut, it is a free parameter.
 *
 * It is not calibrated yet, which is why rows carrying it are graded
 * DEVELOPMENT. `pnpm counterfactual:calibrate` compares it against
 * RESERVE_DELTA_REPLAY_V1 and refuses to promote it if it is not conservative.
 */
export const HAIRCUT_FORMULA = 'adverse_reserve_displacement_v1';
export const HAIRCUT_FLOOR_BPS = 25;

export type EvidenceClass = 'BOUNDED_COUNTERFACTUAL_V1' | 'RESERVE_DELTA_REPLAY_V1';

export class CounterfactualRefused extends Error {
  constructor(
    readonly code: 'IMPACT_ABOVE_BOUND' | 'NO_CONTRACT' | 'STATE_UNKNOWN' | 'NOT_CALIBRATED',
    reason: string,
  ) {
    super(reason);
    this.name = 'CounterfactualRefused';
  }
}

export interface BoundedCounterfactualInput {
  readonly trajectoryId: string;
  readonly offsetMs: number;
  /** OUR post-entry local pool state — the displacement the entry actually made. */
  readonly postEntryBaseReserve: bigint;
  readonly postEntryQuoteReserve: bigint;
  /** The real mainnet pool state at the mark. */
  readonly observedBaseReserve: bigint;
  readonly observedQuoteReserve: bigint;
  /** The tokens the entry acquired, which the counterfactual exit would sell. */
  readonly tokensHeldAtoms: bigint;
  /** Our entry's measured impact on the pool, in bps. */
  readonly entryImpactBps: number;
  readonly nowMs: number;
}

export interface BoundedCounterfactual {
  readonly evidenceClass: 'BOUNDED_COUNTERFACTUAL_V1';
  readonly contractVersion: string;
  readonly adjustedBaseReserve: bigint;
  readonly adjustedQuoteReserve: bigint;
  readonly haircutFormula: string;
  readonly haircutBps: number;
  readonly haircutLamports: bigint;
  readonly counterfactualExitLamports: bigint;
  readonly evidenceGrade: 'DEVELOPMENT';
  readonly refusal: null;
}

/** Constant-product output, with the pool's own rounding (floor). */
function constantProductOut(inAtoms: bigint, inReserve: bigint, outReserve: bigint): bigint {
  if (inAtoms <= 0n || inReserve <= 0n || outReserve <= 0n) return 0n;
  return (inAtoms * outReserve) / (inReserve + inAtoms);
}

/**
 * P8.2 — bounded mode, admissible only at or under the frozen impact cap.
 *
 * The construction:
 *
 *  1. take the real mainnet reserves at the mark;
 *  2. apply OUR entry's displacement to them — the pool our position would have
 *     faced had it existed contains our base and our quote;
 *  3. adjust adversely by the frozen haircut;
 *  4. price the exit against that.
 *
 * Step 2 is what makes this a counterfactual rather than a quote. Step 3 is
 * what makes it conservative. Neither is optional, and step 3's parameter was
 * frozen before any outcome was observed.
 */
export function boundedCounterfactual(input: BoundedCounterfactualInput): BoundedCounterfactual {
  if (input.entryImpactBps > BOUNDED_IMPACT_CAP_BPS) {
    throw new CounterfactualRefused(
      'IMPACT_ABOVE_BOUND',
      `the entry moved the pool ${input.entryImpactBps} bps, over the frozen bound of ` +
        `${BOUNDED_IMPACT_CAP_BPS} bps. Above the bound the later state is not approximately the state ` +
        'this position would have faced, and no haircut makes it so.',
    );
  }
  if (input.observedBaseReserve <= 0n || input.observedQuoteReserve <= 0n) {
    throw new CounterfactualRefused(
      'STATE_UNKNOWN',
      'the observed pool reserves at the mark are not positive, so nothing can be priced against them',
    );
  }

  // 2 — our displacement, carried onto the later real state.
  const ourBaseAdded = input.postEntryBaseReserve;
  const ourQuoteAdded = input.postEntryQuoteReserve;
  const withUsBase = input.observedBaseReserve + ourBaseAdded;
  const withUsQuote = input.observedQuoteReserve + ourQuoteAdded;

  // 3 — adverse adjustment: LESS quote available, MORE base to push through.
  // Both directions make the exit worse, which is the only direction a
  // conservative bound may move.
  const haircutBps = HAIRCUT_FLOOR_BPS;
  const adjustedQuote = (withUsQuote * BigInt(10_000 - haircutBps)) / 10_000n;
  const adjustedBase = (withUsBase * BigInt(10_000 + haircutBps)) / 10_000n;

  // 4 — price the exit.
  const unhaircut = constantProductOut(input.tokensHeldAtoms, withUsBase, withUsQuote);
  const exit = constantProductOut(input.tokensHeldAtoms, adjustedBase, adjustedQuote);

  return {
    evidenceClass: 'BOUNDED_COUNTERFACTUAL_V1',
    contractVersion: COUNTERFACTUAL_CONTRACT_VERSION,
    adjustedBaseReserve: adjustedBase,
    adjustedQuoteReserve: adjustedQuote,
    haircutFormula: HAIRCUT_FORMULA,
    haircutBps,
    haircutLamports: unhaircut > exit ? unhaircut - exit : 0n,
    counterfactualExitLamports: exit,
    /**
     * DEVELOPMENT until `pnpm counterfactual:calibrate` shows the bound is
     * conservative against replay. It cannot be promoted by assertion, and a
     * grade is not a plan to calibrate later.
     */
    evidenceGrade: 'DEVELOPMENT',
    refusal: null,
  };
}

/** One confirmed pool-touching transaction between entry and mark. */
export interface PoolEvent {
  readonly signature: string;
  readonly slot: number;
  readonly baseVaultDelta: bigint;
  readonly quoteVaultDelta: bigint;
}

export interface ReplayedCounterfactual {
  readonly evidenceClass: 'RESERVE_DELTA_REPLAY_V1';
  readonly contractVersion: string;
  readonly finalBaseReserve: bigint;
  readonly finalQuoteReserve: bigint;
  readonly eventsApplied: number;
  readonly counterfactualExitLamports: bigint;
}

/**
 * P8.3 — the exact construction, for the calibration subset.
 *
 * Every confirmed PumpSwap transaction that touched the pool between entry and
 * mark, with its vault deltas read from transaction metadata, applied IN ORDER
 * to the local post-entry state. That state contains our entry, so what comes
 * out the other end is the pool our position would actually have faced.
 *
 * Expensive — it needs every intervening signature — which is why it is a
 * calibration subset rather than the routine path. Its job is to tell us
 * whether the cheap bounded contract is conservative.
 */
export function replayCounterfactual(p: {
  readonly postEntryBaseReserve: bigint;
  readonly postEntryQuoteReserve: bigint;
  readonly events: readonly PoolEvent[];
  readonly tokensHeldAtoms: bigint;
}): ReplayedCounterfactual {
  let base = p.postEntryBaseReserve;
  let quote = p.postEntryQuoteReserve;
  const ordered = [...p.events].sort((a, b) => a.slot - b.slot);
  for (const e of ordered) {
    base += e.baseVaultDelta;
    quote += e.quoteVaultDelta;
    if (base < 0n) base = 0n;
    if (quote < 0n) quote = 0n;
  }
  return {
    evidenceClass: 'RESERVE_DELTA_REPLAY_V1',
    contractVersion: COUNTERFACTUAL_CONTRACT_VERSION,
    finalBaseReserve: base,
    finalQuoteReserve: quote,
    eventsApplied: ordered.length,
    counterfactualExitLamports: constantProductOut(p.tokensHeldAtoms, base, quote),
  };
}

/** FROZEN BEFORE OUTCOMES. */
export const CALIBRATION_TOLERANCE_BPS = 200;

export interface CalibrationResult {
  readonly boundedExitLamports: bigint;
  readonly replayExitLamports: bigint;
  readonly errorLamports: bigint;
  readonly errorBps: number;
  readonly toleranceBps: number;
  /** The bound must be CONSERVATIVE: bounded <= replay. */
  readonly conservative: boolean;
  readonly withinTolerance: boolean;
}

/**
 * P8.3 — is the bounded contract conservative, and by how much?
 *
 * `conservative` is the gate, not `withinTolerance`. A bound that is far below
 * the replayed value is merely pessimistic, which costs opportunity and cannot
 * manufacture edge. A bound ABOVE the replayed value is optimistic, and every
 * row carrying it overstates the exit — which is the failure mode that turns a
 * losing strategy into a winning-looking one.
 */
export function calibrate(bounded: bigint, replayed: bigint): CalibrationResult {
  const error = bounded - replayed;
  const errorBps = replayed === 0n ? 0 : Number((error * 10_000n) / replayed);
  return {
    boundedExitLamports: bounded,
    replayExitLamports: replayed,
    errorLamports: error,
    errorBps,
    toleranceBps: CALIBRATION_TOLERANCE_BPS,
    conservative: bounded <= replayed,
    withinTolerance: Math.abs(errorBps) <= CALIBRATION_TOLERANCE_BPS,
  };
}

/**
 * P8.4 — may this mark enter PnL?
 *
 * The one gate the 545 pre-repair policy outcomes did not pass. A later
 * mainnet quote with no contract is refused BY NAME, so the refusal is
 * countable rather than being an absent grade nobody looked for.
 */
export function admissibleForPnl(
  evidenceClass: string | null,
  evidenceGrade: string | null,
): { admissible: boolean; reason: string } {
  if (evidenceClass === null) {
    return {
      admissible: false,
      reason:
        'this mark carries no counterfactual contract. A later mainnet quote against a pool that never ' +
        'contained our entry is not a future exit for a position that was never taken.',
    };
  }
  if (evidenceClass !== 'BOUNDED_COUNTERFACTUAL_V1' && evidenceClass !== 'RESERVE_DELTA_REPLAY_V1') {
    return { admissible: false, reason: `${evidenceClass} is not an admissible counterfactual contract` };
  }
  if (evidenceClass === 'BOUNDED_COUNTERFACTUAL_V1' && evidenceGrade !== 'CALIBRATED') {
    return {
      admissible: false,
      reason:
        'the bounded contract has not been calibrated against a reserve-delta replay, so it is ' +
        'development evidence and may not enter a confirmatory result',
    };
  }
  return { admissible: true, reason: '' };
}

/** Persist a counterfactual mark. */
export function insertCounterfactualMark(
  db: Db,
  m: {
    readonly trajectoryId: string;
    readonly offsetMs: number;
    readonly evidenceClass: EvidenceClass;
    readonly contractVersion: string;
    readonly postEntryBaseReserve: bigint;
    readonly postEntryQuoteReserve: bigint;
    readonly observedBaseReserve: bigint;
    readonly observedQuoteReserve: bigint;
    readonly adjustedBaseReserve: bigint;
    readonly adjustedQuoteReserve: bigint;
    readonly haircutFormula: string;
    readonly haircutBps: number;
    readonly haircutLamports: bigint;
    readonly entryImpactBps: number;
    readonly counterfactualExitLamports: bigint | null;
    readonly evidenceGrade: 'DEVELOPMENT' | 'CALIBRATED';
    readonly refusal: string | null;
    readonly nowMs: number;
  },
): void {
  const existing = db
    .prepare(
      `SELECT 1 AS x FROM counterfactual_marks
        WHERE trajectory_id = ? AND offset_ms = ? AND evidence_class = ?`,
    )
    .get(m.trajectoryId, m.offsetMs, m.evidenceClass);
  if (existing !== undefined) return;

  expectRows(
    'inserting a counterfactual mark',
    1,
    db
      .prepare(
        `INSERT INTO counterfactual_marks
           (trajectory_id, offset_ms, evidence_class, contract_version,
            post_entry_base_reserve, post_entry_quote_reserve,
            observed_base_reserve, observed_quote_reserve,
            adjusted_base_reserve, adjusted_quote_reserve,
            haircut_formula, haircut_bps, haircut_lamports, entry_impact_bps, impact_bound_bps,
            counterfactual_exit_lamports, evidence_grade, refusal, computed_utc_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.trajectoryId,
        m.offsetMs,
        m.evidenceClass,
        m.contractVersion,
        m.postEntryBaseReserve.toString(),
        m.postEntryQuoteReserve.toString(),
        m.observedBaseReserve.toString(),
        m.observedQuoteReserve.toString(),
        m.adjustedBaseReserve.toString(),
        m.adjustedQuoteReserve.toString(),
        m.haircutFormula,
        m.haircutBps,
        m.haircutLamports.toString(),
        m.entryImpactBps,
        BOUNDED_IMPACT_CAP_BPS,
        m.counterfactualExitLamports?.toString() ?? null,
        m.evidenceGrade,
        m.refusal,
        m.nowMs,
      ).changes,
  );
}
