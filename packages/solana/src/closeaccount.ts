/**
 * The SPL Token `CloseAccount` instruction.
 *
 * At a 0.02 SOL notional the associated account's rent is roughly 2,039,280
 * lamports — about ten percent of the leg. Treating it as sunk understates
 * every trade by that amount; assuming it always returns overstates every
 * trade by the same. It returns when, and only when, the account is closed,
 * and closing has preconditions the chain enforces.
 *
 * Appended to the exit transaction rather than sent as its own, because a
 * separate transaction costs another signature — 5,000 lamports to recover
 * 2,039,280 is still worth it, but it is also another thing that can fail
 * after the position is already flat.
 */

import { base58Decode, base58Encode } from './base58.js';

/** Instruction index 9 in the SPL Token program. Same in Token-2022. */
export const CLOSE_ACCOUNT_IX = 9;

export interface CloseAccountInstruction {
  readonly programId: string;
  readonly accounts: readonly { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  /** Base64, matching how the build response carries instruction data. */
  readonly data: string;
}

export class CannotClose extends Error {
  constructor(reason: string) {
    super(`refusing to build a close: ${reason}`);
    this.name = 'CannotClose';
  }
}

/**
 * Build the close.
 *
 * Refuses on the conditions the runtime would refuse on anyway, so the failure
 * is ours to read here rather than an opaque instruction error later:
 *
 *   a non-empty account cannot be closed
 *   withheld transfer fees must be harvested first
 *   the authority must actually be the owner
 */
export function buildCloseAccount(p: {
  tokenAccount: string;
  destination: string;
  owner: string;
  tokenProgram: string;
  residualAtoms: bigint;
  withheldAtoms: bigint;
  /**
   * Wrapped SOL, where a non-zero balance is not an obstacle.
   *
   * `CloseAccount` on a native account is the documented way to UNWRAP: the
   * program transfers the whole lamport balance to the destination and closes.
   * Applying the non-empty refusal to it would make the exit unable to convert
   * its own proceeds back to spendable SOL, so the proceeds would sit wrapped
   * and every measured round trip would read as a total loss of them.
   *
   * It is a separate flag rather than a mint comparison because the caller is
   * the only one that knows whether the account it holds is the native one.
   */
  isNativeWrappedSol?: boolean;
}): CloseAccountInstruction {
  const native = p.isNativeWrappedSol === true;
  if (p.residualAtoms !== 0n && !native) {
    throw new CannotClose(`${p.residualAtoms} atoms remain; CloseAccount fails on a non-empty account`);
  }
  if (p.withheldAtoms !== 0n) {
    throw new CannotClose(
      `${p.withheldAtoms} atoms of withheld transfer fee remain; they must be harvested to the mint first`,
    );
  }
  for (const [name, key] of [
    ['token account', p.tokenAccount],
    ['destination', p.destination],
    ['owner', p.owner],
    ['token program', p.tokenProgram],
  ] as const) {
    if (base58Decode(key).length !== 32) throw new CannotClose(`${name} is not a 32-byte address`);
  }

  return {
    programId: p.tokenProgram,
    accounts: [
      { pubkey: p.tokenAccount, isSigner: false, isWritable: true },
      // Where the rent goes. The owner, so the recovery lands with the payer.
      { pubkey: p.destination, isSigner: false, isWritable: true },
      { pubkey: p.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(Uint8Array.from([CLOSE_ACCOUNT_IX])).toString('base64'),
  };
}

/** Round-trips an address, so a malformed key fails here rather than on chain. */
export function normalizeAddress(key: string): string {
  const bytes = base58Decode(key);
  if (bytes.length !== 32) throw new CannotClose(`${key.slice(0, 12)} is not a 32-byte address`);
  return base58Encode(bytes);
}
