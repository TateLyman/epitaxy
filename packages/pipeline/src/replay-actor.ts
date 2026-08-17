import { encodeTokenAccount, TOKEN_ACCOUNT_RENT_LAMPORTS, type TokenAccountExtension } from '../../solana/src/tokenaccount.js';
import { associatedTokenAddressOf } from '../../solana/src/pumpswap-offline.js';
import type { FrozenAccount } from '../../simulator/src/sequential-runtime.js';
import type { ReplayStep } from './event-replay.js';

/**
 * Item 49 — the actor that stands in for everyone who traded during the hold.
 *
 * The intervening trades were made by wallets we never snapshot. To push them
 * through the local pool, somebody local has to hold the inputs.
 *
 * ## Why seeding base tokens does NOT inflate the supply
 *
 * This is the question that decides whether the whole construction is honest.
 *
 * The base tokens that mainnet sellers sold into the pool ALREADY EXIST. They
 * are counted in the mint's `supply` field, and they sit in holder accounts
 * that our snapshot never fetched — we snapshot the pool, not the holders. So
 * giving the replay actor those tokens does not create supply; it MODELS the
 * holders we did not fetch. The mint account is therefore left completely
 * alone, and that is the correct accounting, not an omission.
 *
 * Touching `supply` would be the error: market cap is
 * `quoteReserve × supply / baseReserve`, the fee tier is selected from market
 * cap, and inflating supply would silently move the trade into a different fee
 * tier than mainnet used.
 *
 * ## Why one actor and not one per trade
 *
 * Each additional funded wallet is another account in the snapshot and another
 * ATA the runtime has to create. The pool's arithmetic does not depend on who
 * the taker is — only on the amounts — with one exception: the per-user volume
 * accumulator, which affects cashback. That exception is named in
 * `sharedActorCaveat` rather than left for someone to discover.
 */

/** Deterministic, and outside any real keypair. See `REPLAY_ACTOR`. */
export const REPLAY_ACTOR = 'RepLay1111111111111111111111111111111111111';

export type SeedRefusal =
  /** A step's input is not an amount we can hold. */
  | 'SEED_AMOUNT_UNREPRESENTABLE'
  /** The base mint's token program was not identified, so the ATA cannot be built. */
  | 'SEED_TOKEN_PROGRAM_UNKNOWN';

export interface ActorSeed {
  readonly actor: string;
  readonly baseAta: string;
  /** Accounts to ADD to the runtime snapshot. Nothing existing is modified. */
  readonly accounts: readonly FrozenAccount[];
  readonly baseAtomsSeeded: bigint;
  readonly lamportsSeeded: bigint;
  readonly refusals: readonly { readonly code: SeedRefusal; readonly detail: string }[];
}

/**
 * What the actor must hold to execute every step in the plan.
 *
 * Summed over the WHOLE plan up front rather than topped up between events: a
 * mid-replay top-up is a state transplant landing between two trades, and the
 * pool would then be priced against reserves that a transplant, not a trade,
 * produced.
 */
export function seedRequirement(steps: readonly ReplayStep[]): { baseAtoms: bigint; quoteLamports: bigint } {
  let baseAtoms = 0n;
  let quoteLamports = 0n;
  for (const s of steps) {
    if (s.kind === 'SELL') baseAtoms += s.inputAmount;
    else quoteLamports += s.inputAmount;
  }
  return { baseAtoms, quoteLamports };
}

/**
 * Headroom over the exact trade inputs.
 *
 * Every replayed buy pays a base fee, a priority fee, and rent for any account
 * it creates, none of which is in the trade's input amount. An actor funded to
 * the exact sum fails on the first event, and a replay that fails for lack of
 * lamports would look like a market refusal.
 */
export const SEED_LAMPORT_HEADROOM = 2n * 1_000_000_000n;

export function seedActor(p: {
  readonly steps: readonly ReplayStep[];
  readonly baseMint: string;
  readonly baseTokenProgram: string | null;
  /** Extensions the MINT requires of every account holding it. */
  readonly baseAccountExtensions?: readonly TokenAccountExtension[];
}): ActorSeed {
  const refusals: { code: SeedRefusal; detail: string }[] = [];
  const need = seedRequirement(p.steps);

  if (p.baseTokenProgram === null) {
    // Refused rather than defaulted to the legacy program. A Token-2022 mint
    // whose account was written with the legacy layout is rejected by the
    // program in a way that reads as a route failure.
    refusals.push({ code: 'SEED_TOKEN_PROGRAM_UNKNOWN', detail: `no token program for ${p.baseMint}` });
    return {
      actor: REPLAY_ACTOR,
      baseAta: '',
      accounts: [],
      baseAtomsSeeded: 0n,
      lamportsSeeded: 0n,
      refusals,
    };
  }

  if (need.baseAtoms > 0xffff_ffff_ffff_ffffn) {
    refusals.push({ code: 'SEED_AMOUNT_UNREPRESENTABLE', detail: `${need.baseAtoms} atoms exceeds a u64` });
  }

  const baseAta = associatedTokenAddressOf(REPLAY_ACTOR, p.baseMint, p.baseTokenProgram);
  const lamports = need.quoteLamports + SEED_LAMPORT_HEADROOM;

  const accounts: FrozenAccount[] =
    refusals.length > 0
      ? []
      : [
          {
            pubkey: REPLAY_ACTOR,
            dataBase64: '',
            owner: '11111111111111111111111111111111',
            lamports,
          },
          {
            pubkey: baseAta,
            dataBase64: Buffer.from(
              encodeTokenAccount({
                mint: p.baseMint,
                owner: REPLAY_ACTOR,
                amount: need.baseAtoms,
                extensions: p.baseAccountExtensions,
              }),
            ).toString('base64'),
            owner: p.baseTokenProgram,
            // Rent-exempt, like every real ATA. An account below the threshold
            // is one the runtime may reap between two replayed events.
            lamports: TOKEN_ACCOUNT_RENT_LAMPORTS,
          },
        ];

  return {
    actor: REPLAY_ACTOR,
    baseAta,
    accounts,
    baseAtomsSeeded: need.baseAtoms,
    lamportsSeeded: lamports,
    refusals,
  };
}

/**
 * The one way a single shared actor is not equivalent to many distinct traders.
 *
 * PumpSwap keeps a PER-USER volume accumulator, and cashback accrues against
 * it. Running every intervening trade through one wallet concentrates volume
 * that mainnet spread across many, so the accumulator's path differs even
 * though the pool's reserves do not.
 *
 * This does not affect the reserve trajectory, which is what the exit is priced
 * from. It DOES affect any claim about cashback earned during the hold, so that
 * claim is refused rather than adjusted.
 */
export function sharedActorCaveat(steps: readonly ReplayStep[]): string | null {
  if (steps.length === 0) return null;
  return (
    `${steps.length} intervening trade(s) ran through one actor, so the per-user volume ` +
    'accumulator followed a path mainnet did not. Reserve trajectory is unaffected; ' +
    'cashback accrued during the hold is not measurable from this replay.'
  );
}
