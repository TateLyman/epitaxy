/**
 * Base58 (Bitcoin alphabet) codec.
 *
 * Implemented locally rather than pulled from a dependency: this is the one
 * routine that turns untrusted external strings into the bytes we make safety
 * decisions about, and it must reject malformed input rather than silently
 * producing plausible-looking garbage.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const DECODE_MAP: Int8Array = (() => {
  const m = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET.charCodeAt(i)] = i;
  return m;
})();

export class Base58Error extends Error {}

export function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  if (input.length > 128) throw new Base58Error(`base58 input too long: ${input.length}`);

  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? DECODE_MAP[code] ?? -1 : -1;
    if (value < 0) throw new Base58Error(`invalid base58 character at index ${i}`);

    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Each leading '1' is one leading zero byte.
  for (let i = 0; i < input.length && input[i] === '1'; i++) bytes.push(0);

  return new Uint8Array(bytes.reverse());
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i] as number];
  return out;
}

/**
 * A Solana public key is exactly 32 bytes. Anything else is not a mint, however
 * convincing the string looks, and must never reach a quote or a signer.
 */
export function isValidPubkey(input: string): boolean {
  if (input.length < 32 || input.length > 44) return false;
  try {
    return base58Decode(input).length === 32;
  } catch {
    return false;
  }
}

export function assertPubkey(input: string, label: string): string {
  if (!isValidPubkey(input)) {
    throw new Base58Error(`${label} is not a valid 32-byte base58 public key`);
  }
  return input;
}
