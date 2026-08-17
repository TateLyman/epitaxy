import { directSellMark, DirectMarkUnavailable } from './direct-mark.js';
import { decideExit, type ExitPolicy, type MarkPoint } from '../../strategy/src/treatments.js';

/**
 * P9 — ONE shared market path, then every policy evaluated on it.
 *
 * The reason a shared path matters is not tidiness. Allocating one policy to
 * one trajectory means each policy sees a different set of tokens, so any
 * difference between policies is confounded with which tokens each drew — and
 * at these sample sizes that difference is almost entirely noise.
 *
 * One path, every policy, paired outcomes. That removes the token-selection
 * variance entirely, which is the dominant term.
 *
 * The marks are DIRECT pool reads, not router quotes. A router declines most of
 * these tokens, and 93% of a previous corpus was unpriced for exactly that
 * reason.
 */

/**
 * The horizons a path is marked at.
 *
 * 3m and 10m are NEW, and the reason is structural rather than a preference.
 *
 * `FLOW_LIQUIDITY_DETERIORATION_V1` needs TWO measured marks to see a capacity
 * drop, and P9.2 requires it to fill at the first LATER valid mark rather than
 * at the one that revealed the deterioration. On the old 1/5/15/30/60 grid the
 * earliest possible trigger was the 5m mark and the first mark after it was
 * 15m — which is the control's own horizon. The challenger could therefore
 * NEVER exit before the control, on any path, whatever the market did.
 *
 * That is exactly the 8f73cef audit's N-1: "there is no constructed path in
 * this build where it exits EARLIER than the control at a different mark", and
 * "the challenger can only differ by holding longer". The cause was not the
 * policy; it was that the measurement grid could not express the hypothesis.
 * With heavy-tailed returns, "exiting early is the error" is the half most
 * worth testing, and the grid had made the other half untestable.
 *
 * With 3m and 10m, a drop between 1m and 3m triggers at 3m and fills at 5m —
 * genuinely earlier than 15m, at a different mark, on a real path.
 *
 * Recorded in `docs/MULTIPLE_TESTING_LEDGER.csv` as an AVAILABILITY-driven
 * change: it was made before any outcome existed under the current contract,
 * because the design could not represent the comparison, not because the
 * returns looked better one way.
 */
export const MARK_OFFSETS_MS = [60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000] as const;

export interface CollectedMark {
  readonly atMs: number;
  readonly offsetMs: number;
  /**
   * How late the mark was taken relative to its due time.
   *
   * A mark is only a "15-minute mark" if it was OBSERVED at fifteen minutes.
   * When a collector catches up on a trajectory opened long ago, every horizon
   * comes due at once and all five are taken back to back — so the path carries
   * five labels and one instant, and every policy then triggers on the same
   * mark. Measured on the first live run: two exit policies returned identical
   * outcomes on 8 of 8 paths for exactly this reason.
   *
   * Recorded rather than hidden, because a backfilled path is real evidence
   * about mechanics and NOT evidence about horizons.
   */
  readonly latenessMs: number;
  readonly executableLamports: bigint | null;
  readonly exitCapacityLamports: bigint | null;
  readonly effectiveQuoteReserveLamports: bigint | null;
  /**
   * P8 — THE RAW RESERVES AT THE MARK, which the counterfactual needs.
   *
   * `effectiveQuoteReserveLamports` includes the pool's VIRTUAL quote, which is
   * right for depth and wrong for a constant-product exit: the virtual term is
   * not lamports anyone can take out. The counterfactual carries our entry's
   * displacement onto these and prices against the sum, so it must have the two
   * real vault balances, not the depth figure.
   */
  readonly observedBaseReserve: bigint | null;
  readonly observedQuoteReserve: bigint | null;
  /** Why this mark carries no price. Never collapsed to "no route". */
  readonly refusal: string | null;
}

export interface MarkReader {
  getAccountRaw(pubkey: string): Promise<{ owner: string; dataBase64: string; lamports: bigint }>;
}

