import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import BN from 'bn.js';
import {
  feeTiersOf,
  flatFeeOf,
  tierFor,
  boundaries,
  floorRange,
  selectFeeTier,
  tierForPool,
  poolMarketCapLamports,
  feeConfigHash,
} from '../../packages/solana/src/fee-tiers.js';

/**
 * P14 — the dynamic fee boundaries, which the parity matrix never straddled.
 *
 * The size surface measured an AMM drag of 241.5 bps, flat across every size in
 * its grid. That is a correct result and an easy one to misread: the drag is
 * flat in SIZE and a step function across TOKENS, because PumpSwap's fee is a
 * table keyed on the pool's market cap.
 *
 * Reading 241.5 bps as a constant of the venue would calibrate a mechanics gate
 * on whichever tier the sampled mints happened to occupy — the bottom one, as
 * it turns out, which is the most expensive.
 */

const FIXTURE = 'tests/fixtures/pumpswap-selfimpact.json';
const SOL = 1_000_000_000n;

function realFeeConfig(): unknown {
  const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    preBuy: { pubkey: string; owner: string; dataBase64: string }[];
  };
  const raw = f.preBuy.find((x) => x.pubkey === PUMP_AMM_FEE_CONFIG_PDA.toBase58());
  if (raw === undefined) throw new Error('fee config not captured');
  return new PumpAmmSdk().decodeFeeConfig({
    owner: new PublicKey(raw.owner),
    data: Buffer.from(raw.dataBase64, 'base64'),
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  });
}

describe('P14 — the fee is a step function of market cap', () => {
  it.skipIf(!existsSync(FIXTURE))('reads a real tier table out of captured bytes', () => {
    const tiers = feeTiersOf(realFeeConfig());
    expect(tiers.length).toBeGreaterThan(1);
    // Ascending thresholds, because `tierFor` walks them in order.
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i]?.marketCapLamportsThreshold).toBeGreaterThan(
        tiers[i - 1]?.marketCapLamportsThreshold ?? -1n,
      );
    }
  });

  it.skipIf(!existsSync(FIXTURE))('the bottom tier is the most expensive one', () => {
    // Which is the tier every mint in the size surface sat in.
    const tiers = feeTiersOf(realFeeConfig());
    const first = tiers[0];
    const last = tiers[tiers.length - 1];
    expect(first?.marketCapLamportsThreshold).toBe(0n);
    expect(first?.roundTripBps).toBeGreaterThan(last?.roundTripBps ?? 0);
  });

  it.skipIf(!existsSync(FIXTURE))('the floor is a range, not a constant', () => {
    const range = floorRange(feeTiersOf(realFeeConfig()));
    expect(range).not.toBeNull();
    // The measured 241.5 bps has to sit inside it, or one of the two is wrong.
    expect(range?.minBps ?? 0).toBeLessThan(241.5);
    expect(range?.maxBps ?? 0).toBeGreaterThan(241.5);
    expect(range?.spreadBps ?? 0).toBeGreaterThan(100);
  });

  it.skipIf(!existsSync(FIXTURE))('finds boundaries the parity matrix would have to straddle', () => {
    const steps = boundaries(feeTiersOf(realFeeConfig()));
    expect(steps.length).toBeGreaterThan(0);
    // Each is a real change in cost, not a repeated tier.
    expect(steps.every((b) => b.stepBps !== 0)).toBe(true);
  });

  it.skipIf(!existsSync(FIXTURE))('a flat fee exists and is not the tier fee', () => {
    // Two different things in the same account. Confusing them would price
    // every pool at the fallback.
    const cfg = realFeeConfig();
    const flat = flatFeeOf(cfg);
    const tiers = feeTiersOf(cfg);
    expect(flat.totalBps).toBeGreaterThan(0);
    expect(flat.totalBps).not.toBe(tiers[0]?.fees.totalBps);
  });
});

describe('P14 — tier selection', () => {
  const tiers = [
    { marketCapLamportsThreshold: 0n, fees: { lpFeeBps: 2, protocolFeeBps: 93, creatorFeeBps: 30, totalBps: 125 }, roundTripBps: 250 },
    { marketCapLamportsThreshold: 420n * SOL, fees: { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 95, totalBps: 120 }, roundTripBps: 240 },
    { marketCapLamportsThreshold: 1470n * SOL, fees: { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 90, totalBps: 115 }, roundTripBps: 230 },
  ];

  it('takes the highest threshold not exceeding the cap', () => {
    expect(tierFor(tiers, 0n)?.roundTripBps).toBe(250);
    expect(tierFor(tiers, 419n * SOL)?.roundTripBps).toBe(250);
    expect(tierFor(tiers, 420n * SOL)?.roundTripBps).toBe(240);
    expect(tierFor(tiers, 5000n * SOL)?.roundTripBps).toBe(230);
  });

  it('is a step, so one lamport across a boundary changes the cost', () => {
    // The property that makes a single-tier sample uninformative about the
    // boundary: nothing gradual happens here.
    const below = tierFor(tiers, 420n * SOL - 1n);
    const above = tierFor(tiers, 420n * SOL);
    expect(above?.roundTripBps).not.toBe(below?.roundTripBps);
  });

  it('returns null for an empty table rather than inventing a default', () => {
    // A fee config with no tiers is one this code has not understood, and a
    // default fee would be a number nobody measured.
    expect(tierFor([], 1_000n * SOL)).toBeNull();
    expect(floorRange([])).toBeNull();
  });

  it('sums the three components rather than reading one', () => {
    const t = tierFor(tiers, 0n);
    expect(t?.fees.totalBps).toBe(
      (t?.fees.lpFeeBps ?? 0) + (t?.fees.protocolFeeBps ?? 0) + (t?.fees.creatorFeeBps ?? 0),
    );
    // And a round trip pays it twice.
    expect(t?.roundTripBps).toBe((t?.fees.totalBps ?? 0) * 2);
  });
});

