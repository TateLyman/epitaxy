/**
 * MT101 — where flagged-wallet actions come from.
 *
 * The rule lives in `wallet-watchlist.ts`. This is only the source, and the
 * separation is deliberate: a polled source and a streamed source differ in
 * detection lag and in how many wallets they can watch, and in nothing else
 * that the experiment is about. Every event carries the source that produced it
 * and the lag it was produced at, so the two can never be pooled without it
 * being visible which is which.
 *
 * ---
 *
 * WHY THE SIDE IS DECODED FROM BALANCE DELTAS AND NOT FROM AN INSTRUCTION
 *
 * The same reason `migration-history.ts` gives: Pump has changed its
 * instruction layouts before, and a layout drift produces a silently WRONG
 * trade rather than a refusal. Pre- and post-balances are what the chain
 * recorded and they cannot drift. The cost is that a transaction touching the
 * same mint twice nets to one event, which is stated here rather than hidden.
 *
 * ---
 *
 * WHY THE DECODE IS BUDGETED
 *
 * `getSignaturesForAddress` returns a signature, a block time, a slot and an
 * error flag. It does NOT return the program, so establishing that an action
 * was a PumpSwap buy costs one `getTransaction` per new signature. MT101 froze
 * a 2.2 req/s share without costing that; MT102 amended the sweep to 90,000 ms
 * so the headroom is 70 calls rather than 4.
 *
 * When a sweep runs out of headroom the remaining signatures are DEFERRED to
 * the next sweep and counted, never dropped. Dropping them would make the
 * source's measured detection rate a function of how busy the watchlist
 * happened to be, which is the kind of defect that looks like a market fact.
 */

import {
  MT101,
  sweepBudget,
  type Commitment,
  type FlaggedWallet,
  type FlowSourceKind,
  type Side,
  type WalletFlowEvent,
} from './wallet-watchlist.js';

/** PumpSwap AMM. An action that does not invoke it is not an entry we can copy. */
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * The subset of `SolanaRpc` this source needs, declared structurally so a test
 * double is written against the REAL return types. A stub returning a shape the
 * real client never returns produces failures that look like production
 * defects, which is why this interface mirrors `rpc.ts` exactly rather than
 * being convenient.
 */
export interface WalletFlowRpc {
  getSignaturesForAddress(
    address: string,
    limit?: number,
    before?: string,
  ): Promise<{ signature: string; blockTime: number | null; slot: number | null; failed: boolean | null }[]>;
  getTransactionWithMeta(signature: string): Promise<{
    readonly signature: string;
    readonly slot: number | null;
    readonly blockTime: number | null;
    readonly failed: boolean;
    readonly accountKeys: readonly string[];
    readonly preTokenBalances: readonly { accountIndex: number; mint: string; owner: string | null; amount: bigint }[];
    readonly postTokenBalances: readonly { accountIndex: number; mint: string; owner: string | null; amount: bigint }[];
    readonly preBalances: readonly bigint[];
    readonly postBalances: readonly bigint[];
  } | null>;
}

export type DecodedSwap =
  | { readonly ok: true; readonly mint: string; readonly side: Side; readonly quoteLamports: bigint }
  | { readonly ok: false; readonly refusal: string };

type LandedLike = NonNullable<Awaited<ReturnType<WalletFlowRpc['getTransactionWithMeta']>>>;

/**
 * What one wallet did in one transaction, read from balances.
 *
 * Refuses rather than guesses on every ambiguity. A transaction that moved two
 * non-WSOL mints for this wallet is a route or a multi-leg action, and calling
 * it a buy of whichever mint sorted first would be exactly the "partially
 * interpreted" outcome this system refuses.
 */
