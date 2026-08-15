import { describe, it, expect } from 'vitest';
import {
  captureCoherentSnapshotV2,
  SnapshotIncoherent,
  decodeClock,
  decodeRent,
  decodeEpochSchedule,
  decodeLookupTableAddresses,
  hashAccount,
  CLOCK_SYSVAR,
  RENT_SYSVAR,
  EPOCH_SCHEDULE_SYSVAR,
  MAX_ECONOMIC_BATCH,
  type CoherentReader,
} from '../../packages/solana/src/coherent-snapshot.js';
import { base58Encode } from '../../packages/solana/src/base58.js';

/**
 * P2 — a snapshot is a set of accounts that were simultaneously true.
 *
 * The defect being tested against is a capture that reads accounts one at a
 * time and stamps one slot on the result: the stamp then describes none of them,
 * and the set as a whole describes a state that never existed. Every number
 * derived from it is a confident measurement of a fiction.
 */

const POOL = 'So11111111111111111111111111111111111111112';
const VAULT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const VAULT_B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const OWNER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function acct(pubkey: string, slot: number, data = 'AAAA', over: Record<string, unknown> = {}) {
  return {
    pubkey,
    slot,
    owner: OWNER,
    executable: false,
    lamports: 1_000n,
    dataBase64: data,
    rentEpoch: 361n,
    space: 165,
    ...over,
  } as never;
}

function clockBytes(slot: bigint, unix: bigint): string {
  const b = Buffer.alloc(40);
  b.writeBigUInt64LE(slot, 0);
  b.writeBigInt64LE(0n, 8);
  b.writeBigUInt64LE(7n, 16);
  b.writeBigUInt64LE(8n, 24);
  b.writeBigInt64LE(unix, 32);
  return b.toString('base64');
}

function rentBytes(): string {
  const b = Buffer.alloc(17);
  b.writeBigUInt64LE(3_480n, 0);
  b.writeDoubleLE(2, 8);
  b.writeUInt8(50, 16);
  return b.toString('base64');
}

function scheduleBytes(): string {
  const b = Buffer.alloc(33);
  b.writeBigUInt64LE(432_000n, 0);
  b.writeBigUInt64LE(432_000n, 8);
  b.writeUInt8(0, 16);
  b.writeBigUInt64LE(14n, 17);
  b.writeBigUInt64LE(6_048_000n, 25);
  return b.toString('base64');
}

/** A reader whose per-key slots the test controls exactly. */
function readerOf(
  slots: Record<string, number>,
  opts: { missing?: readonly string[]; blockTime?: number | null; data?: Record<string, string> } = {},
): CoherentReader & { batches: string[][] } {
  const batches: string[][] = [];
  return {
    batches,
    async getSlot() {
      return 100;
    },
    async getBlockTime() {
      return opts.blockTime === undefined ? 1_760_000_000 : opts.blockTime;
    },
    async getMultipleAccountsAtSlot(pubkeys) {
      batches.push([...pubkeys]);
      const accounts = new Map<string, never>();
      let high = 0;
      for (const k of pubkeys) {
        if ((opts.missing ?? []).includes(k)) {
          accounts.set(k, null as never);
          continue;
        }
        const slot = slots[k] ?? 100;
        high = Math.max(high, slot);
        const data =
          opts.data?.[k] ??
          (k === CLOCK_SYSVAR
            ? clockBytes(BigInt(slot), 1_760_000_000n)
            : k === RENT_SYSVAR
              ? rentBytes()
              : k === EPOCH_SCHEDULE_SYSVAR
                ? scheduleBytes()
                : 'AAAA');
        accounts.set(k, acct(k, slot, data));
      }
      return { contextSlot: high, accounts };
    },
  };
}

