import { describe, it, expect } from 'vitest';
import {
  vaultBalance,
  NotATokenAccount,
  subscriptionFor,
  assertUnwatchesExactly,
  UnwatchMismatch,
  isMaterialChange,
  drainOrder,
  resyncAfterGap,
  compareAfterResync,
  MATERIAL_RESERVE_CHANGE_BPS,
} from '../../packages/pipeline/src/vault-watch.js';
import { TOKEN_PROGRAM } from '../../packages/solana/src/pda.js';
import { AMM_PROGRAM_ID } from '../../packages/solana/src/pumpswap-offline.js';

// Imported rather than hardcoded. A literal would drift from the real program
// ids and the test would keep passing against addresses nothing uses — and the
// secret scanner reads a bare base58 assignment as a credential, correctly.
const TOKEN = TOKEN_PROGRAM;
const NOT_A_TOKEN_PROGRAM = AMM_PROGRAM_ID;

function tokenAccount(amount: bigint): string {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b.toString('base64');
}

const WATCH = {
  baseVault: 'BaseVault11111111111111111111111111111111',
  quoteVault: 'QuoteVault1111111111111111111111111111111',
  poolState: 'PoolState11111111111111111111111111111111',
  feeConfig: 'FeeConfig11111111111111111111111111111111',
  mint: 'Mint111111111111111111111111111111111111',
  creatorOrCashbackAccumulator: null,
};

describe('P13 — the balance decoder receives vaults, never the pool PDA', () => {
  it('reads a real token account', () => {
    expect(vaultBalance({ pubkey: 'v', owner: TOKEN, dataBase64: tokenAccount(12_345n) })).toBe(12_345n);
  });

  it('REFUSES a pool PDA rather than reading eight arbitrary bytes as a balance', () => {
    // The defect: a pool account decoded as a token account yields a NUMBER, so
    // the alarm fires on nothing or never fires, and both look like it works.
    expect(() => vaultBalance({ pubkey: 'p', owner: NOT_A_TOKEN_PROGRAM, dataBase64: tokenAccount(999n) })).toThrow(NotATokenAccount);
  });

  it('checks the OWNER, not the length', () => {
    // A pool account can be 165 bytes by coincidence. It cannot be owned by a
    // token program.
    expect(() => vaultBalance({ pubkey: 'p', owner: NOT_A_TOKEN_PROGRAM, dataBase64: tokenAccount(1n) })).toThrow(/owned by/);
  });

  it('refuses a truncated account', () => {
    expect(() => vaultBalance({ pubkey: 'v', owner: TOKEN, dataBase64: 'AAAA' })).toThrow(/too short/);
  });
});

describe('P13 — unwatch uses the stored addresses', () => {
  it('persists exactly what was subscribed', () => {
    const s = subscriptionFor('t1', WATCH, 1_000);
    expect(s.addresses).toContain(WATCH.baseVault);
    expect(s.addresses).toContain(WATCH.poolState);
    expect(s.addresses).toHaveLength(5);
  });

  it('detects a leaked subscription when unwatch re-derives instead of reading', () => {
    // A derivation change between watch and unwatch silently leaks. This makes
    // it fail instead.
    const s = subscriptionFor('t1', WATCH, 1_000);
    expect(() => assertUnwatchesExactly(s, [WATCH.baseVault, WATCH.quoteVault])).toThrow(UnwatchMismatch);
  });

  it('accepts an exact unwatch', () => {
    const s = subscriptionFor('t1', WATCH, 1_000);
    expect(() => assertUnwatchesExactly(s, [...s.addresses])).not.toThrow();
  });
});

describe('P13 — the urgent queue is drained first', () => {
  it('treats a 5% reserve move as material', () => {
    expect(MATERIAL_RESERVE_CHANGE_BPS).toBe(500);
    expect(isMaterialChange(1_000_000n, 950_000n)).toBe(true);
    expect(isMaterialChange(1_000_000n, 990_000n)).toBe(false);
  });

  it('a vault appearing from nothing is material', () => {
    expect(isMaterialChange(0n, 1n)).toBe(true);
    expect(isMaterialChange(0n, 0n)).toBe(false);
  });

  it('serves urgent trajectories before ordinary marks, without duplicating', () => {
    // Serving a vault that just moved after a queue of routine marks is the
    // same as not having detected it.
    expect(drainOrder(['t2'], ['t1', 't2', 't3'])).toEqual(['t2', 't1', 't3']);
  });
});

describe('P13 — socket gaps are recorded, per-account gaps are not invented', () => {
  it('resyncs exactly the subscribed addresses', () => {
    const s = subscriptionFor('t1', WATCH, 1_000);
    const plan = resyncAfterGap(s, { fromSlot: 100, toSlot: 140, reason: 'SOCKET_DISCONNECTED' });
    expect(plan.addresses).toEqual(s.addresses);
    expect(plan.reason).toMatch(/100\.\.140/);
  });

  it('names what changed while blind, and what is still unreadable', () => {
    const before = new Map([['a', 'h1'], ['b', 'h2']]);
    const after = new Map([['a', 'h1'], ['b', 'CHANGED']]);
    const r = compareAfterResync(before, after, ['a', 'b', 'c']);
    expect(r.changedWhileBlind).toEqual(['b']);
    expect(r.stillUnreadable).toEqual(['c']);
    // A quiet account is restored, not reported as a gap.
    expect(r.restored).toContain('a');
  });
});