export function decodeWalletSwap(tx: LandedLike, wallet: string): DecodedSwap {
  if (!tx.accountKeys.includes(PUMPSWAP_PROGRAM)) {
    return { ok: false, refusal: 'transaction does not invoke the PumpSwap AMM' };
  }
  const walletIndex = tx.accountKeys.indexOf(wallet);
  if (walletIndex < 0) {
    return { ok: false, refusal: 'wallet is not an account key of its own transaction' };
  }
  const pre = tx.preBalances[walletIndex];
  const post = tx.postBalances[walletIndex];
  if (pre === undefined || post === undefined) {
    return { ok: false, refusal: 'native balance arrays do not cover the wallet index' };
  }

  const deltas = new Map<string, bigint>();
  const add = (rows: readonly { mint: string; owner: string | null; amount: bigint }[], sign: bigint): void => {
    for (const r of rows) {
      if (r.owner !== wallet) continue;
      deltas.set(r.mint, (deltas.get(r.mint) ?? 0n) + sign * r.amount);
    }
  };
  add(tx.preTokenBalances, -1n);
  add(tx.postTokenBalances, 1n);

  // Wrapped SOL is quote, not base. A wallet that wraps to trade shows the
  // quote leg here rather than in the native balance, and counting it as a base
  // mint would report a buy of WSOL.
  const wsolDelta = deltas.get(WSOL_MINT) ?? 0n;
  const baseMints = [...deltas.entries()].filter(([mint, d]) => mint !== WSOL_MINT && d !== 0n);

  if (baseMints.length === 0) return { ok: false, refusal: 'no non-WSOL token balance changed for this wallet' };
  if (baseMints.length > 1) {
    return { ok: false, refusal: `${baseMints.length} non-WSOL mints moved; a multi-leg action is not one entry` };
  }
  const [mint, baseDelta] = baseMints[0]!;

  // The native delta carries the transaction fee and any rent, so it is the
  // quote leg PLUS costs and is recorded as such rather than presented as a
  // clean notional. It is informational here; the arm's own cost accounting
  // comes from our own fills, never from the wallet's.
  const quoteDelta = post - pre + wsolDelta;

  if (baseDelta > 0n && quoteDelta < 0n) return { ok: true, mint, side: 'BUY', quoteLamports: -quoteDelta };
  if (baseDelta < 0n && quoteDelta > 0n) return { ok: true, mint, side: 'SELL', quoteLamports: quoteDelta };
  return {
    ok: false,
    refusal: `base delta ${baseDelta} and quote delta ${quoteDelta} are not a swap in either direction`,
  };
}

export interface SweepResult {
  readonly events: readonly WalletFlowEvent[];
  /** Signatures seen but not decoded because the sweep ran out of budget. */
  readonly deferred: number;
  readonly signatureCalls: number;
  readonly decodeCalls: number;
  /** Wallets whose signature page could not be read at all. */
  readonly unreadableWallets: readonly string[];
}

/**
 * Per-wallet cursor: the newest signature we have already accounted for.
 *
 * `getSignaturesForAddress` returns newest-first, so everything above the
 * cursor is new. A wallet with no cursor yet is SEEDED rather than back-filled:
 * on first sight we record its newest signature and emit nothing, because
 * emitting a wallet's entire recent history as fresh signals would fire the arm
 * on actions that happened before the experiment began.
 */
export type WalletCursors = Map<string, string>;

export class PollingWalletFlowSource {
  readonly kind: FlowSourceKind = 'POLL';

  constructor(
    private readonly rpc: WalletFlowRpc,
    private readonly watchlist: ReadonlyMap<string, FlaggedWallet>,
    private readonly cursors: WalletCursors = new Map(),
    private readonly pageLimit = 10,
    private readonly commitment: Commitment = 'confirmed',
  ) {}

  /** Wallets seeded so far. Exposed so a caller can tell a quiet sweep from a first sweep. */
  seeded(): number {
    return this.cursors.size;
  }

