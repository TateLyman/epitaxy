import { describe, it, expect } from 'vitest';
import {
  evidenceClassOf,
  tallyByClass,
  EVIDENCE_CLASSES,
  type LegEvidence,
} from '../../packages/domain/src/evidence.js';

/**
 * P10 — evidence classes, never aggregated.
 *
 * The class is stamped at open rather than derived at report time. A derivation
 * runs under whatever the code believes now, so a shadow opened when nothing
 * was effect-verified would silently be promoted the moment some later run of
 * the same observation passed.
 */

const leg = (over: Partial<LegEvidence> = {}): LegEvidence => ({
  validity: 'VALID_CONFIRMATORY',
  effectOk: true,
  accountCoverageOk: true,
  offline: true,
  confirmatory: true,
  ...over,
});

describe('P10 — one leg cannot outrank what it established', () => {
  it('a job that measured the instrument is structural, whatever its status said', () => {
    // The 108 pre-repair jobs. Forty of them said SIMULATED_OK.
    const l = leg({ validity: 'INSTRUMENT_DEVELOPMENT' });
    expect(evidenceClassOf(l, l)).toBe('STRUCTURAL_ONLY');
  });

  it('a missing validity is structural, not a benefit of the doubt', () => {
    expect(evidenceClassOf(leg({ validity: null }), leg())).toBe('STRUCTURAL_ONLY');
  });

  it('an unverified effect is structural even under a valid request', () => {
    const l = leg({ validity: 'VALID_DEVELOPMENT', effectOk: false });
    expect(evidenceClassOf(l, l)).toBe('STRUCTURAL_ONLY');
  });

  it('effect-verified under JIT is JIT_EFFECT_VALID and no more', () => {
    // A JIT run fetches its own state from a moving chain, so the same
    // transaction run twice is two experiments.
    const l = leg({ validity: 'VALID_DEVELOPMENT', offline: false, confirmatory: false });
    expect(evidenceClassOf(l, l)).toBe('JIT_EFFECT_VALID');
  });

  it('an uncovered writable caps a run at JIT, because a replay cannot restore what nobody recorded', () => {
    const l = leg({ accountCoverageOk: false });
    expect(evidenceClassOf(l, l)).toBe('JIT_EFFECT_VALID');
  });

  it('offline and effect-verified but unpreregistered is OFFLINE_REPRODUCIBLE', () => {
    const l = leg({ confirmatory: false });
    expect(evidenceClassOf(l, l)).toBe('OFFLINE_REPRODUCIBLE');
  });

  it('all of it is CONFIRMATORY', () => {
    expect(evidenceClassOf(leg(), leg())).toBe('CONFIRMATORY');
  });
});

describe('P10 — the pair takes the MINIMUM of its two legs', () => {
  it('a confirmatory entry with an unverified exit is not a confirmatory round trip', () => {
    // It is a position that cannot be shown to close, which is the more
    // important of the two facts.
    const entry = leg();
    const exit = leg({ validity: 'INSTRUMENT_DEVELOPMENT' });
    expect(evidenceClassOf(entry, exit)).toBe('STRUCTURAL_ONLY');
  });

  it('is symmetric: a weak entry caps the pair the same way', () => {
    expect(evidenceClassOf(leg({ effectOk: false }), leg())).toBe('STRUCTURAL_ONLY');
  });

  it('takes the lower of two non-minimal classes', () => {
    const jit = leg({ offline: false, confirmatory: false });
    expect(evidenceClassOf(jit, leg())).toBe('JIT_EFFECT_VALID');
    expect(evidenceClassOf(leg(), jit)).toBe('JIT_EFFECT_VALID');
  });

  it('a missing leg is structural, because nothing was established about it', () => {
    expect(evidenceClassOf(null, leg())).toBe('STRUCTURAL_ONLY');
    expect(evidenceClassOf(leg(), null)).toBe('STRUCTURAL_ONLY');
    expect(evidenceClassOf(null, null)).toBe('STRUCTURAL_ONLY');
  });
});

describe('P10 — the tally refuses to be summed', () => {
  it('returns a count per class and no total', () => {
    const t = tallyByClass(['STRUCTURAL_ONLY', 'STRUCTURAL_ONLY', 'CONFIRMATORY']);
    expect(t).toEqual({
      STRUCTURAL_ONLY: 2,
      JIT_EFFECT_VALID: 0,
      OFFLINE_REPRODUCIBLE: 0,
      CONFIRMATORY: 1,
    });
    // No `total` key. A caller that wants one has to write the addition and
    // will, one hopes, notice what it is adding: two structural shadows and a
    // confirmatory round trip are not three of anything.
    expect(Object.keys(t)).toEqual([...EVIDENCE_CLASSES]);
  });

  it('reports zeroes rather than omitting empty classes', () => {
    // An omitted class reads as "not applicable"; a zero reads as "none yet",
    // and only the second is true.
    expect(tallyByClass([])).toEqual({
      STRUCTURAL_ONLY: 0,
      JIT_EFFECT_VALID: 0,
      OFFLINE_REPRODUCIBLE: 0,
      CONFIRMATORY: 0,
    });
  });

  it('the classes are ordered weakest to strongest', () => {
    expect(EVIDENCE_CLASSES).toEqual([
      'STRUCTURAL_ONLY',
      'JIT_EFFECT_VALID',
      'OFFLINE_REPRODUCIBLE',
      'CONFIRMATORY',
    ]);
  });
});
