import { describe, it, expect } from 'vitest';
import { decodeToken2022Mint, MINT_EXTENSION } from '../../packages/solana/src/token2022.js';
import { evaluateCheapGates } from '../../packages/intelligence/src/gates.js';
import { readFileSync } from 'node:fs';
import { AppConfigSchema } from '../../packages/domain/src/config.js';

// The real shipped config, parsed by the real schema.
const paper = AppConfigSchema.parse(JSON.parse(readFileSync('config/paper.json', 'utf8')));

/**
 * P16 — Token-2022 extensions are mandatory facts.
 *
 * Several can take a position from its holder or freeze it in place: a
 * permanent delegate transfers at will, a transfer hook runs arbitrary code on
 * every transfer, non-transferable means the position can never be sold,
 * pausable means transfers can stop after entry.
 *
 * The screening gate has been treating every mint as though none of them
 * existed. The important case is the UNKNOWN one: Token-2022 is extensible, so
 * a type this build does not recognise may do any of the above, and
 * "we do not know" is not "it is harmless".
 */

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** A Token-2022 mint carrying the given extensions. */
function mint(exts: readonly { type: number; value?: Uint8Array }[]): Uint8Array {
  const body = exts.reduce((n, e) => n + 4 + (e.value?.length ?? 0), 0);
  const data = new Uint8Array(166 + body);
  data[165] = 1; // AccountType::Mint
  const view = new DataView(data.buffer);
  let at = 166;
  for (const e of exts) {
    const len = e.value?.length ?? 0;
    view.setUint16(at, e.type, true);
    view.setUint16(at + 2, len, true);
    if (e.value) data.set(e.value, at + 4);
    at += 4 + len;
  }
  return data;
}

describe('P16 — a legacy mint is not a Token-2022 mint with no extensions', () => {
  it('says the extension model does not apply', () => {
    const f = decodeToken2022Mint(new Uint8Array(82), LEGACY);
    expect(f.isToken2022).toBe(false);
    expect(f.hasMoneyCriticalBehaviour).toBe(false);
    // The distinction matters: "checked and found none" and "does not apply"
    // are different facts and only one of them is about the token.
    expect(f.detail).toMatch(/does not apply/);
  });

  it('a Token-2022 mint with no extensions is exactly that', () => {
    const f = decodeToken2022Mint(new Uint8Array(82), TOKEN_2022);
    expect(f.isToken2022).toBe(true);
    expect(f.extensions).toEqual([]);
    expect(f.hasMoneyCriticalBehaviour).toBe(false);
  });
});

describe('P16 — money-critical extensions are found', () => {
  for (const [name, type] of [
    ['PermanentDelegate', MINT_EXTENSION.PermanentDelegate],
    ['TransferHook', MINT_EXTENSION.TransferHook],
    ['NonTransferable', MINT_EXTENSION.NonTransferable],
    ['Pausable', MINT_EXTENSION.Pausable],
    ['DefaultAccountState', MINT_EXTENSION.DefaultAccountState],
    ['ConfidentialTransferMint', MINT_EXTENSION.ConfidentialTransferMint],
  ] as const) {
    it(`${name} is money-critical`, () => {
      const f = decodeToken2022Mint(mint([{ type }]), TOKEN_2022);
      expect(f.hasMoneyCriticalBehaviour, name).toBe(true);
      expect(f.extensions[0]?.name).toBe(name);
      expect(f.detail).toContain('MONEY-CRITICAL');
    });
  }

  it('a benign extension is not money-critical', () => {
    const f = decodeToken2022Mint(mint([{ type: MINT_EXTENSION.MetadataPointer }]), TOKEN_2022);
    expect(f.hasMoneyCriticalBehaviour).toBe(false);
    expect(f.hasUnknownExtension).toBe(false);
  });
});