  async sweep(nowUtcMs: number): Promise<SweepResult> {
    const budget = sweepBudget(this.watchlist.size);
    const events: WalletFlowEvent[] = [];
    const unreadable: string[] = [];
    let decodeCalls = 0;
    let signatureCalls = 0;
    let deferred = 0;

    // Rank order, so that when the decode budget runs out it is always the
    // lowest-ranked wallets that defer. Deferring by whichever wallet happened
    // to be iterated last would make the arm's effective watchlist a function
    // of Map insertion order.
    const byRank = [...this.watchlist.values()].sort((a, b) => a.rankPosition - b.rankPosition);

    for (const w of byRank) {
      let page: Awaited<ReturnType<WalletFlowRpc['getSignaturesForAddress']>>;
      try {
        page = await this.rpc.getSignaturesForAddress(w.address, this.pageLimit);
        signatureCalls += 1;
      } catch {
        // A page we could not read is a fact about the provider. The cursor is
        // left alone so the next sweep retries the same span rather than
        // skipping it.
        unreadable.push(w.address);
        continue;
      }

      const cursor = this.cursors.get(w.address);
      if (cursor === undefined) {
        if (page.length > 0) this.cursors.set(w.address, page[0]!.signature);
        continue;
      }

      const fresh: typeof page = [];
      for (const row of page) {
        if (row.signature === cursor) break;
        fresh.push(row);
      }
      if (page.length > 0) this.cursors.set(w.address, page[0]!.signature);
      if (fresh.length === 0) continue;

      // Oldest first, so the arm sees a wallet's actions in the order it took
      // them and a duplicate-mint refusal names the later one.
      fresh.reverse();

      for (const row of fresh) {
        // A failed transaction is observed activity and zero value. It is
        // recorded from the signature page alone, which costs no decode.
        if (row.failed === true) {
          events.push(
            this.event(w, row, null, {
              ok: false,
              refusal: 'transaction failed on chain',
            }),
          );
          continue;
        }
        if (decodeCalls >= budget.decodeHeadroom) {
          deferred += 1;
          continue;
        }
        let tx: LandedLike | null;
        try {
          tx = await this.rpc.getTransactionWithMeta(row.signature);
          decodeCalls += 1;
        } catch {
          decodeCalls += 1;
          events.push(this.event(w, row, null, { ok: false, refusal: 'transaction could not be fetched' }));
          continue;
        }
        if (tx === null) {
          events.push(this.event(w, row, null, { ok: false, refusal: 'transaction has no readable meta' }));
          continue;
        }
        events.push(this.event(w, row, nowUtcMs, decodeWalletSwap(tx, w.address)));
      }
    }

    return {
      events,
      deferred,
      signatureCalls,
      decodeCalls,
      unreadableWallets: unreadable,
    };
  }

  private event(
    w: FlaggedWallet,
    row: { signature: string; blockTime: number | null; slot: number | null; failed: boolean | null },
    nowUtcMs: number | null,
    decoded: DecodedSwap,
  ): WalletFlowEvent {
    const observedUtcMs = nowUtcMs ?? Date.now();
    const blockUtcMs = row.blockTime === null ? null : row.blockTime * 1000;
    return {
      signature: row.signature,
      // One event per transaction, because a balance-delta decode nets a
      // transaction that touched the mint twice. The index is kept in the key so
      // a later instruction-level decoder can raise the count without changing it.
      instructionIndex: 0,
      wallet: w.address,
      mint: decoded.ok ? decoded.mint : null,
      side: decoded.ok ? decoded.side : null,
      quoteLamports: decoded.ok ? decoded.quoteLamports : null,
      programId: decoded.ok ? PUMPSWAP_PROGRAM : null,
      slot: row.slot,
      blockUtcMs,
      observedUtcMs,
      detectionLagMs: blockUtcMs === null ? null : observedUtcMs - blockUtcMs,
      source: this.kind,
      commitment: this.commitment,
      // `failed: null` means the provider told us nothing, which is not "it
      // landed". It is decoded as a refusal above rather than treated as success.
      txError: row.failed === true,
      decodeRefusal: decoded.ok ? null : decoded.refusal,
    };
  }
}

/** Ledger row this source serves, so an artifact can never be attributed to the wrong rule. */
export const SOURCE_LEDGER_ROW = MT101.ledgerRow;