/**
 * Take one mark from the pool's own bytes.
 *
 * A refusal is recorded with its reason rather than as a gap, because a mark
 * that could not be priced and a mark that was never attempted are different
 * facts about the path.
 */
export async function takeMark(
  rpc: MarkReader,
  p: {
    mint: string;
    tokenAmount: bigint;
    slippagePct: number;
    globalConfig: string;
    feeConfig: string;
    offsetMs: number;
    /** When the trajectory opened, so lateness is measurable. */
    openedAtMs?: number;
  },
): Promise<CollectedMark> {
  const atMs = Date.now();
  const lateness = p.openedAtMs === undefined ? 0 : Math.max(0, atMs - (p.openedAtMs + p.offsetMs));
  try {
    const m = await directSellMark(
      rpc,
      { mint: p.mint, tokenAmount: p.tokenAmount, slippagePct: p.slippagePct },
      { globalConfig: p.globalConfig, feeConfig: p.feeConfig },
    );
    return {
      atMs,
      offsetMs: p.offsetMs,
      latenessMs: lateness,
      executableLamports: m.executableLamports,
      // What the position could actually realise right now IS the mark: the
      // pool's own arithmetic on the position's own size.
      exitCapacityLamports: m.executableLamports,
      effectiveQuoteReserveLamports: m.poolFacts.quoteReserveRaw + m.poolFacts.virtualQuoteReserves,
      observedBaseReserve: m.poolFacts.baseReserve,
      observedQuoteReserve: m.poolFacts.quoteReserveRaw + m.poolFacts.virtualQuoteReserves,
      refusal: null,
    };
  } catch (e) {
    return {
      atMs,
      offsetMs: p.offsetMs,
      latenessMs: lateness,
      executableLamports: null,
      exitCapacityLamports: null,
      effectiveQuoteReserveLamports: null,
      observedBaseReserve: null,
      observedQuoteReserve: null,
      refusal: e instanceof DirectMarkUnavailable ? e.reason : (e as Error).message.slice(0, 120),
    };
  }
}

export interface PolicyOutcome {
  readonly exitPolicy: ExitPolicy;
  /** When the rule FIRED. */
  readonly triggeredAtMs: number | null;
  readonly triggeredOffsetMs: number | null;
  /**
   * P9.2 — when it could actually have TRADED, which is what it is priced at.
   * Null means the rule fired and no later mark carried a tradable price: a
   * blocked exit, not a fill at the trigger.
   */
  readonly filledAtMs: number | null;
  readonly filledOffsetMs: number | null;
  readonly reason: string;
  /** The mark the policy actually exits at. Null when it never triggered. */
  readonly exitMarkLamports: bigint | null;
  /** Entry cash out minus what the exit would realise. Null when unpriced. */
  readonly grossDeltaLamports: bigint | null;
  /**
   * P8/M-2 — WHAT KIND OF NUMBER `exitMarkLamports` IS.
   *
   * Null means it rests on a later mainnet quote with no contract over it,
   * which is what all 545 pre-repair outcomes were. `admissibleForPnl` refuses
   * on null BY NAME, so the refusal is countable rather than being an absent
   * grade nobody looked for.
   */
  readonly evidenceClass: string | null;
}

/**
 * Evaluate every exit policy on the SAME path.
 *
 * Returns one row per policy. They are paired by construction — same token,
 * same pool, same marks, same costs — so a difference between them is a
 * difference in the decision and nothing else.
 */
