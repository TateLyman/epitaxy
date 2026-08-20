import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MT101,
  assertWatchlistWithinBudget,
  evaluateSignal,
  freezeWatchlist,
  pollingDetectionLag,
  sweepBudget,
  signalAge,
  watchlistRequestRate,
  WatchlistBudgetExceeded,
  WatchlistInvalid,
  type FlaggedWallet,
  type SignalContext,
  type WalletFlowEvent,
} from '../../packages/intelligence/src/wallet-watchlist.js';

/**
 * MT101 — the flagged-wallet entry arm.
 *
 * H1 is the only confirmed out-of-sample result this programme has, and until
 * now it had never touched the collector. These tests pin the parts of that arm
 * where a silent change would produce a number that looks like the frozen
 * experiment and is not it.
 */

function wallet(address: string, rankPosition: number): FlaggedWallet {
  return { address, rankPosition, rankStat: 0.12, fitPositions: 40 };
}

function fullList(n: number = MT101.watchlistSize): FlaggedWallet[] {
  return Array.from({ length: n }, (_, i) => wallet(`W${i + 1}`, i + 1));
}

const BUY: WalletFlowEvent = {
  signature: 'sig1',
  instructionIndex: 0,
  wallet: 'W1',
  mint: 'MINT1',
  side: 'BUY',
  quoteLamports: 20_000_000n,
  programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  slot: 1,
  blockUtcMs: 1_000_000,
  observedUtcMs: 1_010_000,
  detectionLagMs: 10_000,
  source: 'POLL',
  commitment: 'confirmed',
  txError: false,
  decodeRefusal: null,
};

function ctx(over: Partial<SignalContext> = {}): SignalContext {
  return {
    watchlist: freezeWatchlist(fullList()),
    evaluatedUtcMs: 1_020_000,
    alreadySignalledMints: new Set<string>(),
    poolPresent: true,
    ...over,
  };
}

describe('MT101 frozen parameters agree with the preregistration', () => {
  /**
   * The ledger row is what the experiment IS. If the constants drift away from
   * it, every number the arm produces is attributable to a rule nobody wrote
   * down, and the drift is invisible at analysis time because the artifact
   * still says MT101. This test is the reason that cannot land quietly.
   */
  const ledger = readFileSync('docs/MULTIPLE_TESTING_LEDGER.csv', 'utf8');
  const row = ledger.slice(ledger.indexOf('"MT101"'), ledger.indexOf('"MT102"'));
  const amendment = ledger.slice(ledger.indexOf('"MT102"'));

  it('MT101 exists and is preregistered rather than already resolved', () => {
    expect(row.length).toBeGreaterThan(0);
    expect(row).toContain('"preregistered"');
    expect(row).toContain('NOT YET RUN');
  });

  it('every frozen constant in code is named in the ledger row', () => {
    expect(row).toContain('N = 128');
    expect(row).toContain('lag budget 120,000 ms');
    expect(row).toContain('trigger K = 1');
    expect(row).toContain('at least 20 fit positions');
    expect(row).toContain('20,000,000 lamports');
    expect(row).toContain('H* = 3600s');

    expect(MT101.watchlistSize).toBe(128);
    expect(MT101.lagBudgetMs).toBe(120_000);
    expect(MT101.confluenceK).toBe(1);
    expect(MT101.minFitPositions).toBe(20);
    expect(MT101.notionalLamports).toBe(20_000_000n);
    expect(MT101.primaryHorizonMs).toBe(3_600_000);
  });

  it('the sweep interval comes from MT102, and MT101 still says what it originally froze', () => {
    /**
     * MT101 froze 60,000 ms and MT102 amended it to 90,000 ms before any market
     * was read. MT101 is deliberately left standing verbatim: a preregistration
     * quietly rewritten is indistinguishable from one that was never made. So
     * the original number must STILL be in MT101 and the code must match the
     * amendment, and this test fails if either drifts.
     */
    expect(row).toContain('sweep interval 60,000 ms');
    expect(amendment).toContain('60,000 ms to 90,000 ms');
    expect(amendment).toContain('"landed"');
    expect(MT101.sweepIntervalMs).toBe(90_000);
  });

  it('the amended sweep leaves real decode headroom, which is what MT101 got wrong', () => {
    /**
     * `getSignaturesForAddress` does not name the program, so establishing that
     * an action was a PumpSwap buy costs one `getTransaction` per new
     * signature. Under MT101's original 60,000 ms the whole share was consumed
     * by the signature sweep.
     */
    expect(sweepBudget(128, 60_000).decodeHeadroom).toBe(4);
    expect(sweepBudget().decodeHeadroom).toBe(70);
    expect(sweepBudget().signatureRps).toBeCloseTo(1.422, 3);
  });

  it('the notional is a bigint, because every token amount in this system is', () => {
    expect(typeof MT101.notionalLamports).toBe('bigint');
  });
});

