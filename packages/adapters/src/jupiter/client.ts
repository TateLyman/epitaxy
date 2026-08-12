import { randomUUID } from 'node:crypto';
import type { RateLimiter } from '../ratelimit.js';
import { fetchJson, SourceFetchError } from '../http.js';
import {
  BuildResponseSchema,
  MintListSchema,
  OrderResponseSchema,
  PriceV3Schema,
  PARSER_VERSION,
  SCHEMA_VERSION,
  type MintInformation,
  type OrderResponse,
} from './schemas.js';
import type { ExecutableQuote } from '../../../domain/src/types.js';
import { parseImpact, type ImpactReading } from '../../../domain/src/impact.js';
import type { RawInstruction } from '../../../solana/src/instructionpolicy.js';
import { instructionSetHash, type LookupTableMap } from '../../../solana/src/buildpolicy.js';
import { routePlanHash, type ObservationFailure } from '../../../domain/src/execution.js';
import type { RequestPriority } from '../ratelimit.js';
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
   * Structural build check for a route, via `/swap/v2/build`.
   *
   * Returns whether a transaction could have been CONSTRUCTED for this exact
   * route at this exact size, plus the instruction shape for policy inspection.
   * The taker is a public key only; nothing signable is produced for it and
   * this process holds no key for any address.
   *
   * A null result means the build could not be established and the caller must
   * fail closed — it never means "probably fine".
   */
  async build(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    taker: string;
    slippageBps?: number;
    priority?: RequestPriority;
  }): Promise<BuildOutcome> {
    const qs = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      taker: params.taker,
    });
    if (params.slippageBps !== undefined) qs.set('slippageBps', String(params.slippageBps));

    const requestedUtcMs = Date.now();
    try {
      const res = await fetchJson(this.limiter, {
        url: `${BASE}/swap/v2/build?${qs.toString()}`,
        source: 'jupiter.swap.v2.build',
        sourceType: 'official_indexer',
        bucket: MAIN_BUCKET,
        schema: BuildResponseSchema,
        schemaVersion: SCHEMA_VERSION,
        parserVersion: PARSER_VERSION,
        headers: this.headers,
        priority: params.priority ?? 'open_position',
      });
      const b = res.data;

      // Order matters and is the order they execute in. The policy decoder
      // reads this array, so assembling it wrongly would validate a different
      // transaction from the one the route describes.
      const instructions: RawInstruction[] = [
        ...(b.computeBudgetInstructions ?? []),
        ...(b.setupInstructions ?? []),
        ...(b.swapInstruction ? [b.swapInstruction] : []),
        ...(b.cleanupInstruction ? [b.cleanupInstruction] : []),
        ...(b.otherInstructions ?? []),
      ];
      const programIds = instructions.map((i) => i.programId);

      // Address lookup tables, resolved. Their contents are part of the
      // transaction's identity: a table whose addresses changed resolves to
      // different accounts under the same address.
      const lookupTables: Record<string, string[]> = {};
      for (const [table, addrs] of Object.entries(b.addressesByLookupTableAddress ?? {})) {
        if (Array.isArray(addrs)) lookupTables[table] = addrs.filter((a): a is string => typeof a === 'string');
      }

      // NOT a transaction hash -- /build returns instructions, never serialized
      // bytes. It IS the identity of the instruction set, and it now includes
      // isSigner, isWritable, instruction order and lookup-table contents. The
      // previous version covered only program id, data and account pubkeys, so
      // a transaction that READ an account and one that DRAINED it hashed the
      // same. Those are the two cases a hash exists to tell apart.
      const setHash = instructionSetHash(instructions, lookupTables);

      const expireAtRaw = b.expireAt ?? null;
      const expireAtNum = expireAtRaw === null ? null : Number(expireAtRaw);

      const bh = b.blockhashWithMetadata ?? null;
      const blockhash =
        bh === null || bh.blockhash == null
          ? null
          : typeof bh.blockhash === 'string'
            ? bh.blockhash
            : base58FromBytes(bh.blockhash);

      const receivedUtcMs = res.provenance.receivedUtcMs;
      const buildable = b.swapInstruction != null && (b.errorCode ?? null) === null;
      return {
        buildable,
        failure: buildable ? null : 'NO_ROUTE',
        errorCode: b.errorCode ?? null,
        errorMessage: b.errorMessage ? sanitizeExternal(b.errorMessage, 120) : null,
        instructionCount: instructions.length,
        instructions,
        programIds,
        lookupTables,
        hasSetup: (b.setupInstructions ?? []).length > 0,
        hasCleanup: b.cleanupInstruction != null,
        endpoint: '/swap/v2/build',
        router: b.router ?? null,
        requestId: b.requestId ?? null,
        instructionSetHash: setHash,
        // The route's OWN economics, from this same response. Nothing here is
        // borrowed from an /order call against a different route universe.
        inAmount: BigInt(b.inAmount),
        outAmount: BigInt(b.outAmount),
        otherAmountThreshold: b.otherAmountThreshold === undefined ? null : BigInt(b.otherAmountThreshold),
        slippageBps: b.slippageBps ?? null,
        impact: parseImpact({ priceImpactPct: b.priceImpactPct }),
        routePlanHash: routePlanHash((b.routePlan ?? []).map((r) => ({
          ammKey: r.swapInfo.ammKey,
          label: r.swapInfo.label,
          percent: r.percent,
        }))),
        routeLabels: (b.routePlan ?? []).map((r) => r.swapInfo.label ?? r.swapInfo.ammKey.slice(0, 8)),
        blockhash,
        lastValidBlockHeight: b.lastValidBlockHeight ?? bh?.lastValidBlockHeight ?? null,
        expireAt: expireAtNum !== null && Number.isFinite(expireAtNum) ? expireAtNum : null,
        contextSlot: b.contextSlot ?? null,
        rawBody: res.rawBody,
        requestedUtcMs,
        receivedUtcMs,
        latencyMs: receivedUtcMs - requestedUtcMs,
      };
    } catch (e) {
      // A provider failure is not an untradeable token, and a no-route response
      // is not an outage. Collapsing every SourceFetchError to null made those
      // four cases indistinguishable in the stored record, so a 429 during a
      // rate-limit spike looked exactly like a token with no liquidity.
      if (e instanceof SourceFetchError) {
        return unbuilt(classifyFetchFailure(e), requestedUtcMs, sanitizeExternal(e.message, 160));
      }
      throw e;
    }
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
    priority?: RequestPriority;
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
      priority: params.priority ?? 'discovery',
    });
    return toExecutableQuote(res.data, requestedUtcMs, res.provenance, res.latencyMs, res.rawBody);
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
    priority?: RequestPriority;
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

