/**
 * P12 — the signal clock, from the chain rather than from a provider's poll.
 *
 * Discovery is a 30-second loop over Jupiter's recent/ranked feeds, and every
 * candidate's age is whatever that provider's `updatedAt` says. The corpus
 * holds hundreds of thousands of `stale_source` rejections, which does not by
 * itself prove lost alpha — but it does mean the clock the strategy reacts to
 * is somebody else's polling interval rather than the event.
 *
 * `logsSubscribe` on the Pump and PumpSwap programs gives the event at
 * `processed`, with a slot. That is the earliest an alarm can exist.
 *
 * Deliberately NOT a price source. A log line is notice that something
 * happened; the executable price still comes from an exact BUILD_CUSTOM
 * observation. Raw chain state is an alarm, never a mark and never a fill —
 * the same rule the reserve alarm follows.
 */

export type Commitment = 'processed' | 'confirmed' | 'finalized';

export interface ProgramLogEvent {
  readonly signature: string;
  readonly slot: number;
  readonly programId: string;
  readonly logs: readonly string[];
  /** The commitment this arrived at. `processed` can still be reverted. */
  readonly commitment: Commitment;
  /** Monotonic ms at receipt, immune to wall-clock adjustment. */
  readonly receivedMonotonicMs: number;
  readonly receivedUtcMs: number;
  readonly err: string | null;
}

export interface LogsWatcherOptions {
  readonly wsUrl: string;
  /** Programs to subscribe to. One subscription each; never a global firehose. */
  readonly programs: readonly string[];
  readonly commitment?: Commitment;
  readonly onEvent: (e: ProgramLogEvent) => void;
  /**
   * Coverage loss is a FACT the engine must record, not a silence. A watcher
   * that stops watching and says nothing is indistinguishable from a chain
   * that stopped producing events.
   */
  readonly onGap: (detail: string) => void;
  readonly maxBackoffMs?: number;
  readonly subscribeAckTimeoutMs?: number;
}

interface Sub {
  readonly programId: string;
  subscriptionId: number | null;
  lastSlot: number | null;
  events: number;
}

export class LogsWatcher {
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, Sub>();
  private readonly pending = new Map<number, string>();
  private nextRequestId = 1;
  private backoffMs = 500;
  private closed = false;
  /** Single-flight: a second connect while one is opening makes two sockets. */
  private connecting = false;
  /** Which socket a handler belongs to. A stale one schedules nothing. */
  private generation = 0;

  constructor(private readonly opts: LogsWatcherOptions) {
    for (const p of opts.programs) {
      this.subs.set(p, { programId: p, subscriptionId: null, lastSlot: null, events: 0 });
    }
  }