/**
 * Directive item 40 — the fee tier matches the SDK's selection, not quote reserve.
 *
 * F15. Pump's fee documentation defines the canonical tier by
 *
 * ```
 * current token price in SOL × 1,000,000,000 tokens
 * ```
 *
 * and the SDK implements it as `quoteReserve × baseMintSupply / baseReserve`.
 * Every classification call site in this repository was instead passing the raw
 * quote reserve — one passed a hardcoded `0n` — to a parameter whose unit is a
 * market cap.
 */
describe('40 — the tier comes from market cap, and the SDK decides the edges', () => {
  const SOL = 1_000_000_000n;
  const tiers = feeTiersOf({
    feeTiers: [
      { marketCapLamportsThreshold: new BN(0), fees: { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 100 } },
      { marketCapLamportsThreshold: new BN((100n * SOL).toString()), fees: { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 30 } },
      { marketCapLamportsThreshold: new BN((420n * SOL).toString()), fees: { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 0 } },
    ],
  });

  /** One billion tokens at six decimals, the canonical Pump supply. */
  const SUPPLY = 1_000_000_000_000_000n;

  it('computes the cap the way the SDK does', () => {
    // quote × supply / base. 10 SOL of quote against a tenth of the supply is
    // a hundred-SOL cap, which quote reserve alone would call ten.
    expect(
      poolMarketCapLamports({
        quoteReserveLamports: 10n * SOL,
        baseReserveAtoms: SUPPLY / 10n,
        baseMintSupplyAtoms: SUPPLY,
      }),
    ).toBe(100n * SOL);
  });

  it('puts that pool in the MIDDLE tier, where quote reserve alone would say bottom', () => {
    const byCap = tierForPool(tiers, {
      quoteReserveLamports: 10n * SOL,
      baseReserveAtoms: SUPPLY / 10n,
      baseMintSupplyAtoms: SUPPLY,
    });
    expect(byCap.marketCapLamports).toBe(100n * SOL);
    expect(byCap.tier?.fees.creatorFeeBps).toBe(30);

    // The old reading: quote reserve straight into a market-cap parameter.
    // 10 SOL is below the first threshold, so it reports the bottom tier and a
    // round-trip floor 140 bps too high.
    const byQuoteReserve = selectFeeTier(tiers, 10n * SOL);
    expect(byQuoteReserve?.fees.creatorFeeBps).toBe(100);
    expect(byQuoteReserve?.roundTripBps).not.toBe(byCap.tier?.roundTripBps);
  });

  it('applies the FIRST tier below its own threshold, as calculateFeeTier does', () => {
    // `tierFor` returns null here, which reads as "no tier applies". The
    // program charges the bottom tier, so null understates the floor for
    // exactly the pools this system samples most — the ones that just migrated.
    const withPositiveFloor = feeTiersOf({
      feeTiers: [
        { marketCapLamportsThreshold: new BN((50n * SOL).toString()), fees: { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 100 } },
        { marketCapLamportsThreshold: new BN((420n * SOL).toString()), fees: { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 0 } },
      ],
    });
    expect(tierFor(withPositiveFloor, 1n * SOL)).toBeNull();
    expect(selectFeeTier(withPositiveFloor, 1n * SOL)?.fees.creatorFeeBps).toBe(100);
  });

  it('selects the highest tier at or below the cap', () => {
    expect(selectFeeTier(tiers, 500n * SOL)?.fees.creatorFeeBps).toBe(0);
    expect(selectFeeTier(tiers, 419n * SOL)?.fees.creatorFeeBps).toBe(30);
    // Exactly ON a threshold takes the higher tier, matching the SDK's `gte`.
    expect(selectFeeTier(tiers, 420n * SOL)?.fees.creatorFeeBps).toBe(0);
  });

  it('REFUSES rather than defaulting when the supply was not read', () => {
    // An unread supply is a fact about the capture. Substituting the canonical
    // one billion would place a non-canonical token in the wrong tier silently.
    const r = tierForPool(tiers, {
      quoteReserveLamports: 10n * SOL,
      baseReserveAtoms: SUPPLY / 10n,
      baseMintSupplyAtoms: null,
    });
    expect(r.tier).toBeNull();
    expect(r.refusal).toContain('supply was not read');
  });

  it('refuses a drained pool rather than dividing by zero', () => {
    const r = tierForPool(tiers, {
      quoteReserveLamports: 10n * SOL,
      baseReserveAtoms: 0n,
      baseMintSupplyAtoms: SUPPLY,
    });
    expect(r.tier).toBeNull();
    expect(r.refusal).toContain('base reserve is zero');
  });

  it('hashes the table, so a stored tier survives Pump republishing it', () => {
    const a = feeConfigHash(tiers, { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 100, totalBps: 125 });
    const b = feeConfigHash(tiers, { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 100, totalBps: 125 });
    expect(a).toBe(b);
    const moved = feeTiersOf({
      feeTiers: [
        { marketCapLamportsThreshold: new BN(0), fees: { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 90 } },
      ],
    });
    expect(feeConfigHash(moved, { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 100, totalBps: 125 })).not.toBe(a);
  });
});
