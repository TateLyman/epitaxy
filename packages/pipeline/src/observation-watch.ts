/**
 * Phase G §3 — once a mint enters the corpus, keep observing it until a terminal
 * state, and make death an OBSERVED state rather than an absence.
 *
 * THE DEFECT THIS REPAIRS, measured rather than supposed. Phase F could not decide
 * the pre-migration branch because 97.5% of censored mints had no post-entry price at
 * all: of 1,069 censored T1 mints only 27 had any price observed after entry. The
 * mechanism is in `maturingByCohort`, which selects mints whose age falls inside a
 * cohort band. Once a mint is older than the widest band it can never be selected
 * again, so observation stops — silently, at an age that has nothing to do with the
 * mint and everything to do with the queue.
 *
 * A mint with no later snapshot then looks identical to a mint whose price did not
 * move, and no amount of re-analysis of that corpus can tell them apart. It is a
 * collection defect, and this is the collection fix.
 *
 * THE RULE. A mint under observation is snapshotted on the mark schedule until one of
 * three terminal states is OBSERVED:
 *
 *   POOL_DRAINED        the pool's quote reserve fell below a frozen threshold
 *   NO_TRADE_INTERVAL   no trade for a frozen interval
 *   HORIZON_REACHED     the explicit observation horizon elapsed
 *
 * Anything else that stops observation is a COLLECTION_FAILURE and is counted as one.
 *
 * FAIL CLOSED ON ABSENCE. A reading this cycle could not take is `null`, and a null
 * reading NEVER fires a terminal state. That is the entire point: the old behaviour
 * turned an unobserved mint into an implicit death, and a fix that let a missing
 * reading close a watch would reintroduce exactly that.
 */

/** The mark schedule the trajectory path already uses, reused so the two agree. */
export const OBSERVATION_OFFSETS_MS = [
  60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
] as const;

/**
 * After the last scheduled offset, observation continues at a fixed cadence until a
 * terminal state. Phase F's gap was not at 60 minutes — it was everywhere after the
 * queue lost interest — so the schedule cannot simply end.
 */
export const OBSERVATION_CADENCE_MS = 1_800_000;

/**
 * FROZEN THRESHOLDS. Chosen from what makes a pool unpriceable rather than from any
 * return, and recorded in MT094 before the collector ships them.
 *
 * The drain threshold is one tenth of a SOL of quote reserve: below that a 0.02 SOL
 * probe is a double-digit share of the pool and the price it returns is a function of
 * the probe rather than of the market. The no-trade interval is two hours, which is
 * TWICE the longest mark offset, so a quiet stretch inside the observed hour can never
 * be read as death. The horizon is 24 hours, twenty-four times that longest offset:
 * long enough that every mark offset and every Phase B exit window closes inside it,
 * short enough to bound the watch.
 */
export const POOL_DRAINED_QUOTE_LAMPORTS = 100_000_000n;
/**
 * The same drain threshold expressed in the provider's units, for the cycles where an
 * on-chain reserve was not read.
 *
 * 0.1 SOL of quote reserve is about 20 USD at 200 USD a SOL, and the provider reports
 * BOTH sides of the pool, so the equivalent total is about 40. 50 is that rounded up,
 * which makes the provider rule marginally STRICTER than the on-chain one — the safe
 * direction, because closing a watch early loses observations while closing it late
 * only costs requests.
 */
export const POOL_DRAINED_LIQUIDITY_USD = 50;
export const NO_TRADE_INTERVAL_MS = 7_200_000;
export const OBSERVATION_HORIZON_MS = 86_400_000;

export type TerminalState = 'POOL_DRAINED' | 'NO_TRADE_INTERVAL' | 'HORIZON_REACHED';

/** Why a watch is no longer being observed. `null` means it still is. */
export type WatchClosure = TerminalState | 'COLLECTION_FAILURE';

export interface WatchReading {
  /** The pool's quote reserve, or null when it could not be read this cycle. */
  readonly quoteReserveLamports: bigint | null;
  /** The provider's total pool liquidity in USD, or null when absent. */
  readonly liquidityUsd: number | null;
  /** When the mint was last OBSERVED trading, or null when never seen to trade. */
  readonly lastTradeUtcMs: number | null;
  /** When observation of this mint began. */
  readonly firstObservedUtcMs: number;
  readonly nowUtcMs: number;
}

/** Which observable closed the watch, so a terminal state is never unattributable. */
export type TerminalSource = 'ON_CHAIN_RESERVE' | 'PROVIDER_LIQUIDITY' | 'OBSERVED_TRADES' | 'CLOCK';

export interface TerminalVerdict {
  readonly state: TerminalState;
  readonly source: TerminalSource;
}

