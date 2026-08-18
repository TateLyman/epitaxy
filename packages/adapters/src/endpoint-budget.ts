import { createHash } from 'node:crypto';

/**
 * S079 — ONE endpoint budget, shared by every process that talks to it.
 *
 * `RateLimiter` is a token bucket per PROCESS, and the quota it is protecting
 * is per ENDPOINT. So the screening collector, the trajectory collector and any
 * research script each believed they held the whole allowance and each spent
 * it: `pnpm rpc:usage` reports 48 quota refusals at 1.84 calls per active
 * second against a limit none of them individually exceeded. Three processes
 * politely staying under one limit is four times the limit.
 *
 * This phase makes that strictly worse if it is left alone. Pre-migration
 * history (P3) and targeted flow (P4) are both history-heavy, so the feature
 * collector is a third heavy consumer arriving next to two existing ones.
 *
 * The directive offers a loopback broker first and a SQLite lease bucket as the
 * proportionate alternative. This is the second, deliberately:
 *
 *   - the database is ALREADY the cross-process coordination point (the
 *     collector lock, the reservation table and the mark queue all live there),
 *     so a broker would add a second one that can disagree with the first;
 *   - a broker is a process that can die, and its death mode — every caller
 *     unbudgeted — is the exact failure this is preventing;
 *   - the transactions here are a single read-modify-write on one row, which is
 *     what SQLite is good at.
 *
 * "Do not build a complicated distributed system" is the operative instruction.
 *
 * ---
 *
 * WALL CLOCK, ON PURPOSE, WITH A GUARD.
 *
 * Every other bucket in this repository refills against `monotonicMs()`
 * because an NTP step must not mint API tokens. A monotonic clock is
 * per-process and cannot be compared across processes, so a SHARED bucket has
 * no choice but wall clock. The exposure is bounded on both sides:
 *
 *   - a BACKWARD step mints nothing (elapsed <= 0 returns early);
 *   - a FORWARD step mints at most `capacity`, because the bucket is clamped —
 *     an hour-long jump grants one burst, not an hour of tokens.
 *
 * That is a real weakening compared with the local buckets and it is stated
 * rather than hidden. The alternative — no cross-process limit at all — is the
 * defect being repaired.
 */

/** What the caller may know about an endpoint. Never the URL. */
export interface EndpointIdentity {
  /** Stable across processes, safe to log, and not reversible to a key. */
  readonly key: string;
  /** Host only, for humans. */
  readonly host: string;
}

/**
 * Identify an endpoint without carrying its credential.
 *
 * Helius authenticates by query parameter, so the full URL IS a secret and must
 * never reach a table, a log or an artifact. The key is the host plus a digest
 * prefix of the whole URL: two different API keys against the same host get
 * different budgets (they are different quotas), and neither key can be read
 * back out of the digest.
 */
export function endpointIdentity(url: string): EndpointIdentity {
  let host = 'unknown';
  try {
    host = new URL(url).host;
  } catch {
    /* an unparseable endpoint still gets a budget; the host is only a label */
  }
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 12);
  return { key: `${host}#${digest}`, host };
}

/**
 * Method families with independently measured capacities.
 *
 * Providers do not price all methods alike — Helius bills `getTransaction` and
 * `getSignaturesForAddress` far above `getSlot` — so one flat call-per-second
 * number either starves the cheap calls or overspends on the expensive ones.
 * The families are coarse on purpose: a per-method table would be a config
 * surface nobody maintains, and the families are what the quota actually
 * distinguishes.
 */
export type MethodFamily = 'history' | 'account' | 'token' | 'light';

export function methodFamily(method: string): MethodFamily {
  switch (method) {
    case 'getTransaction':
    case 'getSignaturesForAddress':
    case 'getBlock':
    case 'getBlockTime':
      return 'history';
    case 'getAccountInfo':
    case 'getMultipleAccounts':
    case 'getProgramAccounts':
      return 'account';
    case 'getTokenLargestAccounts':
    case 'getTokenSupply':
    case 'getTokenAccountsByOwner':
    case 'getTokenAccountBalance':
      return 'token';
    default:
      return 'light';
  }
}

/**
 * The endpoint-wide total, enforced ALONGSIDE the family buckets.
 *
 * A family-only scheme lets four families at 5 rps each spend 20 rps against an
 * endpoint sold as 10. Every lease therefore takes from its family AND from
 * this row, and the sum of the family rates is deliberately allowed to exceed
 * the total: families may borrow each other's idle capacity, and the total is
 * what actually binds.
 */
export const ENDPOINT_TOTAL_FAMILY = '__endpoint_total__';

