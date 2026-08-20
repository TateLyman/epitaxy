import { describe, it, expect } from 'vitest';
import {
  PUMPSWAP_PROGRAM,
  PollingWalletFlowSource,
  WSOL_MINT,
  decodeWalletSwap,
  type WalletFlowRpc,
} from '../../packages/intelligence/src/wallet-flow-source.js';
import { freezeWatchlist, sweepBudget, type FlaggedWallet } from '../../packages/intelligence/src/wallet-watchlist.js';

/**
 * MT101 — the source that feeds the flagged-wallet arm.
 *
 * The doubles here are written against the REAL `SolanaRpc` return types
 * (`{ signature, blockTime, slot, failed }` and the full `LandedTransaction`
 * meta shape), not against a convenient one. A stub returning a shape the real
 * client never returns produces failures that look like production defects,
 * which is the trap this repository has already walked into once.
 */

const WALLET = 'Wallet1';
type Landed = NonNullable<Awaited<ReturnType<WalletFlowRpc['getTransactionWithMeta']>>>;

function landed(over: Partial<Landed> = {}): Landed {
  return {
    signature: 'sig',
    slot: 100,
    blockTime: 1_700_000,
    failed: false,
    accountKeys: [WALLET, PUMPSWAP_PROGRAM],
    preTokenBalances: [],
    postTokenBalances: [],
    preBalances: [1_000_000_000n, 0n],
    postBalances: [1_000_000_000n, 0n],
    ...over,
  };
}

const tok = (mint: string, amount: bigint, owner: string | null = WALLET) => ({
  accountIndex: 0,
  mint,
  owner,
  amount,
});

describe('decoding a wallet swap from balance deltas', () => {
  it('reads a BUY: base up, quote down', () => {
    const d = decodeWalletSwap(
      landed({
        preTokenBalances: [tok('MINT', 0n)],
        postTokenBalances: [tok('MINT', 500n)],
        preBalances: [1_000_000_000n, 0n],
        postBalances: [980_000_000n, 0n],
      }),
      WALLET,
    );
    expect(d).toEqual({ ok: true, mint: 'MINT', side: 'BUY', quoteLamports: 20_000_000n });
  });

  it('reads a SELL: base down, quote up', () => {
    const d = decodeWalletSwap(
      landed({
        preTokenBalances: [tok('MINT', 500n)],
        postTokenBalances: [tok('MINT', 0n)],
        preBalances: [1_000_000_000n, 0n],
        postBalances: [1_015_000_000n, 0n],
      }),
      WALLET,
    );
    expect(d).toEqual({ ok: true, mint: 'MINT', side: 'SELL', quoteLamports: 15_000_000n });
  });

  it('counts wrapped SOL as quote, never as the mint bought', () => {
    /**
     * A wallet that wraps to trade shows its quote leg in a WSOL token balance
     * rather than in the native balance. Treating WSOL as a base mint would
     * report a buy of WSOL on every wrapped trade, and those are the ones with
     * the largest notionals.
     */
    const d = decodeWalletSwap(
      landed({
        preTokenBalances: [tok('MINT', 0n), tok(WSOL_MINT, 20_000_000n)],
        postTokenBalances: [tok('MINT', 500n), tok(WSOL_MINT, 0n)],
        preBalances: [1_000_000_000n, 0n],
        postBalances: [1_000_000_000n, 0n],
      }),
      WALLET,
    );
    expect(d).toEqual({ ok: true, mint: 'MINT', side: 'BUY', quoteLamports: 20_000_000n });
  });

  it('refuses a transaction that does not invoke PumpSwap', () => {
    const d = decodeWalletSwap(landed({ accountKeys: [WALLET] }), WALLET);
    expect(d).toMatchObject({ ok: false });
    expect(d).toHaveProperty('refusal', expect.stringMatching(/does not invoke the PumpSwap AMM/));
  });

  it('refuses a multi-leg action rather than picking a mint', () => {
    /**
     * Two non-WSOL mints moving is a route or a multi-leg action. Calling it a
     * buy of whichever sorted first is exactly the partial interpretation this
     * system refuses.
     */
    const d = decodeWalletSwap(
      landed({
        preTokenBalances: [tok('A', 0n), tok('B', 100n)],
        postTokenBalances: [tok('A', 500n), tok('B', 0n)],
        postBalances: [980_000_000n, 0n],
      }),
      WALLET,
    );
    expect(d).toMatchObject({ ok: false });
    expect(d).toHaveProperty('refusal', expect.stringMatching(/multi-leg action is not one entry/));
  });

  it('refuses when nothing but SOL moved', () => {
    expect(decodeWalletSwap(landed({ postBalances: [900_000_000n, 0n] }), WALLET)).toMatchObject({ ok: false });
  });

  it('refuses a token increase with no quote outflow, which is not a purchase', () => {
    /**
     * An airdrop or a transfer in moves the base up while the quote does not
     * move down. Recording it as a BUY would fire the arm on tokens the wallet
     * never chose to buy — the single easiest way to manufacture a signal.
     */
    const d = decodeWalletSwap(
      landed({
        preTokenBalances: [tok('MINT', 0n)],
        postTokenBalances: [tok('MINT', 500n)],
        preBalances: [1_000_000_000n, 0n],
        postBalances: [1_000_000_000n, 0n],
      }),
      WALLET,
    );
    expect(d).toMatchObject({ ok: false });
    expect(d).toHaveProperty('refusal', expect.stringMatching(/not a swap in either direction/));
  });

  it('ignores token balances owned by somebody else in the same transaction', () => {
    const d = decodeWalletSwap(
      landed({
        preTokenBalances: [tok('MINT', 0n), tok('OTHER', 0n, 'SomeoneElse')],
        postTokenBalances: [tok('MINT', 500n), tok('OTHER', 900n, 'SomeoneElse')],
        postBalances: [980_000_000n, 0n],
      }),
      WALLET,
    );
    expect(d).toEqual({ ok: true, mint: 'MINT', side: 'BUY', quoteLamports: 20_000_000n });
  });
});

