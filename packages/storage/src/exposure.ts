import type { Db } from './db.js';

/**
 * Everything this system is still holding, derived from first principles.
 *
 * `openPositions()` asks `state IN ('POSITION_OPEN','EXIT_INTENT')`. That is a
 * state ALLOWLIST, and it silently excluded two states that hold tokens:
 * `EXIT_BLOCKED` and `RECONCILING`. A position whose exit could not be built is
 * exactly the position most likely to be stuck holding something, and it was
 * the one the ledger could not see — so its cost was not exposure, its rent was
 * not locked, and the capital behind it was reported as free and available to
 * open something new.
 *
 * The question is not "is this position in a state we listed". It is:
 *
 *     closed_utc_ms IS NULL AND token_amount > 0
 *
 * That is true of every state that can hold tokens, including states that do
 * not exist yet. A state nobody has written is the one an allowlist gets wrong,
 * and this file is the reason a future one cannot.
 */

export interface ExposedPosition {
  readonly positionId: string;
  readonly mint: string;
  readonly state: string;
  readonly tokenAmount: bigint;
  readonly costLamports: bigint;
  readonly openedUtcMs: number;
  /** True when `state` is not one this build knows how to manage. */
  readonly unknownState: boolean;
}

/**
 * States this build knows how to manage. Anything else holding tokens is a
 * defect that must stop new entries rather than be averaged over.
 */
export const KNOWN_NONTERMINAL_STATES: readonly string[] = [
  'POSITION_OPEN',
  'EXIT_INTENT',
  'EXIT_BLOCKED',
  'RECONCILING',
];

export const TERMINAL_STATES: readonly string[] = ['POSITION_CLOSED'];

export interface ExposureSummary {
  readonly positions: readonly ExposedPosition[];
  /** Sum of entry cash out still at risk. */
  readonly totalCostLamports: bigint;
  /** One ATA per held position: the conservative direction for locked capital. */
  readonly ataCount: number;
  readonly unknownStatePositions: readonly ExposedPosition[];
  /** True when something is held in a state this build cannot manage. */
  readonly blocksNewEntries: boolean;
  readonly reason: string | null;
}

/**
 * Read every position still holding tokens, whatever its state is called.
 *
 * Amounts come back as `bigint` parsed from TEXT. They are never routed through
 * `Number`: a token amount above 2^53 is ordinary for a fresh memecoin with
 * nine decimals, and rounding one is how a position silently changes size.
 */
export function exposedPositions(db: Db): ExposedPosition[] {
  const rows = db
    .prepare(
      `SELECT position_id, mint, state, token_amount, cost_lamports, opened_utc_ms
       FROM positions
       WHERE closed_utc_ms IS NULL
       ORDER BY opened_utc_ms`,
    )
    .all() as {
    position_id: string;
    mint: string;
    state: string;
    token_amount: string;
    cost_lamports: string;
    opened_utc_ms: number;
  }[];

  const out: ExposedPosition[] = [];
  for (const r of rows) {
    // Parsed as bigint before the comparison, so "10000000000000000000" is
    // greater than zero for the right reason rather than by luck of float
    // rounding.
    const tokens = BigInt(r.token_amount);
    if (tokens <= 0n) continue;
    out.push({
      positionId: r.position_id,
      mint: r.mint,
      state: r.state,
      tokenAmount: tokens,
      costLamports: BigInt(r.cost_lamports),
      openedUtcMs: Number(r.opened_utc_ms),
      unknownState: !KNOWN_NONTERMINAL_STATES.includes(r.state),
    });
  }
  return out;
}

export function summariseExposure(db: Db): ExposureSummary {
  const positions = exposedPositions(db);
  const unknown = positions.filter((p) => p.unknownState);
  return {
    positions,
    totalCostLamports: positions.reduce((a, p) => a + p.costLamports, 0n),
    ataCount: positions.length,
    unknownStatePositions: unknown,
    // An unknown nonterminal state holding tokens is not a curiosity. We do not
    // know how it exits, so we must not add anything to it.
    blocksNewEntries: unknown.length > 0,
    reason:
      unknown.length === 0
        ? null
        : `${unknown.length} position(s) hold tokens in a state this build does not manage: ` +
          `${[...new Set(unknown.map((p) => p.state))].join(', ')}. New entries are blocked until each is ` +
          'either managed or closed, because a position we cannot exit is a position we must not add to.',
  };
}