/**
 * What a `/swap/v2/build` attempt established.
 *
 * Always returned -- never null. `buildable` false with a typed `failure` says
 * WHY, because "we could not get a route" and "the provider was down" are
 * different facts about different things and the caller must be able to tell
 * them apart.
 */
export interface BuildOutcome {
  readonly buildable: boolean;
  /** Null only when `buildable`. Never collapsed across causes. */
  readonly failure: ObservationFailure | null;
  readonly errorCode: number | null;
  readonly errorMessage: string | null;
  readonly instructionCount: number;
  /** The instructions themselves, in execution order, for the policy decoder. */
  readonly instructions: readonly RawInstruction[];
  readonly programIds: readonly string[];
  /** Resolved address lookup tables, for writable-account inspection. */
  readonly lookupTables: LookupTableMap;
  readonly hasSetup: boolean;
  readonly hasCleanup: boolean;
  /** Provenance, so a build is never conflated with the quote that priced it. */
  readonly endpoint: string;
  readonly router: string | null;
  readonly requestId: string | null;
  /**
   * Identity of the instruction set: program ids, data, ordered account metas
   * INCLUDING isSigner and isWritable, instruction order, and lookup-table
   * contents. Never called a transaction hash -- /build returns no bytes.
   */
  readonly instructionSetHash: string;

