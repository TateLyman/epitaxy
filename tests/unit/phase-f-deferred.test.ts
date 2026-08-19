import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Phase F — the three measurements that were deferred because stop conditions
 * fired, and the invariants that keep each of them honest.
 *
 * §1  the carry-forward correction on the Phase B trigger means
 * §2  the reserve reconstruction, and the bar it had to clear before any use
 * §3  H1 at entity level
 *
 * The failure modes guarded here:
 *
 *   1. a correction that quietly shrinks its own denominator. Carry-forward and
 *      residual-at-zero exist to widen the population the mean is taken over, so
 *      their n must never fall below the as-reported n;
 *   2. a residual-at-zero treatment that invents a trade. A mint whose ENTRY had no
 *      price has no position to lose, and giving it -100% would manufacture one;
 *   3. calling the reconstruction validated on a p50 alone. The directive requires
 *      p50 within 1% AND agreement above 95%, and the p50 passed while agreement did
 *      not — so a conjunction that was silently read as a disjunction would have
 *      licensed pricing 46% of Phase C's positions with a broken instrument;
 *   4. reading the entity-level re-run as a second test of H1 rather than a
 *      correction to it.
 */

const TRIGGERS = 'artifacts/trigger-cells.json';
const ANCHORS = 'artifacts/phase-f-anchors.json';
const VALIDATION = 'ops/dune/results/q9-reserve-validation.json';

describe('§1 — the carry-forward correction on the Phase B cells', () => {
  if (!existsSync(TRIGGERS)) {
    it.skip('artifact absent — run pnpm trigger:cells', () => {});
    return;
  }
  const a = JSON.parse(readFileSync(TRIGGERS, 'utf8')) as {
    cellCount: number;
    finalState: string;
    cells: {
      trigger: string;
      population: string;
      nHoldout: number;
      censoredHoldout: number;
      firedEligibleHoldout: number;
      censoredFractionHoldout: number | null;
      carryForwardMarkedHoldout: number;
      noMarkAtAllHoldout: number;
      nCarryForward: number;
      nResidualZero: number;
      grossMeanHoldout: number | null;
      carryForwardMeanHoldout: number | null;
      residualZeroMeanHoldout: number | null;
      correctionAgreesInSign: boolean;
    }[];
  };

  it('leaves Phase B\'s own verdict untouched', () => {
    expect(a.finalState).toBe('NO_DECIDABLE_CELL');
    expect(a.cellCount).toBe(720);
  });

  it('never shrinks the population a correction is meant to widen', () => {
    for (const c of a.cells) {
      // The mark adds censored positions to the survivors; it cannot remove any.
      expect(c.nCarryForward).toBeGreaterThanOrEqual(c.nHoldout);
      // -100% is applied to every position that had an entry price, so its n is at
      // least as large again.
      expect(c.nResidualZero).toBeGreaterThanOrEqual(c.nCarryForward);
      expect(c.nResidualZero).toBeLessThanOrEqual(c.firedEligibleHoldout);
    }
  });

  it('accounts for every censored position exactly once', () => {
    for (const c of a.cells) {
      // Marked plus unmarkable equals censored: no position is both or neither.
      expect(c.carryForwardMarkedHoldout + c.noMarkAtAllHoldout).toBe(c.censoredHoldout);
      expect(c.nCarryForward).toBe(c.nHoldout + c.carryForwardMarkedHoldout);
    }
  });

  it('keeps the censored fraction consistent with its own counts', () => {
    for (const c of a.cells) {
      if (c.firedEligibleHoldout === 0) {
        expect(c.censoredFractionHoldout).toBeNull();
        continue;
      }
      expect(c.censoredFractionHoldout as number).toBeCloseTo(
        c.censoredHoldout / c.firedEligibleHoldout,
        10,
      );
    }
  });

  it('flags the sign disagreement rather than choosing a treatment', () => {
    for (const c of a.cells) {
      if (c.grossMeanHoldout === null || c.carryForwardMeanHoldout === null || c.residualZeroMeanHoldout === null) {
        expect(c.correctionAgreesInSign).toBe(false);
        continue;
      }
      const agree =
        Math.sign(c.grossMeanHoldout) === Math.sign(c.carryForwardMeanHoldout) &&
        Math.sign(c.grossMeanHoldout) === Math.sign(c.residualZeroMeanHoldout);
      expect(c.correctionAgreesInSign).toBe(agree);
    }
  });

  it('records that the pre-migration positives do NOT survive the -100% bound', () => {
    // The finding itself, pinned: every positive as-reported mean in the
    // pre-migration population flips under residual-at-zero. If a later change made
    // that stop being true, this phase's conclusion would need rewriting.
    const positives = a.cells.filter((c) => c.population === 'all-snapshotted' && (c.grossMeanHoldout ?? 0) > 0);
    expect(positives.length).toBeGreaterThan(200);
    expect(positives.every((c) => (c.carryForwardMeanHoldout ?? -1) > 0)).toBe(true);
    expect(positives.some((c) => (c.residualZeroMeanHoldout ?? -1) > 0)).toBe(false);
  });
});