  /** True only when the socket is open AND every program is subscribed. */
  get fullyCovered(): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    return [...this.subs.values()].every((s) => s.subscriptionId !== null);
  }

  /** What each program has actually delivered, for an operator surface. */
  get coverage(): { programId: string; subscribed: boolean; lastSlot: number | null; events: number }[] {
    return [...this.subs.values()].map((s) => ({
      programId: s.programId,
      subscribed: s.subscriptionId !== null,
      lastSlot: s.lastSlot,
      events: s.events,
    }));
  }

  connect(): void {
    if (this.closed) return;
    if (this.connecting) return;
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) return;
    this.connecting = true;
    const ws = new WebSocket(this.opts.wsUrl);
    this.ws = ws;
    const generation = ++this.generation;

    ws.addEventListener('open', () => {
      this.connecting = false;
      this.backoffMs = 500;
      // Re-subscribed from scratch: a subscription id from a previous socket
      // names nothing on this one.
      for (const s of this.subs.values()) {
        s.subscriptionId = null;
        this.subscribe(s.programId);
      }
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        this.handle(String(ev.data));
      } catch (e) {
        // A malformed frame must not kill the socket, and must not be silent:
        // it means we are not seeing what we think we are.
        this.opts.onGap(`unparseable logs frame: ${(e as Error).message.slice(0, 200)}`);
      }
    });

    let reconnectScheduled = false;
    const reconnect = (why: string): void => {
      if (this.closed) return;
      if (generation !== this.generation) return;
      if (reconnectScheduled) return;
      reconnectScheduled = true;
      this.connecting = false;
      for (const s of this.subs.values()) s.subscriptionId = null;
      this.opts.onGap(`logs subscription lost (${why}); ${this.subs.size} program(s) uncovered until reconnect`);
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30_000);
      setTimeout(() => this.connect(), delay);
    };
    // ONE per lost socket: a socket error is followed by a close, and handling
    // both doubles the reconnect count every cycle.
    ws.addEventListener('close', () => reconnect('closed'));
    ws.addEventListener('error', () => reconnect('error'));

    const ackDeadline = this.opts.subscribeAckTimeoutMs ?? 15_000;
    setTimeout(() => {
      if (this.closed || generation !== this.generation) return;
      const unacked = [...this.subs.values()].filter((s) => s.subscriptionId === null);
      if (unacked.length > 0) {
        this.opts.onGap(
          `${unacked.length} logs subscription(s) unacknowledged after ${ackDeadline}ms; ` +
            `those programs are NOT covered`,
        );
      }
    }, ackDeadline);
  }

  close(): void {
    this.closed = true;
    for (const s of this.subs.values()) {
      if (s.subscriptionId !== null && this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: this.nextRequestId++,
            method: 'logsUnsubscribe',
            params: [s.subscriptionId],
          }),
        );
      }
    }
    this.ws?.close();
    this.ws = null;
  }

  private subscribe(programId: string): void {
    const id = this.nextRequestId++;
    this.pending.set(id, programId);
    this.ws?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        // One program, not `all`. A global firehose is every transaction on
        // Solana, which is neither affordable nor informative.
        params: [{ mentions: [programId] }, { commitment: this.opts.commitment ?? 'processed' }],
      }),
    );
  }

  private handle(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number;
      result?: number;
      method?: string;
      params?: { subscription?: number; result?: { context?: { slot?: number }; value?: unknown } };
    };

    // Subscription acknowledgement.
    if (typeof msg.id === 'number' && typeof msg.result === 'number') {
      const programId = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (programId !== undefined) {
        const s = this.subs.get(programId);
        if (s !== undefined) s.subscriptionId = msg.result;
      }
      return;
    }

    if (msg.method !== 'logsNotification') return;
    const subscription = msg.params?.subscription;
    const slot = msg.params?.result?.context?.slot ?? null;
    const value = msg.params?.result?.value as
      | { signature?: string; logs?: string[]; err?: unknown }
      | undefined;
    if (subscription === undefined || value === undefined) return;

    const sub = [...this.subs.values()].find((s) => s.subscriptionId === subscription);
    if (sub === undefined) return;
    if (slot !== null) sub.lastSlot = slot;
    sub.events += 1;

    this.opts.onEvent({
      signature: value.signature ?? '',
      slot: slot ?? 0,
      programId: sub.programId,
      logs: value.logs ?? [],
      commitment: this.opts.commitment ?? 'processed',
      receivedMonotonicMs: Math.round(performance.now()),
      receivedUtcMs: Date.now(),
      // An errored transaction is still an event about the pool; it is NOT a
      // trade, and the difference is kept rather than filtered away here.
      err: value.err === null || value.err === undefined ? null : JSON.stringify(value.err).slice(0, 200),
    });
  }
}

/**
 * Which Pump instruction a log block describes, from the program's own logs.
 *
 * Anchor emits `Program log: Instruction: <Name>`. Read rather than inferred:
 * a discriminator table would go stale silently, and this is an ALARM input
 * whose only job is to say "look at this mint now".
 *
 * Returns null when the logs do not name one. Null is a fact about the logs.
 */
export function pumpInstructionFromLogs(logs: readonly string[]): string | null {
  for (const line of logs) {
    const m = /^Program log: Instruction: (\w+)$/.exec(line);
    if (m !== null && m[1] !== undefined) return m[1];
  }
  return null;
}

/** Instruction names that mean a pool's reserves moved. */
export const TRADE_INSTRUCTIONS = new Set([
  'Buy',
  'Sell',
  'BuyV2',
  'SellV2',
  'BuyExactQuoteInV2',
  'buy',
  'sell',
]);

/** Instruction names that mean a bonding curve graduated to PumpSwap. */
export const MIGRATION_INSTRUCTIONS = new Set(['Migrate', 'migrate', 'CreatePool', 'create_pool']);
