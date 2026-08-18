/**
 * S091 — an invalidation reason has to say something.
 *
 * `evidence:invalidate-old --context=<id> --reason=<text>` demotes a window to
 * INSTRUMENT_DEVELOPMENT_INVALID, and that demotion is a ONE-WAY DOOR: the
 * ledger permits demotion and forbids promotion, so the reason string is the
 * only surviving account of why a window's rows stopped counting. The command
 * checked that at least one `--reason=` was PRESENT and never that it carried
 * any content, so `--reason=` (empty), `--reason=S090` (a code with no
 * statement) and `--reason=the window was demoted because` (truncated mid
 * clause) all wrote a permanent record that explains nothing.
 *
 * That is worse than a missing reason. A missing reason is visibly missing; a
 * reason reading `S090` looks like an explanation until someone tries to use
 * it, which is months later and by then nobody remembers.
 *
 * The rule is deliberately mechanical and deliberately loose. It cannot judge
 * whether a sentence is TRUE — no string check can — so it only refuses text
 * that could not be an explanation under any reading. Everything it accepts is
 * still the operator's responsibility.
 */

export type InvalidationReasonRefusal =
  | 'EMPTY'
  | 'CODE_ONLY'
  | 'TRUNCATED'
  | 'TOO_SHORT';

export interface InvalidationReasonVerdict {
  readonly ok: boolean;
  readonly refusal: InvalidationReasonRefusal | null;
  readonly explanation: string;
  /** The reason with surrounding whitespace removed, when it is acceptable. */
  readonly normalized: string;
}

/**
 * A bare defect code and nothing else.
 *
 * The repository's codes are shaped `S091`, `O031`, `F13`, `P2a.1`, and the
 * audit documents cite them constantly, so `--reason=S090` is the single most
 * likely way an empty explanation gets written. A code followed by an actual
 * statement is fine and common — this matches the code ALONE, optionally with
 * separators around it.
 */
const CODE_ONLY = /^[\s:;,.\-—–]*[A-Z]{1,3}[0-9]{1,4}[a-z]?(?:\.[0-9]{1,3})?[\s:;,.\-—–]*$/;

/**
 * Words that cannot end a sentence, because each one takes an object that is
 * not there. A reason ending in one of these was cut off — most often by a
 * shell eating the rest of an unquoted argument at a space, which is exactly
 * how a long `--reason=` becomes a short one without anybody noticing.
 */
const DANGLING_TAIL = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'because', 'since', 'while', 'when',
  'that', 'which', 'who', 'whose', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'into', 'than', 'as', 'is', 'was', 'were', 'are', 'be',
  'been', 'has', 'have', 'had', 'its', 'their', 'this', 'these', 'those',
  'after', 'before', 'over', 'under', 'per', 'via', 'about', 'against',
]);

/**
 * The shortest text that could carry a subject and a claim about it.
 *
 * Two words is the floor rather than an arbitrary character count, because
 * character counts refuse legitimate terse reasons and accept a single long
 * identifier. `mark SLA breached` passes; `breached` does not.
 */
const MIN_WORDS = 3;

export function validateInvalidationReason(raw: string): InvalidationReasonVerdict {
  const text = raw.trim();

  if (text === '') {
    return {
      ok: false,
      refusal: 'EMPTY',
      explanation: 'the reason is empty, and an empty reason is a demotion nobody can audit',
      normalized: '',
    };
  }

  if (CODE_ONLY.test(text)) {
    return {
      ok: false,
      refusal: 'CODE_ONLY',
      explanation:
        `"${text}" is a defect code and not a statement; cite the code AND say what it did to this window`,
      normalized: '',
    };
  }

  const words = text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  if (words.length < MIN_WORDS) {
    return {
      ok: false,
      refusal: 'TOO_SHORT',
      explanation:
        `"${text}" is ${words.length} word(s); a reason needs at least ${MIN_WORDS} to name a subject and a claim`,
      normalized: '',
    };
  }

  // Trailing punctuation is stripped before the tail is judged, so "…because."
  // is still recognised as truncated rather than rescued by a full stop.
  const last = (words[words.length - 1] ?? '').replace(/[.,;:!?)\]]+$/, '').toLowerCase();
  if (DANGLING_TAIL.has(last)) {
    return {
      ok: false,
      refusal: 'TRUNCATED',
      explanation:
        `"${text}" ends on "${last}", which takes an object that is not there — the reason was cut off`,
      normalized: '',
    };
  }

  // An unterminated open bracket or quote is the other shape a cut-off string
  // takes when the truncation happened inside a parenthetical.
  const opens = (text.match(/[([{]/g) ?? []).length;
  const closes = (text.match(/[)\]}]/g) ?? []).length;
  if (opens > closes) {
    return {
      ok: false,
      refusal: 'TRUNCATED',
      explanation: `"${text}" leaves ${opens - closes} bracket(s) unclosed, so it did not survive whatever quoted it`,
      normalized: '',
    };
  }

  return { ok: true, refusal: null, explanation: 'accepted', normalized: text };
}

/**
 * Validate a whole `--reason=` set. Returns every refusal rather than the
 * first, because an operator fixing one argument should not discover the next
 * one on the following attempt.
 */
export function validateInvalidationReasons(reasons: readonly string[]): {
  readonly ok: boolean;
  readonly accepted: readonly string[];
  readonly refused: readonly { reason: string; refusal: InvalidationReasonRefusal; explanation: string }[];
} {
  const accepted: string[] = [];
  const refused: { reason: string; refusal: InvalidationReasonRefusal; explanation: string }[] = [];
  for (const r of reasons) {
    const v = validateInvalidationReason(r);
    if (v.ok) accepted.push(v.normalized);
    else refused.push({ reason: r, refusal: v.refusal as InvalidationReasonRefusal, explanation: v.explanation });
  }
  return { ok: refused.length === 0 && accepted.length > 0, accepted, refused };
}
