import { base58Decode, base58Encode } from './base58.js';
import type { RawInstruction } from './instructionpolicy.js';

/**
 * Build the exact v0 transaction bytes from a `/swap/v2/build` response.
 *
 * §5. Until now the transaction policy reasoned about instructions and
 * ESTIMATED a packet size. That is not a transaction policy: the fee payer's
 * position, the signature count, the account ordering, the real packet length
 * and the set of accounts a lookup table can load are all properties of the
 * assembled message, and none of them can be read off a list of instructions.
 * A simulator cannot be handed an estimate either — it needs bytes.
 *
 * This is a hand-written encoder rather than a dependency, and the reason is
 * that the repository already contains a rigorously tested DECODER. Round-trip
 * is therefore a real proof rather than a claim: encode a message, decode it
 * with the independently written decoder, and require every field to match. A
 * third-party library would have to be trusted; this has to agree with code
 * that already reads mainnet transactions correctly.
 *
 * Account ordering follows the compiled-message rules, which are not
 * negotiable — the runtime derives privileges from POSITION:
 *
 *   1. writable signers      (fee payer first, always index 0)
 *   2. readonly signers
 *   3. writable non-signers
 *   4. readonly non-signers  (program ids live here)
 *
 * Getting this wrong does not produce an error. It produces a transaction that
 * grants the wrong privileges to the wrong accounts, which is the single most
 * dangerous kind of bug this file could contain, so `compileMessage` is
 * exercised by property tests over shuffled inputs.
 */

const PUBKEY_LEN = 32;
const SIGNATURE_LEN = 64;
const MAX_PACKET_BYTES = 1232;

export class EncodeError extends Error {
  constructor(
    readonly code:
      | 'MISSING_BLOCKHASH'
      | 'MISSING_ROUTE_PLAN'
      | 'MISSING_LOOKUP_TABLE'
      | 'MISSING_CONTEXT_SLOT'
      | 'MISSING_MINIMUM_OUTPUT'
      | 'NO_FEE_PAYER'
      | 'TOO_MANY_ACCOUNTS'
      | 'TOO_MANY_SIGNERS'
      | 'OVERSIZED'
      | 'BAD_ACCOUNT',
    message: string,
  ) {
    super(message);
    this.name = 'EncodeError';
  }
}

class Writer {
  private readonly parts: number[] = [];

  u8(v: number): void {
    this.parts.push(v & 0xff);
  }

  /** Solana's compact-u16. Never a plain byte — a 128-account message needs two. */
  shortVec(v: number): void {
    let rem = v;
    for (;;) {
      let elem = rem & 0x7f;
      rem >>= 7;
      if (rem === 0) {
        this.parts.push(elem);
        return;
      }
      elem |= 0x80;
      this.parts.push(elem);
    }
  }

