import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  compileMessage,
  encodeMessage,
  encodeUnsignedTransaction,
  EncodeError,
  MAX_PACKET_BYTES,
} from '../../packages/solana/src/encode.js';
import { decodeTransaction } from '../../packages/solana/src/transaction.js';
import { base58Encode } from '../../packages/solana/src/base58.js';
import type { RawInstruction } from '../../packages/solana/src/instructionpolicy.js';

/**
 * §5 — the encoder, proved against the decoder.
 *
 * The decoder in `transaction.ts` was written independently, is exercised
 * against captured mainnet transactions, and is what the signer relies on.
 * Round-tripping through it is therefore a real proof rather than a
 * restatement: if the encoder invents a layout, the decoder will not read it
 * back the same way.
 *
 * The account-ordering tests matter most. Position IS privilege in a compiled
 * message, so an ordering bug does not error — it silently grants the wrong
 * account the wrong rights.
 */

function key(seed: number): string {
  const b = new Uint8Array(32);
  b[0] = seed & 0xff;
  b[1] = (seed >> 8) & 0xff;
  b[31] = 1; // keep it a plausible, non-zero curve point for base58 length
  return base58Encode(b);
}

const PAYER = key(1);
const PROGRAM = key(2);
const BLOCKHASH = key(99);

function ix(over: Partial<RawInstruction> = {}): RawInstruction {
  return {
    programId: PROGRAM,
    accounts: [{ pubkey: PAYER, isSigner: true, isWritable: true }],
    data: Buffer.from([1, 2, 3]).toString('base64'),
    ...over,
  };
}

describe('a compiled message round-trips through the independent decoder', () => {
  it('reproduces every header field, key, blockhash and instruction', () => {
    const m = compileMessage([ix()], PAYER, BLOCKHASH);
    const bytes = encodeUnsignedTransaction(m);
    const d = decodeTransaction(bytes);

    expect(d.version).toBe(0);
    expect(d.numRequiredSignatures).toBe(m.numRequiredSignatures);
    expect(d.numReadonlySignedAccounts).toBe(m.numReadonlySignedAccounts);
    expect(d.numReadonlyUnsignedAccounts).toBe(m.numReadonlyUnsignedAccounts);
    expect(d.staticAccountKeys).toEqual(m.staticAccountKeys);
    expect(d.recentBlockhash).toBe(BLOCKHASH);
    expect(d.instructions).toHaveLength(1);
    expect(d.instructions[0]?.programIdIndex).toBe(m.instructions[0]?.programIdIndex);
    expect([...(d.instructions[0]?.data ?? [])]).toEqual([1, 2, 3]);
  });

  it('round-trips address lookup tables and their split index vectors', () => {
    const table = key(50);
    const altWritable = key(51);
    const altReadonly = key(52);
    const m = compileMessage(
      [
        ix({
          accounts: [
            { pubkey: PAYER, isSigner: true, isWritable: true },
            { pubkey: altWritable, isSigner: false, isWritable: true },
            { pubkey: altReadonly, isSigner: false, isWritable: false },
          ],
        }),
      ],
      PAYER,
      BLOCKHASH,
      { [table]: [altWritable, altReadonly] },
    );
    const d = decodeTransaction(encodeUnsignedTransaction(m));

    expect(d.addressTableLookups).toHaveLength(1);
    expect(d.addressTableLookups[0]?.accountKey).toBe(table);
    expect(d.addressTableLookups[0]?.writableIndexes).toEqual([0]);
    expect(d.addressTableLookups[0]?.readonlyIndexes).toEqual([1]);
    // ALT addresses are NOT in the static list — that is the point of a table.
    expect(d.staticAccountKeys).not.toContain(altWritable);
    expect(d.staticAccountKeys).not.toContain(altReadonly);
  });

  it('a program id in a lookup table STAYS in the static keys', () => {
    // The bug a real /build response found and the synthetic fixtures did not.
    // Jupiter's own lookup table contains the programs it routes through. The
    // runtime resolves an instruction's program by indexing the STATIC keys, so
    // moving one into the table produced `program index 17 outside static keys`
    // and an undecodable transaction.
    const table = key(70);
    const other = key(71);
    const m = compileMessage(
      [ix({ accounts: [{ pubkey: other, isSigner: false, isWritable: true }] })],
      PAYER,
      BLOCKHASH,
      // The table offers the program AND an ordinary account.
      { [table]: [PROGRAM, other] },
    );
    expect(m.staticAccountKeys).toContain(PROGRAM);
    // The ordinary account is still allowed to come from the table.
    expect(m.staticAccountKeys).not.toContain(other);

    const d = decodeTransaction(encodeUnsignedTransaction(m));
    const programIndex = d.instructions[0]?.programIdIndex ?? -1;
    expect(programIndex).toBeLessThan(d.staticAccountKeys.length);
    expect(d.staticAccountKeys[programIndex]).toBe(PROGRAM);
  });

  it('an ALT-loaded writable account is still reported as writable', () => {
    const table = key(60);
    const vault = key(61);
    const m = compileMessage(
      [ix({ accounts: [{ pubkey: PAYER, isSigner: true, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: true }] })],
      PAYER,
      BLOCKHASH,
      { [table]: [vault] },
    );
    // §P13.4 — the account the transaction can drain must appear in the
    // writable set even though it never appears in the static keys.
    expect(m.writableAccounts).toContain(vault);
    expect(m.staticAccountKeys).not.toContain(vault);
  });
});