describe('P2 — coherence is enforced, not assumed', () => {
  it('captures a coherent set and reports zero drift', async () => {
    const r = readerOf({ [POOL]: 100, [VAULT_A]: 100, [VAULT_B]: 100 });
    const s = await captureCoherentSnapshotV2(r, { economicAccounts: [POOL, VAULT_A, VAULT_B] }, base58Encode);
    expect(s.economicDriftSlots).toBe(0);
    expect(s.captureSlotLow).toBe(100);
    expect(s.captureSlotHigh).toBe(100);
    expect(s.accounts).toHaveLength(6); // three economic plus three sysvars
  });

  it('REFUSES a set whose price-bearing accounts came from different slots', async () => {
    // The exact defect: a vault read one slot later than the pool it belongs to.
    // The old capture stamped one slot on this and called it a snapshot.
    const r = readerOf({ [POOL]: 100, [VAULT_A]: 100, [VAULT_B]: 101 });
    await expect(
      captureCoherentSnapshotV2(r, { economicAccounts: [POOL, VAULT_A, VAULT_B] }, base58Encode),
    ).rejects.toThrow(SnapshotIncoherent);
    await expect(
      captureCoherentSnapshotV2(r, { economicAccounts: [POOL, VAULT_A, VAULT_B] }, base58Encode),
    ).rejects.toThrow(/never simultaneously true/);
  });

  it('a genuinely static account served at a later slot does NOT break coherence', async () => {
    // A program's bytes cannot change what a swap costs. Refusing on its drift
    // would reject good snapshots and teach the operator to widen the bound.
    //
    // The CLOCK is no longer such an account: F4 moved it into the economic
    // tier, because PumpSwap's UserVolumeAccumulator is time-windowed and a
    // Clock from another slot can move a simulated trade into a different fee
    // or cashback window.
    const r = readerOf({ [POOL]: 100, [VAULT_A]: 100, [RENT_SYSVAR]: 140 });
    const s = await captureCoherentSnapshotV2(
      r,
      { economicAccounts: [POOL, VAULT_A], staticAccounts: [] },
      base58Encode,
    );
    expect(s.economicDriftSlots).toBe(0);
  });

  it('a CLOCK from a later slot DOES break coherence', async () => {
    // The F4 repair, asserted directly.
    const r = readerOf({ [POOL]: 100, [VAULT_A]: 100, [CLOCK_SYSVAR]: 140 });
    await expect(
      captureCoherentSnapshotV2(r, { economicAccounts: [POOL, VAULT_A] }, base58Encode),
    ).rejects.toThrow(/never simultaneously true/);
  });

  it('the default drift bound is zero, because any other value admits a fiction', async () => {
    const r = readerOf({ [POOL]: 100, [VAULT_A]: 102 });
    await expect(captureCoherentSnapshotV2(r, { economicAccounts: [POOL, VAULT_A] }, base58Encode)).rejects.toThrow(
      /drift 2 > bound 0/,
    );
  });

  it('refuses more economic accounts than ONE PROVIDER CALL can serve', async () => {
    // The ceiling is the provider's, not a round number. QuickNode's discover
    // plan caps getMultipleAccounts at 5 and answers a sixth with HTTP 413 /
    // -32615 — which a caller then reports as a coherence refusal, an apparatus
    // fault wearing a market fault's name.
    //
    // Splitting the set is not an option: the one-slot guarantee is the whole
    // module, so the cap is a ceiling rather than a tuning parameter.
    const many = Array.from({ length: MAX_ECONOMIC_BATCH + 1 }, (_, i) => {
      const b = Buffer.alloc(32);
      b.writeUInt32LE(i + 1, 0);
      return base58Encode(b);
    });
    expect(new Set(many).size).toBe(MAX_ECONOMIC_BATCH + 1);
    await expect(
      captureCoherentSnapshotV2(readerOf({}), { economicAccounts: many }, base58Encode),
    ).rejects.toThrow(/single-batch ceiling/);
  });

  it('puts the CLOCK in the economic batch, and pins later batches to its slot', async () => {
    const r = readerOf({ [POOL]: 100, [VAULT_A]: 100 });
    await captureCoherentSnapshotV2(r, { economicAccounts: [POOL, VAULT_A] }, base58Encode);
    // The price-bearing accounts AND the Clock go first, in ONE call, so they
    // share one context slot by construction rather than by a later check.
    expect(r.batches[0]).toContain(POOL);
    expect(r.batches[0]).toContain(CLOCK_SYSVAR);
    // Rent and EpochSchedule are not time-windowed and may legitimately follow.
    expect(r.batches[1]).toContain(RENT_SYSVAR);
  });
});

