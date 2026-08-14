import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PumpAmmSdk } from '@pump-fun/pump-swap-sdk';
import {
  mayhemFactsOf,
  bondingCurveMayhemMode,
  breadthUsability,
  MAYHEM_PROGRAM,
  BONDING_CURVE_MAYHEM_OFFSET,
} from '../../packages/solana/src/mayhem.js';
import { poolAddressesFrom, accountSourceOf } from '../../packages/solana/src/pumpswap-offline.js';

/**
 * P24 item 32 — Mayhem flow is excluded from organic breadth.
 *
 * I recorded this requirement as having no verifiable source and left the table
 * empty. That was wrong, and the evidence was already in hand: `isMayhemMode`
 * is a decoded field on the PumpSwap pool account, in the very IDL this system
 * uses to price every swap.
 *
 * What is genuinely unavailable is the Mayhem program's own account layout, so
 * the agent's inventory, buys, sells and burn transition stay null. The
 * distinction those tests defend is the one that matters: a Mayhem pool's
 * breadth is UNUSABLE, not adjustable. Subtracting an unmeasured agent volume
 * from organic flow is not a correction, it is a guess with a minus sign.
 */

const FIXTURE = 'tests/fixtures/pumpswap-selfimpact.json';
const NOW = 1_760_000_000_000;



describe('P11 — Mayhem mode is decoded from the pool, not looked for elsewhere', () => {
  it('reads isMayhemMode off real captured pool bytes', () => {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      pool: string;
      preBuy: { pubkey: string; owner: string; dataBase64: string; lamports: string }[];
    };
    const a = f.preBuy.find((x) => x.pubkey === f.pool);
    expect(a).toBeDefined();
    const addrs = poolAddressesFrom(
      accountSourceOf([
        {
          pubkey: f.pool,
          owner: a?.owner ?? '',
          dataBase64: a?.dataBase64 ?? '',
          lamports: BigInt(a?.lamports ?? '0'),
        },
      ]),
      f.pool,
    );
    // A boolean, from bytes. Not null, which would mean the field is absent.
    expect(typeof addrs.isMayhemMode).toBe('boolean');
    expect(typeof addrs.isCashbackCoin).toBe('boolean');
  });

  it('the SDK the pricing already uses carries the field', () => {
    // Guards the claim itself: if a future SDK drops isMayhemMode, this fails
    // rather than silently returning null forever.
    const sdk = new PumpAmmSdk();
    expect(typeof sdk.decodePool).toBe('function');
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      pool: string;
      preBuy: { pubkey: string; owner: string; dataBase64: string }[];
    };
    const a = f.preBuy.find((x) => x.pubkey === f.pool) as { owner: string; dataBase64: string };
    const decoded = sdk.decodePool({
      owner: new PublicKey(a.owner),
      data: Buffer.from(a.dataBase64, 'base64'),
      lamports: 1,
      executable: false,
      rentEpoch: 0,
    }) as unknown as Record<string, unknown>;
    expect('isMayhemMode' in decoded).toBe(true);
  });

  it('reads the flag off a bonding curve too, so pre-migration is covered', () => {
    // Anchor layout from the published pump IDL: 8 discriminator + 5 u64 +
    // bool + 32-byte creator = 81.
    const curve = Buffer.alloc(BONDING_CURVE_MAYHEM_OFFSET + 1);
    curve[BONDING_CURVE_MAYHEM_OFFSET] = 1;
    expect(bondingCurveMayhemMode(curve)).toBe(true);
    curve[BONDING_CURVE_MAYHEM_OFFSET] = 0;
    expect(bondingCurveMayhemMode(curve)).toBe(false);
  });

  it('refuses a truncated curve rather than reading it as not-Mayhem', () => {
    expect(bondingCurveMayhemMode(Buffer.alloc(BONDING_CURVE_MAYHEM_OFFSET))).toBeNull();
  });

  it('refuses a byte that is not a bool, because the offset would be wrong', () => {
    const curve = Buffer.alloc(BONDING_CURVE_MAYHEM_OFFSET + 1);
    curve[BONDING_CURVE_MAYHEM_OFFSET] = 7;
    expect(bondingCurveMayhemMode(curve)).toBeNull();
  });

  it('names the program without pretending to decode it', () => {
    expect(MAYHEM_PROGRAM).toBe('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
  });
});

describe('P11 — what cannot be decoded stays null, with the reason', () => {
  it('never invents an agent inventory', () => {
    const f = mayhemFactsOf({ mint: 'M', nowUtcMs: NOW, poolIsMayhemMode: true });
    expect(f.agentInventoryAtoms).toBeNull();
    expect(f.agentBuyCount).toBeNull();
    expect(f.agentSellCount).toBeNull();
    expect(f.additionalSupplyAtoms).toBeNull();
    expect(f.burnTransition).toBeNull();
    expect(f.unknownReason).toMatch(/no IDL or decoder/);
  });

  it('prefers the pool over the curve a migrated token has left behind', () => {
    const f = mayhemFactsOf({
      mint: 'M',
      nowUtcMs: NOW,
      poolIsMayhemMode: false,
      bondingCurveIsMayhemMode: true,
    });
    expect(f.enabled).toBe(false);
    expect(f.source).toBe('pumpswap_pool');
  });

  it('falls back to the curve before migration', () => {
    const f = mayhemFactsOf({
      mint: 'M',
      nowUtcMs: NOW,
      poolIsMayhemMode: null,
      bondingCurveIsMayhemMode: true,
    });
    expect(f.enabled).toBe(true);
    expect(f.source).toBe('bonding_curve');
  });

  it('neither venue readable is null and source none, never false', () => {
    const f = mayhemFactsOf({ mint: 'M', nowUtcMs: NOW, poolIsMayhemMode: null });
    expect(f.enabled).toBeNull();
    expect(f.source).toBe('none');
  });
});

describe('P24 item 32 — Mayhem flow does not count as organic breadth', () => {
  it('a Mayhem venue is CONTAMINATED_UNQUANTIFIED and not organic', () => {
    const r = breadthUsability({ enabled: true });
    expect(r.usability).toBe('CONTAMINATED_UNQUANTIFIED');
    expect(r.countsAsOrganic).toBe(false);
    expect(r.reason).toMatch(/cannot be isolated/);
  });

  it('a non-Mayhem venue is organic', () => {
    const r = breadthUsability({ enabled: false });
    expect(r.usability).toBe('ORGANIC');
    expect(r.countsAsOrganic).toBe(true);
  });

  it('an unread venue is NOT organic', () => {
    // Absence of a reading is a fact about the reading, not about the token. A
    // mint whose Mayhem mode was never established has not been shown to have
    // organic flow.
    const r = breadthUsability({ enabled: null });
    expect(r.usability).toBe('UNKNOWN');
    expect(r.countsAsOrganic).toBe(false);
  });

  it('does not offer a subtraction', () => {
    // The tempting shape is `organicVolume = total - agentVolume`. Without the
    // layout, agentVolume is unknown, and subtracting an unknown produces a
    // number that looks corrected and is not.
    const r = breadthUsability({ enabled: true });
    expect(Object.keys(r)).toEqual(['usability', 'countsAsOrganic', 'reason']);
  });
});
