import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * d70b4a9a §1.1 — the corrected cost surface, and the three claims it settles.
 *
 * The directive's premise was that 0.02 SOL "sits at the maximum of the cost
 * curve": ATA rent 10.2% of notional and priority fees ~5%. Measured against
 * the corpus, both figures are wrong by two orders of magnitude in the same
 * direction, and the sign of the conclusion flips — 0.02 SOL is within 2 bps of
 * the cheapest notional available, not at a maximum.
 *
 * What this guards is not the level. It is the three structural facts a later
 * change could quietly reverse:
 *
 *   1. the rent that is RECOVERED is not also charged as a cost, and the
 *      recovery figure in the surface is the one the settlements measured;
 *   2. the priority fee is a CEILING over the applied limit, so it can never be
 *      the zero that a null limit used to produce;
 *   3. the surface says out loud that its failed-attempt term is unknown. Zero
 *      submitted attempts is not a zero failure rate, and a complete-looking
 *      total assembled over an unknown is the exact defect §10.3 names.
 */

const PATH = 'artifacts/cost-surface.json';

interface Row {
  notionalLamports: string;
  notionalSol: number;
  poolsPriced: number;
  poolsAdmissible: number;
  medianVenueDragBps: number | null;
  fixedCostLamports: string;
  fixedCostBps: number | null;
  baseSignatureCostLamports: string;
  priorityFeeLamports: string;
  ataRentLockedLamports: string;
  ataRentRecoveredLamports: string;
  ataRentNotRecoveredLamports: string;
  totalRoundTripCostBps: number | null;
  totalRoundTripCostPct: number | null;
  accountingComplete: boolean;
  accountingMissing: string[];
  expectedFailedAttemptLamports: Record<string, string>;
}

interface Surface {
  label: string;
  directive: string;
  exitPricedAgainst: string;
  poolsAvailable: number;
  fixedCosts: {
    baseFeePerLegLamports: string;
    unitPriceMicroLamportsMedian: string | null;
    frozenRequestedLimit: number | null;
    frozenMarginPct: number;
    priorityFeeAsBuiltLamports: string | null;
    priorityFeeWithFrozenLimitLamports: string | null;
    rentPerTradeRecoverableLamports: string;
    rentPerTradeUnrecoverableLamports: string;
    rentRecoveredMeasuredLamports: string | null;
    submittedAttempts: number;
    unitsConsumedP90: number | null;
    derivedDefaultLimitMedian: number | null;
  };
  rows: Row[];
  belowGridDiagnostic: Row[];
  notionalMinCostLamports: string | null;
  costFloorPct: number | null;
  shape: string;
}

const DIRECTIVE_GRID = ['20000000', '50000000', '100000000', '200000000', '350000000', '500000000', '1000000000'];

const surface = (): Surface | null => (existsSync(PATH) ? (JSON.parse(readFileSync(PATH, 'utf8')) as Surface) : null);

