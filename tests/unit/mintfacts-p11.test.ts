import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluateCheapGates } from '../../packages/intelligence/src/gates.js';
import { AppConfigSchema } from '../../packages/domain/src/config.js';
import {
  readMintFacts,
  gateFactsFrom,
  MintFactsCache,
  type MintFactsSource,
} from '../../packages/intelligence/src/mintfacts-source.js';

/**
 * P11 — one authoritative decoder, read in every mode.
 *
 * `solana/src/token2022.ts` is gone. It walked the TLV area and graded what it
 * found; `solana/src/mint.ts` does that and also decodes both transfer-fee
 * schedules, selects between them by epoch, reports the worst case when the
 * epoch is unknown, and REFUSES an extension newer than itself rather than
 * grading it. The directive's required-capability list is exactly the second
 * one's, and keeping two decoders in parallel means the weaker one is what
 * production actually calls — which it was.
 *
 * The tests that covered the deleted decoder's TLV walk live in
 * `mint-decode.test.ts`, against the decoder that survived. What is here is the
 * part that was never tested at all: the read itself, and the fact that it now
 * happens in paper.
 */

const paper = AppConfigSchema.parse(JSON.parse(readFileSync('config/paper.json', 'utf8')));
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** A legacy mint whose authorities are both live. 82 bytes, both COptions set. */
function legacyMint(p: { mintAuthority: boolean; freezeAuthority: boolean }): Buffer {
  const b = Buffer.alloc(82);
  b.writeUInt32LE(p.mintAuthority ? 1 : 0, 0);
  if (p.mintAuthority) b.fill(7, 4, 36);
  b.writeBigUInt64LE(1_000_000_000n, 36);
  b.writeUInt8(6, 44);
  b.writeUInt8(1, 45);
  b.writeUInt32LE(p.freezeAuthority ? 1 : 0, 46);
  if (p.freezeAuthority) b.fill(9, 50, 82);
  return b;
}

function sourceOf(accounts: Record<string, { owner: string; data: Buffer }>): MintFactsSource {
  return {
    getAccountRaw: async (pubkey: string) => {
      const a = accounts[pubkey];
      if (a === undefined) throw new Error(`no account at ${pubkey}`);
      return { owner: a.owner, dataBase64: a.data.toString('base64'), lamports: 1n };
    },
  };
}

const NOW = 1_760_000_000_000;

describe('P11 — the mint is read, and a legacy mint is read too', () => {
  it('reads mint and freeze authority off a plain SPL mint', async () => {
    // The gates took the provider's word for both of these on every legacy
    // mint, which is most of them.
    const mint = 'Legacy1111111111111111111111111111111111111';
    const f = await readMintFacts(sourceOf({ [mint]: { owner: LEGACY, data: legacyMint({ mintAuthority: true, freezeAuthority: true }) } }), mint, {
      nowUtcMs: NOW,
    });
    expect(f.mintAuthority).toBe('HOSTILE');
    expect(f.freezeAuthority).toBe('HOSTILE');
    expect(f.overall).toBe('HOSTILE');
    expect(f.tokenProgram).toBe(LEGACY);
  });

  it('a renounced mint is SAFE on both, and says so from the bytes', async () => {
    const mint = 'Legacy2222222222222222222222222222222222222';
    const f = await readMintFacts(sourceOf({ [mint]: { owner: LEGACY, data: legacyMint({ mintAuthority: false, freezeAuthority: false }) } }), mint, {
      nowUtcMs: NOW,
    });
    expect(f.mintAuthority).toBe('SAFE');
    expect(f.freezeAuthority).toBe('SAFE');
    expect(f.overall).toBe('SAFE');
  });

  it('an unreadable mint is UNKNOWN and never throws into the screening loop', async () => {
    // A throw here would drop the candidate, and a dropped candidate leaves no
    // row. A filter whose rejects are not stored can never be evaluated.
    const f = await readMintFacts(sourceOf({}), 'Missing1111111111111111111111111111111111111', { nowUtcMs: NOW });
    expect(f.overall).toBe('UNKNOWN');
    expect(f.mintAuthority).toBe('UNKNOWN');
    expect(f.decodeFailure).toMatch(/could not be read/);
  });

  it('an extension newer than the decoder is unknown, not absent', async () => {
    // `decodeMint` throws rather than skipping the entry, so there is no
    // decoded mint to grade — which is stronger than grading it.
    const mint = 'Future11111111111111111111111111111111111111';
    const data = Buffer.alloc(200);
    legacyMint({ mintAuthority: false, freezeAuthority: false }).copy(data, 0);
    data.writeUInt8(1, 165); // account type = Mint
    data.writeUInt16LE(250, 166); // an extension type from the future
    data.writeUInt16LE(0, 168);
    const f = await readMintFacts(sourceOf({ [mint]: { owner: TOKEN_2022, data } }), mint, { nowUtcMs: NOW });
    expect(f.overall).toBe('UNKNOWN');
    expect(f.hasUnknownExtension).toBe(true);
    expect(gateFactsFrom(f).hasMoneyCriticalBehaviour).toBe(true);
  });
});

