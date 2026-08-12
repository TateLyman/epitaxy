import { base58Encode } from './base58.js';

/**
 * Solana transaction wire-format decoder.
 *
 * This exists so that the signer never has to trust a router. A quote provider
 * hands us bytes; those bytes are a set of instructions that will run with our
 * authority. Signing them because they came from the expected URL is the same
 * mistake as executing a downloaded binary because the domain looked right.
 *
 * Decoding is strict: any length that does not add up, any trailing byte, any
 * shortvec that is not minimally encoded, is a decode failure rather than a
 * best-effort parse.
 */

export class TxDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxDecodeError';
  }
}

export interface CompiledInstruction {
  readonly programIdIndex: number;
  readonly accountIndexes: readonly number[];
  readonly data: Uint8Array;
}

export interface AddressTableLookup {
  readonly accountKey: string;
  readonly writableIndexes: readonly number[];
  readonly readonlyIndexes: readonly number[];
}

export interface DecodedTransaction {
  readonly version: 'legacy' | 0;
  readonly signatureCount: number;
  readonly numRequiredSignatures: number;
  readonly numReadonlySignedAccounts: number;
  readonly numReadonlyUnsignedAccounts: number;
  /** Keys written literally into the message. Program IDs are always here. */
  readonly staticAccountKeys: readonly string[];
  readonly recentBlockhash: string;
  readonly instructions: readonly CompiledInstruction[];
  readonly addressTableLookups: readonly AddressTableLookup[];
  readonly messageBytes: Uint8Array;
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  u8(): number {
    if (this.offset >= this.buf.length) throw new TxDecodeError('unexpected end of transaction');
    return this.buf[this.offset++] as number;
  }

  bytes(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.buf.length) {
      throw new TxDecodeError(`transaction claims ${n} bytes past end`);
    }
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /**
   * ShortVec length prefix. Non-minimal encodings are rejected: two different
   * byte sequences that mean the same length are a signature-malleability
   * surface, and we compare transactions by bytes.
   */
  shortVec(): number {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 3; i++) {
      const byte = this.u8();
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        if (i > 0 && (byte & 0x7f) === 0) throw new TxDecodeError('non-minimal shortvec encoding');
        return value;
      }
      shift += 7;
    }
    throw new TxDecodeError('shortvec longer than 3 bytes');
  }
}

const SIGNATURE_LEN = 64;
const PUBKEY_LEN = 32;
const VERSION_MASK = 0x80;

