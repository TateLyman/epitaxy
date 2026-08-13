import { describe, it, expect } from 'vitest';
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  compressTransactionMessageUsingAddressLookupTables,
  address,
  type Address,
  type Blockhash,
} from '@solana/kit';
import { compileMessage, encodeMessage, encodeUnsignedTransaction } from '../../packages/solana/src/encode.js';
import { decodeTransaction, writableStaticKeys } from '../../packages/solana/src/transaction.js';
import { SYSTEM_PROGRAM } from '../../packages/solana/src/txpolicy.js';
import { base58Encode } from '../../packages/solana/src/base58.js';

/**
 * §4.2 — the differential test.
 *
 * This project compiles its own v0 messages, because the signer must validate
 * the exact bytes it signs and a library that compiles them somewhere else is
 * one more thing to trust. That decision is only defensible if the bytes match
 * what the official compiler produces, byte for byte.
 *
 * It is not hypothetical insurance. The multi-table ordering bug this suite
 * already covers produced a transaction that encoded cleanly, passed a packet
 * size check, and named the wrong accounts. A differential against an
 * independent implementation is the cheapest way to catch that whole class.
 *
 * @solana/kit is a DEV dependency. It never appears in the runtime path: the
 * engine, the signer and the daemon all use the encoder in packages/solana.
 */

const key = (n: number): string => base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : i + 1)));

/** Encode through the official compiler and return the message bytes. */
function officialBytes(
  instructions: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[],
  feePayer: string,
  blockhash: string,
  lookupTables: Record<string, string[]> = {},
): Uint8Array {
  // The builder types are progressive: each step adds a capability to the type.
  // So the steps are chained rather than reassigned to one variable -- casting a
  // later stage back onto an earlier one defeats exactly the checking that makes
  // this library worth comparing against.
  const withPayer = setTransactionMessageFeePayer(address(feePayer), createTransactionMessage({ version: 0 }));
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: blockhash as Blockhash, lastValidBlockHeight: 1n },
    withPayer,
  );
  const withInstructions = appendTransactionMessageInstructions(
    instructions.map((ix) => ({
      programAddress: address(ix.programId),
      accounts: ix.accounts.map((a) => ({
        address: address(a.pubkey),
        role: a.isSigner ? (a.isWritable ? 3 : 2) : a.isWritable ? 1 : 0,
      })),
      data: new Uint8Array(Buffer.from(ix.data, 'base64')),
    })),
    withLifetime,
  );

  const tables = Object.fromEntries(
    Object.entries(lookupTables).map(([t, addrs]) => [address(t), addrs.map((a) => address(a))]),
  ) as Record<Address, Address[]>;
  const final =
    Object.keys(lookupTables).length > 0
      ? compressTransactionMessageUsingAddressLookupTables(withInstructions, tables)
      : withInstructions;

  // compileTransaction already returns the ENCODED message bytes; running them
  // through the encoder again was my mistake, not the encoder's.
  return new Uint8Array(compileTransaction(final).messageBytes);
}

function ours(
  instructions: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[],
  feePayer: string,
  blockhash: string,
  lookupTables: Record<string, string[]> = {},
): Uint8Array {
  return encodeMessage(compileMessage(instructions, feePayer, blockhash, lookupTables));
}

/**
 * Our decoder expects a full transaction; the official compiler hands back a
 * bare message. Prefixing a zero signature count makes the two comparable
 * without teaching the decoder a second entry point.
 */
function decodeMessageOnly(messageBytes: Uint8Array): ReturnType<typeof decodeTransaction> {
  // One signature slot, zero-filled. The decoder refuses a zero signature count
  // -- correctly, since no real transaction has one -- so the envelope has to be
  // well formed rather than merely present.
  return decodeTransaction(new Uint8Array([1, ...new Uint8Array(64), ...messageBytes]));
}

const payer = key(3);
const blockhash = base58Encode(Uint8Array.from({ length: 32 }, () => 7));