describe('position is privilege, so ordering is not cosmetic', () => {
  it('the fee payer is always index 0, whatever order the router listed', () => {
    const other = key(10);
    const m = compileMessage(
      [
        ix({
          accounts: [
            { pubkey: other, isSigner: true, isWritable: true },
            { pubkey: PAYER, isSigner: true, isWritable: true },
          ],
        }),
      ],
      PAYER,
      BLOCKHASH,
    );
    expect(m.staticAccountKeys[0]).toBe(PAYER);
  });

  it('writable signers, readonly signers, writable non-signers, readonly non-signers', () => {
    const roSigner = key(11);
    const rwPlain = key(12);
    const roPlain = key(13);
    const m = compileMessage(
      [
        ix({
          accounts: [
            { pubkey: roPlain, isSigner: false, isWritable: false },
            { pubkey: rwPlain, isSigner: false, isWritable: true },
            { pubkey: roSigner, isSigner: true, isWritable: false },
            { pubkey: PAYER, isSigner: true, isWritable: true },
          ],
        }),
      ],
      PAYER,
      BLOCKHASH,
    );
    const keys = m.staticAccountKeys;
    expect(keys.indexOf(PAYER)).toBe(0);
    expect(keys.indexOf(roSigner)).toBeLessThan(keys.indexOf(rwPlain));
    expect(keys.indexOf(rwPlain)).toBeLessThan(keys.indexOf(roPlain));
    expect(m.numRequiredSignatures).toBe(2);
    expect(m.numReadonlySignedAccounts).toBe(1);
  });

  it('privileges are the UNION across instructions, never the intersection', () => {
    // An account read by one instruction and written by another is writable.
    // Taking the intersection would drop a privilege the router asked for and
    // produce a transaction that fails at execution for an invisible reason.
    const shared = key(20);
    const m = compileMessage(
      [
        ix({ accounts: [{ pubkey: shared, isSigner: false, isWritable: false }] }),
        ix({ accounts: [{ pubkey: shared, isSigner: false, isWritable: true }] }),
      ],
      PAYER,
      BLOCKHASH,
    );
    expect(m.writableAccounts).toContain(shared);
    expect(m.readonlyAccounts).not.toContain(shared);
  });

  it('a repeated account is compiled once', () => {
    const m = compileMessage(
      [
        ix({ accounts: [{ pubkey: PAYER, isSigner: true, isWritable: true }] }),
        ix({ accounts: [{ pubkey: PAYER, isSigner: true, isWritable: true }] }),
      ],
      PAYER,
      BLOCKHASH,
    );
    expect(m.staticAccountKeys.filter((k) => k === PAYER)).toHaveLength(1);
  });

  it('the program id is present and readonly', () => {
    const m = compileMessage([ix()], PAYER, BLOCKHASH);
    expect(m.staticAccountKeys).toContain(PROGRAM);
    expect(m.readonlyAccounts).toContain(PROGRAM);
    expect(m.writableAccounts).not.toContain(PROGRAM);
  });
});

