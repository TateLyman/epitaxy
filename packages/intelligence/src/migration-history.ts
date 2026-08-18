import { createHash } from 'node:crypto';
import type { PreMigrationTrade, Coverage } from './migration-microstructure.js';

/**
 * P3.1 / P3.2 — fetch the closed bonding-curve history exactly once.
 *
 * The history of a MIGRATED token is immutable: the curve is complete, its last
 * transaction is the migration, and nothing can append to it. So this is fetched
 * once, hashed, cached against `(mint, feature_version)`, and never fetched
 * again — which matters because it is the most expensive read in the system and
 * `pnpm rpc:usage` already reports 48 quota refusals at the current load.
 *
 * ---
 *
 * THE PAGING DIRECTION IS LOad-BEARING.
 *
 * `getSignaturesForAddress` returns newest-first and walks backward through
 * `before`. So a bounded fetch always holds the NEWEST part of the history and
 * is missing the OLDEST. Every consumer depends on that asymmetry:
 * tail-anchored features stay computable under INCOMPLETE coverage, and
 * creation-anchored ones do not. If this ever paged forward, that reasoning
 * silently inverts and a truncated history would produce confident totals over
 * the wrong half of the launch.
 *
 * ---
 *
 * DECODING FROM BALANCES, NOT FROM INSTRUCTION LAYOUTS.
 *
 * A trade is derived from what the chain RECORDED — the curve's lamport delta
 * and its token-account delta — rather than from a decoded instruction. Two
 * reasons:
 *
 *   1. Pump has changed its instruction layouts before, and a layout drift
 *      produces a silently wrong trade rather than a refusal. Balance deltas
 *      are ground truth and cannot drift.
 *   2. Any instruction that moves the curve's SOL and tokens IS a trade for our
 *      purposes, whatever it is called.
 *
 * The cost is that a transaction touching the curve twice nets to one event.
 * That is recorded in `eventIndex` semantics rather than hidden: this decoder
 * emits at most one event per transaction and says so, so a future
 * instruction-level decoder can raise the count without changing the key.
 */

export interface HistoryRpc {
  getSignaturesForAddress(
    address: string,
    limit?: number,
    before?: string,
  ): Promise<{ signature: string; blockTime: number | null; slot: number | null; failed: boolean | null }[]>;
  getTransactionWithMeta(signature: string): Promise<{
    signature: string;
    slot: number | null;
    blockTime: number | null;
    failed: boolean;
    accountKeys: readonly string[];
    preTokenBalances: readonly { accountIndex: number; mint: string; owner: string | null; amount: bigint }[];
    postTokenBalances: readonly { accountIndex: number; mint: string; owner: string | null; amount: bigint }[];
    preBalances: readonly bigint[];
    postBalances: readonly bigint[];
  } | null>;
}

export interface HistoryRequest {
  readonly mint: string;
  readonly bondingCurve: string;
  readonly migrationSignature: string;
  readonly migrationSlot: number;
}

export interface HistoryLimits {
  /** Signatures per page. The RPC caps this at 1000. */
  readonly pageSize: number;
  /** Hard bound on pages, so one pathological token cannot spend a whole quota. */
  readonly maxPages: number;
  /** Hard bound on transaction fetches. */
  readonly maxTransactions: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  pageSize: 200,
  maxPages: 12,
  maxTransactions: 1_200,
};

export interface HistoryCoverageRecord {
  readonly mint: string;
  readonly bondingCurve: string;
  readonly migrationSignature: string;
  readonly migrationSlot: number;
  readonly newestSignature: string | null;
  readonly oldestSignature: string | null;
  readonly reachedCreation: boolean;
  readonly pages: number;
  readonly transactionsFetched: number;
  readonly transactionsFailed: number;
  readonly transactionsPruned: number;
  readonly coverage: Coverage;
  readonly coverageReason: string | null;
  readonly sourceSignaturesHash: string;
}

export interface HistoryResult {
  readonly trades: readonly PreMigrationTrade[];
  readonly coverage: HistoryCoverageRecord;
}

/**
 * Decode ONE transaction into a curve trade, or null when it is not one.
 *
 * Exported because it is the piece the leakage and dedup tests exercise
 * directly, and because a decoder that can only be reached through a network
 * call is a decoder nobody tests.
 */