describe('§4.2 our encoder against the official compiler', () => {
  it('agrees on a single-instruction transfer', () => {
    const ixs = [
      {
        programId: SYSTEM_PROGRAM,
        accounts: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: key(5), isSigner: false, isWritable: true },
        ],
        data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]).toString('base64'),
      },
    ];
    expect(Buffer.from(ours(ixs, payer, blockhash)).toString('hex')).toBe(
      Buffer.from(officialBytes(ixs, payer, blockhash)).toString('hex'),
    );
  });

  /**
   * Where the two implementations legitimately differ, and why that is not a
   * defect.
   *
   * With several instructions the two compilers order the READONLY NON-SIGNER
   * group differently. The protocol does not canonicalise order within a
   * privilege group: privileges come from the group BOUNDARIES, given by the
   * three header counts, and instruction operands are resolved by index. Two
   * messages with the same accounts in the same groups and correspondingly
   * adjusted indexes are the same transaction.
   *
   * So this case asserts semantic equivalence rather than byte equality, and
   * says so out loud instead of quietly dropping to a weaker assertion. Every
   * case where ordering IS determined -- including both multi-table ones, which
   * is where the real bug lived -- still asserts byte equality.
   */
  it('names the same accounts with the same privileges across several instructions', () => {
    const ixs = [
      {
        programId: SYSTEM_PROGRAM,
        accounts: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: key(9), isSigner: false, isWritable: false },
          { pubkey: key(11), isSigner: false, isWritable: true },
        ],
        data: 'AA==',
      },
      {
        programId: key(60),
        accounts: [
          { pubkey: key(11), isSigner: false, isWritable: true },
          { pubkey: key(12), isSigner: false, isWritable: false },
          { pubkey: payer, isSigner: true, isWritable: true },
        ],
        data: 'AQI=',
      },
    ];

    const mine = decodeTransaction(encodeUnsignedTransaction(compileMessage(ixs, payer, blockhash)));
    const theirs = decodeMessageOnly(officialBytes(ixs, payer, blockhash));

    // Same header: same number of signers, same privilege boundaries.
    expect(mine.numRequiredSignatures).toBe(theirs.numRequiredSignatures);
    expect(mine.numReadonlySignedAccounts).toBe(theirs.numReadonlySignedAccounts);
    expect(mine.numReadonlyUnsignedAccounts).toBe(theirs.numReadonlyUnsignedAccounts);
    // Same accounts, and the fee payer in the one position the protocol does fix.
    expect(mine.staticAccountKeys[0]).toBe(theirs.staticAccountKeys[0]);
    expect([...mine.staticAccountKeys].sort()).toEqual([...theirs.staticAccountKeys].sort());
    // Same writable set, which is what the policy and the runtime care about.
    expect([...writableStaticKeys(mine)].sort()).toEqual([...writableStaticKeys(theirs)].sort());

    // And every instruction names the same accounts in the same order, once
    // each side's indexes are resolved against its own key list.
    expect(mine.instructions).toHaveLength(theirs.instructions.length);
    mine.instructions.forEach((ix, i) => {
      const other = theirs.instructions[i];
      expect(mine.staticAccountKeys[ix.programIdIndex]).toBe(theirs.staticAccountKeys[other?.programIdIndex ?? -1]);
      expect(ix.accountIndexes.map((k) => mine.staticAccountKeys[k])).toEqual(
        (other?.accountIndexes ?? []).map((k) => theirs.staticAccountKeys[k]),
      );
    });
  });

  it('agrees on a single lookup table', () => {
    const table = key(20);
    const a1 = key(31);
    const a2 = key(32);
    const ixs = [
      {
        programId: SYSTEM_PROGRAM,
        accounts: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: a1, isSigner: false, isWritable: true },
          { pubkey: a2, isSigner: false, isWritable: false },
        ],
        data: 'AA==',
      },
    ];
    const tables = { [table]: [a1, a2] };
    expect(Buffer.from(ours(ixs, payer, blockhash, tables)).toString('hex')).toBe(
      Buffer.from(officialBytes(ixs, payer, blockhash, tables)).toString('hex'),
    );
  });

  it('agrees on TWO interleaved lookup tables', () => {
    // The case that was broken. The encoder built its loaded-address order from
    // meta arrival; the runtime groups by table. Every instruction index past
    // the static keys named a different account, in a transaction that still
    // encoded and still looked like a swap.
    const tableA = key(20);
    const tableB = key(21);
    const A1 = key(31);
    const A2 = key(32);
    const B1 = key(41);
    const B2 = key(42);
    const ixs = [
      {
        programId: SYSTEM_PROGRAM,
        accounts: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: A1, isSigner: false, isWritable: true },
          { pubkey: B1, isSigner: false, isWritable: true },
          { pubkey: A2, isSigner: false, isWritable: true },
          { pubkey: B2, isSigner: false, isWritable: true },
        ],
        data: 'AA==',
      },
    ];
    const tables = { [tableA]: [A1, A2], [tableB]: [B1, B2] };
    expect(Buffer.from(ours(ixs, payer, blockhash, tables)).toString('hex')).toBe(
      Buffer.from(officialBytes(ixs, payer, blockhash, tables)).toString('hex'),
    );
  });

  it('agrees on two tables with mixed writable and readonly entries', () => {
    const tableA = key(20);
    const tableB = key(21);
    const AW = key(31);
    const AR = key(32);
    const BW = key(41);
    const BR = key(42);
    const ixs = [
      {
        programId: SYSTEM_PROGRAM,
        accounts: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: AR, isSigner: false, isWritable: false },
          { pubkey: BW, isSigner: false, isWritable: true },
          { pubkey: AW, isSigner: false, isWritable: true },
          { pubkey: BR, isSigner: false, isWritable: false },
        ],
        data: 'AA==',
      },
    ];
    const tables = { [tableA]: [AW, AR], [tableB]: [BW, BR] };
    expect(Buffer.from(ours(ixs, payer, blockhash, tables)).toString('hex')).toBe(
      Buffer.from(officialBytes(ixs, payer, blockhash, tables)).toString('hex'),
    );
  });

  it('agrees that a program id stays in the static keys even when a table offers it', () => {
    // Jupiter's own table contains the programs it routes through. Taking a
    // program id from a table produces "program index outside static keys".
    const table = key(20);
    const other = key(31);
    const ixs = [
      {
        programId: SYSTEM_PROGRAM,
        accounts: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: other, isSigner: false, isWritable: true },
        ],
        data: 'AA==',
      },
    ];
    const tables = { [table]: [SYSTEM_PROGRAM, payer, other] };
    expect(Buffer.from(ours(ixs, payer, blockhash, tables)).toString('hex')).toBe(
      Buffer.from(officialBytes(ixs, payer, blockhash, tables)).toString('hex'),
    );
  });
});
