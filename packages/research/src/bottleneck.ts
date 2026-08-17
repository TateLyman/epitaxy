/**
 * P17 — measure the real bottleneck.
 *
 * The rate-budget report this replaces divided counts by ELAPSED WALL TIME,
 * including every minute the process was not running. A system that ran for
 * twenty minutes out of a day and then reported "48 requests/day against a
 * 10,000/day quota" is describing its downtime, not its capacity, and the
 * conclusion — that quota is not the constraint — is unsupported either way.
 *
 * Everything here is per ACTIVE SECOND. Downtime is reported separately,
 * because "we are not rate limited" and "we were switched off" need different
 * responses.
 *
 * A LABEL IS ONE COMPLETED TRAJECTORY. Not one effect-valid leg, not one mark.
 * Counting legs inflates throughput by the number of legs per trajectory and
 * makes the sample look larger than the number of independent outcomes in it.
 */

export type ResourceKind =
  | 'jupiter_recent'
  | 'jupiter_category'
  | 'jupiter_search'
  | 'jupiter_order'
  | 'jupiter_build'
  | 'solana_rpc'
  | 'wss_bytes'
  | 'wss_events'
  | 'snapshot_account_reads'
  | 'worker_jobs'
  | 'worker_steps'
  | 'db_writes'
  | 'mark_jobs'
  | 'fill_jobs';

export interface ResourceUse {
  readonly kind: ResourceKind;
  /** For solana_rpc, the specific method. Counting all RPC as one hides which. */
  readonly detail: string | null;
  readonly count: number;
  readonly errors429: number;
  readonly quotaErrors: number;
}

export interface ActiveTime {
  /** Seconds the process was actually running and doing work. */
  readonly activeSeconds: number;
  /** Wall seconds spanned, including downtime. Reported, never divided by. */
  readonly wallSeconds: number;
}

export interface LatencySamples {
  readonly queueLagMs: readonly number[];
  readonly markLagMs: readonly number[];
  readonly triggerToFillMs: readonly number[];
}

export interface ThroughputCounts {
  /** ONE COMPLETED TRAJECTORY. Never a leg. */
  readonly completedTrajectories: number;
  readonly candidatesConsidered: number;
  readonly candidatesWithCanonicalPool: number;
  readonly candidatesWithCashbackPool: number;
  readonly apparatusFailures: number;
  readonly duplicateObservations: number;
  /** Seconds the sequential worker spent executing, over active seconds. */
  readonly workerBusySeconds: number;
}

function pct(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] ?? null;
}

export interface BottleneckReport {
  readonly activeSeconds: number;
  readonly wallSeconds: number;
  /** Below 1 means the process was mostly not running. */
  readonly dutyCycle: number | null;

  readonly perResourcePerActiveSecond: Readonly<Record<string, number>>;
  readonly rateLimitErrors: Readonly<Record<string, number>>;

  readonly validTrajectoriesPerDay: number | null;
  readonly validTrajectoriesPerCandidate: number | null;
  readonly canonicalPoolYield: number | null;
  readonly cashbackPoolYield: number | null;
  readonly apparatusFailureRate: number | null;
  readonly duplicateObservationRate: number | null;
  readonly workerUtilization: number | null;

  readonly queueLagMs: { p50: number | null; p95: number | null };
  readonly markLagMs: { p50: number | null; p95: number | null };
  readonly triggerToFillMs: { p50: number | null; p95: number | null };

  /** The single resource closest to its limit, named. */
  readonly bindingConstraint: string;
  readonly notes: readonly string[];
}

/**
 * Build the report.
 *
 * `limits` is per active second per resource. A resource with no stated limit
 * cannot be the binding constraint, and is said to be unknown rather than fine.
 */