// ---------------------------------------------------------------------------

function watchlistOf(n: number): ReadonlyMap<string, FlaggedWallet> {
  const rows: FlaggedWallet[] = Array.from({ length: n }, (_, i) => ({
    address: `W${i + 1}`,
    rankPosition: i + 1,
    rankStat: 1 / (i + 1),
    fitPositions: 25,
  }));
  return freezeWatchlist(rows, n);
}

class FakeRpc implements WalletFlowRpc {
  pages = new Map<string, { signature: string; blockTime: number | null; slot: number | null; failed: boolean | null }[]>();
  txs = new Map<string, Landed>();
  unreadable = new Set<string>();
  sigCalls = 0;
  txCalls = 0;

  async getSignaturesForAddress(address: string): Promise<
    { signature: string; blockTime: number | null; slot: number | null; failed: boolean | null }[]
  > {
    this.sigCalls += 1;
    if (this.unreadable.has(address)) throw new Error('provider refused');
    return this.pages.get(address) ?? [];
  }

  async getTransactionWithMeta(signature: string): Promise<Landed | null> {
    this.txCalls += 1;
    return this.txs.get(signature) ?? null;
  }
}

const sig = (signature: string, failed: boolean | null = false) => ({
  signature,
  blockTime: 1_700_000,
  slot: 1,
  failed,
});

