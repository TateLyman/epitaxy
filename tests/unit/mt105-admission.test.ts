import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MT105,
  admitSignal,
  fnv1a32,
  inclusionProbabilityFor,
} from '../../packages/intelligence/src/wallet-watchlist.js';

/**
 * MT105 — the admission rule.
 *
 * The tape delivers ~69,500 flagged decile-1 buys a day per arm against capacity
 * for a few hundred. Something chooses, and the choice is part of the strategy
 * whether or not anybody writes it down. These tests pin the properties that
 * make it a rule rather than an accident.
 */

describe('MT105 agrees with its preregistration', () => {
  const ledger = readFileSync('docs/MULTIPLE_TESTING_LEDGER.csv', 'utf8');
  const row = ledger.slice(ledger.indexOf('"MT105"'));

  it('is preregistered and not yet resolved', () => {
    expect(row).toContain('"preregistered"');
    expect(row).toContain('NOT YET RUN');
  });

  it('names the hash, the target and the one gate it moves', () => {
    expect(row).toContain('FNV-1a');
    expect(row).toContain('1,000 a day');
    expect(row).toContain('maxTokenAgeMs');
    // The line that matters most: one population gate moves, no risk cap does.
    expect(row).toContain('every risk cap is untouched'.toUpperCase());
    expect(row).toContain('maxPriceImpactBps 150');
    expect(MT105.targetOpensPerDay).toBe(1_000);
  });
});

describe('the admission draw', () => {
  it('is deterministic, so a replay re-derives the same decision', () => {
    /**
     * The invariant this repository applies everywhere: every decision is
     * re-derivable from its snapshot. A call to Math.random would break that
     * silently — the artifact would still say MT105 and the positions would no
     * longer be reproducible.
     */
    const a = admitSignal('MINT', 'WALLET', 0.5);
    for (let i = 0; i < 50; i += 1) expect(admitSignal('MINT', 'WALLET', 0.5)).toBe(a);
  });

  it('does not depend on arrival order, because arrival order is latency', () => {
    const signals = Array.from({ length: 200 }, (_, i) => [`MINT${i}`, `W${i % 7}`] as const);
    const forward = signals.map(([m, w]) => admitSignal(m, w, 0.3));
    const backward = [...signals].reverse().map(([m, w]) => admitSignal(m, w, 0.3)).reverse();
    expect(backward).toEqual(forward);
  });

  it('keys on (mint, wallet) so a refused mint does not come back on the next buy', () => {
    /**
     * MT101 admits one position per mint. Keying the draw on the SIGNATURE
     * would let a refused mint be redrawn on the wallet's next buy, turning
     * "one position per mint" into "however many attempts it took" — which is a
     * selection on how often a wallet re-buys.
     */
    const first = admitSignal('MINT', 'WALLET', 0.2);
    const second = admitSignal('MINT', 'WALLET', 0.2);
    expect(second).toBe(first);
  });

  it('draws a different answer for the same mint under a different wallet', () => {
    const results = new Set(['A', 'B', 'C', 'D', 'E', 'F'].map((w) => admitSignal('MINT', w, 0.5)));
    expect(results.size).toBe(2);
  });

  it('admits about the requested share over many signals', () => {
    const n = 20_000;
    let admitted = 0;
    for (let i = 0; i < n; i += 1) if (admitSignal(`MINT${i}`, 'W', 0.05)) admitted += 1;
    // 5% of 20,000 is 1,000; a hash is not a random source, so the bound is
    // loose enough to be about the sampler rather than about luck.
    expect(admitted / n).toBeGreaterThan(0.04);
    expect(admitted / n).toBeLessThan(0.06);
  });

  it('refuses everything at probability 0 and admits everything at 1', () => {
    expect(admitSignal('M', 'W', 0)).toBe(false);
    expect(admitSignal('M', 'W', -1)).toBe(false);
    expect(admitSignal('M', 'W', Number.NaN)).toBe(false);
    expect(admitSignal('M', 'W', 1)).toBe(true);
    expect(admitSignal('M', 'W', 2)).toBe(true);
  });
});

describe('the inclusion probability', () => {
  it('hits the target against the observed rate', () => {
    expect(inclusionProbabilityFor(139_000)).toBeCloseTo(1_000 / 139_000, 8);
  });

  it('CLAMPS TO 1 when the tape delivers less than the target', () => {
    /**
     * The honest response to a shortfall is to take everything and report it,
     * never to behave as though the target were met. A probability above 1 would
     * silently read as "we hit the target" in any downstream weighting.
     */
    expect(inclusionProbabilityFor(400)).toBe(1);
    expect(inclusionProbabilityFor(0)).toBe(1);
    expect(inclusionProbabilityFor(-5)).toBe(1);
  });
});

describe('the hash', () => {
  it('matches the published FNV-1a 32-bit vectors', () => {
    // The reference values for FNV-1a/32. If the shift-add prime multiply ever
    // drifts out of exact double range these change, and the sample silently
    // becomes a different sample.
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('stays a 32-bit unsigned integer', () => {
    for (const s of ['', 'a', 'MINT|WALLET|MT105', 'x'.repeat(500)]) {
      const h = fnv1a32(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
