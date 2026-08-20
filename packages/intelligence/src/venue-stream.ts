/**
 * The PumpSwap venue tape, over one free `logsSubscribe`.
 *
 * This is MT104's source. It subscribes to pump_amm on a public endpoint,
 * decodes every trade out of the `Program data:` log lines, and hands out the
 * ones that answer a question — a trade by a watched wallet, or any trade in a
 * pool we are tracking.
 *
 * WHY A PROGRAM-WIDE SUBSCRIPTION IS CORRECT HERE AND WAS NOT BEFORE
 *
 * `targeted-flow.ts` refuses to put a program id in a Helius `accountInclude`,
 * and `FORBIDDEN_SUBSCRIPTION_ADDRESSES` names pump and pumpswap explicitly.
 * That rule is right and it is not being bypassed: it exists because the
 * previous build subscribed to those programs on a METERED endpoint and burned
 * both endpoints' credits producing data about tokens nobody was considering.
 *
 * Two things are different, and both are measured rather than argued:
 *
 *   1. `api.mainnet-beta.solana.com` is not metered. The cost of 472
 *      notifications a second there is CPU, not credits.
 *   2. The old firehose produced data about tokens nobody was considering. This
 *      one produces the identity of every trader on the venue, which is the one
 *      thing that lets a watchlist of ANY size be matched locally — the whole
 *      reason MT101's 128-wallet bound disappears.
 *
 * The guard stays exactly as it is for the metered path.
 *
 * THE DENOMINATOR IS KEPT EVEN THOUGH THE ROWS ARE NOT. 40M events a day cannot
 * be stored against a 9.4GB corpus, so unmatched trades are counted and
 * discarded. Without those counts "we saw 40 flagged buys" means nothing, and
 * the arrival rate carries one of MT104's kill conditions.
 *
 * A GAP IS PERSISTED, NOT SMOOTHED. Seconds lost to a reconnect are a fact about
 * the measurement; an arrival rate computed across an unrecorded gap reads a
 * dropped subscription as a quiet market.
 */

import { tradesFromLogs, logsWereTruncated, type PumpSwapTrade } from './pumpswap-event.js';

export const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUBLIC_MAINNET_WS = 'wss://api.mainnet-beta.solana.com';

export type KeptBecause = 'WATCHLIST_TRADER' | 'TRACKED_POOL';

export interface VenueTrade {
  readonly trade: PumpSwapTrade;
  readonly signature: string;
  readonly eventIndex: number;
  readonly slot: number | null;
  readonly observedUtcMs: number;
  readonly keptBecause: KeptBecause;
}

export interface VenueStreamCounters {
  notifications: number;
  tradesDecoded: number;
  buysDecoded: number;
  tradesKept: number;
  failedTx: number;
  logTruncated: number;
  undecodable: number;
}

export function emptyCounters(): VenueStreamCounters {
  return {
    notifications: 0,
    tradesDecoded: 0,
    buysDecoded: 0,
    tradesKept: 0,
    failedTx: 0,
    logTruncated: 0,
    undecodable: 0,
  };
}

export interface VenueStreamDeps {
  /** Is this address on a watchlist? O(1), local, and any size. */
  readonly isWatched: (trader: string) => boolean;
  /** Are we marking this pool? */
  readonly isTrackedPool: (pool: string) => boolean;
  readonly onTrade: (t: VenueTrade) => void;
  readonly onCounters: (c: Readonly<VenueStreamCounters>) => void;
  readonly now: () => number;
}

/**
 * Apply one `logsNotification` to the counters and emit whatever it holds that
 * we care about.
 *
 * Pure with respect to the network: it takes a decoded notification and the
 * deps, so the whole matching rule is testable without a socket. Everything the
 * class does beyond this is connection management.
 */
