import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SWAP_ACCOUNT_INDEX, namedQuoteDestinations } from '../../packages/solana/src/pumpswap-offline.js';
import {
  version as PUMP_SDK_VERSION,
  swapVersion as PUMP_SWAP_SDK_VERSION,
  PINNED_PUMP_SDK,
  PINNED_PUMP_SWAP_SDK,
  pinnedVersionDrift,
} from '../../packages/domain/src/sdk-versions.js';

/**
 * E-4 — the fee-recipient accounts and their ORDER, against the installed SDK.
 *
 * The 8f73cef audit marked this NOT TESTABLE: *"there is no hardcoded recipient
 * list to compare — the open path reads whatever the SDK selects off the frozen
 * plan, which is the correct design. Confirming SDK 1.19.0 itself against
 * current official Pump docs needs network access this harness deliberately does
 * not take."*
 *
 * That was true of the question as posed. It is not true of the question that
 * matters. The authoritative artifact for what THIS BUILD will send is the
 * Anchor IDL that ships inside the installed package — `pump_amm.json`. It is on
 * disk, it is what the SDK encodes against, and comparing to it needs no
 * network at all.
 *
 * This became testable the moment a positional constant existed to compare
 * against, which is itself a consequence of D-2: the protocol fee recipient's
 * token account sits at index 10, is SELECTED by the SDK, and was 46 bps of
 * unattributed quote on every entry until it was named.
 */

const require_ = createRequire(import.meta.url);

/**
 * Find `pump_amm.json` inside the installed package.
 *
 * `require.resolve` on the subpath fails — the package's `exports` map does not
 * publish `./src/idl/...` — so resolve the package entry and walk up to its
 * root. Returns null when it genuinely is not there, which is reported as a
 * skip rather than as a pass.
 */
function findIdl(): { path: string; idl: Record<string, unknown> } | null {
  let dir: string;
  try {
    dir = dirname(require_.resolve('@pump-fun/pump-swap-sdk'));
  } catch {
    return null;
  }
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'src', 'idl', 'pump_amm.json');
    if (existsSync(candidate)) {
      return { path: candidate, idl: JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown> };
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

interface IdlInstruction {
  name: string;
  accounts: { name: string }[];
}

describe('E-4 — the PumpSwap account order matches the installed SDK', () => {
  const found = findIdl();

  it('the SDK versions are the PINNED ones', () => {
    // The capability fingerprint commits to these. A fingerprint claiming a
    // version the process is not running makes two different builds look
    // identical, which is the one thing it exists to deny.
    expect(pinnedVersionDrift()).toEqual([]);
    expect(PUMP_SWAP_SDK_VERSION).toBe(PINNED_PUMP_SWAP_SDK);
    expect(PUMP_SDK_VERSION).toBe(PINNED_PUMP_SDK);
  });

  it('the IDL ships with the installed package', () => {
    expect(found, 'pump_amm.json was not found inside @pump-fun/pump-swap-sdk').not.toBeNull();
    expect(found!.idl['address']).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  });

  /**
   * The positional layout this repository encodes, against the IDL's own.
   *
   * Every index in `SWAP_ACCOUNT_INDEX` is checked by NAME. A layout change in
   * a future SDK moves a name and fails here, rather than silently relocating
   * the account whose delta the quote-side conservation check reads.
   */
  for (const leg of ['buy', 'sell'] as const) {
    it(`${leg}: every named index holds the account the IDL says it does`, () => {
      const ix = ((found!.idl['instructions'] as IdlInstruction[]) ?? []).find((i) => i.name === leg);
      expect(ix, `the IDL has no ${leg} instruction`).toBeDefined();
      const names = ix!.accounts.map((a) => a.name);

      for (const [label, index] of Object.entries(SWAP_ACCOUNT_INDEX)) {
        const expected = label.toLowerCase();
        expect(names[index], `${leg}[${index}] should be ${expected}`).toBe(expected);
      }
    });
  }

  it('buy carries the two volume accumulators positionally and sell does not', () => {
    /**
     * The asymmetry, from the IDL rather than from a re-reading of it.
     *
     * buy  : … coin_creator_vault_authority, global_volume_accumulator,
     *          user_volume_accumulator, fee_config, fee_program      (23)
     * sell : … coin_creator_vault_authority, fee_config, fee_program (21)
     *
     * This is why the cashback tail is verified POSITIONALLY and why the two
     * legs are verified separately: an account list that is correct for the buy
     * is the wrong length for the sell, and a sell missing its tail LANDS AND
     * TRADES NORMALLY — the creator fee simply goes to the creator.
     */
    const ixs = (found!.idl['instructions'] as IdlInstruction[]) ?? [];
    const buy = ixs.find((i) => i.name === 'buy')!.accounts.map((a) => a.name);
    const sell = ixs.find((i) => i.name === 'sell')!.accounts.map((a) => a.name);

    expect(buy).toContain('global_volume_accumulator');
    expect(buy).toContain('user_volume_accumulator');
    expect(sell).not.toContain('global_volume_accumulator');
    expect(sell).not.toContain('user_volume_accumulator');

    // Both end with the fee accounts, and the buy is exactly two longer.
    expect(buy.slice(-2)).toEqual(['fee_config', 'fee_program']);
    expect(sell.slice(-2)).toEqual(['fee_config', 'fee_program']);
    expect(buy.length - sell.length).toBe(2);
  });

  it('namedQuoteDestinations REFUSES a layout it does not recognise', () => {
    const ix = ((found!.idl['instructions'] as IdlInstruction[]) ?? []).find((i) => i.name === 'buy')!;
    // A synthetic account list in the IDL's own order.
    const accounts = ix.accounts.map((a) => `acct-${a.name}`);
    const expect_ = {
      poolQuoteTokenAccount: 'acct-pool_quote_token_account',
      globalConfig: 'acct-global_config',
    };

    const ok = namedQuoteDestinations(accounts, expect_);
    expect(ok).not.toBeNull();
    expect(ok!.protocolFeeRecipientTokenAccount).toBe('acct-protocol_fee_recipient_token_account');
    expect(ok!.coinCreatorVaultAta).toBe('acct-coin_creator_vault_ata');

    // Shift the list by one: the anchors no longer land where the layout says,
    // so it refuses rather than reading whatever sits at index 10.
    expect(namedQuoteDestinations(['x', ...accounts], expect_)).toBeNull();
    // And a truncated list cannot be read at all.
    expect(namedQuoteDestinations(accounts.slice(0, 5), expect_)).toBeNull();
  });
});
