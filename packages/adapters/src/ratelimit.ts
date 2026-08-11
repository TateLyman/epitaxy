import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

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
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillMs) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSecond);
    this.lastRefillMs = now;
  }

  /** Milliseconds until one token is available. 0 when immediately available. */
  msUntilAvailable(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    if (this.ratePerSecond <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
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

  /** Non-blocking. Returns false if no budget is available right now. */
  tryAcquire(bucket: string): boolean {
    const b = this.get(bucket);
    const ok = b.tryTake();
    if (!ok) b.refused++;
    return ok;
  }

  /**
   * Wait for budget, up to `maxWaitMs`. Throws RateLimitRefused rather than
   * waiting unboundedly, so a starved caller surfaces instead of hanging.
   */
  async acquire(bucket: string, maxWaitMs = 30_000): Promise<void> {
    const b = this.get(bucket);
    const started = Date.now();
    for (;;) {
      if (b.tryTake()) {
        b.waitedMs += Date.now() - started;
        return;
      }
      const wait = b.msUntilAvailable();
      if (!Number.isFinite(wait) || Date.now() - started + wait > maxWaitMs) {
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
