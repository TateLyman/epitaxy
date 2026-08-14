
/*
 * Node 22+ ships a global WebSocket, so nothing is imported: one fewer
 * dependency on the path that carries risk alarms.
 */

/**
 * Account subscriptions, for the risk facts that cannot wait for a mark.
 *
 * §14 — a mark interval is ten seconds. Every collapse this system has observed
 * happened INSIDE one interval: the position was above the floor at one mark
 * and near zero at the next, with nothing in between. Polling faster is not the
 * answer, because the rate budget also has to maintain the mark SLA across the
 * whole book.
 *
 * A subscription costs nothing per update and delivers the change when it
 * happens. What arrives is an ALARM, not a price: raw reserve state says the
 * pool moved, and until the direct quoter has passed parity for that venue it
 * does not say what a fill would get. Acting on it means taking an exact
 * same-family observation, not booking a number.
 *
 * Everything here fails loudly and reconnects. A silent subscription is worse
 * than none: the engine would believe it is being warned when it is not.
 */

export type WatchReason = 'POOL_RESERVES' | 'MINT_CONFIG' | 'CREATOR' | 'AUTHORITY';

export interface AccountUpdate {
  readonly address: string;
  readonly reason: WatchReason;
  /** Slot the change was observed at, from the subscription itself. */
  readonly contextSlot: number;
  /** Monotonic receipt time, for latency that a wall clock cannot measure. */
  readonly receivedMonotonicMs: number;
  readonly receivedUtcMs: number;
  readonly lamports: bigint;
  readonly dataBase64: string;
  readonly owner: string;
  /** sha256-free identity: enough to tell "changed" from "same". */
  readonly accountHash: string;
  /** Increments on every reconnect, so a gap in coverage is visible. */
  readonly subscriptionEpoch: number;
  /**
   * Slots skipped since the previous update for this account, or null when
   * this is the first. A gap means updates were missed and the engine was NOT
   * being warned during it.
   */
  readonly slotGap: number | null;
}

export interface WatchOptions {
  readonly wsUrl: string;
  readonly commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Called for every update. Must not throw; it is on the socket path. */
  readonly onUpdate: (u: AccountUpdate) => void;
  /** Called when coverage is lost, which is a fact the engine must record. */
  readonly onGap: (detail: string) => void;
  readonly maxBackoffMs?: number;
  /** How long a subscription may go unacknowledged before it is a gap. */
  readonly subscribeAckTimeoutMs?: number;
}

interface Watched {
  readonly address: string;
  readonly reason: WatchReason;
  lastSlot: number | null;
  subscriptionId: number | null;
}

/**
 * One socket, many accounts, explicit about what it is not covering.
 *
 * Commitment is stated rather than defaulted. `processed` sees changes soonest
 * and can see one that never finalises; for an alarm that is the right trade,
 * and it is the caller's decision to make rather than a hidden default.
 */
export class AccountWatcher {
  private ws: WebSocket | null = null;
  private readonly watched = new Map<string, Watched>();
  private readonly pending = new Map<number, string>();
  private nextRequestId = 1;
  private epoch = 0;
  private backoffMs = 500;
  private closed = false;
  /** P15 — true while a socket is opening, so connect() is single-flight. */
  private connecting = false;
  /** P15 — which socket a handler belongs to. A stale one schedules nothing. */
  private generation = 0;
  private readonly commitment: 'processed' | 'confirmed' | 'finalized';

  constructor(private readonly opts: WatchOptions) {
    this.commitment = opts.commitment ?? 'processed';
  }

  get subscriptionEpoch(): number {
    return this.epoch;
  }

  get watchedCount(): number {
    return this.watched.size;
  }

