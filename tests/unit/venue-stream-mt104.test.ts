import { describe, it, expect } from 'vitest';
import {
  BUY_EVENT_DISCRIMINATOR,
  SELL_EVENT_DISCRIMINATOR,
  MIN_EVENT_BYTES,
  PROGRAM_DATA_PREFIX,
  PumpSwapEventLayoutError,
  decodePumpSwapTrade,
  tradesFromLogs,
  logsWereTruncated,
} from '../../packages/intelligence/src/pumpswap-event.js';
import {
  emptyCounters,
  handleNotification,
  type VenueStreamDeps,
  type VenueTrade,
} from '../../packages/intelligence/src/venue-stream.js';
import { base58Decode, base58Encode } from '../../packages/solana/src/base58.js';

/**
 * MT104's source: the free venue tape.
 *
 * The decoder's byte offsets are verified against the chain by
 * `pnpm venue:verify` — 55 of 55 exact against the pool vaults' own balances in
 * the same transaction. These tests pin the parts that a live probe cannot
 * reach: the refusals, the counting, and the matching rule.
 */

const POOL = 'GAKj13ZPPekCvYoXt2xwmsbtaQp7EcZxzdqjCUcmASmw';
const TRADER = 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn';

/** Build an event with known field values, laid out exactly as the program emits it. */
function buildEvent(opts: {
  side: 'BUY' | 'SELL';
  pool?: string;
  user?: string;
  quoteAmount?: bigint;
  userQuoteAmount?: bigint;
  baseAmount?: bigint;
  poolBaseBefore?: bigint;
  poolQuoteBefore?: bigint;
  lpFeeBps?: bigint;
  protocolFeeBps?: bigint;
  timestamp?: bigint;
}): Buffer {
  const b = Buffer.alloc(MIN_EVENT_BYTES);
  (opts.side === 'BUY' ? BUY_EVENT_DISCRIMINATOR : SELL_EVENT_DISCRIMINATOR).copy(b, 0);
  b.writeBigInt64LE(opts.timestamp ?? 1_700_000_000n, 8);
  b.writeBigUInt64LE(opts.baseAmount ?? 12_345n, 16);
  b.writeBigUInt64LE(opts.poolBaseBefore ?? 999_000n, 48);
  b.writeBigUInt64LE(opts.poolQuoteBefore ?? 888_000n, 56);
  b.writeBigUInt64LE(opts.quoteAmount ?? 20_000_000n, 64);
  b.writeBigUInt64LE(opts.lpFeeBps ?? 20n, 72);
  b.writeBigUInt64LE(opts.protocolFeeBps ?? 5n, 88);
  b.writeBigUInt64LE(opts.userQuoteAmount ?? 19_950_000n, 112);
  Buffer.from(base58Decode(opts.pool ?? POOL)).copy(b, 120);
  Buffer.from(base58Decode(opts.user ?? TRADER)).copy(b, 152);
  return b;
}

const asLog = (b: Buffer): string => `${PROGRAM_DATA_PREFIX}${b.toString('base64')}`;

