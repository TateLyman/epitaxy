import { describe, it, expect } from 'vitest';
import { capitalAtRisk } from '../../packages/domain/src/types.js';
import { screenCheap } from '../../packages/strategy/src/screen.js';
import { loadConfig } from '../../packages/domain/src/config.js';

/**
 * P14 — the strictness that exists for capital modes was unreachable from the
 * path those modes use.
 *
 * `screenCheap` never passed `capitalAtRisk`, so every cheap gate ran with
 * `false` even in canary and live: an unknown source age carried 0.25 soft risk
 * instead of vetoing, and money-critical Token-2022 behaviour carried 0.6 soft
 * risk instead of refusing.
 */
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const info = (over: Record<string, unknown> = {}) =>
  ({
    id: 'MintA',
    name: 'A',
    symbol: 'A',
    decimals: 6,
    tokenProgram: LEGACY,
    liquidity: 60_000,
    holderCount: 500,
    organicScore: 60,
    updatedAt: new Date().toISOString(),
    ...over,
  }) as never;

const paper = loadConfig('paper');
const live = { ...paper, mode: 'live' as const };

describe('P14 — capitalAtRisk has one definition and it reaches the gates', () => {
  it('is true exactly for the signing modes', () => {
    expect(capitalAtRisk('canary')).toBe(true);
    expect(capitalAtRisk('live')).toBe(true);
    expect(capitalAtRisk('paper')).toBe(false);
    expect(capitalAtRisk('observe')).toBe(false);
    expect(capitalAtRisk('backtest')).toBe(false);
  });

  it('VETOES an unknown source age in a capital mode and only softens it in paper', () => {
    const inPaper = screenCheap(info(), paper, Date.now(), null);
    const inLive = screenCheap(info(), live, Date.now(), null);

    const paperGate = inPaper.gates.find((g) => g.reason === 'source_age_unknown');
    const liveGate = inLive.gates.find((g) => g.reason === 'source_age_unknown');
    expect(paperGate?.severity).toBe('soft_risk');
    expect(liveGate?.severity).toBe('hard_veto');
    expect(liveGate?.passed).toBe(false);
  });

  it('VETOES money-critical Token-2022 behaviour in a capital mode', () => {
    // This gate has read `token2022` since it was written and no caller ever
    // supplied it, so it could not fire at all.
    const facts = {
      hasMoneyCriticalBehaviour: true,
      hasUnknownExtension: false,
      transferFeeBps: null,
      detail: 'transfer hook present',
    };
    const r = screenCheap(info({ tokenProgram: TOKEN_2022 }), live, Date.now(), 1_000, null, facts);
    const g = r.gates.find((x) => x.reason === 'token2022_money_critical');
    expect(g?.severity).toBe('hard_veto');
    expect(r.deservesQuote).toBe(false);
  });

  it('refuses a Token-2022 mint it did not read, rather than passing it as unknown', () => {
    // Every money-critical extension presents as silence when nobody looked.
    const r = screenCheap(info({ tokenProgram: TOKEN_2022 }), live, Date.now(), 1_000, null, null);
    const g = r.gates.find((x) => x.reason === 'token2022_unread');
    expect(g).toBeDefined();
    expect(g?.severity).toBe('hard_veto');
    expect(r.deservesQuote).toBe(false);
  });

  it('does not demand a mint read for a legacy token, or in paper', () => {
    const legacyLive = screenCheap(info({ tokenProgram: LEGACY }), live, Date.now(), 1_000, null, null);
    expect(legacyLive.gates.find((x) => x.reason === 'token2022_unread')).toBeUndefined();

    const t22Paper = screenCheap(info({ tokenProgram: TOKEN_2022 }), paper, Date.now(), 1_000, null, null);
    expect(t22Paper.gates.find((x) => x.reason === 'token2022_unread')).toBeUndefined();
  });
});
