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
