import { describe, it, expect } from 'vitest';
import {
  prewarmNonPriceAccounts,
  sharedAccountsToPrewarm,
  PriceStateTransplant,
  type PrewarmAccount,
} from '../../packages/simulator/src/prewarm.js';
import {
  frozenComputeLimit,
  priorityFeeSaving,
  FROZEN_CU_MARGIN_PCT,
  MIN_REQUESTED_CU,
} from '../../packages/solana/src/cu-budget.js';
import { swapAccountRoles } from '../../packages/solana/src/pumpswap-offline.js';
import { classifyCreatedAccount, type ScopeContext } from '../../packages/solana/src/created-accounts.js';

/**
 * The directive's P6 items 31 and 33, and the two things that make them
 * meaningful: a complete scope context, and a compute limit that is measured.
 *
 * 31 — the warm surface removes only NON-price state
 * 33 — the base ATA close rides in the sell, checked from the sell's own post
 *      state rather than from having appended the instruction
 */

const POOL = 'BSHanq7NmdY6j8u5YE9A3SUygj1bhavFqb73vadspkL3';
const BASE_VAULT = '81uxiueSporvHDhyBQDuecuGC1YQYW9mqxisvfaivDQX';
const QUOTE_VAULT = '9kivsjTqAEPWuJWbsGsuo4NxFKRec5Z7tw7W3cTJBEjx';
const MINT = '24fTiNwEG3dEusEjT1GfskFwKpYZhx6MDigceXt2pump';
const CREATOR_VAULT = 'C93K8DX4YsABYJtHX9awzgZW3LWzBqBVezEbbLJH4yet';
const TAKER = 'GgSuFAyZRqpzYNE32WNv5uihdENhz1nPHB7MquioFMj3';
const CREATOR = 'D1Eijw8vMeco5cJjCjSJyDFJL8oMemTwxSLEKgr6eHvp';

const acct = (pubkey: string, lamports: bigint, dataBase64 = ''): PrewarmAccount => ({
  pubkey,
  owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  dataBase64,
  lamports,
});

const PRICE_BEARING = [POOL, BASE_VAULT, QUOTE_VAULT, MINT];