describe('the watchlist budget is enforced, not remembered', () => {
  /**
   * `endpoint-budget.ts` holds the endpoint-wide total at 8 req/s across ALL
   * processes. A watchlist that quietly grows is therefore not refused by the
   * provider — it starves the screening collector sharing the bucket, and the
   * arm's admission rate falls for a reason that has nothing to do with the
   * market. That is exactly the substitution this repository exists to refuse.
   */
  it('the frozen 128 wallets on a 60s sweep fits its share', () => {
    expect(watchlistRequestRate(128, 60_000)).toBeCloseTo(2.133, 3);
    expect(() => assertWatchlistWithinBudget(128, 60_000)).not.toThrow();
  });

  it('doubling the watchlist without lengthening the sweep is refused', () => {
    expect(() => assertWatchlistWithinBudget(256, 60_000)).toThrow(WatchlistBudgetExceeded);
  });

  it('the refusal names the collector that would be starved, not just the number', () => {
    expect(() => assertWatchlistWithinBudget(256, 60_000)).toThrow(/screening collector/);
  });

  it('lengthening the sweep is the permitted way to watch more wallets', () => {
    expect(() => assertWatchlistWithinBudget(256, 120_000)).not.toThrow();
  });
});

describe('freezing the watchlist enforces the frozen rule at construction', () => {
  it('accepts the frozen list', () => {
    expect(freezeWatchlist(fullList()).size).toBe(128);
  });

  it('refuses a short list, because a short list is a different experiment', () => {
    expect(() => freezeWatchlist(fullList(127))).toThrow(WatchlistInvalid);
  });

  it('refuses a wallet below the 20-position bar MT073 set', () => {
    const rows = fullList();
    rows[7] = { ...rows[7]!, fitPositions: 19 };
    expect(() => freezeWatchlist(rows)).toThrow(/19 fit positions/);
  });

  it('refuses a duplicated rank, because a repeated rank is not a ranking', () => {
    const rows = fullList();
    rows[5] = { ...rows[5]!, rankPosition: 1 };
    expect(() => freezeWatchlist(rows)).toThrow(/not a ranking/);
  });

  it('refuses the same address twice, because one wallet counted twice is not two wallets', () => {
    const rows = fullList();
    rows[9] = { ...rows[9]!, address: 'W1' };
    expect(() => freezeWatchlist(rows)).toThrow(/appears twice/);
  });
});

describe('signal age is measured against the wallet clock where it exists', () => {
  /**
   * Enforcing the lag budget against our own observation measures how promptly
   * we processed what we already held. That is a different quantity and it
   * always flatters us, so which clock was used is returned rather than assumed.
   */
  it('uses the block time when it is known', () => {
    expect(signalAge({ blockUtcMs: 1_000_000, observedUtcMs: 1_010_000 }, 1_020_000)).toEqual({
      ageMs: 20_000,
      basis: 'BLOCK_TIME',
    });
  });

  it('falls back to our observation and says so, rather than reporting a smaller number silently', () => {
    expect(signalAge({ blockUtcMs: null, observedUtcMs: 1_010_000 }, 1_020_000)).toEqual({
      ageMs: 10_000,
      basis: 'OBSERVATION',
    });
  });
});