describe('decoding a PumpSwap trade', () => {
  it('reads every field back at the offsets the program wrote them', () => {
    const t = decodePumpSwapTrade(buildEvent({ side: 'BUY' }));
    expect(t).not.toBeNull();
    expect(t!.side).toBe('BUY');
    expect(t!.pool).toBe(POOL);
    expect(t!.user).toBe(TRADER);
    expect(t!.quoteAmount).toBe(20_000_000n);
    expect(t!.userQuoteAmount).toBe(19_950_000n);
    expect(t!.baseAmount).toBe(12_345n);
    expect(t!.poolBaseReservesBefore).toBe(999_000n);
    expect(t!.poolQuoteReservesBefore).toBe(888_000n);
    expect(t!.lpFeeBasisPoints).toBe(20n);
    expect(t!.protocolFeeBasisPoints).toBe(5n);
  });

  it('keeps the pool leg and the trader leg apart', () => {
    /**
     * They differ by the fee. Phase G measured the program's rule: a sell has
     * the trader receive quote_pool x (1 - f_total). Using the pool leg for a
     * wallet's proceeds overstates a sell by the whole fee, and it is exactly
     * the kind of error that looks like edge.
     */
    const t = decodePumpSwapTrade(buildEvent({ side: 'SELL', quoteAmount: 1_000_000n, userQuoteAmount: 987_500n }))!;
    expect(t.quoteAmount).not.toBe(t.userQuoteAmount);
    expect(t.quoteAmount - t.userQuoteAmount).toBe(12_500n);
  });

  it('takes the side from the discriminator and not from the body', () => {
    expect(decodePumpSwapTrade(buildEvent({ side: 'SELL' }))!.side).toBe('SELL');
  });

  it('returns null for a payload that is not a trade, because a venue-wide feed is mostly not', () => {
    const other = Buffer.alloc(MIN_EVENT_BYTES);
    other.writeUInt32LE(0xdeadbeef, 0);
    expect(decodePumpSwapTrade(other)).toBeNull();
    expect(decodePumpSwapTrade(Buffer.alloc(4))).toBeNull();
  });

  it('REFUSES a trade discriminator on a short payload rather than decoding part of it', () => {
    /**
     * A short payload with a trade discriminator means the layout moved. A
     * partial decode would produce a plausible wrong number — the failure mode
     * that made `quote_amount_in` read as 0.0000 SOL when it was actually
     * `lp_fee_basis_points`.
     */
    const short = buildEvent({ side: 'BUY' }).subarray(0, MIN_EVENT_BYTES - 1);
    expect(() => decodePumpSwapTrade(short)).toThrow(PumpSwapEventLayoutError);
  });

  it('finds every trade in one transaction and indexes them so the key stays stable', () => {
    const logs = [
      'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]',
      asLog(buildEvent({ side: 'BUY' })),
      'Program log: something else entirely',
      asLog(buildEvent({ side: 'SELL' })),
    ];
    const found = tradesFromLogs(logs);
    expect(found.map((f) => f.index)).toEqual([0, 1]);
    expect(found.map((f) => f.trade.side)).toEqual(['BUY', 'SELL']);
  });

  it('notices a truncated log array', () => {
    expect(logsWereTruncated(['Program log: x', 'Log truncated'])).toBe(true);
    expect(logsWereTruncated(['Program log: x'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function depsFor(over: Partial<VenueStreamDeps> = {}): { deps: VenueStreamDeps; kept: VenueTrade[] } {
  const kept: VenueTrade[] = [];
  return {
    kept,
    deps: {
      isWatched: () => false,
      isTrackedPool: () => false,
      now: () => 1_700_000_500_000,
      onTrade: (t) => kept.push(t),
      onCounters: () => {},
      ...over,
    },
  };
}

const notification = (logs: string[], err: unknown = null) => ({
  logs,
  err,
  signature: 'SIG',
  slot: 42,
});

describe('the venue stream matching rule', () => {
  it('keeps a trade by a watched wallet and says that is why', () => {
    const { deps, kept } = depsFor({ isWatched: (t) => t === TRADER });
    const c = emptyCounters();
    handleNotification(notification([asLog(buildEvent({ side: 'BUY' }))]), c, deps);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.keptBecause).toBe('WATCHLIST_TRADER');
    expect(c.tradesKept).toBe(1);
    expect(c.buysDecoded).toBe(1);
  });

  it('keeps a trade in a tracked pool by anyone, which is how a reserve path gets recorded', () => {
    const { deps, kept } = depsFor({ isTrackedPool: (p) => p === POOL });
    handleNotification(notification([asLog(buildEvent({ side: 'SELL' }))]), emptyCounters(), deps);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.keptBecause).toBe('TRACKED_POOL');
  });

  it('prefers the watchlist reason when both are true, so the reason answers a question', () => {
    const { deps, kept } = depsFor({ isWatched: () => true, isTrackedPool: () => true });
    handleNotification(notification([asLog(buildEvent({ side: 'BUY' }))]), emptyCounters(), deps);
    expect(kept[0]!.keptBecause).toBe('WATCHLIST_TRADER');
  });

  it('COUNTS a trade it does not keep, because the denominator is the whole point', () => {
    /**
     * 472 notifications a second cannot be stored against a 9.4GB corpus, so
     * unmatched trades are discarded. If they were not counted, "we saw 40
     * flagged buys" would have no denominator — and the arrival rate carries
     * one of MT104's five kill conditions.
     */
    const { deps, kept } = depsFor();
    const c = emptyCounters();
    handleNotification(notification([asLog(buildEvent({ side: 'BUY' }))]), c, deps);
    expect(kept).toHaveLength(0);
    expect(c.tradesDecoded).toBe(1);
    expect(c.buysDecoded).toBe(1);
    expect(c.tradesKept).toBe(0);
  });

  it('counts a failed transaction and emits nothing from it', () => {
    const { deps, kept } = depsFor({ isWatched: () => true });
    const c = emptyCounters();
    handleNotification(notification([asLog(buildEvent({ side: 'BUY' }))], { InstructionError: [0, 'x'] }), c, deps);
    expect(kept).toHaveLength(0);
    expect(c.failedTx).toBe(1);
    expect(c.tradesDecoded).toBe(0);
  });

  it('counts a truncated log array and emits nothing from it', () => {
    const { deps, kept } = depsFor({ isWatched: () => true });
    const c = emptyCounters();
    handleNotification(notification([asLog(buildEvent({ side: 'BUY' })), 'Log truncated']), c, deps);
    expect(kept).toHaveLength(0);
    expect(c.logTruncated).toBe(1);
  });

  it('counts a notification with no signature as undecodable rather than dropping it silently', () => {
    const { deps } = depsFor({ isWatched: () => true });
    const c = emptyCounters();
    handleNotification({ logs: [asLog(buildEvent({ side: 'BUY' }))], err: null }, c, deps);
    expect(c.undecodable).toBe(1);
    expect(c.notifications).toBe(1);
  });

  it('counts a layout change as undecodable instead of letting it read as a quiet market', () => {
    const { deps, kept } = depsFor({ isWatched: () => true });
    const c = emptyCounters();
    const short = buildEvent({ side: 'BUY' }).subarray(0, MIN_EVENT_BYTES - 1);
    handleNotification(notification([asLog(short)]), c, deps);
    expect(kept).toHaveLength(0);
    expect(c.undecodable).toBe(1);
  });

  it('carries the signature and event index through, so the dedupe key is stable', () => {
    const { deps, kept } = depsFor({ isWatched: () => true });
    handleNotification(
      notification([asLog(buildEvent({ side: 'BUY' })), asLog(buildEvent({ side: 'SELL' }))]),
      emptyCounters(),
      deps,
    );
    expect(kept.map((k) => [k.signature, k.eventIndex])).toEqual([
      ['SIG', 0],
      ['SIG', 1],
    ]);
  });

  it('round-trips a pubkey through base58, so a decoded trader can be matched at all', () => {
    expect(base58Encode(base58Decode(TRADER))).toBe(TRADER);
  });
});