export function evaluateExitPolicies(
  path: readonly CollectedMark[],
  p: {
    openedAtMs: number;
    policies: readonly ExitPolicy[];
    entryCashOutLamports: bigint;
    /**
     * P8 — the counterfactual exit per horizon, and its class.
     *
     * Absent for a horizon means no admissible contract covers it. The outcome
     * is then UNPRICED rather than priced at the mark's quote: a quote against
     * a pool that never held our position is not an exit for it, and booking it
     * as one is the defect that built the entire pre-repair gross delta.
     */
    counterfactualExits?: ReadonlyMap<number, { lamports: bigint; evidenceClass: string }>;
  },
): readonly PolicyOutcome[] {
  /**
   * Policies are evaluated on the horizon the mark REPRESENTS, not the instant
   * it was fetched. On a backfilled path every mark shares one wall-clock
   * moment, so using `atMs` collapses 1m/5m/15m/30m/60m onto the same point and
   * every policy trivially agrees — which is what happened on the first live
   * run, 8 of 8 paths.
   */
  const marks: MarkPoint[] = path.map((m) => ({
    atMs: p.openedAtMs + m.offsetMs,
    executableLamports: m.executableLamports ?? 0n,
    exitCapacityLamports: m.exitCapacityLamports,
    effectiveQuoteReserveLamports: m.effectiveQuoteReserveLamports,
  }));

  return p.policies.map((policy) => {
    const d = decideExit(policy, p.openedAtMs, marks);
    /**
     * P9.2 — the exit is priced at the FILL, not at the trigger.
     *
     * This read `triggeredAtMs` for both. On the control they are the same
     * instant, because a preregistered horizon is a clock the strategy can
     * stand ready at. On the challenger they are NOT: the deterioration is
     * detected BY a mark, so pricing the exit at that mark books it at the one
     * observation the strategy demonstrably could not have traded at — it did
     * not know until the mark existed.
     *
     * That difference flatters the challenger by exactly the move that
     * triggered it, which is the move most likely to be adverse. Using the fill
     * removes it.
     */
    const triggeredAt = d.triggeredAtMs;
    const filledAt = d.filledAtMs;
    const triggerMark =
      triggeredAt === null ? null : (path.find((m) => p.openedAtMs + m.offsetMs === triggeredAt) ?? null);
    const fillMark = filledAt === null ? null : (path.find((m) => p.openedAtMs + m.offsetMs === filledAt) ?? null);
    /**
     * The FILL horizon decides WHEN. The counterfactual decides AT WHAT.
     *
     * When no contract covers the fill horizon the outcome carries a null price
     * and a null class, and `admissibleForPnl` refuses it. That is deliberately
     * a visible hole rather than a fallback to the quote.
     */
    const cf = fillMark === null ? undefined : p.counterfactualExits?.get(fillMark.offsetMs);
    const exitLamports = cf?.lamports ?? null;
    return {
      exitPolicy: policy,
      triggeredAtMs: triggeredAt,
      triggeredOffsetMs: triggerMark?.offsetMs ?? null,
      filledAtMs: filledAt,
      filledOffsetMs: fillMark?.offsetMs ?? null,
      reason: d.reason,
      exitMarkLamports: exitLamports,
      grossDeltaLamports: exitLamports === null ? null : exitLamports - p.entryCashOutLamports,
      evidenceClass: cf?.evidenceClass ?? null,
    };
  });
}

/**
 * Whether a path is complete enough to conclude anything from.
 *
 * A path missing its 60-minute mark cannot evaluate a policy that might have
 * held that long, and treating a truncated path as finished silently biases
 * every horizon toward whatever the collector happened to reach.
 */
/** A mark later than this represents its horizon in name only. */
export const MAX_MARK_LATENESS_MS = 120_000;

export function pathIsComplete(
  path: readonly CollectedMark[],
): { complete: boolean; reason: string; backfilled?: boolean } {
  const have = new Set(path.map((m) => m.offsetMs));
  const missing = MARK_OFFSETS_MS.filter((o) => !have.has(o));
  if (missing.length > 0) {
    return { complete: false, reason: `missing marks at ${missing.map((m) => m / 60_000 + 'm').join(', ')}`, backfilled: false };
  }
  const unpriced = path.filter((m) => m.executableLamports === null).length;
  if (unpriced === path.length) {
    return { complete: false, reason: 'every mark on the path was unpriced' };
  }
  const late = path.filter((m) => m.latenessMs > MAX_MARK_LATENESS_MS).length;
  return {
    complete: true,
    reason:
      `${path.length} marks, ${unpriced} unpriced` +
      (late > 0 ? `, ${late} BACKFILLED beyond ${MAX_MARK_LATENESS_MS}ms — horizons are labels, not observations` : ''),
    backfilled: late > 0,
  };
}