describe('missing decision-bearing fields fail explicitly', () => {
  it('a missing blockhash is an error, not an all-zero default', () => {
    expect(() => compileMessage([ix()], PAYER, '')).toThrow(EncodeError);
    try {
      compileMessage([ix()], PAYER, '');
    } catch (e) {
      expect((e as EncodeError).code).toBe('MISSING_BLOCKHASH');
    }
  });

  it('a missing fee payer is an error', () => {
    try {
      compileMessage([ix()], '', BLOCKHASH);
    } catch (e) {
      expect((e as EncodeError).code).toBe('NO_FEE_PAYER');
    }
  });

  it('an empty account pubkey is an error', () => {
    expect(() =>
      compileMessage([ix({ accounts: [{ pubkey: '', isSigner: false, isWritable: false }] })], PAYER, BLOCKHASH),
    ).toThrow(EncodeError);
  });

  it('more than eight required signatures is refused, matching the decoder', () => {
    // Found by the round-trip property test: the encoder happily built a
    // 9-signer message that the signer's own decoder rejects as implausible.
    // Bytes nothing can validate are not worth producing.
    const signers = Array.from({ length: 9 }, (_, i) => ({
      pubkey: key(300 + i),
      isSigner: true,
      isWritable: false,
    }));
    try {
      compileMessage([ix({ accounts: signers })], PAYER, BLOCKHASH);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as EncodeError).code).toBe('TOO_MANY_SIGNERS');
    }
  });

  it('an oversized transaction is refused rather than truncated', () => {
    // Many distinct accounts push the message past the 1232-byte packet limit.
    const accounts = Array.from({ length: 40 }, (_, i) => ({
      pubkey: key(200 + i),
      isSigner: false,
      isWritable: false,
    }));
    const m = compileMessage([ix({ accounts, data: Buffer.alloc(400).toString('base64') })], PAYER, BLOCKHASH);
    expect(() => encodeUnsignedTransaction(m)).toThrow(/OVERSIZED|bytes/);
  });
});

describe('the packet size is measured, not estimated', () => {
  it('includes signature placeholders, because the wire does', () => {
    const m = compileMessage([ix()], PAYER, BLOCKHASH);
    const message = encodeMessage(m);
    const tx = encodeUnsignedTransaction(m);
    // 1 byte count + 64 per signature. A message measured without them
    // understates the packet by exactly the margin an oversized transaction
    // fails by.
    expect(tx.length).toBe(message.length + 1 + 64 * m.numRequiredSignatures);
    expect(tx.length).toBeLessThanOrEqual(MAX_PACKET_BYTES);
  });
});

describe('property: any instruction set the encoder accepts, the decoder reads back', () => {
  it('round-trips across shuffled account orders and privileges', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            seed: fc.integer({ min: 100, max: 180 }),
            isSigner: fc.boolean(),
            isWritable: fc.boolean(),
          }),
          // Bounded so the generator does not routinely demand more signatures
          // than a transaction may carry; the 8-signer bound has its own test.
          { minLength: 1, maxLength: 6 },
        ),
        fc.uint8Array({ minLength: 0, maxLength: 32 }),
        (accountSpecs, data) => {
          const accounts = accountSpecs.map((a) => ({
            pubkey: key(a.seed),
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          }));
          const m = compileMessage(
            [{ programId: PROGRAM, accounts, data: Buffer.from(data).toString('base64') }],
            PAYER,
            BLOCKHASH,
          );
          const d = decodeTransaction(encodeUnsignedTransaction(m));

          expect(d.staticAccountKeys).toEqual(m.staticAccountKeys);
          expect(d.numRequiredSignatures).toBe(m.numRequiredSignatures);
          expect(d.recentBlockhash).toBe(BLOCKHASH);
          // Every signer sits before every non-signer.
          const lastSigner = d.numRequiredSignatures - 1;
          for (const a of accounts) {
            const i = d.staticAccountKeys.indexOf(a.pubkey);
            if (a.isSigner) expect(i).toBeLessThanOrEqual(lastSigner);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
