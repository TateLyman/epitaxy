import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { monotonicMs } from '../../domain/src/clock.js';

/**
 * Token-bucket scheduler.
 *
 * The keyless Jupiter budget is 0.5 RPS / 30 RPM shared across the Swap, Price
 * and Token APIs. That makes request budget — not CPU or bandwidth — the
 * scarcest resource in the system, so every outbound call must pass through a
 * bucket and callers must be prepared to wait or be refused.
 */

const BucketSchema = z.object({
  name: z.string(),
  bucket: z.string(),
  requestsPerSecond: z.number().min(0),
  burst: z.number().int().min(1),
  withKeyRequestsPerSecond: z.number().min(0).optional(),
});

const LimitsFileSchema = z.object({
  buckets: z.array(BucketSchema.passthrough()),
});

export interface BucketStats {
  readonly bucket: string;
  readonly available: number;
  readonly capacity: number;
  readonly ratePerSecond: number;
  readonly granted: number;
  readonly refused: number;
  readonly waitedMs: number;
}

class Bucket {
  private tokens: number;
  private lastRefillMs: number;
  granted = 0;
  refused = 0;
  waitedMs = 0;

  constructor(
    readonly name: string,
    readonly ratePerSecond: number,
    readonly capacity: number,
  ) {
    this.tokens = capacity;
    // §19.4 — MONOTONIC, not wall clock.
    //
    // Refilling against `Date.now()` means an NTP step or a resume decides how
    // many API tokens exist. A forward jump of an hour mints a full bucket out
    // of nothing and lets the engine burst into a 0.5 RPS limit; a backward
    // step freezes refill entirely and starves the exit path, which is the one
    // caller that cannot wait. Neither is a rate limit.
    this.lastRefillMs = monotonicMs();
  }

  private refill(): void {
    const now = monotonicMs();
    const elapsed = (now - this.lastRefillMs) / 1000;
    // Monotonic time cannot go backwards, so a negative elapsed would mean the
    // platform clock is broken. Refuse to mint tokens either way.
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSecond);
    this.lastRefillMs = now;
  }

  /** Milliseconds until `need` tokens are available. 0 when already there. */
  msUntilAvailable(need = 1): number {
    this.refill();
    if (this.tokens >= need) return 0;
    if (this.ratePerSecond <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil(((need - this.tokens) / this.ratePerSecond) * 1000);
  }

  /**
   * Take one token, but only if at least `need` are present.
   *
   * `need > 1` is how priority is implemented: a low-priority caller must leave
   * a floor of tokens behind for anything more urgent. See `RESERVED_TOKENS`.
   */
  tryTake(need = 1): boolean {
    this.refill();
    if (this.tokens >= need) {
      this.tokens -= 1;
      this.granted++;
      return true;
    }
    return false;
  }

  stats(): BucketStats {
    this.refill();
    return {
      bucket: this.name,
      available: Math.floor(this.tokens),
      capacity: this.capacity,
      ratePerSecond: this.ratePerSecond,
      granted: this.granted,
      refused: this.refused,
      waitedMs: Math.round(this.waitedMs),
    };
  }
}

/**
 * What a request is for, in the order the budget should serve it.
 *
 * P2a.1 §P4. Every Swap, Price and Token call shares one bucket at 0.5 RPS
 * keyless — roughly one request every two seconds for the whole system. Before
 * this, discovery and an emergency exit competed as equals for that budget, so
 * the request that could save a position queued behind an enrichment call for a
 * token nobody had bought. Ordering the queue costs nothing and is the single
 * cheapest improvement available.
 *
 * The order is deliberate and is the directive's: getting out first, then
 * keeping open positions marked, then risk, then finding new things, then
 * nice-to-have data.
 */
export const REQUEST_PRIORITIES = [
  'emergency_exit',
  'open_position',
  'risk',
  'discovery',
  'enrichment',
] as const;

export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];