export interface BudgetLimits {
  readonly totalRatePerSecond: number;
  readonly totalBurst: number;
  readonly family: Readonly<Record<MethodFamily, { ratePerSecond: number; burst: number }>>;
}

/**
 * The default limits.
 *
 * Chosen from the MEASURED figure in `artifacts/rpc-usage.json` — 1.84 calls
 * per active second across all processes, with 48 quota refusals — and from the
 * free-tier reality that produced those refusals. This is a budget that fits
 * inside what the endpoint has been observed to tolerate, not a guess at what
 * it is sold as.
 *
 * These are apparatus constants, not strategy thresholds: they change how fast
 * evidence is gathered and they cannot change what any policy decides. They are
 * therefore NOT ledger-registered thresholds.
 */
export const CONSERVATIVE_LIMITS: BudgetLimits = {
  totalRatePerSecond: 8,
  totalBurst: 16,
  family: {
    history: { ratePerSecond: 4, burst: 8 },
    account: { ratePerSecond: 5, burst: 10 },
    token: { ratePerSecond: 3, burst: 6 },
    light: { ratePerSecond: 5, burst: 10 },
  },
};

/**
 * What a caller gets back. A refusal carries the wait, so the caller can decide
 * between waiting and giving up rather than being told only "no".
 */
export interface LeaseResult {
  readonly granted: boolean;
  readonly waitMs: number;
  /** Which bucket bound: the family, the endpoint total, or the local fallback. */
  readonly boundBy: string;
  /** True when the shared table could not be used and a local budget was applied. */
  readonly degraded: boolean;
}

/** The minimum SQLite surface this needs. Keeps the module testable and storage-free. */
export interface BudgetDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown;
  };
}

interface BucketRow {
  tokens: number;
  capacity: number;
  rate_per_second: number;
  last_refill_utc_ms: number;
  granted: number;
  refused: number;
}

/**
 * A conservative process-local bucket, used ONLY when the shared table is
 * unreachable.
 *
 * FAILS CLOSED, as the directive requires: the fallback rate is a fraction of
 * the shared rate, so a process that has lost sight of its peers spends as if
 * it were the least important of several rather than the only one. The wrong
 * behaviour here — and the one a naive fallback picks — is to run unlimited
 * when the coordination fails, which turns a database hiccup into a banned key.
 */
const DEGRADED_SHARE = 0.25;

class LocalBucket {
  private tokens: number;
  private lastMs: number;
  constructor(
    private readonly rate: number,
    private readonly capacity: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.lastMs = now;
  }
  take(now: number): { ok: boolean; waitMs: number } {
    const elapsed = (now - this.lastMs) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
      this.lastMs = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true, waitMs: 0 };
    }
    return { ok: false, waitMs: this.rate <= 0 ? Number.POSITIVE_INFINITY : Math.ceil(((1 - this.tokens) / this.rate) * 1000) };
  }
}

export class SharedEndpointBudget {
  private readonly locals = new Map<string, LocalBucket>();
  private degradedCalls = 0;