describe('31 — the warm surface transplants setup, never reserves', () => {
  const original = [
    acct(POOL, 5_000_000n, 'cold-pool'),
    acct(BASE_VAULT, 2_039_280n, 'cold-base'),
    acct(QUOTE_VAULT, 2_039_280n, 'cold-quote'),
    acct(MINT, 1_461_600n, 'cold-mint'),
  ];
  // The first trade created the creator vault AND moved both reserves.
  const afterFirstTrade = [
    acct(POOL, 5_000_000n, 'warm-pool'),
    acct(BASE_VAULT, 2_039_280n, 'warm-base-MOVED'),
    acct(QUOTE_VAULT, 22_039_280n, 'warm-quote-MOVED'),
    acct(MINT, 1_461_600n, 'cold-mint'),
    acct(CREATOR_VAULT, 2_039_280n, 'created-by-the-first-trade'),
  ];

  it('warms an account the first trade created', () => {
    const r = prewarmNonPriceAccounts({
      original,
      afterFirstTrade,
      priceBearing: PRICE_BEARING,
      transplant: [CREATOR_VAULT],
    });
    expect(r.transplanted).toEqual([CREATOR_VAULT]);
    expect(r.accounts.find((a) => a.pubkey === CREATOR_VAULT)?.lamports).toBe(2_039_280n);
  });

  it('leaves every price-bearing account exactly as the ORIGINAL had it', () => {
    const r = prewarmNonPriceAccounts({
      original,
      afterFirstTrade,
      priceBearing: PRICE_BEARING,
      transplant: [CREATOR_VAULT],
    });
    // This is the whole test. If the quote vault carried 22,039,280 forward,
    // the surface would be measuring the second trade's price, not the first
    // trade's cost — REPEAT wearing PREWARMED's label.
    expect(r.accounts.find((a) => a.pubkey === QUOTE_VAULT)?.dataBase64).toBe('cold-quote');
    expect(r.accounts.find((a) => a.pubkey === QUOTE_VAULT)?.lamports).toBe(2_039_280n);
    expect(r.accounts.find((a) => a.pubkey === BASE_VAULT)?.dataBase64).toBe('cold-base');
    expect(r.accounts.find((a) => a.pubkey === POOL)?.dataBase64).toBe('cold-pool');
  });

  it('REFUSES a price-bearing transplant by name rather than honouring it', () => {
    expect(() =>
      prewarmNonPriceAccounts({
        original,
        afterFirstTrade,
        priceBearing: PRICE_BEARING,
        transplant: [CREATOR_VAULT, QUOTE_VAULT],
      }),
    ).toThrow(PriceStateTransplant);
  });

  it('refuses on the REQUEST, not on whether the account happened to move', () => {
    // The mint is identical in both states. It is still price-bearing, and a
    // check that passed because this particular run did not move it would pass
    // right up until the run where it did.
    expect(() =>
      prewarmNonPriceAccounts({
        original,
        afterFirstTrade,
        priceBearing: PRICE_BEARING,
        transplant: [MINT],
      }),
    ).toThrow(PriceStateTransplant);
  });

  it('reports an account the trade never created rather than inventing it', () => {
    const r = prewarmNonPriceAccounts({
      original,
      afterFirstTrade,
      priceBearing: PRICE_BEARING,
      transplant: ['9kivsjTqAEPWuJWbsGsuo4NxFKRec5Z7tw7W3cTJBEjy'],
    });
    expect(r.transplanted).toEqual([]);
    expect(r.unavailable).toHaveLength(1);
  });

  it('offers only SHARED accounts for warming, because our own rent is a float', () => {
    const shared = sharedAccountsToPrewarm([
      { pubkey: CREATOR_VAULT, sharedWithOtherTraders: true },
      { pubkey: 'ourAta', sharedWithOtherTraders: false },
    ]);
    expect(shared).toEqual([CREATOR_VAULT]);
  });
});