describe('P11 — the cache spends the RPC budget once, and lets go', () => {
  it('serves a second read of the same mint without touching the source', async () => {
    const mint = 'Cache111111111111111111111111111111111111111';
    let reads = 0;
    const src: MintFactsSource = {
      getAccountRaw: async () => {
        reads += 1;
        return { owner: LEGACY, dataBase64: legacyMint({ mintAuthority: false, freezeAuthority: false }).toString('base64'), lamports: 1n };
      },
    };
    const cache = new MintFactsCache();
    await readMintFacts(src, mint, { nowUtcMs: NOW, cache });
    await readMintFacts(src, mint, { nowUtcMs: NOW + 1_000, cache });
    expect(reads).toBe(1);
  });

  it('re-reads once the entry is older than its TTL', async () => {
    // Authorities do change. Caching forever would turn one read into a
    // permanent claim.
    const mint = 'Cache222222222222222222222222222222222222222';
    let reads = 0;
    const src: MintFactsSource = {
      getAccountRaw: async () => {
        reads += 1;
        return { owner: LEGACY, dataBase64: legacyMint({ mintAuthority: false, freezeAuthority: false }).toString('base64'), lamports: 1n };
      },
    };
    const cache = new MintFactsCache(1_000);
    await readMintFacts(src, mint, { nowUtcMs: NOW, cache });
    await readMintFacts(src, mint, { nowUtcMs: NOW + 5_000, cache });
    expect(reads).toBe(2);
  });

  it('stays bounded, because the system sees thousands of new mints a day', async () => {
    const cache = new MintFactsCache(60_000, 3);
    const src = sourceOf({});
    for (let i = 0; i < 10; i++) {
      const mint = `Bound${i}`.padEnd(43, 'x');
      // Unreadable accounts are not cached, so a readable one is used instead.
      await readMintFacts(
        {
          getAccountRaw: async () => ({
            owner: LEGACY,
            dataBase64: legacyMint({ mintAuthority: false, freezeAuthority: false }).toString('base64'),
            lamports: 1n,
          }),
        },
        mint,
        { nowUtcMs: NOW, cache },
      );
    }
    void src;
    expect(cache.size).toBeLessThanOrEqual(3);
  });
});

