import { describe, it, expect } from 'vitest';
import {
  seedActor,
  seedRequirement,
  sharedActorCaveat,
  REPLAY_ACTOR,
  SEED_LAMPORT_HEADROOM,
} from '../../packages/pipeline/src/replay-actor.js';
import { isValidPubkey } from '../../packages/solana/src/base58.js';
import { decodeTokenAccountAmount } from '../../packages/solana/src/tokenaccount.js';
import type { ReplayStep } from '../../packages/pipeline/src/event-replay.js';
import { TOKEN_PROGRAM } from '../../packages/solana/src/pda.js';

/**
 * Item 49 — the actor that stands in for the traders we never snapshot.
 *
 * The decisive question is whether seeding it corrupts the pool's economics.
 * It does not, and the reason is specific: the base tokens mainnet sellers sold
 * ALREADY EXIST in the mint's supply, held by accounts our snapshot never
 * fetched. Modelling those holders is not minting.
 */

// The real constant, not a copy. A test double written against a value the
// repository does not actually use produces failures that look like defects.
const MINT = 'So11111111111111111111111111111111111111112';

const step = (kind: 'BUY' | 'SELL', inputAmount: bigint): ReplayStep => ({
  signature: `s${kind}${inputAmount}`,
  slot: 1,
  kind,
  inputAmount,
});

describe('49 — the actor holds exactly what the plan spends', () => {
  it('sums buys into lamports and sells into base atoms', () => {
    expect(seedRequirement([step('BUY', 100n), step('SELL', 7n), step('BUY', 50n)])).toEqual({
      quoteLamports: 150n,
      baseAtoms: 7n,
    });
  });

  it('sums the WHOLE plan up front rather than topping up mid-replay', () => {
    // A mid-replay top-up is a state transplant landing between two trades, and
    // the pool would then be priced against reserves a transplant produced.
    const seed = seedActor({
      steps: [step('SELL', 10n), step('BUY', 100n), step('SELL', 5n)],
      baseMint: MINT,
      baseTokenProgram: TOKEN_PROGRAM,
    });
    expect(seed.baseAtomsSeeded).toBe(15n);
    expect(seed.lamportsSeeded).toBe(100n + SEED_LAMPORT_HEADROOM);
  });

  it('funds headroom over the trade inputs, because fees and rent are not in them', () => {
    // An actor funded to the exact sum fails on the first event, and a replay
    // that failed for lack of lamports would look like a market refusal.
    const seed = seedActor({ steps: [step('BUY', 1n)], baseMint: MINT, baseTokenProgram: TOKEN_PROGRAM });
    expect(seed.lamportsSeeded).toBeGreaterThan(1n);
  });

  it('uses a real 32-byte pubkey, so nothing downstream rejects it', () => {
    expect(isValidPubkey(REPLAY_ACTOR)).toBe(true);
  });
});

describe('49 — seeding does NOT touch the mint', () => {
  it('adds only the actor and its ATA', () => {
    // Market cap is quoteReserve × supply / baseReserve and the fee tier is
    // selected from market cap, so inflating supply would silently move the
    // replayed trades into a tier mainnet never used.
    const seed = seedActor({
      steps: [step('SELL', 42n)],
      baseMint: MINT,
      baseTokenProgram: TOKEN_PROGRAM,
    });
    expect(seed.accounts.map((a) => a.pubkey).sort()).toEqual([REPLAY_ACTOR, seed.baseAta].sort());
    expect(seed.accounts.some((a) => a.pubkey === MINT)).toBe(false);
  });

  it('writes the seeded amount into a real token account layout', () => {
    const seed = seedActor({ steps: [step('SELL', 42n)], baseMint: MINT, baseTokenProgram: TOKEN_PROGRAM });
    const ata = seed.accounts.find((a) => a.pubkey === seed.baseAta);
    expect(ata?.owner).toBe(TOKEN_PROGRAM);
    expect(decodeTokenAccountAmount(Buffer.from(ata?.dataBase64 ?? '', 'base64'))).toBe(42n);
  });

  it('makes the ATA rent-exempt, so the runtime cannot reap it mid-replay', () => {
    const seed = seedActor({ steps: [step('SELL', 1n)], baseMint: MINT, baseTokenProgram: TOKEN_PROGRAM });
    const ata = seed.accounts.find((a) => a.pubkey === seed.baseAta);
    expect(ata?.lamports).toBeGreaterThan(0n);
  });

  it('carries the extensions a Token-2022 mint requires of its accounts', () => {
    // An account written without them is rejected by the program in a way that
    // reads as a route failure.
    const plain = seedActor({ steps: [step('SELL', 1n)], baseMint: MINT, baseTokenProgram: TOKEN_PROGRAM });
    const ext = seedActor({
      steps: [step('SELL', 1n)],
      baseMint: MINT,
      baseTokenProgram: TOKEN_PROGRAM,
      baseAccountExtensions: [{ kind: 'immutable_owner' }],
    });
    const len = (s: typeof plain) =>
      Buffer.from(s.accounts.find((a) => a.pubkey === s.baseAta)?.dataBase64 ?? '', 'base64').length;
    expect(len(ext)).toBeGreaterThan(len(plain));
  });
});

describe('49 — the actor refuses rather than guessing', () => {
  it('refuses an unknown token program instead of defaulting to legacy', () => {
    const seed = seedActor({ steps: [step('SELL', 1n)], baseMint: MINT, baseTokenProgram: null });
    expect(seed.refusals.map((r) => r.code)).toEqual(['SEED_TOKEN_PROGRAM_UNKNOWN']);
    expect(seed.accounts).toEqual([]);
  });

  it('refuses a base requirement that does not fit a u64', () => {
    const seed = seedActor({
      steps: [step('SELL', 0xffff_ffff_ffff_ffffn), step('SELL', 1n)],
      baseMint: MINT,
      baseTokenProgram: TOKEN_PROGRAM,
    });
    expect(seed.refusals.map((r) => r.code)).toEqual(['SEED_AMOUNT_UNREPRESENTABLE']);
    expect(seed.accounts).toEqual([]);
  });
});

describe('49 — the one thing a shared actor gets wrong is stated, not adjusted', () => {
  it('names the per-user volume accumulator caveat when events ran', () => {
    // Cashback accrues against a PER-USER accumulator. One wallet concentrates
    // volume mainnet spread across many, so cashback during the hold is not
    // measurable from this replay — and saying so beats correcting for it.
    const c = sharedActorCaveat([step('BUY', 1n)]);
    expect(c).toContain('volume');
    expect(c).toContain('cashback');
  });

  it('says nothing when no event ran, because there is nothing to caveat', () => {
    expect(sharedActorCaveat([])).toBeNull();
  });
});
