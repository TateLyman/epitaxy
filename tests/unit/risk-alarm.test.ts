import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import { ReserveAlarm } from '../../apps/engine/src/risk-alarm.js';
import { encodeTokenAccount } from '../../packages/solana/src/tokenaccount.js';
import { base58Encode } from '../../packages/solana/src/base58.js';
import type { DatabaseSync } from 'node:sqlite';
import type { AccountUpdate } from '../../packages/adapters/src/accountwatch.js';

/**
 * P17.3 — the WSS reserve alarm.
 *
 * `accountwatch.ts` was complete, tested, and imported by nothing. A watcher
 * that decides nothing is worse than no watcher: it counts as coverage in every
 * report that counts files, while the collapse it exists to catch happens
 * between two marks anyway.
 *
 * The alarm says LOOK. It never says what a position is worth.
 */

const pk = (seed: number): string => {
  const b = new Uint8Array(32);
  b[0] = seed;
  b[31] = 1;
  return base58Encode(b);
};
const MINT = pk(3);
const OWNER = pk(4);
const RESERVE = pk(5);

let dir: string;
let db: DatabaseSync;
let fired: { mint: string; detail: string }[];
let alarm: ReserveAlarm;

/** Reach the private handler the socket would call. No socket is opened. */
const deliver = (u: Partial<AccountUpdate> & { dataBase64: string }): void => {
  (alarm as unknown as { handle: (u: AccountUpdate) => void }).handle({
    address: RESERVE,
    reason: 'POOL_RESERVES',
    contextSlot: 1,
    receivedMonotonicMs: 1,
    receivedUtcMs: 1,
    lamports: 2_039_280n,
    owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    accountHash: 'h',
    subscriptionEpoch: 0,
    slotGap: null,
    ...u,
  } as AccountUpdate);
};

const reserveOf = (amount: bigint): string =>
  Buffer.from(encodeTokenAccount({ mint: MINT, owner: OWNER, amount })).toString('base64');

const health = (kind: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM health_events WHERE kind = ?').get(kind) as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alarm-'));
  db = openDb({ path: join(dir, 'a.db'), skipBackup: true });
  fired = [];
  alarm = new ReserveAlarm(
    { db, onMaterialChange: (mint, detail) => fired.push({ mint, detail }) },
    'ws://127.0.0.1:1',
  );
  alarm.watch({ mint: MINT, reserveTokenAccount: RESERVE });
});

afterEach(() => {
  try {
    alarm.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows holds -wal briefly */
  }
});

describe('P17.3 — the reserve is the decoded token amount', () => {
  it('fires when the decoded reserve drops materially', () => {
    deliver({ dataBase64: reserveOf(1_000_000n) });
    expect(fired).toHaveLength(0); // baseline
    deliver({ dataBase64: reserveOf(500_000n) });
    expect(fired).toHaveLength(1);
    expect(fired[0]?.mint).toBe(MINT);
    expect(health('wss_reserve_drop')).toBe(1);
  });

  it('does NOT read the account lamports as the reserve', () => {
    // A token account's lamports are its rent-exempt minimum and barely move.
    // Reading them as the reserve gives an alarm that never fires, which is the
    // failure mode that looks most like working.
    deliver({ dataBase64: reserveOf(1_000_000n), lamports: 2_039_280n });
    deliver({ dataBase64: reserveOf(1_000_000n), lamports: 1n });
    // The lamports collapsed and the RESERVE did not. No alarm.
    expect(fired).toHaveLength(0);
  });

  it('ignores a rise', () => {
    deliver({ dataBase64: reserveOf(1_000_000n) });
    deliver({ dataBase64: reserveOf(5_000_000n) });
    expect(fired).toHaveLength(0);
  });

  it('treats the first update as a baseline, not a drop from zero', () => {
    deliver({ dataBase64: reserveOf(1n) });
    expect(fired).toHaveLength(0);
  });

  it('an undecodable account is unknown, not a total drain', () => {
    deliver({ dataBase64: reserveOf(1_000_000n) });
    deliver({ dataBase64: Buffer.from([1, 2, 3]).toString('base64') });
    expect(fired).toHaveLength(0);
    expect(health('wss_undecodable_account')).toBe(1);
  });
});

describe('P17.3 — gaps are recorded, not assumed away', () => {
  it('records a slot gap, because the baseline is then stale', () => {
    deliver({ dataBase64: reserveOf(1_000_000n) });
    deliver({ dataBase64: reserveOf(900_000n), slotGap: 42 });
    // A slot gap means updates were MISSED. It does not mean the account did
    // not change during them, and the comparison is against a stale baseline.
    expect(health('wss_slot_gap')).toBe(1);
  });

  it('a null slot gap is a first sighting, not a gap of zero', () => {
    deliver({ dataBase64: reserveOf(1_000_000n), slotGap: null });
    expect(health('wss_slot_gap')).toBe(0);
  });
});

describe('P17.3 — an alarm is not a price', () => {
  it('reports the mint to observe and never a value to act on', () => {
    deliver({ dataBase64: reserveOf(1_000_000n) });
    deliver({ dataBase64: reserveOf(100_000n) });
    expect(fired).toHaveLength(1);
    // The callback carries a mint and a human-readable detail. It carries no
    // price, no mark and no size, because raw account state must never become
    // a fill price -- it arrives before any quote could, which is exactly what
    // makes it the wrong thing to value a position with.
    expect(Object.keys(fired[0] ?? {}).sort()).toEqual(['detail', 'mint']);
  });

  it('drops an update for an account it does not watch', () => {
    deliver({ address: pk(9), dataBase64: reserveOf(1n) });
    expect(fired).toHaveLength(0);
  });

  it('unwatch forgets the account', () => {
    deliver({ dataBase64: reserveOf(1_000_000n) });
    alarm.unwatch({ mint: MINT, reserveTokenAccount: RESERVE });
    deliver({ dataBase64: reserveOf(1n) });
    expect(fired).toHaveLength(0);
  });
});