/**
 * The terminal state this reading OBSERVES, or null if none does.
 *
 * Order matters only for reporting: a drained pool that has also passed its horizon
 * is recorded as drained, because that is the fact about the market and the horizon is
 * a fact about the design.
 */
export function terminalStateOf(r: WatchReading): TerminalVerdict | null {
  if (r.quoteReserveLamports !== null && r.quoteReserveLamports < POOL_DRAINED_QUOTE_LAMPORTS) {
    return { state: 'POOL_DRAINED', source: 'ON_CHAIN_RESERVE' };
  }
  if (r.quoteReserveLamports === null && r.liquidityUsd !== null && r.liquidityUsd < POOL_DRAINED_LIQUIDITY_USD) {
    return { state: 'POOL_DRAINED', source: 'PROVIDER_LIQUIDITY' };
  }
  if (r.lastTradeUtcMs !== null && r.nowUtcMs - r.lastTradeUtcMs >= NO_TRADE_INTERVAL_MS) {
    return { state: 'NO_TRADE_INTERVAL', source: 'OBSERVED_TRADES' };
  }
  if (r.nowUtcMs - r.firstObservedUtcMs >= OBSERVATION_HORIZON_MS) {
    return { state: 'HORIZON_REACHED', source: 'CLOCK' };
  }
  return null;
}

export interface Watch {
  readonly mint: string;
  readonly firstObservedUtcMs: number;
  readonly lastObservedUtcMs: number;
  readonly observations: number;
  /** Set once a terminal state was observed. A closed watch is never reopened. */
  readonly terminalState: TerminalState | null;
}

/**
 * When this watch's next observation is due.
 *
 * The scheduled offsets run from first observation; after the last one the cadence
 * takes over. Expressed as an absolute instant so a caller can order by lateness.
 */
export function nextDueAtUtcMs(w: Watch): number {
  const elapsed = w.lastObservedUtcMs - w.firstObservedUtcMs;
  for (const off of OBSERVATION_OFFSETS_MS) {
    if (off > elapsed) return w.firstObservedUtcMs + off;
  }
  return w.lastObservedUtcMs + OBSERVATION_CADENCE_MS;
}

/** Open watches whose next observation is due, most overdue first. */
export function dueForObservation(watches: readonly Watch[], nowUtcMs: number): Watch[] {
  return watches
    .filter((w) => w.terminalState === null && nextDueAtUtcMs(w) <= nowUtcMs)
    .sort((a, b) => nextDueAtUtcMs(a) - nextDueAtUtcMs(b));
}

/**
 * Classify a watch that is no longer being observed.
 *
 * This is the accounting §3 asks for: a gap with a terminal state is a fact about the
 * market, and a gap without one is a fact about the collector. Calling the second
 * kind "death" is what made Phase F undecidable, so it gets its own name and is
 * counted.
 *
 * `staleAfterMs` is the tolerance for a watch that is merely late rather than
 * abandoned — one cadence, so a single missed cycle is not a failure.
 */
export function classifyClosure(
  w: Watch,
  nowUtcMs: number,
  staleAfterMs = OBSERVATION_CADENCE_MS,
): WatchClosure | null {
  if (w.terminalState !== null) return w.terminalState;
  if (nowUtcMs - nextDueAtUtcMs(w) > staleAfterMs) return 'COLLECTION_FAILURE';
  return null;
}

export interface WatchAudit {
  readonly open: number;
  readonly byTerminalState: Readonly<Record<TerminalState, number>>;
  readonly collectionFailures: number;
  /** Closed for an observed reason, as a share of everything no longer observed. */
  readonly observedShare: number | null;
}

/**
 * The number this fix exists to move.
 *
 * Phase F's corpus would report an observed share near zero: almost every mint
 * stopped being snapshotted for a queue reason and nothing recorded it. A later phase
 * reading this audit can tell immediately whether the corpus it is about to analyse
 * has observed deaths or absences.
 */
export function auditWatches(watches: readonly Watch[], nowUtcMs: number): WatchAudit {
  const byTerminalState: Record<TerminalState, number> = {
    POOL_DRAINED: 0,
    NO_TRADE_INTERVAL: 0,
    HORIZON_REACHED: 0,
  };
  let open = 0;
  let failures = 0;
  for (const w of watches) {
    const c = classifyClosure(w, nowUtcMs);
    if (c === null) {
      open += 1;
      continue;
    }
    if (c === 'COLLECTION_FAILURE') failures += 1;
    else byTerminalState[c] += 1;
  }
  const closed = failures + byTerminalState.POOL_DRAINED + byTerminalState.NO_TRADE_INTERVAL + byTerminalState.HORIZON_REACHED;
  return {
    open,
    byTerminalState,
    collectionFailures: failures,
    observedShare: closed === 0 ? null : (closed - failures) / closed,
  };
}