  /** True only when the socket is open AND every account is subscribed. */
  get fullyCovered(): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    return [...this.watched.values()].every((w) => w.subscriptionId !== null);
  }

  watch(address: string, reason: WatchReason): void {
    if (this.watched.has(address)) return;
    this.watched.set(address, { address, reason, lastSlot: null, subscriptionId: null });
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.subscribe(address);
  }

  unwatch(address: string): void {
    /**
     * P15 — SEND the unsubscribe. Forgetting locally is not unsubscribing.
     *
     * The caller's comment claimed this sent one. It deleted a map entry, so
     * the server kept streaming updates for every account the engine had ever
     * watched, consuming the socket's subscription capacity for data nobody
     * reads — and the leak grows with every position ever opened.
     */
    const w = this.watched.get(address);
    this.watched.delete(address);
    if (w?.subscriptionId != null && this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: this.nextRequestId++,
          method: 'accountUnsubscribe',
          params: [w.subscriptionId],
        }),
      );
    }
  }

  connect(): void {
    if (this.closed) return;
    /**
     * P15 — single-flight.
     *
     * `connect()` could be called while a socket was already opening, and the
     * second one replaced `this.ws` while the first kept firing handlers. Two
     * sockets, one of them unreachable and neither closed.
     */
    if (this.connecting) return;
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) return;
    this.connecting = true;
    const ws = new WebSocket(this.opts.wsUrl);
    this.ws = ws;
    // The generation this socket belongs to. A handler from a previous socket
    // must not schedule a reconnect for the current one.
    const generation = ++this.generation;

    ws.addEventListener('open', () => {
      this.connecting = false;
      this.epoch += 1;
      this.backoffMs = 500;
      // Everything is re-subscribed from scratch. A subscription id from a
      // previous socket names nothing on this one.
      for (const w of this.watched.values()) {
        w.subscriptionId = null;
        this.subscribe(w.address);
      }
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        this.handle(String(ev.data));
      } catch (e) {
        // A malformed frame must not kill the socket, but it must not be
        // silent either: it means we are not seeing what we think we are.
        this.opts.onGap(`unparseable subscription frame: ${(e as Error).message.slice(0, 200)}`);
      }
    });

    /**
     * P15 — ONE reconnect per lost socket.
     *
     * This was registered on both `error` and `close`. A socket error is
     * followed by a close, so a single failure scheduled two reconnects, and
     * each of those could fail and schedule two more. The count doubles per
     * cycle, and the backoff — shared state — is reset by whichever succeeds.
     */
    let reconnectScheduled = false;
    const reconnect = (why: string): void => {
      if (this.closed) return;
      if (generation !== this.generation) return;
      if (reconnectScheduled) return;
      reconnectScheduled = true;
      this.connecting = false;
      for (const w of this.watched.values()) w.subscriptionId = null;
      this.opts.onGap(`subscription lost (${why}); ${this.watched.size} account(s) uncovered until reconnect`);
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30_000);
      setTimeout(() => this.connect(), delay);
    };
    ws.addEventListener('close', () => reconnect('closed'));
    ws.addEventListener('error', () => reconnect('error'));

    /**
     * P15 — a subscription that is never acknowledged is not coverage.
     *
     * Without this the socket is OPEN, `watched` is populated, and the engine
     * believes it is watching accounts the server never confirmed. That is the
     * failure mode that looks most like working.
     */
    const ackDeadline = this.opts.subscribeAckTimeoutMs ?? 15_000;
    setTimeout(() => {
      if (this.closed || generation !== this.generation) return;
      const unacked = [...this.watched.values()].filter((w) => w.subscriptionId === null);
      if (unacked.length > 0) {
        this.opts.onGap(
          `${unacked.length} subscription(s) unacknowledged after ${ackDeadline}ms; those accounts are NOT covered`,
        );
      }
    }, ackDeadline);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private subscribe(address: string): void {
    const id = this.nextRequestId++;
    this.pending.set(id, address);
    this.ws?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'accountSubscribe',
        params: [address, { encoding: 'base64', commitment: this.commitment }],
      }),
    );
  }

  private handle(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number;
      result?: unknown;
      method?: string;
      params?: { subscription?: number; result?: { context?: { slot?: number }; value?: Record<string, unknown> } };
    };

    // Subscription confirmation.
    if (typeof msg.id === 'number' && typeof msg.result === 'number') {
      const address = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      const w = address === undefined ? undefined : this.watched.get(address);
      if (w !== undefined) w.subscriptionId = msg.result;
      return;
    }

    if (msg.method !== 'accountNotification') return;
    const subId = msg.params?.subscription;
    const entry = [...this.watched.values()].find((w) => w.subscriptionId === subId);
    if (entry === undefined) return;

    const value = msg.params?.result?.value ?? {};
    const slot = Number(msg.params?.result?.context?.slot ?? 0);
    const data = value['data'];
    const dataBase64 = Array.isArray(data) ? String(data[0]) : '';

    // Slots skipped since the last update for THIS account. Not a health
    // metric: it is the count of changes we may not have seen.
    const slotGap = entry.lastSlot === null ? null : Math.max(0, slot - entry.lastSlot - 1);
    entry.lastSlot = slot;

    this.opts.onUpdate({
      address: entry.address,
      reason: entry.reason,
      contextSlot: slot,
      receivedMonotonicMs: Math.round(performance.now()),
      receivedUtcMs: Date.now(),
      lamports: BigInt(String(value['lamports'] ?? 0)),
      dataBase64,
      owner: String(value['owner'] ?? ''),
      accountHash: `${slot}:${dataBase64.length}:${String(value['lamports'] ?? 0)}`,
      subscriptionEpoch: this.epoch,
      slotGap,
    });
  }
}

/**
 * Is this update material enough to spend an observation on?
 *
 * §14 — "material changes enqueue an immediate same-family BUILD_CUSTOM
 * observation". Every update would exhaust the rate budget; a threshold on the
 * thing that actually matters will not.
 *
 * Measured on real curves: reserves move constantly, and what precedes a
 * collapse is a large move in ONE direction. The threshold is on the drop,
 * because a pool gaining liquidity is not the risk.
 */
export function isMaterialDrop(previousLamports: bigint, currentLamports: bigint, thresholdBps: number): boolean {
  if (previousLamports <= 0n) return false;
  if (currentLamports >= previousLamports) return false;
  const dropBps = ((previousLamports - currentLamports) * 10_000n) / previousLamports;
  return dropBps >= BigInt(thresholdBps);
}