export function decodeCurveTrade(
  tx: NonNullable<Awaited<ReturnType<HistoryRpc['getTransactionWithMeta']>>>,
  req: { bondingCurve: string; mint: string },
): PreMigrationTrade | null {
  const curveIndex = tx.accountKeys.indexOf(req.bondingCurve);
  if (curveIndex < 0) return null;

  const pre = tx.preBalances[curveIndex];
  const post = tx.postBalances[curveIndex];
  if (pre === undefined || post === undefined) return null;
  const solDelta = post - pre;

  /**
   * The curve's token side, summed over every token account it owns for this
   * mint. Summed rather than assuming one account, because assuming one is how
   * a decoder silently ignores half a movement.
   */
  const tokenOf = (rows: readonly { mint: string; owner: string | null; amount: bigint }[]): bigint =>
    rows.filter((r) => r.mint === req.mint && r.owner === req.bondingCurve).reduce((a, r) => a + r.amount, 0n);
  const baseDelta = tokenOf(tx.postTokenBalances) - tokenOf(tx.preTokenBalances);

  // Neither side moved: this transaction mentions the curve without trading it.
  if (solDelta === 0n && baseDelta === 0n) return null;

  /**
   * A FAILED transaction is emitted with zero amounts.
   *
   * It is real evidence — somebody tried — and it must never contribute flow.
   * Emitting it with its amounts and relying on a downstream filter would make
   * a missed filter into inflated volume; emitting zeros makes a missed filter
   * harmless.
   */
  if (tx.failed) {
    return {
      signature: tx.signature,
      eventIndex: 0,
      slot: tx.slot ?? 0,
      blockTimeMs: tx.blockTime === null ? null : tx.blockTime * 1000,
      side: 'buy',
      quoteLamports: 0n,
      baseAtoms: 0n,
      actor: tx.accountKeys[0] ?? null,
      failed: true,
      curveRealSolAfterLamports: null,
    };
  }

  // SOL into the curve is a buy; SOL out of it is a sell. The token side is
  // used for amounts, not for the direction, because a token delta of zero on
  // a real SOL movement is a state we want to see rather than misclassify.
  const side: 'buy' | 'sell' = solDelta > 0n ? 'buy' : 'sell';
  const abs = (x: bigint): bigint => (x < 0n ? -x : x);

  return {
    signature: tx.signature,
    eventIndex: 0,
    slot: tx.slot ?? 0,
    blockTimeMs: tx.blockTime === null ? null : tx.blockTime * 1000,
    side,
    quoteLamports: abs(solDelta),
    baseAtoms: abs(baseDelta),
    actor: tx.accountKeys[0] ?? null,
    failed: false,
    curveRealSolAfterLamports: post,
  };
}

export async function fetchPreMigrationHistory(
  rpc: HistoryRpc,
  req: HistoryRequest,
  limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
  /** Called between pages so a long history cannot starve the mark scheduler. */
  yieldTo?: () => Promise<void>,
): Promise<HistoryResult> {
  const signatures: { signature: string; blockTime: number | null; slot: number | null; failed: boolean | null }[] = [];
  let before: string | undefined = undefined;
  let pages = 0;
  let reachedCreation = false;
  let coverageReason: string | null = null;

  while (pages < limits.maxPages) {
    if (yieldTo !== undefined) await yieldTo();
    const page = await rpc.getSignaturesForAddress(req.bondingCurve, limits.pageSize, before);
    pages++;
    if (page.length === 0) {
      // An empty page IS the creation boundary: there is nothing older.
      reachedCreation = true;
      break;
    }
    signatures.push(...page);
    const last = page[page.length - 1];
    if (last === undefined) break;
    before = last.signature;
    if (page.length < limits.pageSize) {
      reachedCreation = true;
      break;
    }
    if (signatures.length >= limits.maxTransactions) {
      coverageReason = `stopped at the ${limits.maxTransactions}-transaction bound`;
      break;
    }
  }
  if (!reachedCreation && coverageReason === null) {
    coverageReason = `stopped at the ${limits.maxPages}-page bound`;
  }

  /**
   * Everything at or after the migration is discarded HERE as well as in the
   * feature computation.
   *
   * Twice on purpose. This one saves the fetch; the one in the feature layer is
   * the invariant. A single check in the cheap place would leave the expensive
   * guarantee resting on a caller doing the right thing.
   */
  const preMigration = signatures.filter((s) => (s.slot ?? 0) < req.migrationSlot && s.signature !== req.migrationSignature);

  const trades: PreMigrationTrade[] = [];
  let fetched = 0;
  let failedCount = 0;
  let pruned = 0;

  // Oldest first, so the emitted order matches the order the market saw.
  const ordered = [...preMigration].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

  for (const s of ordered) {
    if (yieldTo !== undefined) await yieldTo();
    if (fetched >= limits.maxTransactions) {
      coverageReason = coverageReason ?? `stopped at the ${limits.maxTransactions}-transaction bound`;
      break;
    }
    let tx: Awaited<ReturnType<HistoryRpc['getTransactionWithMeta']>> = null;
    try {
      tx = await rpc.getTransactionWithMeta(s.signature);
    } catch {
      // A transaction the node refused is PRUNED, not absent. Counted so an
      // incomplete history cannot pass as a complete one with fewer trades.
      pruned++;
      continue;
    }
    if (tx === null) {
      pruned++;
      continue;
    }
    fetched++;
    if (tx.failed) failedCount++;
    const t = decodeCurveTrade(tx, req);
    if (t !== null) trades.push(t);
  }

  /**
   * COMPLETE requires reaching creation AND losing nothing along the way.
   *
   * A history that reached creation but could not read 40 of its transactions
   * is not complete, and calling it complete would let those 40 transactions
   * become implicit zeros in every total.
   */
  const complete = reachedCreation && pruned === 0;
  if (!complete && coverageReason === null && pruned > 0) {
    coverageReason = `${pruned} transaction(s) could not be read`;
  }

  const sourceSignaturesHash = createHash('sha256')
    .update(ordered.map((s) => s.signature).join('\n'))
    .digest('hex');

  return {
    trades,
    coverage: {
      mint: req.mint,
      bondingCurve: req.bondingCurve,
      migrationSignature: req.migrationSignature,
      migrationSlot: req.migrationSlot,
      newestSignature: signatures[0]?.signature ?? null,
      oldestSignature: signatures[signatures.length - 1]?.signature ?? null,
      reachedCreation,
      pages,
      transactionsFetched: fetched,
      transactionsFailed: failedCount,
      transactionsPruned: pruned,
      coverage: complete ? 'COMPLETE' : 'INCOMPLETE',
      coverageReason,
      sourceSignaturesHash,
    },
  };
}
