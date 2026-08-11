import { randomUUID } from 'node:crypto';
import type { RateLimiter } from '../ratelimit.js';
import { fetchJson, SourceFetchError } from '../http.js';
import {
  MintListSchema,
  OrderResponseSchema,
  PriceV3Schema,
  PARSER_VERSION,
  SCHEMA_VERSION,
  type MintInformation,
  type OrderResponse,
} from './schemas.js';
import type { ExecutableQuote } from '../../../domain/src/types.js';
import { lossBps } from '../../../domain/src/amounts.js';
import { sanitizeExternal } from '../../../observability/src/log.js';

/**
 * Jupiter adapter.
 *
 * Base URL: https://api.jup.ag  (verified 2026-08-11)
 * `lite-api.jup.ag` is being retired per the official migration guide and is
 * deliberately NOT used here, even though it still answers today.
 *
 * Rate reality: keyless is 0.5 RPS / 30 RPM shared across Swap + Price + Token.
 * That makes a quote the most expensive thing we can spend, so the caller is
 * expected to gate cheaply before asking for one.
 */

const BASE = 'https://api.jup.ag';
const MAIN_BUCKET = 'jupiter_main';

export interface JupiterClientOptions {
  readonly limiter: RateLimiter;
  readonly apiKey?: string | null;
}

export class JupiterClient {
  private readonly limiter: RateLimiter;
  private readonly headers: Record<string, string>;

  constructor(opts: JupiterClientOptions) {
    this.limiter = opts.limiter;
    this.headers = opts.apiKey ? { 'x-api-key': opts.apiKey } : {};
  }

  /** Tokens whose FIRST POOL was recently created. The new-launch feed. */
  async recentTokens(): Promise<{ tokens: MintInformation[]; latencyMs: number; payloadHash: string }> {
    const res = await fetchJson(this.limiter, {
      url: `${BASE}/tokens/v2/recent`,
      source: 'jupiter.tokens.recent',
      sourceType: 'official_indexer',
      bucket: MAIN_BUCKET,
      schema: MintListSchema,
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      headers: this.headers,
    });
    return { tokens: res.data, latencyMs: res.latencyMs, payloadHash: res.provenance.payloadHash };
  }

  /** Ranked feeds: category is toporganicscore | toptraded | toptrending. */
  async category(
    category: 'toporganicscore' | 'toptraded' | 'toptrending',
    interval: '5m' | '1h' | '6h' | '24h',
    limit = 50,
  ): Promise<MintInformation[]> {
    const res = await fetchJson(this.limiter, {
      url: `${BASE}/tokens/v2/${category}/${interval}?limit=${limit}`,
      source: `jupiter.tokens.${category}`,
      sourceType: 'official_indexer',
      bucket: MAIN_BUCKET,
      schema: MintListSchema,
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      headers: this.headers,
    });
    return res.data;
  }

  /** Lookup by mint. Up to 100 comma-separated mints per call. */
  async search(mints: readonly string[]): Promise<MintInformation[]> {
    if (mints.length === 0) return [];
    if (mints.length > 100) throw new Error('jupiter search accepts at most 100 mints per request');
    const res = await fetchJson(this.limiter, {
      url: `${BASE}/tokens/v2/search?query=${encodeURIComponent(mints.join(','))}`,
      source: 'jupiter.tokens.search',
      sourceType: 'official_indexer',
      bucket: MAIN_BUCKET,
      schema: MintListSchema,
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      headers: this.headers,
    });
    return res.data;
  }

  async prices(mints: readonly string[]): Promise<Record<string, { usdPrice: number; liquidity?: number | null }>> {
    if (mints.length === 0) return {};
    if (mints.length > 50) throw new Error('jupiter price/v3 accepts at most 50 mints per request');
    const res = await fetchJson(this.limiter, {
      url: `${BASE}/price/v3?ids=${encodeURIComponent(mints.join(','))}`,
      source: 'jupiter.price.v3',
      sourceType: 'official_indexer',
      bucket: MAIN_BUCKET,
      schema: PriceV3Schema,
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      headers: this.headers,
    });
    return res.data;
  }

