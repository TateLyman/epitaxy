/**
 * P10 — which evidence class a pair of legs qualifies for.
 *
 * One function, used at open time to stamp a shadow and by every report that
 * counts them, so a row cannot be one class in the database and another in a
 * summary.
 *
 * The classes are ordered and are NEVER aggregated. A structural shadow and an
 * effect-verified one are not two of the same thing; adding them produces a
 * number that describes neither, and the temptation to do it is strongest
 * exactly when the higher class is empty.
 */

export const EVIDENCE_CLASSES = [
  'STRUCTURAL_ONLY',
  'JIT_EFFECT_VALID',
  'OFFLINE_REPRODUCIBLE',
  'CONFIRMATORY',
] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** What one leg's simulation established. Absent fields are unknowns. */
export interface LegEvidence {
  /** Derived from the request bytes. Anything but VALID_* measured the instrument. */
  readonly validity: string | null;
  /** All four effect checks passed. */
  readonly effectOk: boolean;
  /** The run stood at a frozen snapshot rather than fetching a moving chain. */
  readonly offline: boolean;
  /** The daemon judged the run reproducible AND the caller preregistered it. */
  readonly confirmatory: boolean;
  /** Every writable the run touched was observed on both sides. */
  readonly accountCoverageOk: boolean;
}

/**
 * The class BOTH legs support.
 *
 * The minimum, not the maximum. A round trip whose entry is confirmatory and
 * whose exit was never effect-verified is not a confirmatory round trip: it is
 * a position that cannot be shown to close, which is the more important of the
 * two facts.
 */
export function evidenceClassOf(entry: LegEvidence | null, exit: LegEvidence | null): EvidenceClass {
  if (entry === null || exit === null) return 'STRUCTURAL_ONLY';

  const legClass = (l: LegEvidence): EvidenceClass => {
    // A job whose request did not describe an economic leg establishes nothing
    // about the route, however green its status column.
    if (l.validity === null || !l.validity.startsWith('VALID_')) return 'STRUCTURAL_ONLY';
    if (!l.effectOk) return 'STRUCTURAL_ONLY';
    // Coverage is part of the effect verdict, and it is checked again here
    // because an uncovered writable is precisely what makes a run
    // irreproducible: the replay cannot restore state nobody recorded.
    if (!l.accountCoverageOk) return 'JIT_EFFECT_VALID';
    if (!l.offline) return 'JIT_EFFECT_VALID';
    if (!l.confirmatory) return 'OFFLINE_REPRODUCIBLE';
    return 'CONFIRMATORY';
  };

  const a = EVIDENCE_CLASSES.indexOf(legClass(entry));
  const b = EVIDENCE_CLASSES.indexOf(legClass(exit));
  return EVIDENCE_CLASSES[Math.min(a, b)] ?? 'STRUCTURAL_ONLY';
}

/**
 * Counts that refuse to be summed.
 *
 * Returns a record keyed by class with no total, deliberately. A caller that
 * wants a total has to write the addition itself and will, one hopes, notice
 * what it is adding.
 */
export function tallyByClass(classes: readonly EvidenceClass[]): Readonly<Record<EvidenceClass, number>> {
  const out = { STRUCTURAL_ONLY: 0, JIT_EFFECT_VALID: 0, OFFLINE_REPRODUCIBLE: 0, CONFIRMATORY: 0 };
  for (const c of classes) out[c] += 1;
  return out;
}
