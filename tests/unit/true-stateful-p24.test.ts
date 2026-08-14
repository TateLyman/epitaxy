import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { classifyRoundTrip, selfImpactBps } from '../../packages/domain/src/statefulness.js';
import {
  accountSourceOf,
  overlaySource,
  quoteSellFrom,
  poolAddressesFrom,
  poolFactsFrom,
  canonicalPool,
  swapAccountAddresses,
  OfflineStateIncomplete,
} from '../../packages/solana/src/pumpswap-offline.js';

/**
 * P24 items 1–3 — the corrections this directive exists for.
 *
 * All three fail against `3bc708d`, where `classifyRoundTrip` and
 * `pumpswap-offline.ts` did not exist and the only thing distinguishing a
 * sequential round trip from two independent markets sharing a wallet was the
 * word "stateful" in a filename.
 */

const FIXTURE = 'tests/fixtures/pumpswap-selfimpact.json';

interface FixtureAccount {
  pubkey: string;
  owner: string;
  dataBase64: string;
  lamports: string;
}
interface Fixture {
  mint: string;
  pool: string;
  baseVault: string;
  quoteVault: string;
  buyLamports: string;
  acquiredAtoms: string;
  preBuy: FixtureAccount[];
  postBuy: FixtureAccount[];
}

describe('P24 item 1 — linked fresh-state legs are not called stateful', () => {
  it('classifies a mainnet-priced exit as LINKED_FRESH_STATE_LEGS', () => {
    // Exactly the shape of the invalidated proof: the wallet inventory carried,
    // and every account that decides the PRICE re-read from the chain.
    const c = classifyRoundTrip({
      entryCommitted: true,
      exitCommitted: true,
      exitPricedFrom: 'FRESH_MAINNET',
      exitExecutedOn: 'FRESH_MAINNET',
      entryMutatedExitVenue: null,
    });
    expect(c.evidenceClass).toBe('LINKED_FRESH_STATE_LEGS');
    expect(c.usableAsStrategyEvidence).toBe(false);
  });

  it('is not rescued by carrying inventory alone', () => {
    // The precise claim the previous doc made — "the sell starts from the SOL
    // the buy LEFT" — is true and is not the property.
    const c = classifyRoundTrip({
      entryCommitted: true,
      exitCommitted: true,
      exitPricedFrom: 'CARRIED_INVENTORY_ONLY',
      exitExecutedOn: 'CARRIED_INVENTORY_ONLY',
      entryMutatedExitVenue: true,
    });
    expect(c.evidenceClass).toBe('LINKED_FRESH_STATE_LEGS');
    expect(c.usableAsStrategyEvidence).toBe(false);
  });

  it('refuses an exit that EXECUTED on committed state but was PRICED on mainnet', () => {
    // The subtle half. The size, the route and the minimum output were all
    // chosen against depth that no longer exists.
    const c = classifyRoundTrip({
      entryCommitted: true,
      exitCommitted: true,
      exitPricedFrom: 'FRESH_MAINNET',
      exitExecutedOn: 'COMMITTED_PRIOR_STEP',
      entryMutatedExitVenue: true,
    });
    expect(c.evidenceClass).toBe('LINKED_FRESH_STATE_LEGS');
    expect(c.reasons.join(' ')).toContain('priced');
  });

  it('will not call an unmeasured venue overlap sequential', () => {
    const c = classifyRoundTrip({
      entryCommitted: true,
      exitCommitted: true,
      exitPricedFrom: 'COMMITTED_PRIOR_STEP',
      exitExecutedOn: 'COMMITTED_PRIOR_STEP',
      entryMutatedExitVenue: null,
    });
    expect(c.evidenceClass).toBe('SEQUENTIAL_BUT_DISJOINT_VENUE');
    expect(c.usableAsStrategyEvidence).toBe(false);
  });

  it('admits only the complete property', () => {
    const c = classifyRoundTrip({
      entryCommitted: true,
      exitCommitted: true,
      exitPricedFrom: 'COMMITTED_PRIOR_STEP',
      exitExecutedOn: 'COMMITTED_PRIOR_STEP',
      entryMutatedExitVenue: true,
    });
    expect(c.evidenceClass).toBe('TRUE_SEQUENTIAL_ROUND_TRIP');
    expect(c.usableAsStrategyEvidence).toBe(true);
  });

  it('an uncommitted leg is INCOMPLETE, not a zero-PnL trip', () => {
    const c = classifyRoundTrip({
      entryCommitted: true,
      exitCommitted: false,
      exitPricedFrom: 'COMMITTED_PRIOR_STEP',
      exitExecutedOn: 'COMMITTED_PRIOR_STEP',
      entryMutatedExitVenue: true,
    });
    expect(c.evidenceClass).toBe('INCOMPLETE');
    expect(c.usableAsStrategyEvidence).toBe(false);
  });
});

