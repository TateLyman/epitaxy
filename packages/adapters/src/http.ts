import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { RateLimiter, RateLimitRefused, backoffMs, sleep } from './ratelimit.js';
import type { Provenance, SourceType } from '../../domain/src/types.js';
import { sanitizeExternal } from '../../observability/src/log.js';

/**
 * Hardened JSON fetch.
 *
 * Responsibilities that must not be duplicated by callers:
 *  - respect the rate bucket
 *  - classify failures precisely (a 429 is NOT "token untradable")
 *  - validate against a strict schema and fail closed on drift
 *  - attach provenance so a decision can prove what it saw and when
 */

export type FetchErrorKind =
  | 'rate_limited' // provider 429 / our own bucket refusal
  | 'auth' // 401/403
  | 'not_found' // 404
  | 'server_error' // 5xx
  | 'timeout'
  | 'network'
  | 'schema_drift' // response parsed as JSON but failed our schema
  | 'not_json' // provider returned HTML or plain text
  | 'client_error';

export class SourceFetchError extends Error {
  constructor(
    readonly kind: FetchErrorKind,
    readonly source: string,
    message: string,
    readonly status: number | null = null,
    readonly retryable: boolean = false,
  ) {
    super(`[${source}/${kind}] ${message}`);
    this.name = 'SourceFetchError';
  }
}

export interface FetchResult<T> {
  readonly data: T;
  readonly provenance: Provenance;
  readonly latencyMs: number;
  /** Provider rate-limit headers when exposed, for budget reconciliation. */
  readonly rateRemaining: number | null;
}

export interface JsonFetchOptions<T> {
  readonly url: string;
  readonly source: string;
  readonly sourceType: SourceType;
  readonly bucket: string;
  readonly schema: z.ZodType<T>;
  readonly schemaVersion: string;
  readonly parserVersion: string;
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  /** Slot the caller believes this data refers to, when known out-of-band. */
  readonly slot?: number | null;
}

function classify(status: number): { kind: FetchErrorKind; retryable: boolean } {
  if (status === 429) return { kind: 'rate_limited', retryable: true };
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (status === 404) return { kind: 'not_found', retryable: false };
  if (status >= 500) return { kind: 'server_error', retryable: true };
  return { kind: 'client_error', retryable: false };
}

export async function fetchJson<T>(limiter: RateLimiter, opts: JsonFetchOptions<T>): Promise<FetchResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let lastError: SourceFetchError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await limiter.acquire(opts.bucket);
    } catch (e) {
      if (e instanceof RateLimitRefused) {
        throw new SourceFetchError('rate_limited', opts.source, e.message, null, true);
      }
      throw e;
    }

    const startedUtc = Date.now();
    const startedMono = Math.round(performance.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(opts.url, {
        method: opts.method ?? 'GET',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'solmeme-research/0.1 (+local)',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - startedUtc;
      const text = await res.text();

      const remainingRaw = res.headers.get('x-ratelimit-remaining');
      const rateRemaining = remainingRaw === null ? null : Number(remainingRaw);

      if (!res.ok) {
        const { kind, retryable } = classify(res.status);
        // Cap and sanitize: provider error bodies are untrusted external text.
        lastError = new SourceFetchError(
          kind,
          opts.source,
          `HTTP ${res.status}: ${sanitizeExternal(text, 200)}`,
          res.status,
          retryable,
        );
        if (!retryable || attempt === maxAttempts - 1) throw lastError;
        await sleep(backoffMs(attempt));
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // A provider returning an HTML error page as 200 is a real failure mode.
        throw new SourceFetchError(
          'not_json',
          opts.source,
          `expected JSON, got ${sanitizeExternal(text, 120)}`,
          res.status,
          false,
        );
      }

      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        // Fail CLOSED on schema drift. Never coerce or guess.
        throw new SourceFetchError(
          'schema_drift',
          opts.source,
          `schema validation failed: ${sanitizeExternal(parsed.error.message, 300)}`,
          res.status,
          false,
        );
      }

      const provenance: Provenance = {
        source: opts.source,
        sourceType: opts.sourceType,
        receivedMonotonicMs: startedMono,
        receivedUtcMs: startedUtc,
        slot: opts.slot ?? null,
        sourceUtcMs: null,
        schemaVersion: opts.schemaVersion,
        parserVersion: opts.parserVersion,
        payloadHash: createHash('sha256').update(text).digest('hex').slice(0, 32),
      };

      return { data: parsed.data, provenance, latencyMs, rateRemaining };
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof SourceFetchError) {
        if (!e.retryable || attempt === maxAttempts - 1) throw e;
        lastError = e;
        await sleep(backoffMs(attempt));
        continue;
      }
      const isAbort = (e as Error).name === 'AbortError';
      const err = new SourceFetchError(
        isAbort ? 'timeout' : 'network',
        opts.source,
        sanitizeExternal((e as Error).message, 200),
        null,
        true,
      );
      if (attempt === maxAttempts - 1) throw err;
      lastError = err;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError ?? new SourceFetchError('network', opts.source, 'exhausted attempts', null, false);
}