export function handleNotification(
  value: { logs?: string[]; err?: unknown; signature?: string; slot?: number },
  counters: VenueStreamCounters,
  deps: VenueStreamDeps,
): void {
  counters.notifications += 1;
  const logs = value.logs ?? [];

  // A failed transaction is observed activity and zero value. Counted, never
  // emitted: counting it inflates exactly the moments that matter most, because
  // failures cluster where liquidity is thinnest.
  if (value.err !== null && value.err !== undefined) {
    counters.failedTx += 1;
    return;
  }
  // Truncation would correlate with the busiest transactions, so it is counted
  // rather than silently producing a short trade list.
  if (logsWereTruncated(logs)) {
    counters.logTruncated += 1;
    return;
  }
  const signature = value.signature;
  if (typeof signature !== 'string') {
    counters.undecodable += 1;
    return;
  }

  let found;
  try {
    found = tradesFromLogs(logs);
  } catch {
    // A layout change throws rather than decoding partially. Counted here so a
    // silent decode failure shows up as a number instead of as a quiet market.
    counters.undecodable += 1;
    return;
  }

  const observedUtcMs = deps.now();
  for (const { trade, index } of found) {
    counters.tradesDecoded += 1;
    if (trade.side === 'BUY') counters.buysDecoded += 1;

    const watched = deps.isWatched(trade.user);
    const tracked = deps.isTrackedPool(trade.pool);
    if (!watched && !tracked) continue;

    counters.tradesKept += 1;
    deps.onTrade({
      trade,
      signature,
      eventIndex: index,
      slot: typeof value.slot === 'number' ? value.slot : null,
      observedUtcMs,
      // A watchlist hit is the reason that answers a question, so it wins when
      // both are true. Recorded rather than inferred at analysis.
      keptBecause: watched ? 'WATCHLIST_TRADER' : 'TRACKED_POOL',
    });
  }
  deps.onCounters(counters);
}

export interface VenueStreamOptions {
  readonly endpoint?: string;
  /** Backoff between reconnects, milliseconds. */
  readonly reconnectDelayMs?: number;
}

/**
 * Long-running subscription with reconnect.
 *
 * Every disconnect closes the current session row and opens a new one, so the
 * interval between them is visible as a gap rather than being averaged away.
 */
export class VenueLogStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private counters = emptyCounters();

  constructor(
    private readonly deps: VenueStreamDeps,
    private readonly onSession: (event: 'open' | 'close', info: { counters: VenueStreamCounters; closeCode: number | null }) => void,
    private readonly opts: VenueStreamOptions = {},
  ) {}

  get endpoint(): string {
    return this.opts.endpoint ?? PUBLIC_MAINNET_WS;
  }

  currentCounters(): Readonly<VenueStreamCounters> {
    return this.counters;
  }

  stop(): void {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      this.counters = emptyCounters();
      const code = await this.connectOnce();
      if (this.stopped) break;
      this.onSession('close', { counters: this.counters, closeCode: code });
      await new Promise((r) => setTimeout(r, this.opts.reconnectDelayMs ?? 2_000));
    }
  }

  private async connectOnce(): Promise<number | null> {
    return await new Promise<number | null>((resolve) => {
      const ws = new WebSocket(this.endpoint);
      this.ws = ws;
      let settled = false;
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        resolve(code);
      };

      ws.addEventListener('open', () => {
        this.onSession('open', { counters: this.counters, closeCode: null });
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'logsSubscribe',
            params: [{ mentions: [PUMPSWAP_PROGRAM_ID] }, { commitment: 'confirmed' }],
          }),
        );
      });

      ws.addEventListener('message', (ev: MessageEvent) => {
        let msg: {
          method?: string;
          error?: unknown;
          params?: { result?: { value?: { logs?: string[]; err?: unknown; signature?: string }; context?: { slot?: number } } };
        };
        try {
          msg = JSON.parse(String(ev.data)) as typeof msg;
        } catch {
          return;
        }
        if (msg.method !== 'logsNotification') return;
        const value = msg.params?.result?.value;
        if (value === undefined) return;
        handleNotification(
          { ...value, slot: msg.params?.result?.context?.slot },
          this.counters,
          this.deps,
        );
      });

      ws.addEventListener('close', (e: CloseEvent) => done(e.code));
      ws.addEventListener('error', () => {
        /* the close event follows and carries the code */
      });
    });
  }
}
