import { RateLimiter } from '../../adapters/src/ratelimit.js';
import { SolanaRpc } from './rpc.js';

/**
 * One place that decides which RPC a research script talks to.
 *
 * Three scripts grew an `RPC_ENDPOINT` override and three did not, and the ones
 * that did not silently kept using the configured provider. That produced a
 * "max usage reached" from an endpoint nobody had chosen, on a run that was
 * explicitly pointed somewhere else — a failure that looks like the override
 * not working rather than like the override not being read.
 *
 * The override is EXPLICIT and it is reported. It is never a silent fallback:
 * a research row whose source is ambiguous is a row that cannot be compared
 * with the ones around it.
 */
export interface ResearchRpc {
  readonly rpc: SolanaRpc;
  /** Host only. The configured endpoints carry API keys in their query strings. */
  readonly host: string;
  readonly overridden: boolean;
}

export function researchRpc(configured: { rpcHttp: string | null; rpcHttpFallback?: string | null }): ResearchRpc {
  const override = process.env['RPC_ENDPOINT'] ?? null;
  const endpoint = override ?? configured.rpcHttp;
  if (endpoint === null) {
    throw new Error('no RPC endpoint: set RPC_ENDPOINT or configure one');
  }
  let host = 'unknown';
  try {
    host = new URL(endpoint).host;
  } catch {
    /* an unparseable endpoint still gets used; the host is only for reporting */
  }
  return {
    // The unkeyed limiter when overriding, because an override is usually a
    // public or borrowed endpoint and hammering one earns a ban, not data.
    rpc: new SolanaRpc(RateLimiter.fromConfig(override === null), {
      primary: endpoint,
      fallback: override === null ? (configured.rpcHttpFallback ?? null) : null,
    }),
    host,
    overridden: override !== null,
  };
}
