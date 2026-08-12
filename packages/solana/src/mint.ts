import { base58Encode } from './base58.js';

/**
 * SPL Token and Token-2022 mint account decoding.
 *
 * This decoder answers exactly one question: is this mint's own on-chain
 * configuration capable of taking our position away from us? Mint authority,
 * freeze authority, transfer fees, transfer hooks, permanent delegates and
 * pause switches are all mechanisms by which a token can be made unsellable
 * or silently taxed after we have bought it.
 *
 * It fails CLOSED. An extension we do not recognise is treated as a reason to
 * refuse the token, never as a field to skip, because the entire value of this
 * check is that it cannot be bypassed by a mechanism we have not read about.
 */

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const BASE_MINT_LEN = 82;
/** Token-2022 pads the mint to the base Account length before the TLV area. */
const ACCOUNT_TYPE_OFFSET = 165;
const TLV_START = 166;
const ACCOUNT_TYPE_MINT = 1;

/**
 * Highest extension discriminant this decoder was written against.
 * Verified 2026-08-11 against the spl-token-2022 interface. Note that 28
 * (PermissionedBurn) is absent from the solana.com documentation; a decoder
 * built from the docs alone would wrongly reject valid mints.
 */
export const MAX_KNOWN_EXTENSION = 28;

export const EXTENSION_NAMES: Readonly<Record<number, string>> = {
  0: 'Uninitialized',
  1: 'TransferFeeConfig',
  2: 'TransferFeeAmount',
  3: 'MintCloseAuthority',
  4: 'ConfidentialTransferMint',
  5: 'ConfidentialTransferAccount',
  6: 'DefaultAccountState',
  7: 'ImmutableOwner',
  8: 'MemoTransfer',
  9: 'NonTransferable',
  10: 'InterestBearingConfig',
  11: 'CpiGuard',
  12: 'PermanentDelegate',
  13: 'NonTransferableAccount',
  14: 'TransferHook',
  15: 'TransferHookAccount',
  16: 'ConfidentialTransferFeeConfig',
  17: 'ConfidentialTransferFeeAmount',
  18: 'MetadataPointer',
  19: 'TokenMetadata',
  20: 'GroupPointer',
  21: 'TokenGroup',
  22: 'GroupMemberPointer',
  23: 'TokenGroupMember',
  24: 'ConfidentialMintBurn',
  25: 'ScaledUiAmount',
  26: 'Pausable',
  27: 'PausableAccount',
  28: 'PermissionedBurn',
};

/**
 * Extensions that can make a held position unsellable, silently taxed, or
 * seizable. Presence of any of these is a hard refusal, not a risk weight.
 */
const HOSTILE_EXTENSIONS: ReadonlySet<number> = new Set([
  9, // NonTransferable — the position can never be sold
  12, // PermanentDelegate — the issuer can move our tokens at will
  14, // TransferHook — arbitrary program runs on transfer, can block the sell
  26, // Pausable — transfers can be switched off after we buy
  28, // PermissionedBurn — the issuer can destroy our balance
]);

export interface ExtensionEntry {
  readonly discriminant: number;
  readonly name: string;
  readonly length: number;
  readonly offset: number;
}

export interface TransferFee {
  readonly basisPoints: number;
  readonly maximumFee: bigint;
}

export interface DecodedMint {
  readonly programId: string;
  readonly mintAuthority: string | null;
  readonly supply: bigint;
  readonly decimals: number;
  readonly isInitialized: boolean;
  readonly freezeAuthority: string | null;
  readonly extensions: readonly ExtensionEntry[];
  /** Fee applied to every transfer, including our exit. */
  readonly transferFee: TransferFee | null;
  readonly hostileExtensions: readonly string[];
}

export class MintDecodeError extends Error {
  constructor(
    readonly reason:
      | 'wrong_length'
      | 'not_initialized'
      | 'unknown_extension'
      | 'malformed_tlv'
      | 'wrong_account_type'
      | 'unknown_program',
    message: string,
  ) {
    super(message);
    this.name = 'MintDecodeError';
  }
}

function readU32LE(b: Uint8Array, o: number): number {
  return (
    (b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16) | ((b[o + 3] as number) << 24)
  ) >>> 0;
}

function readU16LE(b: Uint8Array, o: number): number {
  return ((b[o] as number) | ((b[o + 1] as number) << 8)) >>> 0;
}

function readU64LE(b: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i] as number);
  return v;
}

function readPubkey(b: Uint8Array, o: number): string {
  return base58Encode(b.subarray(o, o + 32));
}