describe('§2 — the anchor inventory and the validation bar', () => {
  if (!existsSync(ANCHORS)) {
    it.skip('artifact absent — run pnpm anchors', () => {});
    return;
  }
  const a = JSON.parse(readFileSync(ANCHORS, 'utf8')) as {
    snapshots: number;
    pools: number;
    readableSnapshots: number;
    readablePools: number;
    anchoredPoolsOverlappingPhaseCWindow: number;
    anchors: { readable: boolean; baseReserve: string | null; quoteReserve: string | null }[];
  };

  it('reads reserves out of the stored bytes for every snapshot it claims', () => {
    expect(a.snapshots).toBe(413);
    expect(a.pools).toBe(142);
    expect(a.readableSnapshots).toBe(a.anchors.filter((x) => x.readable).length);
    for (const x of a.anchors.filter((y) => y.readable)) {
      expect(x.baseReserve).not.toBeNull();
      expect(x.quoteReserve).not.toBeNull();
      // Reserves are raw units held as strings, never floats.
      expect(BigInt(x.baseReserve as string) >= 0n).toBe(true);
      expect(BigInt(x.quoteReserve as string) >= 0n).toBe(true);
    }
  });

  if (!existsSync(VALIDATION)) {
    it.skip('validation result absent', () => {});
    return;
  }
  const v = JSON.parse(readFileSync(VALIDATION, 'utf8')) as {
    result: { rows: { test: string; n_trades: number; base_ratio: number | null; quote_ratio: number | null }[] };
  };
  const pairs = v.result.rows.filter((r) => r.test === 'PAIR');

  it('requires p50 within 1% AND agreement above 95%, as a conjunction', () => {
    const within = (f: 'base_ratio' | 'quote_ratio'): { p50: number; share: number } => {
      const xs = pairs.map((r) => r[f]).filter((x): x is number => x !== null).sort((p, q) => p - q);
      return {
        p50: xs[Math.floor(xs.length / 2)] as number,
        share: xs.filter((x) => Math.abs(x - 1) <= 0.01).length / xs.length,
      };
    };
    const b = within('base_ratio');
    const q = within('quote_ratio');
    // The p50 passes...
    expect(Math.abs(b.p50 - 1)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(q.p50 - 1)).toBeLessThanOrEqual(0.01);
    // ...and agreement does not, which is why the reconstruction was NOT used.
    expect(b.share).toBeLessThan(0.95);
    expect(q.share).toBeLessThan(0.95);
  });

  it('shows the error growing with trade count, which is a per-trade bias not a liquidity event', () => {
    const median = (rows: typeof pairs, f: 'base_ratio'): number => {
      const xs = rows.map((r) => r[f]).filter((x): x is number => x !== null).sort((p, q) => p - q);
      return xs.length === 0 ? Number.NaN : (xs[Math.floor(xs.length / 2)] as number);
    };
    const few = median(pairs.filter((r) => r.n_trades === 1), 'base_ratio');
    const many = median(pairs.filter((r) => r.n_trades >= 101), 'base_ratio');
    expect(Math.abs(few - 1)).toBeLessThan(0.001);
    expect(Math.abs(many - 1)).toBeGreaterThan(0.5);
  });

  it('produces impossible reserves on part of the sample, which is a hard falsification', () => {
    const negative = v.result.rows.filter(
      (r) => r.test === 'PAIR' && (r.base_ratio ?? 1) < 0,
    ).length;
    const negativeQuote = v.result.rows.filter((r) => r.test === 'PAIR' && (r.quote_ratio ?? 1) < 0).length;
    expect(negative + negativeQuote).toBeGreaterThan(0);
  });
});
