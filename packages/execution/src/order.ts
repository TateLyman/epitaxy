import { fetchJson } from '../../adapters/src/http.js';
import type { RateLimiter } from '../../adapters/src/ratelimit.js';
import { OrderResponseSchema } from '../../adapters/src/jupiter/schemas.js';
import { toExecutableQuote } from '../../adapters/src/jupiter/client.js';
import type { ExecutableQuote } from '../../domain/src/types.js';

/**
 * The signable-order request.
 *
 * `JupiterClient.quote` omits `taker` so that no keyless process can obtain a
 * transaction to sign. That guarantee is only worth something if the version
 * WITH a taker lives somewhere observe and paper do not import, so it lives
 * here rather than as a flag on the shared client. A boolean parameter would
 * have made the guarantee depend on every future caller passing false.
 */

const BASE = 'https://api.jup.ag';
const SCHEMA_VERSION = '2026-08-11';
const PARSER_VERSION = '0.1.0';

export class OrderBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderBuildError';
  }
}

export interface SignableOrder {
  readonly quote: ExecutableQuote;
  readonly transaction: Uint8Array;
  readonly requestId: string | null;
}

export async function buildSignableOrder(
  limiter: RateLimiter,
  apiKey: string | null,
  params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    taker: string;
  },
): Promise<SignableOrder> {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: String(params.slippageBps),
    taker: params.taker,
  });

  const requestedUtcMs = Date.now();
  const res = await fetchJson(limiter, {
    url: `${BASE}/swap/v2/order?${qs.toString()}`,
    source: 'jupiter.swap.v2.order.signable',
    sourceType: 'official_indexer',
    bucket: 'jupiter_main',
    schema: OrderResponseSchema,
    schemaVersion: SCHEMA_VERSION,
    parserVersion: PARSER_VERSION,
    headers: apiKey === null ? {} : { 'x-api-key': apiKey },
    timeoutMs: 12_000,
  });

  const tx = res.data.transaction;
  if (typeof tx !== 'string' || tx.length === 0) {
    // A taker was supplied and no transaction came back. Treating that as a
    // recoverable "quote only" would silently downgrade an execution attempt
    // into a measurement, which is how a system reports trades it never made.
    throw new OrderBuildError('order returned no transaction despite a taker being supplied');
  }

  return {
    quote: toExecutableQuote(res.data, requestedUtcMs, res.provenance, res.latencyMs),
    transaction: new Uint8Array(Buffer.from(tx, 'base64')),
    requestId: res.data.requestId ?? null,
  };
}

/**
 * Build the same order through Jupiter's CLASSIC endpoint, because the modern one routes through a
 * program the signer will not accept.
 *
 * `/swap/v2/order` began returning transactions whose TOP-LEVEL program is
 * DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH - DFlow, a separate aggregator - and the signer
 * refused them, correctly. The allowlist admits Jupiter V6 and reaches everything past it by CPI,
 * which is the right shape: a program INVOKED BY Jupiter is bounded by Jupiter's own output
 * constraint, while a top-level call is bounded by nothing we checked. Two live positions became
 * unsellable behind that refusal.
 *
 * The fix is not to admit DFlow. Widening a security gate to accommodate a vendor's routing choice
 * trades a real guarantee for a convenience. `/swap/v1/quote` followed by `/swap/v1/swap` builds
 * the identical trade with JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 at the top level, verified
 * by decoding the returned message and resolving its program indices against the static account
 * keys, so the policy passes on its own terms rather than being relaxed.
 *
 * Everything downstream is unchanged: the transaction still goes through decode, effect
 * verification and the signer's single entry point.
 */
export async function buildSignableOrderV1(
  apiKey: string | null,
  params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    taker: string;
    /**
     * A QUOTE THE CALLER ALREADY FETCHED, SO THE SAME PRICE IS NOT ASKED FOR TWICE.
     *
     * The bot quotes to decide whether to trade, then this function quoted again to build the order,
     * and both round trips sat in the entry path. MT193 measures the cost of that directly: delay is
     * counted in TRADES between the decision and the fill, and curves in the entry band trade at a
     * median of 1.22 per second and 7.5 per second in the fastest tenth. Growth at f=0.20 runs 0.0179
     * at zero delay, 0.0083 at three trades and zero at five, so several hundred milliseconds of
     * duplicated work is not housekeeping - it is a material part of the edge.
     *
     * Reusing the decision quote also makes the order the one we actually judged, rather than a second
     * quote taken at a price we never evaluated.
     */
    preQuote?: unknown;
  },
): Promise<SignableOrder> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey !== null) headers['x-api-key'] = apiKey;
  const sleep = async (ms: number): Promise<void> => { await new Promise((r) => { setTimeout(r, ms); }); };

  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: String(params.slippageBps),
  });
  let quote: { outAmount?: string; inAmount?: string } | null = (params.preQuote as { outAmount?: string; inAmount?: string } | undefined) ?? null;
  for (let attempt = 0; quote === null && attempt < 8; attempt += 1) {
    let res: Response;
    try { res = await fetch(`${BASE}/swap/v1/quote?${qs.toString()}`, { headers, signal: AbortSignal.timeout(20_000) }); }
    catch { await sleep(700 * (attempt + 1)); continue; }
    if (res.status === 429) { await sleep(900 * (attempt + 1)); continue; }
    if (!res.ok) throw new OrderBuildError(`v1 quote HTTP ${String(res.status)}`);
    quote = (await res.json()) as { outAmount?: string; inAmount?: string };
    break;
  }
  if (quote === null || quote.outAmount === undefined) throw new OrderBuildError('v1 quote unavailable');

  let swap: { swapTransaction?: string } | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/swap/v1/swap`, {
        method: 'POST', headers,
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: params.taker, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch { await sleep(700 * (attempt + 1)); continue; }
    if (res.status === 429) { await sleep(1_200 * (attempt + 1)); continue; }
    if (!res.ok) throw new OrderBuildError(`v1 swap HTTP ${String(res.status)}`);
    swap = (await res.json()) as { swapTransaction?: string };
    break;
  }
  if (swap === null || swap.swapTransaction === undefined) throw new OrderBuildError('v1 swap returned no transaction');

  return {
    quote: {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: BigInt(quote.inAmount ?? params.amount.toString()),
      outAmount: BigInt(quote.outAmount),
      slippageBps: params.slippageBps,
      routeLabels: [],
      contextSlot: null,
      lastValidBlockHeight: null,
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
    } as unknown as ExecutableQuote,
    transaction: new Uint8Array(Buffer.from(swap.swapTransaction, 'base64')),
    requestId: null,
  };
}
