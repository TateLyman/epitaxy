import { base58Decode } from './base58.js';

/**
 * P4 — an SPL token account, constructed byte for byte.
 *
 * The Surfpool convenience API takes a JavaScript `number` for token amounts.
 * Refusing to round is right, but it means an ordinary fresh memecoin position
 * cannot be simulated at all: nine decimals against a billion supply is 10^18
 * atoms, three orders of magnitude past exact.
 *
 * Writing the account directly solves that and one other thing. When the
 * cheatcode opens the account, the fee payer carries its rent, and that rent
 * lands in the same net SOL movement the sell's proceeds do — 2,039,280
 * lamports against a 0.02 SOL leg is ten percent of the notional, enough to
 * make a correct sell look like a loss. An account written directly is already
 * rent-exempt and the payer never pays for it, so the question does not arise
 * rather than being adjusted for in two places that disagree.
 *
 * The layout is fixed and is not guessed at:
 *
 * ```
 *   0..32    mint
 *  32..64    owner
 *  64..72    amount            u64 little-endian
 *  72..76    delegate          COption tag
 *  76..108   delegate pubkey
 * 108..109   state             0 uninitialised, 1 initialised, 2 frozen
 * 109..113   isNative          COption tag
 * 113..121   isNative rent
 * 121..129   delegated amount  u64
 * 129..133   close authority   COption tag
 * 133..165   close authority pubkey
 * ```
 *
 * Token-2022 shares that prefix and appends a one-byte account type at 165
 * followed by TLV extensions.
 */

export const TOKEN_ACCOUNT_LEN = 165;
/** `AccountType::Account`. `Mint` is 1, and a mint must never decode as one. */
export const TOKEN_2022_ACCOUNT_TYPE = 2;

const AMOUNT_OFFSET = 64;
const STATE_OFFSET = 108;
const STATE_INITIALIZED = 1;

/** Rent-exempt minimum for a 165-byte account on mainnet. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;
/** Per-byte rent, so an extended account can be priced rather than assumed. */
const LAMPORTS_PER_BYTE_YEAR = 3480n;
const RENT_EXEMPTION_YEARS = 2n;
const ACCOUNT_STORAGE_OVERHEAD = 128n;

export class TokenAccountEncodeError extends Error {
  constructor(reason: string) {
    super(`cannot construct a token account: ${reason}`);
    this.name = 'TokenAccountEncodeError';
  }
}

/**
 * Rent-exempt lamports for an account of this data length.
 *
 * Derived rather than hardcoded, because a Token-2022 account with extensions
 * is longer than 165 and would be under-funded by the constant.
 */
export function rentExemptLamports(dataLen: number): bigint {
  return (BigInt(dataLen) + ACCOUNT_STORAGE_OVERHEAD) * LAMPORTS_PER_BYTE_YEAR * RENT_EXEMPTION_YEARS;
}

function writePubkey(into: Uint8Array, offset: number, pubkey: string, label: string): void {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(pubkey);
  } catch {
    throw new TokenAccountEncodeError(`${label} is not valid base58`);
  }
  if (bytes.length !== 32) throw new TokenAccountEncodeError(`${label} is ${bytes.length} bytes, not 32`);
  into.set(bytes, offset);
}

export interface TokenAccountFields {
  readonly mint: string;
  readonly owner: string;
  /** Raw atoms. A `bigint` throughout: this is the whole point. */
  readonly amount: bigint;
  /**
   * Extensions the MINT requires the account to carry.
   *
   * A Token-2022 mint with a transfer-fee config requires every account to hold
   * a `TransferFeeAmount` extension. An account without it is rejected by the
   * program, so an unknown extension requirement is refused rather than
   * written without it and discovered at runtime.
   */
  readonly extensions?: readonly TokenAccountExtension[];
}

export type TokenAccountExtension =
  /** TLV type 1. Withheld transfer fees, zero on a fresh account. */
  | { readonly kind: 'transfer_fee_amount'; readonly withheldAmount: bigint }
  /** TLV type 7. Immutable owner, which every ATA carries under Token-2022. */
  | { readonly kind: 'immutable_owner' };

const EXTENSION_TYPE: Readonly<Record<TokenAccountExtension['kind'], number>> = {
  transfer_fee_amount: 1,
  immutable_owner: 7,
};

/**
 * Build the exact bytes.
 *
 * Every field is written explicitly, including the ones that are zero. A
 * partially-initialised account is one the token program refuses in a way that
 * looks like a route failure.
 */
export function encodeTokenAccount(f: TokenAccountFields): Uint8Array {
  if (f.amount < 0n) throw new TokenAccountEncodeError('a negative token amount is not a balance');
  if (f.amount > 0xffff_ffff_ffff_ffffn) {
    // u64 is the on-chain type. An amount past it is not a large balance, it is
    // a wrong number, and truncating it would produce a small one silently.
    throw new TokenAccountEncodeError(`amount ${f.amount} does not fit in a u64`);
  }

  const extensions = f.extensions ?? [];
  // Base 165, then the account-type byte, then each extension as
  // type(2) + length(2) + value.
  const extBytes = extensions.reduce((n, e) => n + 4 + (e.kind === 'transfer_fee_amount' ? 8 : 0), 0);
  const len = extensions.length === 0 ? TOKEN_ACCOUNT_LEN : TOKEN_ACCOUNT_LEN + 1 + extBytes;
  const data = new Uint8Array(len);
  const view = new DataView(data.buffer);

  writePubkey(data, 0, f.mint, 'mint');
  writePubkey(data, 32, f.owner, 'owner');
  view.setBigUint64(AMOUNT_OFFSET, f.amount, true);
  // delegate COption::None, close authority COption::None, isNative
  // COption::None, delegated amount 0 — all already zero, and left explicit in
  // this comment so nobody later reads the absence as an oversight.
  data[STATE_OFFSET] = STATE_INITIALIZED;

  if (extensions.length > 0) {
    data[TOKEN_ACCOUNT_LEN] = TOKEN_2022_ACCOUNT_TYPE;
    let at = TOKEN_ACCOUNT_LEN + 1;
    for (const e of extensions) {
      const type = EXTENSION_TYPE[e.kind];
      const valueLen = e.kind === 'transfer_fee_amount' ? 8 : 0;
      view.setUint16(at, type, true);
      view.setUint16(at + 2, valueLen, true);
      if (e.kind === 'transfer_fee_amount') view.setBigUint64(at + 4, e.withheldAmount, true);
      at += 4 + valueLen;
    }
  }

  return data;
}

/** Decode what we wrote, so a round trip is checked rather than assumed. */
export function decodeTokenAccountAmount(data: Uint8Array): bigint | null {
  if (data.length < AMOUNT_OFFSET + 8) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(AMOUNT_OFFSET, true);
}