/**
 * COption<Pubkey>: a 4-byte little-endian tag followed by the key. Only 0 and 1
 * are valid tags; anything else means we are not looking at what we think we
 * are looking at, and guessing would be worse than refusing.
 */
function readCOptionPubkey(b: Uint8Array, tagOffset: number): string | null {
  const tag = readU32LE(b, tagOffset);
  if (tag === 0) return null;
  if (tag !== 1) throw new MintDecodeError('malformed_tlv', `invalid COption tag ${tag} at ${tagOffset}`);
  return readPubkey(b, tagOffset + 4);
}

export function decodeMint(data: Uint8Array, programId: string): DecodedMint {
  if (programId !== TOKEN_PROGRAM && programId !== TOKEN_2022_PROGRAM) {
    throw new MintDecodeError('unknown_program', `mint owned by unrecognised program ${programId}`);
  }
  if (data.length < BASE_MINT_LEN) {
    throw new MintDecodeError('wrong_length', `mint account is ${data.length} bytes, need >= ${BASE_MINT_LEN}`);
  }

  const mintAuthority = readCOptionPubkey(data, 0);
  const supply = readU64LE(data, 36);
  const decimals = data[44] as number;
  const isInitialized = data[45] === 1;
  const freezeAuthority = readCOptionPubkey(data, 46);

  if (!isInitialized) {
    throw new MintDecodeError('not_initialized', 'mint account is not initialized');
  }
  if (decimals > 18) {
    // Not illegal on-chain, but every downstream amount conversion assumes a
    // sane exponent; refusing is cheaper than an overflow we discover later.
    throw new MintDecodeError('malformed_tlv', `implausible decimals ${decimals}`);
  }

  const extensions: ExtensionEntry[] = [];
  let transferFee: TransferFee | null = null;

  if (programId === TOKEN_2022_PROGRAM && data.length > BASE_MINT_LEN) {
    if (data.length <= ACCOUNT_TYPE_OFFSET) {
      throw new MintDecodeError('wrong_length', `token-2022 mint truncated at ${data.length} bytes`);
    }
    const accountType = data[ACCOUNT_TYPE_OFFSET] as number;
    if (accountType !== ACCOUNT_TYPE_MINT) {
      throw new MintDecodeError('wrong_account_type', `account type ${accountType} is not a mint`);
    }

    let cursor = TLV_START;
    while (cursor + 4 <= data.length) {
      const discriminant = readU16LE(data, cursor);
      const length = readU16LE(data, cursor + 2);
      const valueStart = cursor + 4;

      // Uninitialized marks the end of the populated TLV area.
      if (discriminant === 0 && length === 0) break;

      if (valueStart + length > data.length) {
        throw new MintDecodeError(
          'malformed_tlv',
          `extension ${discriminant} claims ${length} bytes past end of account`,
        );
      }
      if (discriminant > MAX_KNOWN_EXTENSION) {
        // The point of this decoder is that an unread mechanism cannot slip
        // past it. Skipping the unknown entry would defeat that entirely.
        throw new MintDecodeError(
          'unknown_extension',
          `extension discriminant ${discriminant} is newer than this decoder (max known ${MAX_KNOWN_EXTENSION})`,
        );
      }

      extensions.push({
        discriminant,
        name: EXTENSION_NAMES[discriminant] ?? `Unnamed(${discriminant})`,
        length,
        offset: valueStart,
      });

      // TransferFeeConfig, 108 bytes:
      //   config authority (OptionalNonZeroPubkey, a bare 32-byte key where
      //   all-zero means None — NOT a 4-byte-tagged COption) + withdraw
      //   authority (32) + withheld amount (8) + older fee (18) + newer fee
      //   (18), each fee being epoch(8) maximumFee(8) basisPoints(2).
      // The newer config is what a transfer today pays.
      if (discriminant === 1 && length >= 108) {
        const newerOffset = valueStart + 32 + 32 + 8 + 18;
        transferFee = {
          maximumFee: readU64LE(data, newerOffset + 8),
          basisPoints: readU16LE(data, newerOffset + 16),
        };
      }

      cursor = valueStart + length;
    }
  }

  const hostileExtensions = extensions
    .filter((e) => HOSTILE_EXTENSIONS.has(e.discriminant))
    .map((e) => e.name);

  return {
    programId,
    mintAuthority,
    supply,
    decimals,
    isInitialized,
    freezeAuthority,
    extensions,
    transferFee,
    hostileExtensions,
  };
}