describe('P11 — the epoch selects the fee, and an unknown epoch takes the worst', () => {
  /** A Token-2022 mint carrying a TransferFeeConfig with two schedules. */
  function feeMint(older: { epoch: bigint; bps: number }, newer: { epoch: bigint; bps: number }): Buffer {
    // 82 base, padded to 165, type byte at 165, then TLV.
    const data = Buffer.alloc(166 + 4 + 108);
    legacyMint({ mintAuthority: false, freezeAuthority: false }).copy(data, 0);
    data.writeUInt8(1, 165);
    data.writeUInt16LE(1, 166); // TransferFeeConfig
    data.writeUInt16LE(108, 168);
    const v = 170;
    // 32 transfer-fee-config authority, 32 withdraw authority, 8 withheld.
    let at = v + 64 + 8;
    data.writeBigUInt64LE(older.epoch, at);
    data.writeBigUInt64LE(0n, at + 8);
    data.writeUInt16LE(older.bps, at + 16);
    at += 18;
    data.writeBigUInt64LE(newer.epoch, at);
    data.writeBigUInt64LE(0n, at + 8);
    data.writeUInt16LE(newer.bps, at + 16);
    return data;
  }

  it('reports the schedule that is live in THIS epoch', async () => {
    const mint = 'Fee11111111111111111111111111111111111111111';
    const f = await readMintFacts(sourceOf({ [mint]: { owner: TOKEN_2022, data: feeMint({ epoch: 100n, bps: 50 }, { epoch: 900n, bps: 900 }) } }), mint, {
      nowUtcMs: NOW,
      currentEpoch: 200n,
    });
    expect(f.currentEpochTransferFeeBps).toBe(50);
    expect(f.worstCaseTransferFeeBps).toBe(900);
  });

  it('takes the WORST when the epoch is unknown', async () => {
    // Either schedule could be the live one. Only one direction of that error
    // is safe, and it is not the flattering one.
    const mint = 'Fee22222222222222222222222222222222222222222';
    const f = await readMintFacts(sourceOf({ [mint]: { owner: TOKEN_2022, data: feeMint({ epoch: 100n, bps: 50 }, { epoch: 900n, bps: 900 }) } }), mint, {
      nowUtcMs: NOW,
    });
    expect(f.currentEpochTransferFeeBps).toBe(900);
  });

  it('the fee the gate sizes risk on is the one that reaches it', async () => {
    const mint = 'Fee33333333333333333333333333333333333333333';
    const f = await readMintFacts(sourceOf({ [mint]: { owner: TOKEN_2022, data: feeMint({ epoch: 100n, bps: 50 }, { epoch: 900n, bps: 900 }) } }), mint, {
      nowUtcMs: NOW,
      currentEpoch: 200n,
    });
    expect(gateFactsFrom(f).transferFeeBps).toBe(50);
  });
});

describe('P11 — what the gates do with it is still the mode’s decision', () => {
  const base = {
    info: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } as never,
    nowUtcMs: NOW,
    sourceAgeMs: 1_000,
    config: paper.gates,
  };
  const hostile = {
    hasMoneyCriticalBehaviour: true,
    hasUnknownExtension: false,
    transferFeeBps: null,
    detail: 'a permanent delegate is present',
  };

  it('hard-vetoes when capital is at risk', () => {
    const gates = evaluateCheapGates({ ...base, token2022: hostile, capitalAtRisk: true });
    const g = gates.find((x) => x.gate === 'token2022_money_critical');
    expect(g?.severity).toBe('hard_veto');
    expect(g?.passed).toBe(false);
  });

  it('grades it as soft risk while only observing, so the row survives', () => {
    const gates = evaluateCheapGates({ ...base, token2022: hostile, capitalAtRisk: false });
    expect(gates.find((x) => x.gate === 'token2022_money_critical')?.severity).toBe('soft_risk');
  });

  it('says nothing when the mint was not read', () => {
    // Absent is not "read and found plain".
    const gates = evaluateCheapGates({ ...base, token2022: null, capitalAtRisk: true });
    expect(gates.find((x) => x.gate === 'token2022_money_critical')).toBeUndefined();
  });

  it('charges a transfer fee as risk, on BOTH legs', () => {
    const gates = evaluateCheapGates({
      ...base,
      token2022: { ...hostile, hasMoneyCriticalBehaviour: false, transferFeeBps: 300 },
    });
    const g = gates.find((x) => x.gate === 'token2022_transfer_fee');
    expect(g?.riskContribution).toBeGreaterThan(0);
    expect(g?.detail).toMatch(/entry AND exit/);
  });
});