describe('30 — the scope context is complete, so a real account is not UNKNOWN', () => {
  const roles = swapAccountRoles({
    user: TAKER,
    baseMint: MINT,
    coinCreator: CREATOR,
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  });

  const ctx: ScopeContext = {
    taker: TAKER,
    takerBaseAta: 'ownBaseAta1111111111111111111111111111111111',
    takerQuoteAta: 'ownQuoteAta111111111111111111111111111111111',
    pool: POOL,
    poolBaseVault: BASE_VAULT,
    poolQuoteVault: QUOTE_VAULT,
    baseMint: MINT,
    quoteMint: 'So11111111111111111111111111111111111111112',
    coinCreator: CREATOR,
    coinCreatorVaultAta: roles.coinCreatorVaultAta,
    coinCreatorVaultAuthority: roles.coinCreatorVaultAuthority,
    userVolumeAccumulator: roles.userVolumeAccumulator,
    globalVolumeAccumulator: roles.globalVolumeAccumulator,
    accumulatorWsolAta: roles.accumulatorWsolAta,
    poolV2: roles.poolV2,
  };

  const classify = (pubkey: string) =>
    classifyCreatedAccount(
      { pubkey, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', space: 165, lamports: 2_039_280n },
      ctx,
    );

  it('derives every role the SDK actually appends', () => {
    expect(roles.userVolumeAccumulator).not.toBeNull();
    expect(roles.accumulatorWsolAta).not.toBeNull();
    expect(roles.coinCreatorVaultAta).not.toBeNull();
    expect(roles.coinCreatorVaultAuthority).not.toBeNull();
    expect(roles.poolV2).not.toBeNull();
    // Distinct accounts, not one address wearing five names.
    const all = [
      roles.userVolumeAccumulator,
      roles.accumulatorWsolAta,
      roles.coinCreatorVaultAta,
      roles.coinCreatorVaultAuthority,
      roles.poolV2,
      roles.globalVolumeAccumulator,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('names the accumulator WSOL ATA as ours, per quote mint, and NOT recoverable', () => {
    // Cashback lands here. Only claim_cashback moves it, and we cannot sign for
    // the PDA that owns it — so the rent is paid once and never returns.
    const a = classify(roles.accumulatorWsolAta as string);
    expect(a.scope).toBe('WALLET_QUOTE_MINT');
    expect(a.recoverability).toBe('NOT_RECOVERABLE');
    // Nobody else's transaction opens OUR accumulator's ATA.
    expect(a.sharedWithOtherTraders).toBe(false);
  });

  it('names the pool-v2 PDA as shared, because the next trader gets it free', () => {
    const a = classify(roles.poolV2 as string);
    expect(a.scope).toBe('MINT_SPECIFIC');
    expect(a.sharedWithOtherTraders).toBe(true);
  });

  it('names the creator vault as ours to pay for and theirs to close', () => {
    const a = classify(roles.coinCreatorVaultAta as string);
    expect(a.scope).toBe('CREATOR_QUOTE_MINT');
    expect(a.recoverability).toBe('RECOVERABLE_BY_OTHER');
    expect(a.sharedWithOtherTraders).toBe(true);
  });

  it('still refuses to guess: an address matching no role is UNKNOWN', () => {
    const a = classify('D1Eijw8vMeco5cJjCjSJyDFJL8oMemTwxSLEKgr6eHvq');
    expect(a.scope).toBe('UNKNOWN');
    expect(a.recoverability).toBe('UNKNOWN');
  });

  it('a user that does not decode yields null roles, never a placeholder address', () => {
    const bad = swapAccountRoles({ user: 'not-a-pubkey', baseMint: 'also-not-one' });
    expect(bad.userVolumeAccumulator).toBeNull();
    expect(bad.accumulatorWsolAta).toBeNull();
    expect(bad.poolV2).toBeNull();
  });
});

describe('P6 — the compute limit is measured, and the margin is frozen', () => {
  it('requests measured use plus the frozen margin', () => {
    const plan = frozenComputeLimit(100_000);
    expect(plan?.requestedUnits).toBe(120_000);
    expect(plan?.marginPct).toBe(FROZEN_CU_MARGIN_PCT);
    expect(plan?.derivedFromMeasurement).toBe(true);
  });

  it('returns null when nothing was measured, rather than a default', () => {
    // A guessed limit is indistinguishable in the transaction from a measured
    // one and costs real lamports if it is wrong in either direction.
    expect(frozenComputeLimit(null)).toBeNull();
    expect(frozenComputeLimit(0)).toBeNull();
  });

  it('floors a tiny leg, because 20% of nothing is no headroom', () => {
    expect(frozenComputeLimit(1_000)?.requestedUnits).toBe(MIN_REQUESTED_CU);
  });

  it('clamps at the chain maximum and says it clamped', () => {
    const plan = frozenComputeLimit(1_390_000);
    expect(plan?.requestedUnits).toBe(1_400_000);
    expect(plan?.clamped).toBe(true);
  });

  it('prices what omitting the limit actually costs', () => {
    // Five non-builtin instructions derive 1,000,000 units; the leg used 90,000.
    const plan = frozenComputeLimit(90_000);
    const s = priorityFeeSaving({
      plan: plan as NonNullable<typeof plan>,
      derivedUnits: 1_000_000,
      unitPriceMicroLamports: 10_000n,
    });
    expect(s.withoutLimitLamports).toBe(10_000n);
    expect(s.withLimitLamports).toBe(1_080n);
    expect(s.savedLamports).toBe(8_920n);
  });

  it('reports no saving at a zero unit price, because there is none', () => {
    const plan = frozenComputeLimit(90_000);
    const s = priorityFeeSaving({
      plan: plan as NonNullable<typeof plan>,
      derivedUnits: 1_000_000,
      unitPriceMicroLamports: 0n,
    });
    expect(s.savedLamports).toBe(0n);
  });
});