describe('P24 item 2 — the sell is built from the buy-mutated pool state', () => {
  it('an account source that lacks the vaults REFUSES rather than reading zero', () => {
    // The failure mode that would make every other assertion here meaningless:
    // a missing vault silently read as an empty pool prices a sell at nothing
    // and returns a number.
    const src = accountSourceOf([]);
    expect(() => poolAddressesFrom(src, canonicalPool('So11111111111111111111111111111111111111112'))).toThrow(
      OfflineStateIncomplete,
    );
  });

  it('an overlay puts the committed post-state ahead of the snapshot', () => {
    // The mechanism the proof depends on: the same pubkey resolves to the
    // runtime's bytes, not the chain's, wherever the runtime has them.
    const base = accountSourceOf([
      { pubkey: 'A', owner: 'O', dataBase64: 'AAAA', lamports: 1n },
      { pubkey: 'B', owner: 'O', dataBase64: 'BBBB', lamports: 2n },
    ]);
    const over = accountSourceOf([{ pubkey: 'A', owner: 'O', dataBase64: 'ZZZZ', lamports: 9n }]);
    const s = overlaySource(base, over);
    expect(s.get('A')?.dataBase64).toBe('ZZZZ');
    expect(s.get('B')?.dataBase64).toBe('BBBB');
    expect(s.get('C')).toBeNull();
  });

  it('names every account a PumpSwap swap can touch, so the runtime holds them', () => {
    const mint = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
    const user = '11111111111111111111111111111112';
    const pool = canonicalPool(mint);
    const addrs = swapAccountAddresses({ poolKey: pool, baseMint: mint, user });
    expect(addrs).toContain(pool);
    expect(addrs).toContain(mint);
    // The volume accumulator is derived per user and is written by every swap.
    // Omitting it is why a sell that priced correctly still could not run.
    expect(addrs.length).toBeGreaterThanOrEqual(9);
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it.skipIf(!existsSync(FIXTURE))('the captured post-buy vaults differ from the pre-buy vaults', () => {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
    const pre = f.preBuy.find((a) => a.pubkey === f.baseVault);
    const post = f.postBuy.find((a) => a.pubkey === f.baseVault);
    expect(pre).toBeDefined();
    expect(post).toBeDefined();
    // A buy takes base out of the pool. If these bytes were equal the whole
    // sequential claim would be vacuous on this case.
    expect(post?.dataBase64).not.toBe(pre?.dataBase64);
  });
});

describe('P24 item 3 — the committed-state sell differs from the fresh-state sell', () => {
  it('reports the gap with its sign, because the naive expectation is backwards', () => {
    // A buy leaves the pool with less base and more quote, so selling the same
    // atoms back into it fetches MORE, not less. Taking a magnitude here would
    // have hidden the direction, and the direction is the finding.
    expect(selfImpactBps(1_000_000n, 1_002_000n)).toBe(-20);
    expect(selfImpactBps(1_000_000n, 998_000n)).toBe(20);
    expect(selfImpactBps(0n, 5n)).toBeNull();
  });

  it.skipIf(!existsSync(FIXTURE))('quotes the same atoms differently on the two states', () => {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
    const toRec = (a: FixtureAccount) => ({
      pubkey: a.pubkey,
      owner: a.owner,
      dataBase64: a.dataBase64,
      lamports: BigInt(a.lamports),
    });
    const pre = accountSourceOf(f.preBuy.map(toRec));
    const post = overlaySource(pre, accountSourceOf(f.postBuy.map(toRec)));
    const atoms = BigInt(f.acquiredAtoms);

    const qPre = quoteSellFrom(pre, f.pool, atoms, 3);
    const qPost = quoteSellFrom(post, f.pool, atoms, 3);

    // The reserves the two quotes ran against are genuinely different.
    expect(qPost.poolBaseReserve).not.toBe(qPre.poolBaseReserve);
    expect(qPost.quoteOutLamports).not.toBe(qPre.quoteOutLamports);

    // And the difference is in the direction the AMM requires: the buy removed
    // base and added quote, so the post-buy pool pays more for the same atoms.
    expect(qPost.poolBaseReserve).toBeLessThan(qPre.poolBaseReserve);
    expect(qPost.quoteOutLamports).toBeGreaterThan(qPre.quoteOutLamports);
    expect(selfImpactBps(qPre.quoteOutLamports, qPost.quoteOutLamports)).toBeLessThan(0);
  });

  it.skipIf(!existsSync(FIXTURE))('reads the reserves from the vault bytes, not from the pool account', () => {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
    const src = accountSourceOf(
      f.preBuy.map((a) => ({
        pubkey: a.pubkey,
        owner: a.owner,
        dataBase64: a.dataBase64,
        lamports: BigInt(a.lamports),
      })),
    );
    const facts = poolFactsFrom(src, f.pool);
    expect(facts.poolBaseTokenAccount).toBe(f.baseVault);
    expect(facts.poolQuoteTokenAccount).toBe(f.quoteVault);
    expect(facts.baseReserve).toBeGreaterThan(0n);
    // The EFFECTIVE quote reserve is raw + virtual; a canonical pool carries a
    // non-trivial virtual component and pricing on the vault alone misprices it.
    expect(facts.quoteReserveRaw).toBeGreaterThan(0n);
  });
});
