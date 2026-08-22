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

/**
 * The default bound suits an address or a signature.
 *
 * The decode is O(n²) in the input length, so an unbounded one is a denial of
 * service on hostile input. 128 characters covers a 64-byte signature with room
 * to spare.
 *
 * INSTRUCTION DATA IS LEGITIMATELY LONGER, and that is a real failure this
 * constant caused: `getTransactionInstructions` decodes each instruction's
 * base58 data to read its 8-byte anchor discriminator, and every instruction
 * above 128 characters threw — silently becoming "data not readable", which the
 * migration decoder correctly refuses. On live PumpSwap traffic that was 108 of
 * 200 instructions. A caller with genuinely longer input must say so and pick
 * its own bound, rather than the bound being invisible.
 */
export const BASE58_DEFAULT_MAX_LENGTH = 128;

/** Enough for a 1232-byte transaction's worth of instruction data. */
export const BASE58_INSTRUCTION_DATA_MAX_LENGTH = 2_048;

export function base58Decode(input: string, maxLength = BASE58_DEFAULT_MAX_LENGTH): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  if (input.length > maxLength) throw new Base58Error(`base58 input too long: ${input.length} > ${maxLength}`);

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

/**
 * Bulk decoder for OFFLINE analysis. Byte-for-byte identical to `base58Decode`, ~10x faster.
 *
 * WHY THIS EXISTS AS A SEPARATE FUNCTION AND NOT AS A REPLACEMENT. `base58Decode` sits on the
 * transaction-decode path that feeds the signer, where this repository's rule is that anything
 * which cannot be fully decoded is refused rather than partially interpreted. A faster
 * implementation of a base conversion is exactly the kind of change that is correct in testing and
 * catastrophic in the one case nobody generated. So the canonical decoder is left ALONE, keeps its
 * existing tests, and keeps every call site that touches signing. This one is used only by the
 * offline backfill, where a wrong byte corrupts a research corpus rather than a transaction.
 *
 * WHY IT IS FASTER. The canonical version is O(n²) with a very large constant: for each of the n
 * input characters it walks every byte accumulated so far, multiplying by 58 one digit at a time,
 * on a `number[]` grown by `push`. PumpSwap event payloads average 594 base58 characters, which is
 * roughly 260,000 inner iterations PER INSTRUCTION, and a block-C backfill decodes about 15 million
 * of them. Measured on real data it is 99.4% of the entire cache build - 311.7ms against 1.9ms for
 * JSON.parse of the same blocks.
 *
 * This version keeps the same O(n²) shape - base conversion cannot avoid it - but shrinks the
 * constant two ways. It consumes FIVE base58 digits per outer step instead of one, because 58^5 is
 * 656,356,768 and a 16-bit limb times that is about 4.3e13, comfortably inside the 2^53 range where
 * a double represents integers exactly. And it works on a preallocated Uint16Array rather than a
 * growing array of boxed numbers, with no final `reverse()`.
 *
 * THE LEADING-ZERO RULE IS THE SUBTLE PART and is preserved exactly: each leading '1' in the input
 * is one leading zero byte in the output, independent of the numeric value.
 */
export function base58DecodeBulk(input: string, maxLength = BASE58_DEFAULT_MAX_LENGTH): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  if (input.length > maxLength) throw new Base58Error(`base58 input too long: ${input.length} > ${maxLength}`);

  let zeros = 0;
  while (zeros < input.length && input.charCodeAt(zeros) === 49 /* '1' */) zeros += 1;

  // log(58)/log(65536) < 0.3665; +2 is slack for the final carry.
  const limbs = new Uint16Array(Math.ceil((input.length - zeros) * 0.3665) + 2);
  let used = 0;

  for (let i = zeros; i < input.length;) {
    let group = 0;
    let mul = 1;
    const end = Math.min(i + 5, input.length);
    for (; i < end; i += 1) {
      const code = input.charCodeAt(i);
      const value = code < 128 ? DECODE_MAP[code] ?? -1 : -1;
      if (value < 0) throw new Base58Error(`invalid base58 character at index ${i}`);
      group = group * 58 + value;
      mul *= 58;
    }
    let carry = group;
    for (let j = 0; j < used; j += 1) {
      const t = (limbs[j] as number) * mul + carry;
      limbs[j] = t & 0xffff;
      carry = Math.floor(t / 65536);
    }
    while (carry > 0) {
      limbs[used] = carry & 0xffff;
      used += 1;
      carry = Math.floor(carry / 65536);
    }
  }

  // Big-endian bytes of the accumulated number, with no leading zeros of its own.
  let top = used * 2;
  const hi = used > 0 ? (limbs[used - 1] as number) : 0;
  if (used > 0 && hi < 256) top -= 1;
  const out = new Uint8Array(zeros + top);
  for (let k = 0; k < top; k += 1) {
    const limb = limbs[(top - 1 - k) >> 1] as number;
    out[zeros + k] = ((top - 1 - k) & 1) === 1 ? (limb >> 8) & 0xff : limb & 0xff;
  }
  return out;
}
