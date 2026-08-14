import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LogsWatcher,
  pumpInstructionFromLogs,
  TRADE_INSTRUCTIONS,
  MIGRATION_INSTRUCTIONS,
  type ProgramLogEvent,
} from '../../packages/adapters/src/logswatch.js';

interface FakeSocket {
  readyState: number;
  sent: string[];
  listeners: Record<string, ((ev?: unknown) => void)[]>;
  close: () => void;
  send: (data: string) => void;
  addEventListener: (name: string, fn: (ev?: unknown) => void) => void;
}

const sockets: FakeSocket[] = [];
/**
 * The real global, restored after each test.
 *
 * Replacing `globalThis.WebSocket` and leaving it replaced leaks into every
 * file the worker runs afterwards, and the failure surfaces in a SIBLING test
 * that looks unrelated. A stub that outlives its test is a defect in the
 * harness, not in the code under test.
 */
const REAL_WEBSOCKET = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;

function makeSocket(): FakeSocket {
  const s: FakeSocket = {
    readyState: 0,
    sent: [],
    listeners: {},
    close: () => {
      s.readyState = 3;
    },
    send: (d) => s.sent.push(d),
    addEventListener: (n, fn) => {
      (s.listeners[n] ??= []).push(fn);
    },
  };
  sockets.push(s);
  return s;
}

const fire = (s: FakeSocket, n: string, ev?: unknown): void => {
  for (const fn of s.listeners[n] ?? []) fn(ev);
};
const open = (s: FakeSocket): void => {
  s.readyState = 1;
  fire(s, 'open');
};

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

beforeEach(() => {
  sockets.length = 0;
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = Object.assign(
    function () {
      return makeSocket();
    } as unknown as new () => FakeSocket,
    { OPEN: 1, CLOSED: 3 },
  );
});
afterEach(() => {
  vi.useRealTimers();
  (globalThis as unknown as { WebSocket?: unknown }).WebSocket = REAL_WEBSOCKET;
});

function watcher(onEvent: (e: ProgramLogEvent) => void = () => {}, onGap: (d: string) => void = () => {}) {
  return new LogsWatcher({
    wsUrl: 'wss://example.invalid',
    programs: [PUMP, PUMPSWAP],
    commitment: 'processed',
    onEvent,
    onGap,
  });
}

describe('P12 — the signal clock reads the chain, not a poll', () => {
  it('subscribes per program rather than to a global firehose', () => {
    const w = watcher();
    w.connect();
    const s = sockets[0]!;
    open(s);
    const frames = s.sent.map((f) => JSON.parse(f) as { method: string; params: unknown[] });
    expect(frames).toHaveLength(2);
    for (const f of frames) expect(f.method).toBe('logsSubscribe');
    // `all` would be every transaction on Solana: neither affordable nor
    // informative.
    const mentions = frames.map((f) => (f.params[0] as { mentions: string[] }).mentions[0]);
    expect(new Set(mentions)).toEqual(new Set([PUMP, PUMPSWAP]));
    expect((frames[0]!.params[1] as { commitment: string }).commitment).toBe('processed');
  });

  it('reports coverage only when every program is acknowledged', () => {
    const w = watcher();
    w.connect();
    const s = sockets[0]!;
    open(s);
    const ids = s.sent.map((f) => (JSON.parse(f) as { id: number }).id);
    expect(w.fullyCovered).toBe(false);
    fire(s, 'message', { data: JSON.stringify({ jsonrpc: '2.0', id: ids[0], result: 1 }) });
    // One of two: still not covered.
    expect(w.fullyCovered).toBe(false);
    fire(s, 'message', { data: JSON.stringify({ jsonrpc: '2.0', id: ids[1], result: 2 }) });
    expect(w.fullyCovered).toBe(true);
  });

  it('delivers the event with its slot and commitment', () => {
    const got: ProgramLogEvent[] = [];
    const w = watcher((e) => got.push(e));
    w.connect();
    const s = sockets[0]!;
    open(s);
    const ids = s.sent.map((f) => (JSON.parse(f) as { id: number }).id);
    fire(s, 'message', { data: JSON.stringify({ jsonrpc: '2.0', id: ids[0], result: 7 }) });
    fire(s, 'message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'logsNotification',
        params: {
          subscription: 7,
          result: {
            context: { slot: 438_000_123 },
            value: { signature: 'sig1', logs: ['Program log: Instruction: Buy'], err: null },
          },
        },
      }),
    });
    expect(got).toHaveLength(1);
    expect(got[0]!.slot).toBe(438_000_123);
    // `processed` CAN be reverted, so the row has to say which it was.
    expect(got[0]!.commitment).toBe('processed');
    expect(got[0]!.err).toBeNull();
  });

  it('keeps a failed transaction as an event, not as a trade', () => {
    const got: ProgramLogEvent[] = [];
    const w = watcher((e) => got.push(e));
    w.connect();
    const s = sockets[0]!;
    open(s);
    const ids = s.sent.map((f) => (JSON.parse(f) as { id: number }).id);
    fire(s, 'message', { data: JSON.stringify({ jsonrpc: '2.0', id: ids[0], result: 7 }) });
    fire(s, 'message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'logsNotification',
        params: {
          subscription: 7,
          result: { context: { slot: 1 }, value: { signature: 's', logs: [], err: { InstructionError: [0, 'X'] } } },
        },
      }),
    });
    expect(got[0]!.err).not.toBeNull();
  });

  it('reads the instruction from the logs rather than a discriminator table', () => {
    // A table goes stale silently. This is an ALARM input whose only job is to
    // say "look at this mint now".
    expect(pumpInstructionFromLogs(['Program log: Instruction: BuyV2'])).toBe('BuyV2');
    expect(pumpInstructionFromLogs(['Program log: something else'])).toBeNull();
    expect(TRADE_INSTRUCTIONS.has('BuyExactQuoteInV2')).toBe(true);
    expect(MIGRATION_INSTRUCTIONS.has('Migrate')).toBe(true);
  });

  it('schedules ONE reconnect for a socket that errors then closes', () => {
    const w = watcher();
    w.connect();
    const s = sockets[0]!;
    open(s);
    s.readyState = 3;
    fire(s, 'error');
    fire(s, 'close');
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBe(2);
  });

  it('reports unacknowledged subscriptions instead of claiming coverage', () => {
    const gaps: string[] = [];
    const w = watcher(() => {}, (d) => gaps.push(d));
    w.connect();
    open(sockets[0]!);
    vi.advanceTimersByTime(20_000);
    expect(gaps.join(' ')).toMatch(/unacknowledged/);
    expect(gaps.join(' ')).toMatch(/NOT covered/);
  });
});