  /**
   * Quote-only order. Deliberately omits `taker`, which means Jupiter returns
   * routing and fees but never a signable transaction. This is the ONLY form
   * observe and paper mode are permitted to call.
   */
  async quote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps?: number;
  }): Promise<ExecutableQuote> {
    const qs = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
    });
    if (params.slippageBps !== undefined) qs.set('slippageBps', String(params.slippageBps));

    const requestedUtcMs = Date.now();
    const res = await fetchJson(this.limiter, {
      url: `${BASE}/swap/v2/order?${qs.toString()}`,
      source: 'jupiter.swap.v2.order',
      sourceType: 'official_indexer',
      bucket: MAIN_BUCKET,
      schema: OrderResponseSchema,
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      headers: this.headers,
      timeoutMs: 12_000,
    });
    return toExecutableQuote(res.data, requestedUtcMs, res.provenance, res.latencyMs);
  }

  /**
   * Best-effort quote that converts "no route" into a null rather than an
   * exception. A missing route is a fact about the token; an outage is a fact
   * about the provider, and the two must never be conflated.
   */
  async tryQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps?: number;
  }): Promise<{ quote: ExecutableQuote | null; providerFailure: SourceFetchError | null }> {
    try {
      return { quote: await this.quote(params), providerFailure: null };
    } catch (e) {
      if (e instanceof SourceFetchError) {
        // 404 / client_error with a "no route" body is a token fact.
        if (e.kind === 'not_found' || (e.kind === 'client_error' && /route|no.*liquidit/i.test(e.message))) {
          return { quote: null, providerFailure: null };
        }
        return { quote: null, providerFailure: e };
      }
      throw e;
    }
  }
}

export function toExecutableQuote(
  o: OrderResponse,
  requestedUtcMs: number,
  provenance: ExecutableQuote['provenance'],
  latencyMs: number,
): ExecutableQuote {
  // Prefer the current field, fall back to the deprecated one.
  const impact =
    typeof o.priceImpact === 'number'
      ? o.priceImpact / 100
      : o.priceImpactPct !== undefined
        ? Number(o.priceImpactPct)
        : 0;

  const labels = o.routePlan.map((r) => r.swapInfo.label ?? r.swapInfo.ammKey.slice(0, 8));

  // `transaction` is null for quote-only requests and "" when a build failed.
  const buildable = typeof o.transaction === 'string' && o.transaction.length > 0;

  return {
    quoteId: o.requestId ?? o.quoteId ?? randomUUID(),
    inputMint: o.inputMint,
    outputMint: o.outputMint,
    inAmount: BigInt(o.inAmount),
    outAmount: BigInt(o.outAmount),
    otherAmountThreshold: BigInt(o.otherAmountThreshold),
    slippageBps: o.slippageBps,
    platformFeeBps: o.feeBps ?? o.platformFee?.feeBps ?? 0,
    priceImpactPct: Number.isFinite(impact) ? impact : 0,
    router: o.router ?? o.swapType ?? 'unknown',
    routeLabels: labels,
    signatureFeeLamports: BigInt(o.signatureFeeLamports ?? 0),
    prioritizationFeeLamports: BigInt(o.prioritizationFeeLamports ?? 0),
    rentFeeLamports: BigInt(o.rentFeeLamports ?? 0),
    transactionBuildable: buildable,
    errorCode: o.errorCode ?? null,
    errorMessage: o.errorMessage ? sanitizeExternal(o.errorMessage, 120) : null,
    requestedUtcMs,
    receivedUtcMs: provenance.receivedUtcMs,
    latencyMs,
    provenance,
  };
}

/**
 * Measure a full in-and-out at the current instant.
 *
 * This is the single most important cost number in the system: a fresh
 * memecoin must appreciate by more than this before a trade is even flat.
 */
export async function measureRoundTrip(
  client: JupiterClient,
  solMint: string,
  tokenMint: string,
  lamportsIn: bigint,
  slippageBps: number,
): Promise<{
  buy: ExecutableQuote | null;
  sell: ExecutableQuote | null;
  roundTripLossBps: number | null;
  providerFailure: SourceFetchError | null;
}> {
  const buyRes = await client.tryQuote({
    inputMint: solMint,
    outputMint: tokenMint,
    amount: lamportsIn,
    slippageBps,
  });
  if (buyRes.providerFailure) {
    return { buy: null, sell: null, roundTripLossBps: null, providerFailure: buyRes.providerFailure };
  }
  const buy = buyRes.quote;
  if (!buy || buy.outAmount === 0n) {
    return { buy, sell: null, roundTripLossBps: null, providerFailure: null };
  }

  // Reverse quote for exactly what the buy would produce. A buy route without
  // a sell route is not a trade.
  const sellRes = await client.tryQuote({
    inputMint: tokenMint,
    outputMint: solMint,
    amount: buy.outAmount,
    slippageBps,
  });
  if (sellRes.providerFailure) {
    return { buy, sell: null, roundTripLossBps: null, providerFailure: sellRes.providerFailure };
  }
  const sell = sellRes.quote;
  const loss = sell ? lossBps(lamportsIn, sell.outAmount) : null;
  return { buy, sell, roundTripLossBps: loss, providerFailure: null };
}
