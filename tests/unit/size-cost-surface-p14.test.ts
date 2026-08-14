import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * P14 — the size and cost surface, and the finding it settled.
 *
 * The round-trip drag on a freshly migrated PumpSwap token is a FIXED cost of
 * roughly 10,100,000 lamports — five rent-exempt minimums of 2,039,280 for
 * accounts the first trade on a new token has to open — not price impact and
 * not a proportional fee.
 *
 * The evidence is the shape, not the level: across a 4x size range the median
 * drag moves 1.8% in LAMPORTS and 293% in BPS. A fixed cost looks exactly like
 * that; price impact cannot.
 *
 * This guards the shape, because the shape is what changes the conclusion. A
 * proportional 12.7% drag and a fixed 0.0101 SOL setup cost imply opposite
 * things about sizing, and the single-notional run could not tell them apart.
 */

const PATH = 'artifacts/size-cost-surface.json';

interface Surface {
  sizesLamports: string[];
  bySize: {
    sizeLamports: string;
    completed: number;
    dragBps: { p50: number | null; p90: number | null };
    dragLamports: { p50: number | null };
  }[];
  costShape: {
    medianDragLamportsBySize: number[];
    medianDragBpsBySize: number[];
    lamportSpreadAcrossSizes: number | null;
    bpsSpreadAcrossSizes: number | null;
    verdict: string;
  };
  rows: { outcome?: string; quoteStateSurvived?: boolean; sizeLamports?: string }[];
}

const surface = (): Surface | null => (existsSync(PATH) ? (JSON.parse(readFileSync(PATH, 'utf8')) as Surface) : null);

describe('P14 — the cost is fixed, not proportional', () => {
  it('swept more than one notional', () => {
    const s = surface();
    if (s === null) return;
    expect(s.sizesLamports.length).toBeGreaterThanOrEqual(3);
  });

  it('completed at least three sizes, or the shape is not measurable', () => {
    const s = surface();
    if (s === null) return;
    expect(s.bySize.filter((b) => b.completed > 0).length).toBeGreaterThanOrEqual(3);
  });

  it('the drag is far more constant in LAMPORTS than in BPS', () => {
    // THE finding. If this ever inverts, the cost stopped being a fixed setup
    // charge and started being proportional, and every sizing conclusion in
    // docs/MECHANICS_FLOOR_MEASURED.md needs revisiting.
    const s = surface();
    if (s === null) return;
    const lam = s.costShape.lamportSpreadAcrossSizes;
    const bps = s.costShape.bpsSpreadAcrossSizes;
    expect(lam).not.toBeNull();
    expect(bps).not.toBeNull();
    expect(lam as number).toBeLessThan(bps as number);
  });

  it('the bps drag FALLS as size rises, which a proportional cost cannot do', () => {
    const s = surface();
    if (s === null) return;
    const bps = s.costShape.medianDragBpsBySize;
    if (bps.length < 2) return;
    expect(bps[bps.length - 1] as number).toBeLessThan(bps[0] as number);
  });

  it('the verdict names a fixed cost', () => {
    const s = surface();
    if (s === null) return;
    expect(s.costShape.verdict).toMatch(/CONSTANT IN LAMPORTS/);
  });

  it('every completed size had its quote state survive to execution', () => {
    const s = surface();
    if (s === null) return;
    for (const r of s.rows.filter((x) => x.outcome === 'COMPLETE')) {
      expect(r.quoteStateSurvived).toBe(true);
    }
  });

  it('the fixed cost is close to a whole number of rent-exempt minimums', () => {
    // 2,039,280 lamports is the rent-exempt minimum for a 165-byte token
    // account. The observed fixed cost sitting within a few percent of an
    // integer multiple is what identifies it as account setup rather than as
    // an unexplained constant.
    const s = surface();
    if (s === null) return;
    const lam = s.costShape.medianDragLamportsBySize;
    if (lam.length === 0) return;
    const RENT = 2_039_280;
    const smallest = Math.min(...lam);
    const k = Math.round(smallest / RENT);
    expect(k).toBeGreaterThanOrEqual(1);
    expect(Math.abs(smallest - k * RENT) / (k * RENT)).toBeLessThan(0.05);
  });
});