  /** This response's OWN economics. Never mixed with an /order quote. */
  readonly inAmount: bigint;
  readonly outAmount: bigint;
  readonly otherAmountThreshold: bigint | null;
  readonly slippageBps: number | null;
  readonly impact: ImpactReading;
  readonly routePlanHash: string;
  readonly routeLabels: readonly string[];

  readonly blockhash: string | null;
  readonly lastValidBlockHeight: number | null;
  readonly expireAt: number | null;
  readonly contextSlot: number | null;
  /** The exact response body, for `raw_payloads`. Empty when the call failed. */
  readonly rawBody: string;
  readonly requestedUtcMs: number;
  readonly receivedUtcMs: number;
  readonly latencyMs: number;
}

/** Map a transport failure onto the persisted taxonomy. */
export function classifyFetchFailure(e: SourceFetchError): ObservationFailure {
  switch (e.kind) {
    case 'rate_limited':
      return 'HTTP_429';
    case 'server_error':
      return 'HTTP_5XX';
    case 'not_found':
      return 'NO_ROUTE';
    case 'client_error':
      return /route|no.*liquidit/i.test(e.message) ? 'NO_ROUTE' : 'HTTP_4XX';
    case 'timeout':
      return 'TIMEOUT';
    case 'schema_drift':
      return 'SCHEMA_DRIFT';
    case 'not_json':
      return 'PARSER_ERROR';
    default:
      return 'UNKNOWN';
  }
}

/** A failed build, fully typed rather than a null. */
function unbuilt(failure: ObservationFailure, requestedUtcMs: number, detail: string): BuildOutcome {
  const now = Date.now();
  return {
    buildable: false,
    failure,
    errorCode: null,
    errorMessage: detail,
    instructionCount: 0,
    instructions: [],
    programIds: [],
    lookupTables: {},
    hasSetup: false,
    hasCleanup: false,
    endpoint: '/swap/v2/build',
    router: null,
    requestId: null,
    instructionSetHash: '',
    inAmount: 0n,
    outAmount: 0n,
    otherAmountThreshold: null,
    slippageBps: null,
    impact: parseImpact({}),
    routePlanHash: '',
    routeLabels: [],
    blockhash: null,
    lastValidBlockHeight: null,
    expireAt: null,
    contextSlot: null,
    rawBody: '',
    requestedUtcMs,
    receivedUtcMs: now,
    latencyMs: now - requestedUtcMs,
  };
}

/** Blockhash bytes to base58, for the shape /build sometimes returns. */
function base58FromBytes(bytes: readonly number[]): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b & 0xff);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function toExecutableQuote(
  o: OrderResponse,
  requestedUtcMs: number,
  provenance: ExecutableQuote['provenance'],
  latencyMs: number,
  rawBody: string | null = null,
): ExecutableQuote {
  // Impact goes through the audited parser. The previous inline expression
  // coerced an ABSENT field to 0, which is a claim of a perfect fill on a
  // market the provider declined to describe. See packages/domain/src/impact.ts
  // for the live trace of the sign convention.
  const reading = parseImpact(o);

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
    feeMint: o.feeMint ?? o.platformFee?.feeMint ?? null,
    platformFeeAmount: o.platformFee?.amount === undefined ? null : BigInt(o.platformFee.amount),
    // Signed, raw, unmodified. `impact` carries the status and the non-negative
    // adverse magnitude; consumers must read that rather than re-deriving a
    // sign from this number.
    priceImpactPct: reading.signedPct ?? 0,
    impact: reading,
    contextSlot: o.contextSlot ?? null,
    rawBody,
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