describe('P16 — an unknown extension is money-critical', () => {
  it('an unrecognised type is not assumed harmless', () => {
    // Token-2022 is extensible. A type this build cannot name may be a
    // permanent delegate under another number, and "we do not know" is not
    // "it is harmless".
    const f = decodeToken2022Mint(mint([{ type: 9999 }]), TOKEN_2022);
    expect(f.hasUnknownExtension).toBe(true);
    expect(f.hasMoneyCriticalBehaviour).toBe(true);
    expect(f.extensions[0]?.unknown).toBe(true);
    expect(f.extensions[0]?.name).toBeNull();
  });

  it('a malformed TLV is unknown, not a shorter list', () => {
    // A walk that ended early because the bytes were bad looks exactly like a
    // mint with fewer extensions, and that is the reading that lets a hostile
    // mint through.
    const data = mint([{ type: MINT_EXTENSION.MetadataPointer }]);
    const view = new DataView(data.buffer);
    view.setUint16(168, 9999, true); // a length that runs past the end
    const f = decodeToken2022Mint(data, TOKEN_2022);
    expect(f.hasUnknownExtension).toBe(true);
    expect(f.hasMoneyCriticalBehaviour).toBe(true);
    expect(f.detail).toMatch(/malformed/);
  });

  it('an account type that is not Mint is refused rather than decoded', () => {
    const data = mint([]);
    data[165] = 2; // AccountType::Account
    const f = decodeToken2022Mint(data, TOKEN_2022);
    expect(f.hasMoneyCriticalBehaviour).toBe(true);
    expect(f.detail).toMatch(/not Mint/);
  });
});

describe('P16 — the transfer fee is read, not assumed zero', () => {
  it('decodes basis points and the maximum fee', () => {
    // 108 bytes of TransferFeeConfig with the newer fee at the tail:
    // ... epoch(8) maximumFee(8) basisPoints(2)
    const value = new Uint8Array(108);
    const v = new DataView(value.buffer);
    v.setBigUint64(108 - 10, 5_000_000n, true);
    v.setUint16(108 - 2, 250, true);
    const f = decodeToken2022Mint(mint([{ type: MINT_EXTENSION.TransferFeeConfig, value }]), TOKEN_2022);
    expect(f.transferFeeBps).toBe(250);
    expect(f.maximumFee).toBe(5_000_000n);
    expect(f.detail).toContain('250bps');
  });

  it('a mint with no fee config reports null, not zero', () => {
    // Zero says the token charges nothing. Null says nobody read it, and an
    // unobserved transfer fee understates every cost it touches.
    const f = decodeToken2022Mint(mint([{ type: MINT_EXTENSION.MetadataPointer }]), TOKEN_2022);
    expect(f.transferFeeBps).toBeNull();
    expect(f.maximumFee).toBeNull();
  });
});

describe('P16 — several extensions at once', () => {
  it('finds all of them and reports the worst', () => {
    const f = decodeToken2022Mint(
      mint([
        { type: MINT_EXTENSION.MetadataPointer },
        { type: MINT_EXTENSION.PermanentDelegate },
        { type: MINT_EXTENSION.TokenMetadata },
      ]),
      TOKEN_2022,
    );
    expect(f.extensions).toHaveLength(3);
    expect(f.hasMoneyCriticalBehaviour).toBe(true);
    expect(f.detail).toContain('PermanentDelegate');
  });
});

describe('P16 — the gate treats money-critical behaviour by mode', () => {
  const base = {
    info: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } as never,
    nowUtcMs: 1_760_000_000_000,
    sourceAgeMs: 1_000,
    config: paper.gates,
  };
  const hostile = {
    hasMoneyCriticalBehaviour: true,
    hasUnknownExtension: false,
    transferFeeBps: null,
    detail: 'MONEY-CRITICAL: PermanentDelegate',
  };

  it('hard-vetoes when capital is at risk', () => {
    // Studying the behaviour is not worth the position.
    const gates = evaluateCheapGates({ ...base, token2022: hostile, capitalAtRisk: true });
    const g = gates.find((x) => x.gate === 'token2022_money_critical');
    expect(g?.severity).toBe('hard_veto');
    expect(g?.passed).toBe(false);
  });

  it('grades it as soft risk while only observing', () => {
    // Development keeps the row so the behaviour can be studied. Refusing to
    // observe it would mean never learning what these mints do.
    const gates = evaluateCheapGates({ ...base, token2022: hostile, capitalAtRisk: false });
    expect(gates.find((x) => x.gate === 'token2022_money_critical')?.severity).toBe('soft_risk');
  });

  it('says nothing when the mint was not read', () => {
    // Absent is not "read and found plain". The gate does not invent a verdict
    // from an absence.
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
