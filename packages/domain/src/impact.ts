/**
 * Price impact, parsed once and never re-interpreted.
 *
 * P2a.1 §P1 required tracing this field end to end before any rule was allowed
 * to consume it. The trace was run live on 2026-08-12 against
 * `https://api.jup.ag/swap/v2/order` and the result contradicts the premise the
 * directive was written on, so the evidence is recorded here rather than in a
 * commit message:
 *
 *   1 SOL -> USDC, a deep and unremarkable pair, returned
 *     "priceImpact":    -0.1820511452303203      (percent)
 *     "priceImpactPct": "-0.0018205114523032028" (fraction)
 *
 * Both fields are SIGNED, they agree to fifteen decimal places after scaling,
 * and NEGATIVE IS THE ORDINARY ADVERSE DIRECTION. The published documentation
 * describes `priceImpactPct` as a decimal from 0 to 1; the endpoint does not
 * behave that way. Treating every negative value as a schema error — the rule
 * the directive asked for — would have condemned 1262 of 2255 stored rows (56%)
 * as corrupt when they are ordinary quotes on illiquid tokens. That rule is
 * therefore NOT implemented, and this comment is the reason why.
 *
 * What IS implemented is the invariant the observed convention supports:
 *
 *     -1 <= signedPct <= 1
 *
 * A fraction outside that range is a genuine parser or schema failure: impact
 * cannot exceed the whole value of the trade in either direction. `-1.0` is the
 * legitimate floor and was observed on `3XiaH5DA` at the moment its route
 * evaporated.
 *
 * Three numbers come out, because one signed number doing three jobs is what
 * produced the `Math.abs` defect in the first place:
 *
 *   signedPct / signedBps  raw, exactly as delivered, for the record
 *   adverseBps             >= 0, movement AGAINST us. The only field an exit
 *                          rule may compare against a cap.
 *   favourableBps          >= 0, movement in our favour
 *
 * Absence is not zero. A response with no impact field yields `ABSENT` and
 * nulls, never `0`, because zero impact is a strong claim about a market and
 * the provider made no such claim. The previous parser returned `0` for a
 * missing field, and that value was indistinguishable from a perfect fill.
 */

export const IMPACT_PARSER_VERSION = 'impact-v1';

export type ImpactSchemaStatus =
  /** Present, finite, and inside the observed range. */
  | 'OK'
  /** The provider returned no impact field. A fact about the provider. */
  | 'ABSENT'
  /** Present but outside -1..1. A real schema or parser failure. */
  | 'OUT_OF_RANGE'
  /** Present but not a finite number, e.g. "NaN", "", "1e999". */
  | 'NOT_A_NUMBER'
  /** Both fields present and disagreeing by more than tolerance. */
  | 'FIELDS_DISAGREE';

export interface ImpactReading {
  /** Which raw JSON field the value came from. Null when absent. */
  readonly sourceField: 'priceImpact' | 'priceImpactPct' | null;
  /** The raw JSON value, stringified, before any arithmetic. */
  readonly rawString: string | null;
  /** Signed fraction of notional. Null unless status is OK. */
  readonly signedPct: number | null;
  /** Signed basis points. Null unless status is OK. */
  readonly signedBps: number | null;
  /** Movement against us, >= 0. Null when unknown — never 0 for unknown. */
  readonly adverseBps: number | null;
  /** Movement in our favour, >= 0. Null when unknown. */
  readonly favourableBps: number | null;
  readonly status: ImpactSchemaStatus;
  readonly detail: string;
  readonly parserVersion: string;
}

/** The two fields are the same quantity at different scales. */
const PERCENT_TO_FRACTION = 100;

/**
 * Tolerance for the cross-check when both fields are present.
 *
 * The live probe agreed to fifteen decimal places, so anything looser would
 * miss a real divergence and anything tighter would fire on double rounding.
 */
const AGREEMENT_TOLERANCE = 1e-9;

