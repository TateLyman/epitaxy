import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccountWatcher } from '../../packages/adapters/src/accountwatch.js';

/**
 * P15 — the alarm's failures were all SILENT.
 *
 * A watcher that forgets an account locally, a socket that reconnects twice
 * per failure, a subscription nobody acknowledged: each of these leaves the
 * engine reporting coverage it does not have. None of them throws.
 */

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

function fire(s: FakeSocket, name: string, ev?: unknown): void {
  for (const fn of s.listeners[name] ?? []) fn(ev);
}

function open(s: FakeSocket): void {
  s.readyState = 1;
  fire(s, 'open');
}

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

function watcher(onGap: (d: string) => void = () => {}) {
  return new AccountWatcher({
    wsUrl: 'wss://example.invalid',
    commitment: 'processed',
    onUpdate: () => {},
    onGap,
  });
}

describe('P15 — the reserve alarm actually watches', () => {
  it('SENDS accountUnsubscribe rather than forgetting locally', () => {
    const w = watcher();
    w.connect();
    const s = sockets[0]!;
    open(s);
    w.watch('AcctA', 'POOL_RESERVES');
    // Acknowledge the subscription so it has an id to unsubscribe.
    const sub = JSON.parse(s.sent[s.sent.length - 1]!) as { id: number };
    fire(s, 'message', { data: JSON.stringify({ jsonrpc: '2.0', id: sub.id, result: 77 }) });

    s.sent.length = 0;
    w.unwatch('AcctA');

    // The defect: this deleted a map entry and sent nothing, so the server
    // kept streaming for every account ever watched. The leak grows with every
    // position ever opened.
    const frames = s.sent.map((f) => JSON.parse(f) as { method?: string; params?: unknown[] });
    expect(frames.some((f) => f.method === 'accountUnsubscribe')).toBe(true);
    expect(frames.find((f) => f.method === 'accountUnsubscribe')?.params).toEqual([77]);
  });

  it('schedules ONE reconnect when a socket errors and then closes', () => {
    const w = watcher();
    w.connect();
    const s = sockets[0]!;
    open(s);
    expect(sockets.length).toBe(1);

    // A real socket failure fires BOTH. The handler was registered on each, so
    // one failure scheduled two reconnects — and each of those could fail and
    // schedule two more. The count doubles per cycle.
    // A real socket is CLOSED by the time these fire.
    s.readyState = 3;
    fire(s, 'error');
    fire(s, 'close');
    vi.advanceTimersByTime(60_000);

    expect(sockets.length).toBe(2);
  });

  it('is single-flight: connect() while opening does not make a second socket', () => {
    const w = watcher();
    w.connect();
    w.connect();
    w.connect();
    expect(sockets.length).toBe(1);
  });

  it('reports a subscription nobody acknowledged, instead of claiming coverage', () => {
    const gaps: string[] = [];
    const w = watcher((d) => gaps.push(d));
    w.connect();
    const s = sockets[0]!;
    open(s);
    w.watch('AcctA', 'POOL_RESERVES');

    // Never acknowledged. The socket is OPEN and the account is in the map, so
    // without this the engine believes it is watching an account the server
    // never confirmed — the failure mode that looks most like working.
    expect(w.fullyCovered).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(gaps.join(' ')).toMatch(/unacknowledged/);
    expect(gaps.join(' ')).toMatch(/NOT covered/);
  });

  it('does not report a gap once every subscription is acknowledged', () => {
    const gaps: string[] = [];
    const w = watcher((d) => gaps.push(d));
    w.connect();
    const s = sockets[0]!;
    open(s);
    w.watch('AcctA', 'POOL_RESERVES');
    const sub = JSON.parse(s.sent[s.sent.length - 1]!) as { id: number };
    fire(s, 'message', { data: JSON.stringify({ jsonrpc: '2.0', id: sub.id, result: 5 }) });

    expect(w.fullyCovered).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(gaps.join(' ')).not.toMatch(/unacknowledged/);
  });
});
