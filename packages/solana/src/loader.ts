import { base58Encode } from './base58.js';

/**
 * Upgradeable loader state, decoded from account bytes.
 *
 * §7.2 — "an upgradeable program state is not merely an executable account".
 * The account at a program's address does not contain its code. Under
 * BPFLoaderUpgradeable it contains a four-byte enum and a pointer to a second
 * account, and the ELF lives there behind a 45-byte header.
 *
 * This matters because a snapshot cannot restore a program without its code:
 * `setAccount` has no executable parameter, so a program must go through
 * `deploy()` with real ELF bytes or the route through it fails with an
 * invalid-program error that reads as a fact about the token.
 *
 * Bincode layout, from the Agave loader:
 *
 *   enum UpgradeableLoaderState {
 *     Uninitialized,                                            // 0
 *     Buffer { authority: Option<Pubkey> },                      // 1
 *     Program { programdata_address: Pubkey },                   // 2
 *     ProgramData { slot: u64, upgrade_authority: Option<Pubkey> } // 3, then ELF
 *   }
 *
 * The discriminant is a u32 little-endian. `Option<Pubkey>` is one tag byte
 * followed by 32 bytes when the tag is 1. So ProgramData's header is
 * 4 + 8 + 1 + 32 = 45 bytes, and the ELF starts there.
 *
 * The 32 pubkey bytes are present even when the tag is 0 — bincode reserves the
 * space — so the ELF offset does not move when a program's upgrade authority
 * has been revoked. Getting that wrong would shift every byte of the code.
 */

export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const BPF_LOADER_V2 = 'BPFLoader2111111111111111111111111111111111';
export const BPF_LOADER_V1 = 'BPFLoader1111111111111111111111111111111111';
export const LOADER_V4 = 'LoaderV411111111111111111111111111111111111';
export const NATIVE_LOADER = 'NativeLoader1111111111111111111111111111111';

/** Where the ELF begins inside a ProgramData account. */
export const PROGRAMDATA_HEADER_BYTES = 45;

export class LoaderDecodeError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'LoaderDecodeError';
  }
}

export type LoaderKind = 'upgradeable' | 'v2' | 'v1' | 'v4' | 'native' | 'unknown';

export function loaderKind(owner: string): LoaderKind {
  switch (owner) {
    case BPF_LOADER_UPGRADEABLE:
      return 'upgradeable';
    case BPF_LOADER_V2:
      return 'v2';
    case BPF_LOADER_V1:
      return 'v1';
    case LOADER_V4:
      return 'v4';
    case NATIVE_LOADER:
      return 'native';
    default:
      return 'unknown';
  }
}

/**
 * The programdata address a Program account points at.
 *
 * Fails closed on anything it does not recognise. A program whose state we
 * cannot read is one whose code we cannot freeze, and guessing an address here
 * would produce a snapshot that restores the wrong code.
 */
export function programDataAddress(data: Uint8Array): string {
  if (data.length < 36) {
    throw new LoaderDecodeError('PROGRAM_ACCOUNT_TOO_SHORT', `${data.length} bytes, need at least 36`);
  }
  const disc = (data[0] as number) | ((data[1] as number) << 8) | ((data[2] as number) << 16) | ((data[3] as number) << 24);
  if (disc !== 2) {
    throw new LoaderDecodeError('NOT_A_PROGRAM_ACCOUNT', `discriminant ${disc}, expected 2 (Program)`);
  }
  return base58Encode(data.slice(4, 36));
}

export interface ProgramData {
  readonly slot: bigint;
  /** null when the authority has been revoked — which is a fact, not a missing value. */
  readonly upgradeAuthority: string | null;
  readonly elf: Uint8Array;
}

export function decodeProgramData(data: Uint8Array): ProgramData {
  if (data.length < PROGRAMDATA_HEADER_BYTES) {
    throw new LoaderDecodeError(
      'PROGRAMDATA_TOO_SHORT',
      `${data.length} bytes, need at least ${PROGRAMDATA_HEADER_BYTES}`,
    );
  }
  const disc = (data[0] as number) | ((data[1] as number) << 8) | ((data[2] as number) << 16) | ((data[3] as number) << 24);
  if (disc !== 3) {
    throw new LoaderDecodeError('NOT_A_PROGRAMDATA_ACCOUNT', `discriminant ${disc}, expected 3 (ProgramData)`);
  }
  let slot = 0n;
  for (let i = 11; i >= 4; i--) slot = (slot << 8n) | BigInt(data[i] as number);

  const tag = data[12] as number;
  if (tag !== 0 && tag !== 1) {
    throw new LoaderDecodeError('BAD_OPTION_TAG', `upgrade authority Option tag ${tag}, expected 0 or 1`);
  }
  // The 32 pubkey bytes are reserved whether or not the tag is set, so the ELF
  // offset does not move when an authority has been revoked.
  const upgradeAuthority = tag === 1 ? base58Encode(data.slice(13, 45)) : null;
  const elf = data.slice(PROGRAMDATA_HEADER_BYTES);
  if (elf.length === 0) {
    throw new LoaderDecodeError('EMPTY_ELF', 'the ProgramData account carries no code');
  }
  return { slot, upgradeAuthority, elf };
}

/** ELF magic, so a "program" that is not one is caught rather than deployed. */
export function looksLikeElf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

/**
 * Addresses held by an address lookup table account.
 *
 * §8 — a transaction's account coverage is not its static keys. Everything a
 * lookup table loads is an account the transaction touches, and on a Jupiter
 * route that is where the pools live. A snapshot without them replays into a
 * chain that has no liquidity.
 *
 * `AddressLookupTable` layout:
 *
 *   u32  discriminator (1)
 *   u64  deactivation_slot
 *   u64  last_extended_slot
 *   u8   last_extended_slot_start_index
 *   u8   Option tag for authority
 *   u8[32] authority (reserved whether or not the tag is set)
 *   u8[2]  padding
 *   then 32-byte addresses to the end
 *
 * 56 bytes of header. The remainder must divide by 32 exactly; a table that
 * does not is refused rather than truncated, because a partial read would
 * silently drop the last pool.
 */
export const LOOKUP_TABLE_HEADER_BYTES = 56;

export function lookupTableAddresses(data: Uint8Array): string[] {
  if (data.length < LOOKUP_TABLE_HEADER_BYTES) {
    throw new LoaderDecodeError('LOOKUP_TABLE_TOO_SHORT', `${data.length} bytes, need at least ${LOOKUP_TABLE_HEADER_BYTES}`);
  }
  const disc = (data[0] as number) | ((data[1] as number) << 8) | ((data[2] as number) << 16) | ((data[3] as number) << 24);
  if (disc !== 1) {
    throw new LoaderDecodeError('NOT_A_LOOKUP_TABLE', `discriminant ${disc}, expected 1`);
  }
  const body = data.length - LOOKUP_TABLE_HEADER_BYTES;
  if (body % 32 !== 0) {
    throw new LoaderDecodeError('RAGGED_LOOKUP_TABLE', `${body} address bytes is not a multiple of 32`);
  }
  const out: string[] = [];
  for (let off = LOOKUP_TABLE_HEADER_BYTES; off < data.length; off += 32) {
    out.push(base58Encode(data.slice(off, off + 32)));
  }
  return out;
}