describe('the polling source', () => {
  it('SEEDS on first sight and emits nothing, rather than back-filling history as fresh signals', async () => {
    /**
     * A wallet's recent page is its past. Emitting it on the first sweep would
     * fire the arm on actions taken before the experiment began, at a signal
     * age of hours, and the lag budget would be the only thing standing between
     * that and an entry.
     */
    const rpc = new FakeRpc();
    rpc.pages.set('W1', [sig('s3'), sig('s2'), sig('s1')]);
    const src = new PollingWalletFlowSource(rpc, watchlistOf(1));

    const first = await src.sweep(1_700_020_000);
    expect(first.events).toHaveLength(0);
    expect(src.seeded()).toBe(1);
    expect(rpc.txCalls).toBe(0);
  });

  it('emits only what is newer than the cursor on the next sweep', async () => {
    const rpc = new FakeRpc();
    rpc.pages.set('W1', [sig('s1')]);
    const src = new PollingWalletFlowSource(rpc, watchlistOf(1));
    await src.sweep(1_700_020_000);

    rpc.pages.set('W1', [sig('s3'), sig('s2'), sig('s1')]);
    rpc.txs.set(
      's2',
      landed({
        accountKeys: ['W1', PUMPSWAP_PROGRAM],
        preTokenBalances: [tok('MINT2', 0n, 'W1')],
        postTokenBalances: [tok('MINT2', 5n, 'W1')],
        postBalances: [980_000_000n, 0n],
      }),
    );
    rpc.txs.set(
      's3',
      landed({
        accountKeys: ['W1', PUMPSWAP_PROGRAM],
        preTokenBalances: [tok('MINT3', 0n, 'W1')],
        postTokenBalances: [tok('MINT3', 5n, 'W1')],
        postBalances: [980_000_000n, 0n],
      }),
    );

    const second = await src.sweep(1_700_020_000);
    expect(second.events.map((e) => e.signature)).toEqual(['s2', 's3']);
    expect(second.events.map((e) => e.mint)).toEqual(['MINT2', 'MINT3']);
  });

  it('emits oldest-first, so a duplicate-mint refusal names the later action', async () => {
    const rpc = new FakeRpc();
    rpc.pages.set('W1', [sig('old')]);
    const src = new PollingWalletFlowSource(rpc, watchlistOf(1));
    await src.sweep(1);
    rpc.pages.set('W1', [sig('newest'), sig('middle'), sig('old')]);
    const r = await src.sweep(1_700_020_000);
    expect(r.events.map((e) => e.signature)).toEqual(['middle', 'newest']);
  });

  it('records a failed transaction without spending a decode call', async () => {
    /**
     * A failed transaction is observed activity and zero value — rule 2 of
     * TARGETED_FLOW_V1. The signature page already carries the error flag, so
     * paying a getTransaction to learn it would spend budget the screening
     * collector shares to establish something we were already told.
     */
    const rpc = new FakeRpc();
    rpc.pages.set('W1', [sig('a')]);
    const src = new PollingWalletFlowSource(rpc, watchlistOf(1));
    await src.sweep(1);
    rpc.pages.set('W1', [sig('bad', true), sig('a')]);

    const r = await src.sweep(1_700_020_000);
    expect(rpc.txCalls).toBe(0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.txError).toBe(true);
    expect(r.events[0]!.decodeRefusal).toMatch(/failed on chain/);
  });

  it('DEFERS decodes past the budget and counts them, rather than dropping them', async () => {
    /**
     * Dropping them would make the measured detection rate a function of how
     * busy the watchlist happened to be, which reads at analysis time as a fact
     * about the market.
     */
    const n = 4;
    const headroom = sweepBudget(n).decodeHeadroom;
    const rpc = new FakeRpc();
    const seeded = Array.from({ length: n }, (_, i) => `W${i + 1}`);
    for (const w of seeded) rpc.pages.set(w, [sig(`${w}-seed`)]);
    const src = new PollingWalletFlowSource(rpc, watchlistOf(n));
    await src.sweep(1);

    // Give every wallet more fresh signatures than the whole sweep can decode.
    const per = headroom + 3;
    for (const w of seeded) {
      rpc.pages.set(w, [
        ...Array.from({ length: per }, (_, i) => sig(`${w}-new${i}`)),
        sig(`${w}-seed`),
      ]);
    }
    const r = await src.sweep(1_700_020_000);
    expect(r.decodeCalls).toBe(headroom);
    expect(r.deferred).toBe(n * per - headroom);
    expect(r.decodeCalls + r.deferred).toBe(n * per);
  });

  it('leaves the cursor alone when a page could not be read, so the span is retried not skipped', async () => {
    const rpc = new FakeRpc();
    rpc.pages.set('W1', [sig('a')]);
    const src = new PollingWalletFlowSource(rpc, watchlistOf(1));
    await src.sweep(1);

    rpc.unreadable.add('W1');
    const bad = await src.sweep(1_700_020_000);
    expect(bad.unreadableWallets).toEqual(['W1']);
    expect(bad.events).toHaveLength(0);

    rpc.unreadable.delete('W1');
    rpc.pages.set('W1', [sig('b'), sig('a')]);
    rpc.txs.set(
      'b',
      landed({
        accountKeys: ['W1', PUMPSWAP_PROGRAM],
        preTokenBalances: [tok('MINT', 0n, 'W1')],
        postTokenBalances: [tok('MINT', 5n, 'W1')],
        postBalances: [980_000_000n, 0n],
      }),
    );
    const good = await src.sweep(1_700_020_000);
    expect(good.events.map((e) => e.signature)).toEqual(['b']);
  });

  it('reports a null detection lag when the block time is unknown, never a zero one', async () => {
    const rpc = new FakeRpc();
    rpc.pages.set('W1', [sig('a')]);
    const src = new PollingWalletFlowSource(rpc, watchlistOf(1));
    await src.sweep(1);
    rpc.pages.set('W1', [{ signature: 'b', blockTime: null, slot: 1, failed: false }, sig('a')]);
    rpc.txs.set('b', landed());

    const r = await src.sweep(1_700_020_000);
    expect(r.events[0]!.detectionLagMs).toBeNull();
    expect(r.events[0]!.blockUtcMs).toBeNull();
  });

  it('measures the detection lag against the block time when it is known', async () => {
    const rpc = new FakeRpc();
    rpc.pages.set('W1', [sig('a')]);
    const src = new PollingWalletFlowSource(rpc, watchlistOf(1));
    await src.sweep(1);
    rpc.pages.set('W1', [sig('b'), sig('a')]);
    rpc.txs.set('b', landed());

    const r = await src.sweep(1_700_045_000);
    expect(r.events[0]!.blockUtcMs).toBe(1_700_000_000);
    expect(r.events[0]!.detectionLagMs).toBe(45_000);
  });

  it('spends exactly one signature call per watched wallet per sweep', async () => {
    const rpc = new FakeRpc();
    const src = new PollingWalletFlowSource(rpc, watchlistOf(8));
    const r = await src.sweep(1);
    expect(r.signatureCalls).toBe(8);
    expect(rpc.sigCalls).toBe(8);
  });
});