function reading(over: Partial<ImpactReading> & { status: ImpactSchemaStatus; detail: string }): ImpactReading {
  return {
    sourceField: null,
    rawString: null,
    signedPct: null,
    signedBps: null,
    adverseBps: null,
    favourableBps: null,
    parserVersion: IMPACT_PARSER_VERSION,
    ...over,
  };
}

export interface RawImpactFields {
  /** V2 `priceImpact`, expressed in PERCENT. */
  readonly priceImpact?: number | null | undefined;
  /** Deprecated `priceImpactPct`, expressed as a FRACTION, sometimes a string. */
  readonly priceImpactPct?: string | number | null | undefined;
}

/**
 * Parse the impact fields of one order response.
 *
 * Total: every input produces a reading and no input throws. A refusal to parse
 * is itself a recorded observation, because a parser that throws inside the
 * mark loop takes the position's exit management down with it.
 */
export function parseImpact(o: RawImpactFields): ImpactReading {
  const hasPercent = typeof o.priceImpact === 'number';
  const hasFraction = o.priceImpactPct !== undefined && o.priceImpactPct !== null;

  if (!hasPercent && !hasFraction) {
    return reading({
      status: 'ABSENT',
      detail: 'response carried neither priceImpact nor priceImpactPct; impact is unknown, not zero',
    });
  }

  // Prefer the current field. The deprecated one is a fallback, never a silent
  // substitute — `sourceField` records which was actually used.
  const sourceField: 'priceImpact' | 'priceImpactPct' = hasPercent ? 'priceImpact' : 'priceImpactPct';
  const rawValue = hasPercent ? o.priceImpact : o.priceImpactPct;
  const rawString = String(rawValue);

  const asFraction = hasPercent ? Number(o.priceImpact) / PERCENT_TO_FRACTION : Number(o.priceImpactPct);

  if (!Number.isFinite(asFraction)) {
    return reading({
      sourceField,
      rawString,
      status: 'NOT_A_NUMBER',
      detail: `${sourceField}=${rawString} did not parse to a finite number`,
    });
  }

  if (asFraction < -1 || asFraction > 1) {
    // The real schema failure. Impact cannot exceed the entire notional.
    return reading({
      sourceField,
      rawString,
      status: 'OUT_OF_RANGE',
      detail: `${sourceField}=${rawString} is ${asFraction} as a fraction, outside -1..1`,
    });
  }

  // When both are present they must be the same number. This is the live
  // cross-check that established the sign convention; keeping it in the parser
  // turns a provider changing one field without the other into an observation
  // instead of a silent change of economics.
  if (hasPercent && hasFraction) {
    const other = Number(o.priceImpactPct);
    if (Number.isFinite(other) && Math.abs(other - asFraction) > AGREEMENT_TOLERANCE) {
      return reading({
        sourceField,
        rawString,
        status: 'FIELDS_DISAGREE',
        detail: `priceImpact implies ${asFraction} but priceImpactPct is ${other}`,
      });
    }
  }

  const signedBps = asFraction * 10_000;

  return reading({
    sourceField,
    rawString,
    signedPct: asFraction,
    signedBps,
    // Negative is adverse. This is the ONLY place in the tree that encodes that
    // convention, and it is encoded from measurement.
    adverseBps: signedBps < 0 ? -signedBps : 0,
    favourableBps: signedBps > 0 ? signedBps : 0,
    status: 'OK',
    detail: '',
  });
}

/** True when the reading is safe to compare against an economic cap. */
export function impactIsUsable(r: ImpactReading): boolean {
  return r.status === 'OK';
}

/** True when the reading proves the parser or the schema is wrong. */
export function impactIsSchemaError(r: ImpactReading): boolean {
  return r.status === 'OUT_OF_RANGE' || r.status === 'NOT_A_NUMBER' || r.status === 'FIELDS_DISAGREE';
}
