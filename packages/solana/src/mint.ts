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
  /** The epoch this schedule takes effect from. */
  readonly epoch: bigint;
}

/**
 * Both halves of a Token-2022 transfer fee config, and which one applies.
 *
 * §10.5. The config holds an OLDER and a NEWER schedule, each with the epoch it
 * takes effect from, and `get_epoch_fee(e)` returns the newer only when
 * `e >= newer.epoch`. Reading the newer unconditionally is wrong in exactly the
 * direction that matters: a mint can advertise 0 bps effective next epoch while
 * charging 1,000 bps today, and a decoder that reads only the newer reports a
 * free transfer on a token taking a tenth of every trade.
 *
 * The epoch is not in the mint account, so this decoder cannot say on its own
 * which applies. It reports both and a worst case, and the caller either
 * supplies an epoch or accepts the worst case. It never silently picks one.
 */
export interface TransferFeeConfig {
  readonly older: TransferFee;
  readonly newer: TransferFee;
  /** Fees already withheld in the mint, awaiting withdrawal. */
  readonly withheldAmount: bigint;
}

/** The schedule in force at a given epoch. */
export function transferFeeAtEpoch(config: TransferFeeConfig, epoch: bigint): TransferFee {
  return epoch >= config.newer.epoch ? config.newer : config.older;
}

/**
 * The dearer of the two schedules.
 *
 * What to use when the epoch is unknown. Overstating a cost refuses a trade
 * that might have been fine; understating one takes a trade that was not.
 */
export function worstCaseTransferFee(config: TransferFeeConfig): TransferFee {
  const a = config.older;
  const b = config.newer;
  if (a.basisPoints !== b.basisPoints) return a.basisPoints > b.basisPoints ? a : b;
  return a.maximumFee >= b.maximumFee ? a : b;
}

/**
 * Tokens actually received after the transfer fee.
 *
 * ceil on the fee, so the recipient is never credited a token the fee took.
 */
export function amountAfterTransferFee(amount: bigint, fee: TransferFee): bigint {
  if (amount <= 0n || fee.basisPoints <= 0) return amount;
  const raw = (amount * BigInt(fee.basisPoints) + 9_999n) / 10_000n;
  const charged = raw > fee.maximumFee ? fee.maximumFee : raw;
  return amount - charged;
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
  /** Both schedules and the withheld amount, when the extension is present. */
  readonly transferFeeConfig: TransferFeeConfig | null;
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
  let transferFeeConfig: TransferFeeConfig | null = null;

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
        // config authority (32) + withdraw authority (32) + withheld (8),
        // then older(18) then newer(18), each epoch(8) maximumFee(8) bps(2).
        const withheldOffset = valueStart + 32 + 32;
        const olderOffset = withheldOffset + 8;
        const newerOffset = olderOffset + 18;
        transferFeeConfig = {
          withheldAmount: readU64LE(data, withheldOffset),
          older: {
            epoch: readU64LE(data, olderOffset),
            maximumFee: readU64LE(data, olderOffset + 8),
            basisPoints: readU16LE(data, olderOffset + 16),
          },
          newer: {
            epoch: readU64LE(data, newerOffset),
            maximumFee: readU64LE(data, newerOffset + 8),
            basisPoints: readU16LE(data, newerOffset + 16),
          },
        };
        // Kept for callers that only ever asked "is there a fee". It is the
        // WORST case now, not the newer schedule -- the old behaviour reported a
        // free transfer on a mint charging a tenth of every trade today.
        transferFee = worstCaseTransferFee(transferFeeConfig);
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
    transferFeeConfig,
    hostileExtensions,
  };
}
