import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AppConfigSchema } from '../../packages/domain/src/config.js';
import type { AppConfig } from '../../packages/domain/src/config.js';
import { toExecutableQuote } from '../../packages/adapters/src/jupiter/client.js';
import { OrderResponseSchema } from '../../packages/adapters/src/jupiter/schemas.js';

/**
 * P2a.1 §P0 — a price is not an execution.
 *
 * `transactionBuildable` was written to storage from the first commit and read
 * by no decision. Paper mode booked 38 fills across 19 positions against
 * quotes where the flag was false on all 2255 rows, because every quote was
 * fetched without a `taker` and Jupiter therefore returned no transaction.
 *
 * These tests pin the two halves of that: the parser must report buildability
 * honestly for every shape the API can return, and the config that gates on it
 * must default to refusing.
 */

const MODES = ['observe', 'paper', 'canary', 'live'] as const;

/** A structurally complete order response, minus whatever a test removes. */
function order(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inAmount: '1000000000',
    outAmount: '75802844',
    otherAmountThreshold: '75423830',
    swapMode: 'ExactIn',
    slippageBps: 50,
    routePlan: [
      {
        swapInfo: {
          ammKey: 'AAAAAAAAAAAA',
          label: 'Raydium',
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          inAmount: '1000000000',
          outAmount: '75802844',
        },
      },
    ],
    feeBps: 2,
    priceImpact: -0.1820511452303203,
    priceImpactPct: '-0.0018205114523032028',
    router: 'metis',
    swapType: 'aggregator',
    transaction: null,
    taker: null,
    ...over,
  };
}

function parse(raw: Record<string, unknown>) {
  const o = OrderResponseSchema.parse(raw);
  return toExecutableQuote(o, 1_000, {
    source: 'test',
    sourceType: 'official_indexer',
    receivedMonotonicMs: 0,
    receivedUtcMs: 1_100,
    slot: null,
    sourceUtcMs: null,
    schemaVersion: 'test',
    parserVersion: 'test',
    payloadHash: '',
  }, 100);
}

describe('buildability is reported from what the provider actually returned', () => {
  it('quote-only (no taker) is NOT buildable — the shape every stored row has', () => {
    expect(parse(order()).transactionBuildable).toBe(false);
  });

  it('an empty-string transaction is NOT buildable', () => {
    // Jupiter returns "" when a build was attempted and failed.
    expect(parse(order({ transaction: '' })).transactionBuildable).toBe(false);
  });

  it('an absent transaction field is NOT buildable', () => {
    const o = order();
    delete o['transaction'];
    expect(parse(o).transactionBuildable).toBe(false);
  });

  it('a non-empty transaction IS buildable', () => {
    expect(parse(order({ transaction: 'AQABAgMEBQ==' })).transactionBuildable).toBe(true);
  });

  it('pricing being present does not make a quote buildable', () => {
    // The exact failure mode: full routing, fees and amounts, no transaction.
    const q = parse(order());
    expect(q.outAmount).toBeGreaterThan(0n);
    expect(q.routeLabels.length).toBeGreaterThan(0);
    expect(q.transactionBuildable).toBe(false);
  });
});

describe('every mode refuses an unbuildable fill by default', () => {
  for (const mode of MODES) {
    it(`${mode}.json sets requireBuildableFill true`, () => {
      const config: AppConfig = AppConfigSchema.parse(JSON.parse(readFileSync(`config/${mode}.json`, 'utf8')));
      expect(config.requireBuildableFill).toBe(true);
    });
  }

  it('the field is required, so a config omitting it cannot load', () => {
    const raw = JSON.parse(readFileSync('config/paper.json', 'utf8')) as Record<string, unknown>;
    delete raw['requireBuildableFill'];
    expect(() => AppConfigSchema.parse(raw)).toThrow();
  });
});

describe('the impact field carries the provider’s own sign', () => {
  /**
   * Verified against the live endpoint on 2026-08-12: `/swap/v2/order` returns
   * BOTH `priceImpact` (percent) and `priceImpactPct` (fraction), and both are
   * NEGATIVE for an ordinary adverse quote. Documentation describing an
   * unsigned 0..1 decimal does not match the deployed API, so a negative value
   * is a market fact and must not be discarded as a parser error.
   */
  it('preserves a negative impact rather than dropping or flipping it', () => {
    const q = parse(order());
    expect(q.priceImpactPct).toBeCloseTo(-0.0018205114523032028, 12);
  });

  it('the two provider fields agree once scaled, so the branch taken is immaterial', () => {
    const viaPercent = parse(order()).priceImpactPct;
    const o = order();
    delete o['priceImpact'];
    const viaFraction = parse(o).priceImpactPct;
    expect(viaPercent).toBeCloseTo(viaFraction, 15);
  });

  it('a total-loss quote reads as -1, which is -10000bps and not +10000', () => {
    const q = parse(order({ priceImpact: -100, priceImpactPct: '-1' }));
    expect(q.priceImpactPct).toBe(-1);
    expect(Math.round(q.priceImpactPct * 10_000)).toBe(-10_000);
  });
});
