import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { attributeSoleVenue } from '../../packages/domain/src/trajectory-evidence.js';

/**
 * Directive items 7, 8 and 61 — the checks that had no test.
 *
 * The coverage audit found these by refusing to accept a citation whose text
 * was not in the file it named. Sole-venue attribution is the rule that makes
 * every direct-mechanics number in this repository mean anything, and it sat
 * inline in a 700-line function with nothing exercising it.
 */

describe('7/8 — the canonical pool supplied the WHOLE entry, or it is not evidence', () => {
  it('attributes when BOTH sides conserve: base out == taker credit, and the payer outflow reaches this pool', () => {
    const a = attributeSoleVenue({
      baseOutAtoms: 1_000n,
      quoteInLamports: 19_800_000n,
      takerCreditAtoms: 1_000n,
      entryQuoteOutLamports: 20_000_000n,
      // Protocol, creator, LP and cashback cuts land outside the quote vault.
      feeFlowsLamports: 200_000n,
    });
    expect(a.attributed).toBe(true);
    expect(a.refusal).toBeNull();
  });

  /**
   * D-2 from the 8f73cef runtime audit, as an executable test.
   *
   * The quote leg was checked ONLY FOR SIGN, so this exact case attributed:
   *
   *     quote in -> 0          attributed = false   correct
   *     quote in -> 1 lamport  attributed = TRUE    against a 20,000,000 entry
   *
   * "The canonical pool accounts for all named deltas" was true of the base
   * vault and false of the quote vault, because the notional was never compared
   * to what the pool actually received.
   */
  it('REFUSES a one-lamport quote credit against a 0.02 SOL entry', () => {
    const a = attributeSoleVenue({
      baseOutAtoms: 1_000n,
      quoteInLamports: 1n,
      takerCreditAtoms: 1_000n,
      entryQuoteOutLamports: 20_000_000n,
      feeFlowsLamports: 0n,
    });
    expect(a.attributed).toBe(false);
    expect(a.refusal).toContain('went somewhere unnamed');
    expect(a.refusal).toContain('19999999');
  });

  it('refuses rather than attributing when the payer outflow was not supplied at all', () => {
    // A missing input must not read as a passed check. Before the quote side
    // was conserved this signature could not express the difference.
    const a = attributeSoleVenue({ baseOutAtoms: 1_000n, quoteInLamports: 20_000_000n, takerCreditAtoms: 1_000n });
    expect(a.attributed).toBe(false);
    expect(a.refusal).toContain('sign test');
  });

  it('allows documented rounding, and nothing beyond it', () => {
    const within = attributeSoleVenue({
      baseOutAtoms: 1_000n,
      quoteInLamports: 19_999_999n,
      takerCreditAtoms: 1_000n,
      entryQuoteOutLamports: 20_000_000n,
      toleranceLamports: 1n,
    });
    expect(within.attributed).toBe(true);
    const beyond = attributeSoleVenue({
      baseOutAtoms: 1_000n,
      quoteInLamports: 19_999_998n,
      takerCreditAtoms: 1_000n,
      entryQuoteOutLamports: 20_000_000n,
      toleranceLamports: 1n,
    });
    expect(beyond.attributed).toBe(false);
  });

  it('REFUSES a split entry: the taker gained more than this pool gave up', () => {
    // The defining case. A routed fill moves the canonical base vault too, so
    // "the vault changed" proves nothing — the taker's credit exceeding the
    // pool's outflow is what says another venue supplied part of the flow.
    const a = attributeSoleVenue({ baseOutAtoms: 600n, quoteInLamports: 20_000_000n, takerCreditAtoms: 1_000n });
    expect(a.attributed).toBe(false);
    expect(a.refusal).toContain('came from somewhere else');
  });

  it('refuses when the taker somehow gained LESS than the pool released', () => {
    // Also not attributable: tokens went somewhere that is not our account.
    expect(attributeSoleVenue({ baseOutAtoms: 1_000n, quoteInLamports: 1n, takerCreditAtoms: 600n }).attributed).toBe(false);
  });

  it('refuses when the pool base vault never fell', () => {
    const a = attributeSoleVenue({ baseOutAtoms: 0n, quoteInLamports: 20_000_000n, takerCreditAtoms: 1_000n });
    expect(a.attributed).toBe(false);
    expect(a.refusal).toContain('supplied nothing');
  });

  it('refuses when no quote was paid INTO the pool', () => {
    // Tokens moving out with nothing coming in is not a purchase at this venue.
    const a = attributeSoleVenue({ baseOutAtoms: 1_000n, quoteInLamports: 0n, takerCreditAtoms: 1_000n });
    expect(a.attributed).toBe(false);
    expect(a.refusal).toContain('nothing was paid');
  });

  it('carries the three measured quantities, so a refusal is auditable', () => {
    const a = attributeSoleVenue({ baseOutAtoms: 600n, quoteInLamports: 7n, takerCreditAtoms: 1_000n });
    expect(a.baseOutAtoms).toBe(600n);
    expect(a.quoteInLamports).toBe(7n);
    expect(a.takerCreditAtoms).toBe(1_000n);
  });
});

describe('61 — no signing path is reachable from the collector', () => {
  it('no packages/execution function is reachable from runCycle', () => {
    /**
     * `trajectory-collect.ts` says in its own header: "This process cannot
     * sign. It does not import packages/execution." Nothing asserted it.
     *
     * A comment is the weakest possible form of that guarantee, and this
     * repository has twice shipped a path whose reassuring identifier was
     * present and whose behaviour was absent. This reads the machine-generated
     * graph, where reachability is resolved through the TypeScript checker
     * rather than by matching import text.
     */
    const g = JSON.parse(readFileSync('artifacts/collector-call-graph.json', 'utf8')) as {
      executionPackageReachableFromCollector: { fn: string; declaredIn: string }[];
    };
    expect(g.executionPackageReachableFromCollector).toEqual([]);
  });

  it('the collector source imports no execution package either', () => {
    // Weaker than the graph and kept as a second, cheaper tripwire: the graph
    // only sees what the entry files reach.
    for (const f of ['apps/collector/src/trajectory-collect.ts', 'apps/collector/src/live-lane.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/from\s+['"][^'"]*packages\/execution/);
    }
  });
});