  constructor(
    private readonly db: BudgetDb,
    private readonly limits: BudgetLimits = CONSERVATIVE_LIMITS,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  get degradedLeaseCount(): number {
    return this.degradedCalls;
  }

  /**
   * Take one token for `method` against `endpointKey`, or refuse.
   *
   * Non-blocking by design. The caller owns the waiting policy, because an exit
   * and a backfill should wait for very different lengths of time and this
   * layer does not know which one it is serving.
   */
  lease(endpointKey: string, method: string): LeaseResult {
    const family = methodFamily(method);
    try {
      return this.leaseShared(endpointKey, family);
    } catch {
      return this.leaseLocal(endpointKey, family);
    }
  }

  private leaseLocal(endpointKey: string, family: MethodFamily): LeaseResult {
    this.degradedCalls++;
    const k = `${endpointKey}|${family}`;
    const spec = this.limits.family[family];
    let b = this.locals.get(k);
    if (b === undefined) {
      b = new LocalBucket(spec.ratePerSecond * DEGRADED_SHARE, Math.max(1, Math.floor(spec.burst * DEGRADED_SHARE)), this.nowMs());
      this.locals.set(k, b);
    }
    const r = b.take(this.nowMs());
    return {
      granted: r.ok,
      waitMs: Number.isFinite(r.waitMs) ? r.waitMs : -1,
      boundBy: `LOCAL_FALLBACK:${family}`,
      degraded: true,
    };
  }

  /**
   * The shared path: ONE immediate transaction touching two rows.
   *
   * Both buckets are refilled and checked before either is debited, so a lease
   * that the endpoint total refuses does not silently consume a family token.
   * A partial debit would leak budget on every refusal, and refusals are
   * exactly when budget is scarcest.
   */
  private leaseShared(endpointKey: string, family: MethodFamily): LeaseResult {
    const now = this.nowMs();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const total = this.load(endpointKey, ENDPOINT_TOTAL_FAMILY, this.limits.totalRatePerSecond, this.limits.totalBurst, now);
      const fam = this.load(endpointKey, family, this.limits.family[family].ratePerSecond, this.limits.family[family].burst, now);

      const refill = (r: BucketRow): void => {
        const elapsed = (now - r.last_refill_utc_ms) / 1000;
        // A backward wall-clock step mints nothing. See the header.
        if (elapsed <= 0) return;
        r.tokens = Math.min(r.capacity, r.tokens + elapsed * r.rate_per_second);
        r.last_refill_utc_ms = now;
      };
      refill(total);
      refill(fam);

      const waitFor = (r: BucketRow): number =>
        r.rate_per_second <= 0 ? Number.POSITIVE_INFINITY : Math.ceil(((1 - r.tokens) / r.rate_per_second) * 1000);

      if (total.tokens < 1 || fam.tokens < 1) {
        const boundBy = total.tokens < 1 ? ENDPOINT_TOTAL_FAMILY : family;
        const short = total.tokens < 1 ? total : fam;
        // The refusal is recorded, so `rpc:shared-budget` can report pressure
        // rather than only the calls that got through.
        short.refused++;
        this.store(endpointKey, ENDPOINT_TOTAL_FAMILY, total);
        this.store(endpointKey, family, fam);
        this.db.exec('COMMIT');
        const w = waitFor(short);
        return { granted: false, waitMs: Number.isFinite(w) ? w : -1, boundBy, degraded: false };
      }

      total.tokens -= 1;
      fam.tokens -= 1;
      total.granted++;
      fam.granted++;
      this.store(endpointKey, ENDPOINT_TOTAL_FAMILY, total);
      this.store(endpointKey, family, fam);
      this.db.exec('COMMIT');
      return { granted: true, waitMs: 0, boundBy: family, degraded: false };
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already unwound */
      }
      throw e;
    }
  }

  private load(endpointKey: string, family: string, rate: number, burst: number, now: number): BucketRow {
    const row = this.db
      .prepare(
        `SELECT tokens, capacity, rate_per_second, last_refill_utc_ms, granted, refused
           FROM rpc_endpoint_budget WHERE endpoint_key = ? AND method_family = ?`,
      )
      .get(endpointKey, family) as BucketRow | undefined;
    if (row !== undefined) {
      // The configured rate wins over a stored one, so raising the budget does
      // not require deleting rows. The token count is preserved either way.
      return { ...row, capacity: burst, rate_per_second: rate };
    }
    return {
      tokens: burst,
      capacity: burst,
      rate_per_second: rate,
      last_refill_utc_ms: now,
      granted: 0,
      refused: 0,
    };
  }

  private store(endpointKey: string, family: string, r: BucketRow): void {
    this.db
      .prepare(
        `INSERT INTO rpc_endpoint_budget
           (endpoint_key, method_family, tokens, capacity, rate_per_second, last_refill_utc_ms, granted, refused)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint_key, method_family) DO UPDATE SET
           tokens = excluded.tokens,
           capacity = excluded.capacity,
           rate_per_second = excluded.rate_per_second,
           last_refill_utc_ms = excluded.last_refill_utc_ms,
           granted = excluded.granted,
           refused = excluded.refused`,
      )
      .run(endpointKey, family, r.tokens, r.capacity, r.rate_per_second, r.last_refill_utc_ms, r.granted, r.refused);
  }

  /** Every bucket, for `pnpm rpc:shared-budget`. Carries no URL and no key. */
  snapshot(): {
    endpointKey: string;
    methodFamily: string;
    tokens: number;
    capacity: number;
    ratePerSecond: number;
    granted: number;
    refused: number;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT endpoint_key, method_family, tokens, capacity, rate_per_second, granted, refused
           FROM rpc_endpoint_budget ORDER BY endpoint_key, method_family`,
      )
      .all() as {
      endpoint_key: string;
      method_family: string;
      tokens: number;
      capacity: number;
      rate_per_second: number;
      granted: number;
      refused: number;
    }[];
    return rows.map((r) => ({
      endpointKey: r.endpoint_key,
      methodFamily: r.method_family,
      tokens: r.tokens,
      capacity: r.capacity,
      ratePerSecond: r.rate_per_second,
      granted: r.granted,
      refused: r.refused,
    }));
  }
}