describe('the MT101 trigger', () => {
  it('forwards a fresh flagged buy into a mint with a pool', () => {
    const d = evaluateSignal(BUY, ctx())!;
    expect(d.outcome).toBe('FORWARDED');
    expect(d.refusal).toBeNull();
    expect(d.walletRank).toBe(1);
    expect(d.kObserved).toBe(1);
  });

  it('is not a signal at all when we could not decode the event', () => {
    const undecoded: WalletFlowEvent = {
      ...BUY,
      mint: null,
      side: null,
      decodeRefusal: 'instruction shape unrecognised',
    };
    // Null, not a refusal row: the event is already stored with its reason, and
    // inventing a signal row would count our decoder's failure as a decision
    // about a market.
    expect(evaluateSignal(undecoded, ctx())).toBeNull();
  });

  it('refuses a failed transaction, which is observed activity and zero value', () => {
    const d = evaluateSignal({ ...BUY, txError: true }, ctx())!;
    expect(d.outcome).toBe('REFUSED_TX_FAILED');
  });

  it('refuses a sell', () => {
    expect(evaluateSignal({ ...BUY, side: 'SELL' }, ctx())!.outcome).toBe('REFUSED_NOT_BUY');
  });

  it('refuses a wallet that is not on the frozen list', () => {
    const d = evaluateSignal({ ...BUY, wallet: 'STRANGER' }, ctx())!;
    expect(d.outcome).toBe('REFUSED_WALLET_NOT_FLAGGED');
    expect(d.walletRank).toBe(0);
  });

  it('refuses a signal past the frozen lag budget rather than entering late', () => {
    const d = evaluateSignal(BUY, ctx({ evaluatedUtcMs: 1_000_000 + MT101.lagBudgetMs + 1 }))!;
    expect(d.outcome).toBe('REFUSED_STALE');
    expect(d.signalAgeMs).toBe(MT101.lagBudgetMs + 1);
  });

  it('admits a signal exactly at the budget, so the boundary is not off by one', () => {
    const d = evaluateSignal(BUY, ctx({ evaluatedUtcMs: 1_000_000 + MT101.lagBudgetMs }))!;
    expect(d.outcome).toBe('FORWARDED');
  });

  it('refuses a mint this arm already signalled', () => {
    const d = evaluateSignal(BUY, ctx({ alreadySignalledMints: new Set(['MINT1']) }))!;
    expect(d.outcome).toBe('REFUSED_DUPLICATE_MINT');
  });

  it('refuses when no pool exists', () => {
    expect(evaluateSignal(BUY, ctx({ poolPresent: false }))!.outcome).toBe('REFUSED_NO_POOL');
  });

  it('FAILS CLOSED when pool presence could not be established', () => {
    /**
     * An unread account is not an absent pool. If this returned FORWARDED on a
     * null the arm would enter on a provider outage, and if it recorded a plain
     * "no pool" the refusal would read as a fact about the venue.
     */
    const d = evaluateSignal(BUY, ctx({ poolPresent: null }))!;
    expect(d.outcome).toBe('REFUSED_NO_POOL');
    expect(d.refusal).toMatch(/unread account is not an absent pool/);
  });

  it('reports the event-intrinsic reason ahead of our own latency', () => {
    /**
     * A failed transaction was never a signal whatever our lag was. If lag were
     * checked first, every failed transaction arriving late would be recorded
     * as REFUSED_STALE and the source would look slower than it is while the
     * failure rate looked lower than it is. Both errors point the same way.
     */
    const d = evaluateSignal(
      { ...BUY, txError: true },
      ctx({ evaluatedUtcMs: 1_000_000 + MT101.lagBudgetMs + 5_000 }),
    )!;
    expect(d.outcome).toBe('REFUSED_TX_FAILED');
  });

  it('never produces a refusal without a reason, which is what the schema also enforces', () => {
    const cases: SignalDecisionCase[] = [
      [{ ...BUY, txError: true }, ctx()],
      [{ ...BUY, side: 'SELL' }, ctx()],
      [{ ...BUY, wallet: 'STRANGER' }, ctx()],
      [BUY, ctx({ evaluatedUtcMs: 9_000_000 })],
      [BUY, ctx({ alreadySignalledMints: new Set(['MINT1']) })],
      [BUY, ctx({ poolPresent: false })],
      [BUY, ctx({ poolPresent: null })],
    ];
    for (const [event, context] of cases) {
      const d = evaluateSignal(event, context)!;
      expect(d.outcome).not.toBe('FORWARDED');
      expect(d.refusal).toBeTruthy();
    }
  });
});

type SignalDecisionCase = readonly [WalletFlowEvent, SignalContext];

describe('the polled source costs a measured amount of the signal, not an assumed one', () => {
  /**
   * Phase C measured the as-priced return at +23.00% at a 30s lag against
   * +24.45% at 2s. The frozen 60s sweep has a 30s mean lag, so this source
   * gives up roughly 6% of the signal in relative terms and any MT101 result is
   * a LOWER bound on what a streamed source would measure. That is stated in
   * the ledger row as the direction of bias, and it follows from this number.
   */
  it('the amended 90s sweep has a 45s mean and 90s worst-case detection lag', () => {
    expect(pollingDetectionLag(MT101.sweepIntervalMs)).toEqual({ meanMs: 45_000, worstMs: 90_000 });
  });

  it('the mean polled lag sits well inside the frozen lag budget', () => {
    expect(pollingDetectionLag(MT101.sweepIntervalMs).worstMs).toBeLessThan(MT101.lagBudgetMs);
  });
});