  bytes(b: Uint8Array | readonly number[]): void {
    for (const x of b) this.parts.push(x & 0xff);
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export interface AccountMeta {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface CompiledMessage {
  readonly numRequiredSignatures: number;
  readonly numReadonlySignedAccounts: number;
  readonly numReadonlyUnsignedAccounts: number;
  readonly staticAccountKeys: readonly string[];
  readonly recentBlockhash: string;
  readonly instructions: readonly {
    programIdIndex: number;
    accountIndexes: readonly number[];
    data: Uint8Array;
  }[];
  readonly addressTableLookups: readonly {
    accountKey: string;
    writableIndexes: readonly number[];
    readonlyIndexes: readonly number[];
  }[];
  readonly feePayer: string;
  /** Accounts the message can mutate, static and ALT-loaded. */
  readonly writableAccounts: readonly string[];
  readonly readonlyAccounts: readonly string[];
}

/**
 * Collapse instruction account metas into the compiled account list.
 *
 * A pubkey appearing twice is one account, and its privileges are the UNION of
 * every appearance: an account that is writable in one instruction is writable
 * in the message, and taking the intersection would silently drop a privilege
 * the router asked for and produce a transaction that fails at execution for a
 * reason nobody could see in the instructions.
 */
export function compileMessage(
  instructions: readonly RawInstruction[],
  feePayer: string,
  recentBlockhash: string,
  lookupTables: Readonly<Record<string, readonly string[]>> = {},
): CompiledMessage {
  if (recentBlockhash.length === 0) {
    throw new EncodeError('MISSING_BLOCKHASH', 'the build response carried no blockhash');
  }
  if (feePayer.length === 0) throw new EncodeError('NO_FEE_PAYER', 'no fee payer supplied');

  const metas = new Map<string, { isSigner: boolean; isWritable: boolean }>();
  const note = (pubkey: string, isSigner: boolean, isWritable: boolean): void => {
    const prev = metas.get(pubkey);
    metas.set(pubkey, {
      isSigner: (prev?.isSigner ?? false) || isSigner,
      isWritable: (prev?.isWritable ?? false) || isWritable,
    });
  };

  // The fee payer is a writable signer by definition, whatever the router said.
  note(feePayer, true, true);

  for (const ix of instructions) {
    for (const a of ix.accounts ?? []) {
      if (a.pubkey.length === 0) throw new EncodeError('BAD_ACCOUNT', 'instruction account has an empty pubkey');
      note(a.pubkey, a.isSigner, a.isWritable);
    }
  }
  // Program ids are readonly non-signers and must be in the STATIC account
  // list. They may never be taken from an address lookup table: the runtime
  // resolves an instruction's program by indexing the static keys, so a program
  // sitting only in a table produces an index that points nowhere.
  //
  // This is not hypothetical. Jupiter's own lookup table contains the programs
  // it routes through, so a real /build response moved JUP6, ATokenGPvbdG and
  // Tokenkeg out of the static list and produced `program index 17 outside
  // static keys`. The synthetic fixtures never put a program in a table, which
  // is exactly the shape a real response has.
  const programIds = new Set<string>();
  for (const ix of instructions) {
    programIds.add(ix.programId);
    note(ix.programId, false, false);
  }

  // Addresses a lookup table provides are NOT written into the static list —
  // that is what the table is for. They are removed here and re-attached as
  // table indexes below.
  const altAddresses = new Map<string, { table: string; index: number }>();
  for (const [table, addresses] of Object.entries(lookupTables)) {
    addresses.forEach((addr, index) => {
      if (!altAddresses.has(addr)) altAddresses.set(addr, { table, index });
    });
  }

  const staticEntries = [...metas.entries()].filter(([pubkey]) => {
    // A signer can never come from a lookup table: signatures are matched by
    // position in the static list.
    if (metas.get(pubkey)?.isSigner === true) return true;
    // Neither can a program id, for the reason above.
    if (programIds.has(pubkey)) return true;
    return !altAddresses.has(pubkey);
  });

  // Positional privilege. The order IS the permission model.
  const writableSigners = staticEntries.filter(([, m]) => m.isSigner && m.isWritable).map(([k]) => k);
  const readonlySigners = staticEntries.filter(([, m]) => m.isSigner && !m.isWritable).map(([k]) => k);
  const writableNonSigners = staticEntries.filter(([, m]) => !m.isSigner && m.isWritable).map(([k]) => k);
  const readonlyNonSigners = staticEntries.filter(([, m]) => !m.isSigner && !m.isWritable).map(([k]) => k);

  // Fee payer first, always index 0.
  const orderedWritableSigners = [feePayer, ...writableSigners.filter((k) => k !== feePayer)];

  const staticAccountKeys = [
    ...orderedWritableSigners,
    ...readonlySigners,
    ...writableNonSigners,
    ...readonlyNonSigners,
  ];

  if (staticAccountKeys.length > 255) {
    throw new EncodeError('TOO_MANY_ACCOUNTS', `${staticAccountKeys.length} static accounts`);
  }

  // The decoder refuses more than 8 signatures as implausible, and the encoder
  // must agree: a message this side produced but the signer's own decoder would
  // reject can never be validated, so building the bytes is pointless. Our flow
  // has exactly one signer -- the taker -- and the instruction policy already
  // refuses any other, so anything near this bound is a routing anomaly rather
  // than a transaction. Found by the round-trip property test.
  const requiredSignatures = orderedWritableSigners.length + readonlySigners.length;
  if (requiredSignatures > 8) {
    throw new EncodeError(
      'TOO_MANY_SIGNERS',
      `${requiredSignatures} required signatures; the decoder refuses above 8`,
    );
  }

  // Lookup entries, grouped by table.
  const usedAlt = new Map<string, { writable: number[]; readonly: number[] }>();
  for (const [pubkey, meta] of metas) {
    const hit = altAddresses.get(pubkey);
    if (hit === undefined || meta.isSigner || programIds.has(pubkey)) continue;
    const entry = usedAlt.get(hit.table) ?? { writable: [], readonly: [] };
    if (meta.isWritable) entry.writable.push(hit.index);
    else entry.readonly.push(hit.index);
    usedAlt.set(hit.table, entry);
  }

  const addressTableLookups = [...usedAlt.entries()]
    .filter(([, v]) => v.writable.length > 0 || v.readonly.length > 0)
    .map(([accountKey, v]) => ({
      accountKey,
      writableIndexes: v.writable,
      readonlyIndexes: v.readonly,
    }));

  // Runtime index space, derived FROM the lookups we just emitted rather than
  // from the order the instruction metas happened to arrive in.
  //
  // The runtime resolves loaded addresses by walking the message's lookup list
  // in order, taking every writable index of every table first, then every
  // readonly index of every table. It does NOT interleave tables. Building the
  // order from meta insertion order does, and the two disagree the moment a
  // second table is involved:
  //
  //   table A = [A1, A2], table B = [B1, B2], metas arrive A1, B1, A2, B2
  //     meta order    -> A1, B1, A2, B2
  //     runtime order -> A1, A2, B1, B2
  //
  // Every instruction index past the static keys would then name a different
  // account than the one intended, in a transaction that still encodes, still
  // passes a packet-size check, and still looks entirely ordinary. Single-table
  // routes are unaffected, which is why the existing tests did not catch it.
  //
  // Deriving the order from `addressTableLookups` makes the two constructions
  // the same construction, so they cannot drift apart again.
  const indexOf = new Map<string, number>();
  staticAccountKeys.forEach((k, i) => indexOf.set(k, i));
  let next = staticAccountKeys.length;
  const resolveEntry = (table: string, index: number): string | undefined => lookupTables[table]?.[index];
  // The resolved loaded addresses, in runtime order. These are also what the
  // account policy inspects: a policy that checked a different set than the
  // runtime loads would be checking a different transaction.
  const altOrderWritable: string[] = [];
  const altOrderReadonly: string[] = [];
  for (const lut of addressTableLookups) {
    for (const i of lut.writableIndexes) {
      const k = resolveEntry(lut.accountKey, i);
      if (k !== undefined && !indexOf.has(k)) {
        indexOf.set(k, next++);
        altOrderWritable.push(k);
      }
    }
  }
  for (const lut of addressTableLookups) {
    for (const i of lut.readonlyIndexes) {
      const k = resolveEntry(lut.accountKey, i);
      if (k !== undefined && !indexOf.has(k)) {
        indexOf.set(k, next++);
        altOrderReadonly.push(k);
      }
    }
  }

  const compiled = instructions.map((ix) => {
    const programIdIndex = indexOf.get(ix.programId);
    if (programIdIndex === undefined) {
      throw new EncodeError('BAD_ACCOUNT', `program ${ix.programId} is not in the account list`);
    }
    const accountIndexes = (ix.accounts ?? []).map((a) => {
      const i = indexOf.get(a.pubkey);
      if (i === undefined) throw new EncodeError('BAD_ACCOUNT', `account ${a.pubkey} is not in the account list`);
      return i;
    });
    return {
      programIdIndex,
      accountIndexes,
      data: ix.data === undefined ? new Uint8Array(0) : new Uint8Array(Buffer.from(ix.data, 'base64')),
    };
  });

  return {
    numRequiredSignatures: requiredSignatures,
    numReadonlySignedAccounts: readonlySigners.length,
    numReadonlyUnsignedAccounts: readonlyNonSigners.length,
    staticAccountKeys,
    recentBlockhash,
    instructions: compiled,
    addressTableLookups,
    feePayer,
    writableAccounts: [
      ...orderedWritableSigners,
      ...writableNonSigners,
      ...altOrderWritable,
    ],
    readonlyAccounts: [...readonlySigners, ...readonlyNonSigners, ...altOrderReadonly],
  };
}

/** Serialize a compiled v0 message. */
export function encodeMessage(m: CompiledMessage): Uint8Array {
  const w = new Writer();
  // Version prefix: high bit set, version 0.
  w.u8(0x80);
  w.u8(m.numRequiredSignatures);
  w.u8(m.numReadonlySignedAccounts);
  w.u8(m.numReadonlyUnsignedAccounts);

  w.shortVec(m.staticAccountKeys.length);
  for (const k of m.staticAccountKeys) {
    const bytes = base58Decode(k);
    if (bytes.length !== PUBKEY_LEN) throw new EncodeError('BAD_ACCOUNT', `${k} is not a 32-byte pubkey`);
    w.bytes(bytes);
  }

  const bh = base58Decode(m.recentBlockhash);
  if (bh.length !== PUBKEY_LEN) throw new EncodeError('MISSING_BLOCKHASH', 'blockhash is not 32 bytes');
  w.bytes(bh);

  w.shortVec(m.instructions.length);
  for (const ix of m.instructions) {
    w.u8(ix.programIdIndex);
    w.shortVec(ix.accountIndexes.length);
    for (const i of ix.accountIndexes) w.u8(i);
    w.shortVec(ix.data.length);
    w.bytes(ix.data);
  }

  w.shortVec(m.addressTableLookups.length);
  for (const lut of m.addressTableLookups) {
    w.bytes(base58Decode(lut.accountKey));
    w.shortVec(lut.writableIndexes.length);
    for (const i of lut.writableIndexes) w.u8(i);
    w.shortVec(lut.readonlyIndexes.length);
    for (const i of lut.readonlyIndexes) w.u8(i);
  }

  return w.toUint8Array();
}

/**
 * A complete transaction with empty signature placeholders.
 *
 * Nothing here is ever signed. The placeholders exist because the packet size
 * that matters is the one that would go on the wire, and a message measured
 * without its signatures understates it by 64 bytes each — which is exactly the
 * margin an oversized transaction fails by.
 */
export function encodeUnsignedTransaction(m: CompiledMessage): Uint8Array {
  const message = encodeMessage(m);
  const w = new Writer();
  w.shortVec(m.numRequiredSignatures);
  for (let i = 0; i < m.numRequiredSignatures; i++) w.bytes(new Uint8Array(SIGNATURE_LEN));
  w.bytes(message);
  const out = w.toUint8Array();
  if (out.length > MAX_PACKET_BYTES) {
    throw new EncodeError('OVERSIZED', `${out.length} > ${MAX_PACKET_BYTES} bytes`);
  }
  return out;
}

export { MAX_PACKET_BYTES };

/** base58 of a pubkey, for callers assembling account lists. */
export function normalizePubkey(pubkey: string): string {
  return base58Encode(base58Decode(pubkey));
}
