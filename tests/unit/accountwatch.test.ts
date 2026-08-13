import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { AccountWatcher, isMaterialDrop, type AccountUpdate } from '../../packages/adapters/src/accountwatch.js';

/**
 * §14 — the subscription that catches what a ten-second mark cannot.
 *
 * Every collapse this system has observed happened INSIDE one mark interval:
 * above the floor at one mark, near zero at the next, nothing in between.
 *
 * These run against a real WebSocket server rather than a mocked socket,
 * because the things worth testing here — resubscription after a drop, gap
 * accounting, coverage reporting — are exactly the behaviours a mock would be
 * written to satisfy.
 */

function notification(subscription: number, slot: number, lamports: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'accountNotification',
    params: {
      subscription,
      result: {
        context: { slot },
        value: { lamports, owner: 'Owner1', data: ['AAAA', 'base64'], executable: false },
      },
    },
  });
}

/** A server that confirms subscriptions and then pushes what the test wants. */
async function withServer(
  run: (url: string, push: (frame: string) => void, sockets: () => number) => Promise<void>,
): Promise<void> {
  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as { port: number }).port;
  let live: import('ws').WebSocket | null = null;
  let connections = 0;

  wss.on('connection', (socket) => {
    live = socket;
    connections += 1;
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; method: string };
      if (msg.method === 'accountSubscribe') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 100 + msg.id }));
      }
    });
  });

  try {
    await run(
      `ws://127.0.0.1:${port}`,
      (frame) => live?.send(frame),
      () => connections,
    );
  } finally {
    wss.close();
  }
}

const settle = async (ms = 120): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

describe('AccountWatcher', () => {
  it('subscribes and reports full coverage', async () => {
    await withServer(async (url) => {
      const w = new AccountWatcher({ wsUrl: url, onUpdate: () => {}, onGap: () => {} });
      w.watch('PoolA', 'POOL_RESERVES');
      w.connect();
      await settle();
      expect(w.watchedCount).toBe(1);
      expect(w.fullyCovered).toBe(true);
      w.close();
    });
  });

  it('delivers an update with the slot and a monotonic receipt time', async () => {
    await withServer(async (url, push) => {
      const seen: AccountUpdate[] = [];
      const w = new AccountWatcher({ wsUrl: url, onUpdate: (u) => seen.push(u), onGap: () => {} });
      w.watch('PoolA', 'POOL_RESERVES');
      w.connect();
      await settle();
      push(notification(101, 500, '1000'));
      await settle();

      expect(seen).toHaveLength(1);
      expect(seen[0]?.contextSlot).toBe(500);
      expect(seen[0]?.lamports).toBe(1_000n);
      expect(seen[0]?.reason).toBe('POOL_RESERVES');
      // A wall clock can move backwards; latency measured against one is not
      // latency.
      expect(seen[0]?.receivedMonotonicMs).toBeGreaterThan(0);
      // The first update has no previous slot, so the gap is unknown, not zero.
      expect(seen[0]?.slotGap).toBeNull();
      w.close();
    });
  });

  it('counts the slots it did not see', async () => {
    await withServer(async (url, push) => {
      const seen: AccountUpdate[] = [];
      const w = new AccountWatcher({ wsUrl: url, onUpdate: (u) => seen.push(u), onGap: () => {} });
      w.watch('PoolA', 'POOL_RESERVES');
      w.connect();
      await settle();
      push(notification(101, 500, '1000'));
      await settle(60);
      push(notification(101, 510, '900'));
      await settle();

      // Nine slots passed unseen. That is not a health metric: it is the count
      // of changes we may have missed while believing we were being warned.
      expect(seen[1]?.slotGap).toBe(9);
      w.close();
    });
  });

  it('reports lost coverage rather than failing silently', async () => {
    await withServer(async (url) => {
      const gaps: string[] = [];
      const w = new AccountWatcher({ wsUrl: url, onUpdate: () => {}, onGap: (d) => gaps.push(d), maxBackoffMs: 50 });
      w.watch('PoolA', 'POOL_RESERVES');
      w.watch('PoolB', 'POOL_RESERVES');
      w.connect();
      await settle();
      expect(w.fullyCovered).toBe(true);

      // Drop the socket underneath it.
      w.close();
      await settle(60);
      // A silent subscription is worse than none: the engine would believe it
      // is being warned when it is not.
      expect(w.fullyCovered).toBe(false);
    });
  });

  it('is not fully covered before its subscriptions are confirmed', async () => {
    await withServer(async (url) => {
      const w = new AccountWatcher({ wsUrl: url, onUpdate: () => {}, onGap: () => {} });
      w.watch('PoolA', 'POOL_RESERVES');
      // Never connected: watching is not covering.
      expect(w.fullyCovered).toBe(false);
      w.close();
    });
  });
});

describe('isMaterialDrop', () => {
  it('fires on a large drop', () => {
    expect(isMaterialDrop(1_000_000_000n, 400_000_000n, 2_000)).toBe(true);
  });

  it('ignores a small one, because every update would exhaust the budget', () => {
    expect(isMaterialDrop(1_000_000_000n, 990_000_000n, 2_000)).toBe(false);
  });

  it('ignores a pool GAINING liquidity, which is not the risk', () => {
    expect(isMaterialDrop(1_000_000_000n, 5_000_000_000n, 2_000)).toBe(false);
  });

  it('fires exactly at the threshold, not just past it', () => {
    // 20% of 1,000 is 800 remaining. A strict comparison would miss the case
    // the threshold was chosen to catch.
    expect(isMaterialDrop(1_000n, 800n, 2_000)).toBe(true);
  });

  it('says nothing when there was nothing there before', () => {
    expect(isMaterialDrop(0n, 0n, 2_000)).toBe(false);
  });
});