describe('d70b4a9a §1.1 — the corrected cost surface', () => {
  it('prices every notional the directive named, in order', () => {
    const s = surface();
    if (s === null) return;
    expect(s.rows.map((r) => r.notionalLamports)).toEqual(DIRECTIVE_GRID);
  });

  it('charges recovered rent as locked capital and not as a cost', () => {
    const s = surface();
    if (s === null) return;
    // The base ATA closes in the same transaction as the exit swap, so its rent
    // comes back. Charging it anyway is a 1,020 bps phantom at 0.02 SOL, which
    // is larger than the entire real cost of the round trip.
    for (const r of s.rows) {
      const locked = BigInt(r.ataRentLockedLamports);
      const recovered = BigInt(r.ataRentRecoveredLamports);
      const lost = BigInt(r.ataRentNotRecoveredLamports);
      expect(locked).toBeGreaterThan(0n);
      expect(recovered).toBe(locked);
      expect(lost).toBe(0n);
      // And it is absent from the assembled fixed cost, which is fees only.
      expect(BigInt(r.fixedCostLamports)).toBeLessThan(locked);
    }
  });

  it('takes its recovery figure from what the settlements measured', () => {
    const s = surface();
    if (s === null) return;
    const measured = s.fixedCosts.rentRecoveredMeasuredLamports;
    if (measured === null) return;
    const claimed = BigInt(s.fixedCosts.rentPerTradeRecoverableLamports);
    // Within one rent-exempt minimum's rounding of the measured per-sell
    // recovery. A claimed recovery no settlement ever observed is a fabricated
    // credit, and it flatters every notional equally.
    const delta = claimed > BigInt(measured) ? claimed - BigInt(measured) : BigInt(measured) - claimed;
    expect(delta).toBeLessThan(100_000n);
  });

  it('computes the priority fee as a ceiling over the applied limit', () => {
    const s = surface();
    if (s === null) return;
    const price = s.fixedCosts.unitPriceMicroLamportsMedian;
    const limit = s.fixedCosts.frozenRequestedLimit;
    const fee = s.fixedCosts.priorityFeeWithFrozenLimitLamports;
    if (price === null || limit === null || fee === null) return;
    const expected = (BigInt(price) * BigInt(limit) + 999_999n) / 1_000_000n;
    expect(BigInt(fee)).toBe(expected);
    // Never zero merely because the router omitted a limit: the whole point of
    // §10.2 is that an absent limit is a derived limit, not a free transaction.
    expect(BigInt(fee)).toBeGreaterThan(0n);
  });

  it('requests a limit above what the legs measured, by the frozen margin', () => {
    const s = surface();
    if (s === null) return;
    const p90 = s.fixedCosts.unitsConsumedP90;
    const requested = s.fixedCosts.frozenRequestedLimit;
    if (p90 === null || requested === null) return;
    expect(requested).toBeGreaterThan(p90);
    expect(requested).toBe(Math.ceil(p90 * (1 + s.fixedCosts.frozenMarginPct / 100)));
  });

  it('does not present an unknown failure rate as a measured zero', () => {
    const s = surface();
    if (s === null) return;
    if (s.fixedCosts.submittedAttempts !== 0) return;
    for (const r of s.rows) {
      expect(r.accountingComplete).toBe(false);
      expect(r.accountingMissing.join(' ')).toContain('failure probability unknown');
      expect(r.expectedFailedAttemptLamports['observed']).toBe('0');
      // The stress rows exist, so the term's size is bounded rather than absent.
      expect(BigInt(r.expectedFailedAttemptLamports['stress-20pct'] ?? '0')).toBeGreaterThan(0n);
    }
  });

  it('reports the total as fixed plus venue, with nothing appearing only in one', () => {
    const s = surface();
    if (s === null) return;
    for (const r of s.rows) {
      if (r.totalRoundTripCostBps === null || r.medianVenueDragBps === null || r.fixedCostBps === null) continue;
      const assembled = r.medianVenueDragBps + r.fixedCostBps;
      // Both sides round UP independently, so they may differ by the rounding of
      // each term and no more.
      expect(Math.abs(r.totalRoundTripCostBps - assembled)).toBeLessThanOrEqual(3);
    }
  });

  it('says which state the exit was priced against', () => {
    const s = surface();
    if (s === null) return;
    // A round trip priced against its own post-buy state cancels first-order
    // impact and reports a fee-only cost. Which one was done is not a detail.
    expect(s.exitPricedAgainst).toBe('PRE_BUY_RESERVES');
    expect(s.label).toContain('MODELLED_VENUE_DRAG');
  });

  it('shows the cost rising with size, and admissibility falling with it', () => {
    const s = surface();
    if (s === null) return;
    const totals = s.rows.map((r) => r.totalRoundTripCostBps).filter((v): v is number => v !== null);
    const admissible = s.rows.map((r) => r.poolsAdmissible);
    expect(totals.length).toBe(s.rows.length);
    for (let i = 1; i < totals.length; i += 1) {
      expect(totals[i] as number).toBeGreaterThan(totals[i - 1] as number);
      expect(admissible[i] as number).toBeLessThanOrEqual(admissible[i - 1] as number);
    }
  });

  it('locates the minimum below the grid rather than asserting the grid holds it', () => {
    const s = surface();
    if (s === null) return;
    // MONOTONE_INCREASING over the seven grid points says only that the minimum
    // is at or below the smallest of them. The below-grid diagnostic is what
    // makes "0.02 SOL is near-optimal" a measurement instead of an assumption.
    if (!s.shape.startsWith('MONOTONE_INCREASING')) return;
    expect(s.belowGridDiagnostic.length).toBeGreaterThan(0);
    const gridMin = Math.min(...s.rows.map((r) => r.totalRoundTripCostBps ?? Number.POSITIVE_INFINITY));
    const belowMin = Math.min(...s.belowGridDiagnostic.map((r) => r.totalRoundTripCostBps ?? Number.POSITIVE_INFINITY));
    // Near-optimal means within a few basis points, not merely "not worse".
    expect(gridMin - belowMin).toBeLessThanOrEqual(10);
  });
});