export function buildBottleneckReport(p: {
  time: ActiveTime;
  resources: readonly ResourceUse[];
  throughput: ThroughputCounts;
  latency: LatencySamples;
  limitsPerActiveSecond?: Readonly<Record<string, number>>;
}): BottleneckReport {
  const notes: string[] = [];
  const active = p.time.activeSeconds;
  if (active <= 0) {
    notes.push('no active time recorded; every rate below would be a division by zero and is null instead');
  }

  const perSecond: Record<string, number> = {};
  const rateErrors: Record<string, number> = {};
  for (const r of p.resources) {
    const key = r.detail === null ? r.kind : `${r.kind}:${r.detail}`;
    perSecond[key] = active > 0 ? r.count / active : 0;
    if (r.errors429 > 0 || r.quotaErrors > 0) rateErrors[key] = r.errors429 + r.quotaErrors;
  }

  const t = p.throughput;
  const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

  // A day of ACTIVE time, not a calendar day.
  const perDay = active > 0 ? (t.completedTrajectories / active) * 86_400 : null;

  const limits = p.limitsPerActiveSecond ?? {};
  let binding = 'unknown: no per-resource limits were supplied';
  let worstUtil = -1;
  for (const [key, rate] of Object.entries(perSecond)) {
    const limit = limits[key];
    if (limit === undefined || limit <= 0) continue;
    const util = rate / limit;
    if (util > worstUtil) {
      worstUtil = util;
      binding = `${key} at ${(util * 100).toFixed(1)}% of its ${limit}/s limit`;
    }
  }
  if (worstUtil >= 0 && worstUtil < 0.5) {
    notes.push(
      `the busiest limited resource is at ${(worstUtil * 100).toFixed(1)}% of its limit, so per-second rate capacity is NOT the constraint — ` +
        'buying more requests per second would not produce more completed trajectories',
    );
  }

  /**
   * AN OBSERVED QUOTA ERROR OUTRANKS A MODELLED RATIO.
   *
   * A per-second limit and a daily allowance are different limits, and this
   * report only models the first. Measured on 2026-08-16: the endpoint was at
   * 0.9% of its 10/s limit and returned `daily request limit reached` on every
   * call. The modelled ratio said rate capacity was not the constraint, which
   * was true and useless — the account had no requests left for the day.
   *
   * A quota error is direct evidence rather than an inference from a rate, so
   * it wins outright. It also names the resource, which is what the
   * infrastructure decision needs.
   */
  const quotaHit = p.resources.filter((r) => r.quotaErrors > 0);
  if (quotaHit.length > 0) {
    const worst = quotaHit.reduce((a, b) => (b.quotaErrors > a.quotaErrors ? b : a));
    const key = worst.detail === null ? worst.kind : `${worst.kind}:${worst.detail}`;
    binding = `${key}: the DAILY QUOTA is exhausted (${worst.quotaErrors} observed), which no per-second headroom relieves`;
    notes.push(
      'a daily allowance was spent, not a per-second limit. Backing off does not help: every retry today ' +
        'fails, and the refusals it produces read as facts about the chain rather than about the account.',
    );
  }
  if (Object.keys(rateErrors).length > 0) {
    notes.push(`rate-limit or quota errors were observed on: ${Object.keys(rateErrors).join(', ')}`);
  }

  const duty = p.time.wallSeconds > 0 ? active / p.time.wallSeconds : null;
  if (duty !== null && duty < 0.5) {
    notes.push(
      `duty cycle ${(duty * 100).toFixed(1)}%: the process was not running for most of the window. ` +
        'Throughput per calendar day is therefore a fact about downtime, not about capacity.',
    );
  }

  if (t.completedTrajectories === 0) {
    notes.push('zero completed trajectories: every per-trajectory rate below is undefined rather than zero');
  }

  return {
    activeSeconds: active,
    wallSeconds: p.time.wallSeconds,
    dutyCycle: duty,
    perResourcePerActiveSecond: perSecond,
    rateLimitErrors: rateErrors,
    validTrajectoriesPerDay: perDay,
    validTrajectoriesPerCandidate: ratio(t.completedTrajectories, t.candidatesConsidered),
    canonicalPoolYield: ratio(t.candidatesWithCanonicalPool, t.candidatesConsidered),
    cashbackPoolYield: ratio(t.candidatesWithCashbackPool, t.candidatesConsidered),
    apparatusFailureRate: ratio(t.apparatusFailures, t.candidatesConsidered),
    duplicateObservationRate: ratio(t.duplicateObservations, t.candidatesConsidered),
    workerUtilization: active > 0 ? t.workerBusySeconds / active : null,
    queueLagMs: { p50: pct(p.latency.queueLagMs, 50), p95: pct(p.latency.queueLagMs, 95) },
    markLagMs: { p50: pct(p.latency.markLagMs, 50), p95: pct(p.latency.markLagMs, 95) },
    triggerToFillMs: { p50: pct(p.latency.triggerToFillMs, 50), p95: pct(p.latency.triggerToFillMs, 95) },
    bindingConstraint: binding,
    notes,
  };
}

/**
 * What may and may not be bought, and on what evidence.
 *
 * Encoded rather than written in prose because the whole point is that the
 * decision is not a judgement call made while frustrated with throughput.
 */
export const INFRASTRUCTURE_POLICY = {
  forbiddenBeforePositiveUntouchedEdge: [
    'shreds',
    'dedicated_validator',
    'colocation',
    'archival_rpc',
    'business_tier_infrastructure',
  ] as readonly string[],
  /** Paid Jupiter raises rate capacity. It does not improve data freshness. */
  jupiterDeveloperJustifiedOnlyWhen:
    'corrected ACTIVE-TIME metrics show the 1 RPS limit is what caps completed trajectory throughput or breaks the fill SLA',
  heliusDeveloperJustifiedWhen:
    'holder and entity reads are the blocked resource; exploit immediately with batched coherent snapshots',
} as const;

export function infrastructurePurchaseAllowed(p: {
  item: string;
  positiveUntouchedEdgeExists: boolean;
  bindingConstraintIsThisResource: boolean;
}): { allowed: boolean; reason: string } {
  if (INFRASTRUCTURE_POLICY.forbiddenBeforePositiveUntouchedEdge.includes(p.item) && !p.positiveUntouchedEdgeExists) {
    return {
      allowed: false,
      reason: `${p.item} may not be bought before a positive untouched edge exists; faster access to a losing strategy loses faster`,
    };
  }
  if (!p.bindingConstraintIsThisResource) {
    return {
      allowed: false,
      reason: `${p.item} is not the binding constraint, so buying it changes nothing measurable`,
    };
  }
  return { allowed: true, reason: `${p.item} is the measured binding constraint` };
}