export function decodeTransaction(raw: Uint8Array): DecodedTransaction {
  const r = new Reader(raw);

  const signatureCount = r.shortVec();
  if (signatureCount === 0 || signatureCount > 8) {
    throw new TxDecodeError(`implausible signature count ${signatureCount}`);
  }
  r.bytes(signatureCount * SIGNATURE_LEN);

  const messageStart = r.position;
  const prefix = r.u8();
  let version: 'legacy' | 0;
  let header0: number;
  if ((prefix & VERSION_MASK) === 0) {
    version = 'legacy';
    header0 = prefix;
  } else {
    const v = prefix & 0x7f;
    if (v !== 0) throw new TxDecodeError(`unsupported transaction version ${v}`);
    version = 0;
    header0 = r.u8();
  }

  const numRequiredSignatures = header0;
  const numReadonlySignedAccounts = r.u8();
  const numReadonlyUnsignedAccounts = r.u8();

  const keyCount = r.shortVec();
  if (keyCount === 0 || keyCount > 256) throw new TxDecodeError(`implausible account key count ${keyCount}`);
  const staticAccountKeys: string[] = [];
  for (let i = 0; i < keyCount; i++) staticAccountKeys.push(base58Encode(r.bytes(PUBKEY_LEN)));

  const recentBlockhash = base58Encode(r.bytes(PUBKEY_LEN));

  const ixCount = r.shortVec();
  if (ixCount > 64) throw new TxDecodeError(`implausible instruction count ${ixCount}`);
  const instructions: CompiledInstruction[] = [];
  for (let i = 0; i < ixCount; i++) {
    const programIdIndex = r.u8();
    const accLen = r.shortVec();
    const accountIndexes: number[] = [];
    for (let j = 0; j < accLen; j++) accountIndexes.push(r.u8());
    const dataLen = r.shortVec();
    instructions.push({ programIdIndex, accountIndexes, data: new Uint8Array(r.bytes(dataLen)) });
  }

  const addressTableLookups: AddressTableLookup[] = [];
  if (version === 0) {
    const lookupCount = r.shortVec();
    if (lookupCount > 16) throw new TxDecodeError(`implausible lookup table count ${lookupCount}`);
    for (let i = 0; i < lookupCount; i++) {
      const accountKey = base58Encode(r.bytes(PUBKEY_LEN));
      const wLen = r.shortVec();
      const writableIndexes: number[] = [];
      for (let j = 0; j < wLen; j++) writableIndexes.push(r.u8());
      const rLen = r.shortVec();
      const readonlyIndexes: number[] = [];
      for (let j = 0; j < rLen; j++) readonlyIndexes.push(r.u8());
      addressTableLookups.push({ accountKey, writableIndexes, readonlyIndexes });
    }
  }

  if (r.remaining !== 0) {
    // Trailing bytes mean we did not understand the structure we just signed.
    throw new TxDecodeError(`${r.remaining} trailing bytes after transaction`);
  }

  if (numRequiredSignatures === 0 || numRequiredSignatures > staticAccountKeys.length) {
    throw new TxDecodeError(`invalid numRequiredSignatures ${numRequiredSignatures}`);
  }
  for (const ix of instructions) {
    if (ix.programIdIndex >= staticAccountKeys.length) {
      // The runtime forbids loading a program from a lookup table, so an index
      // outside the static keys is malformed, not merely unresolvable.
      throw new TxDecodeError(`instruction program index ${ix.programIdIndex} outside static keys`);
    }
  }

  return {
    version,
    signatureCount,
    numRequiredSignatures,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts,
    staticAccountKeys,
    recentBlockhash,
    instructions,
    addressTableLookups,
    messageBytes: raw.subarray(messageStart),
  };
}

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

export interface ComputeBudgetSettings {
  readonly unitLimit: number | null;
  readonly unitPriceMicroLamports: bigint | null;
}

/**
 * Priority fee is the one field a router can quietly inflate without changing
 * anything we would notice in the quote, so we read it from the bytes.
 */
export function readComputeBudget(tx: DecodedTransaction): ComputeBudgetSettings {
  let unitLimit: number | null = null;
  let unitPriceMicroLamports: bigint | null = null;

  for (const ix of tx.instructions) {
    if (tx.staticAccountKeys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM) continue;
    const d = ix.data;
    if (d.length === 0) continue;
    const tag = d[0] as number;
    if (tag === 2 && d.length >= 5) {
      unitLimit = ((d[1] as number) | ((d[2] as number) << 8) | ((d[3] as number) << 16) | ((d[4] as number) << 24)) >>> 0;
    } else if (tag === 3 && d.length >= 9) {
      let v = 0n;
      for (let i = 8; i >= 1; i--) v = (v << 8n) | BigInt(d[i] as number);
      unitPriceMicroLamports = v;
    }
  }
  return { unitLimit, unitPriceMicroLamports };
}

/**
 * Priority fee in lamports implied by the compute budget instructions.
 *
 * CEILING, not floor. The runtime charges `ceil(unit_price * limit / 1e6)`, so
 * flooring understates the fee by up to one lamport on every transaction that
 * does not divide evenly — which is most of them. One lamport is trivial; a
 * cost model that is systematically one lamport optimistic on every leg is not,
 * because it is optimistic in the same direction every time and this project is
 * trying to measure an edge of a few hundred basis points against costs of a
 * few thousand lamports.
 *
 * The boundary is mutation-tested: `(1, 1)` must be 1 lamport, not 0.
 */
export function priorityFeeLamports(cb: ComputeBudgetSettings): bigint {
  if (cb.unitLimit === null || cb.unitPriceMicroLamports === null) return 0n;
  const numerator = BigInt(cb.unitLimit) * cb.unitPriceMicroLamports;
  if (numerator === 0n) return 0n;
  return (numerator + 999_999n) / 1_000_000n;
}