/**
 * Tokens a caller of each priority must leave in the bucket.
 *
 * A floor, not a share: `enrichment` may take a token only when four remain, so
 * three are always held back for an exit. With the keyless burst of 5 that
 * means discovery stops well before the bucket is empty and an exit can always
 * find budget without waiting for a refill.
 *
 * Reserves are clamped against capacity at acquisition time, so a bucket
 * configured with a burst of 1 does not deadlock every non-emergency caller.
 */
export const RESERVED_TOKENS: Record<RequestPriority, number> = {
  emergency_exit: 1,
  open_position: 2,
  risk: 2,
  discovery: 3,
  enrichment: 4,
};

export class RateLimitRefused extends Error {
  constructor(
    readonly bucket: string,
    readonly waitMs: number,
  ) {
    super(`rate budget exhausted for bucket "${bucket}"; next token in ${waitMs}ms`);
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(definitions: readonly { bucket: string; requestsPerSecond: number; burst: number }[]) {
    for (const d of definitions) {
      // Several named sources can share one bucket (e.g. jupiter_main). The
      // first definition wins; sharing is the point.
      if (!this.buckets.has(d.bucket)) {
        this.buckets.set(d.bucket, new Bucket(d.bucket, d.requestsPerSecond, d.burst));
      }
    }
  }

  static fromConfig(hasJupiterKey = false): RateLimiter {
    const path = resolve(process.cwd(), 'config', 'source-limits.json');
    const parsed = LimitsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const defs = parsed.buckets.map((b) => ({
      bucket: b.bucket,
      requestsPerSecond:
        hasJupiterKey && b.bucket === 'jupiter_main' && typeof b.withKeyRequestsPerSecond === 'number'
          ? b.withKeyRequestsPerSecond
          : b.requestsPerSecond,
      burst: b.burst,
    }));
    return new RateLimiter(defs);
  }

  private get(bucket: string): Bucket {
    const b = this.buckets.get(bucket);
    if (!b) throw new Error(`unknown rate bucket "${bucket}" — add it to config/source-limits.json`);
    return b;
  }

  /**
   * Tokens this priority must find in the bucket before it may take one.
   *
   * Clamped to capacity so that a bucket with a burst of 1 still serves every
   * class rather than deadlocking everything below `emergency_exit`.
   */
  private need(bucket: string, priority: RequestPriority): number {
    const b = this.get(bucket);
    return Math.min(RESERVED_TOKENS[priority], b.capacity);
  }

  /** Non-blocking. Returns false if no budget is available for this priority. */
  tryAcquire(bucket: string, priority: RequestPriority = 'discovery'): boolean {
    const b = this.get(bucket);
    const ok = b.tryTake(this.need(bucket, priority));
    if (!ok) b.refused++;
    return ok;
  }

  /**
   * Wait for budget, up to `maxWaitMs`. Throws RateLimitRefused rather than
   * waiting unboundedly, so a starved caller surfaces instead of hanging.
   *
   * `priority` decides how much of the bucket the caller must leave behind. A
   * discovery call therefore gives up while an exit still has budget, which is
   * the whole point: the alternative is an exit queued behind a token feed.
   */
  async acquire(bucket: string, maxWaitMs = 30_000, priority: RequestPriority = 'discovery'): Promise<void> {
    const b = this.get(bucket);
    const need = this.need(bucket, priority);
    // Monotonic here too: a wall-clock step during a wait would otherwise make
    // a caller believe it had already waited its whole budget, or none of it.
    const started = monotonicMs();
    for (;;) {
      if (b.tryTake(need)) {
        b.waitedMs += monotonicMs() - started;
        return;
      }
      const wait = b.msUntilAvailable(need);
      if (!Number.isFinite(wait) || monotonicMs() - started + wait > maxWaitMs) {
        b.refused++;
        throw new RateLimitRefused(bucket, Number.isFinite(wait) ? wait : -1);
      }
      await sleep(Math.min(wait, 250));
    }
  }

  stats(): BucketStats[] {
    return [...this.buckets.values()].map((b) => b.stats());
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Full jitter exponential backoff (AWS "Exponential Backoff and Jitter"). */
export function backoffMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}
