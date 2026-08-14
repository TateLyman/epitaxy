import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import { feeTiersOf, flatFeeOf, tierFor, boundaries, floorRange } from '../../packages/solana/src/fee-tiers.js';

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