describe('P2 — fail closed, and name what is missing', () => {
  it('an account required to decode that is absent refuses the snapshot', async () => {
    const r = readerOf({ [POOL]: 100 }, { missing: [VAULT_A] });
    await expect(
      captureCoherentSnapshotV2(
        r,
        { economicAccounts: [POOL, VAULT_A], requireDecodable: [VAULT_A] },
        base58Encode,
      ),
    ).rejects.toThrow(/required to decode but is absent/);
  });

  it('a missing account REFUSES the snapshot unless incompleteness is accepted', async () => {
    // F5: this used to return a usable snapshot with a note, delegating refusal
    // to whichever consumer remembered to inspect `omissions` — fail OPEN.
    const r = readerOf({ [POOL]: 100 }, { missing: [VAULT_A] });
    await expect(
      captureCoherentSnapshotV2(r, { economicAccounts: [POOL, VAULT_A] }, base58Encode),
    ).rejects.toThrow(/pass allowIncomplete/);
  });

  it('a deliberately partial snapshot still records the omission, never drops it', async () => {
    const r = readerOf({ [POOL]: 100 }, { missing: [VAULT_A] });
    const s = await captureCoherentSnapshotV2(
      r,
      { economicAccounts: [POOL, VAULT_A], allowIncomplete: true },
      base58Encode,
    );
    expect(s.omissions).toContain(VAULT_A);
    expect(s.incompleteness.join(' ')).toMatch(/do not exist on chain/);
  });

  it('records that the chain would not give a block time rather than substituting one', async () => {
    const r = readerOf({ [POOL]: 100 }, { blockTime: null });
    const s = await captureCoherentSnapshotV2(r, { economicAccounts: [POOL] }, base58Encode);
    expect(s.blockTimeUnix).toBeNull();
    expect(s.incompleteness.join(' ')).toMatch(/block time/);
  });
});

describe('P2 — u64 never crosses Number, and rentEpoch is never invented', () => {
  it('serializes lamports as a decimal string above 2^53', async () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const r = readerOf({ [POOL]: 100 });
    const orig = r.getMultipleAccountsAtSlot.bind(r);
    r.getMultipleAccountsAtSlot = async (keys, o) => {
      const res = await orig(keys, o);
      const v = res.accounts.get(POOL);
      if (v) res.accounts.set(POOL, { ...v, lamports: big } as never);
      return res;
    };
    const s = await captureCoherentSnapshotV2(r, { economicAccounts: [POOL] }, base58Encode);
    const row = s.accounts.find((a) => a.pubkey === POOL);
    expect(row?.lamports).toBe('9007199254740993');
    // The round trip through JSON must not damage it.
    expect(JSON.parse(JSON.stringify(s)).accounts.find((a: never) => (a as { pubkey: string }).pubkey === POOL).lamports).toBe(
      '9007199254740993',
    );
  });

  it('keeps the real rentEpoch and does not hardcode zero', async () => {
    const r = readerOf({ [POOL]: 100 });
    const s = await captureCoherentSnapshotV2(r, { economicAccounts: [POOL] }, base58Encode);
    expect(s.accounts.find((a) => a.pubkey === POOL)?.rentEpoch).toBe('361');
  });

  it('hashes "the provider did not say" differently from "the epoch is zero"', () => {
    const base = { owner: OWNER, lamports: 1n, dataBase64: 'AAAA' };
    expect(hashAccount({ ...base, rentEpoch: null })).not.toBe(hashAccount({ ...base, rentEpoch: 0n }));
  });
});

describe('P2 — the sysvars a replayed runtime needs', () => {
  it('decodes Clock, Rent and EpochSchedule from their real layouts', async () => {
    const r = readerOf({ [POOL]: 100 });
    const s = await captureCoherentSnapshotV2(r, { economicAccounts: [POOL] }, base58Encode);
    expect(s.clock?.slot).toBe('100');
    expect(s.clock?.unixTimestamp).toBe('1760000000');
    expect(s.rent?.lamportsPerByteYear).toBe('3480');
    expect(s.rent?.exemptionThreshold).toBe(2);
    expect(s.epochSchedule?.slotsPerEpoch).toBe('432000');
    expect(s.epochSchedule?.warmup).toBe(false);
  });

  it('refuses a truncated sysvar rather than decoding a partial one', () => {
    expect(() => decodeClock(Buffer.alloc(8))).toThrow(SnapshotIncoherent);
    expect(() => decodeRent(Buffer.alloc(4))).toThrow(SnapshotIncoherent);
    expect(() => decodeEpochSchedule(Buffer.alloc(20))).toThrow(SnapshotIncoherent);
  });
});

describe('P2 — address lookup tables resolve or refuse', () => {
  it('decodes the packed 32-byte address array after the 56-byte header', () => {
    const b = Buffer.alloc(56 + 64);
    b[56] = 1;
    b[88] = 2;
    const addrs = decodeLookupTableAddresses(b, base58Encode);
    expect(addrs).toHaveLength(2);
    expect(addrs[0]).not.toBe(addrs[1]);
  });

  it('refuses a trailing partial address instead of truncating it', () => {
    // A truncated table would silently resolve FEWER accounts than the
    // transaction actually references, which reads as a missing account rather
    // than as a corrupt table.
    expect(() => decodeLookupTableAddresses(Buffer.alloc(56 + 33), base58Encode)).toThrow(/not a multiple of 32/);
  });
});
