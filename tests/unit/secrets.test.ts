import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { heliusRpcUrl, loadSecrets } from '../../packages/domain/src/config.js';
import { scrubSecrets } from '../../packages/observability/src/log.js';

/**
 * `HELIUS_API_KEY` was read by `loadSecrets` for months and used by nothing.
 * A secret that is loaded and never consumed is worse than one that is absent:
 * `pnpm doctor` reported it as present, so the operator had every reason to
 * believe on-chain reads were configured when no endpoint existed at all.
 *
 * Helius authenticates by query parameter, so consuming the key means putting
 * it in a URL. That is the provider's design, not a choice available to us, and
 * it is the reason these tests exist — the URL is the one place in this system
 * where a live credential is concatenated into a string that other code will
 * happily pass to a logger.
 */

const ENV_KEYS = ['HELIUS_API_KEY', 'SOLANA_RPC_HTTP', 'SOLANA_RPC_HTTP_FALLBACK'] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('the RPC endpoint derived from a Helius key', () => {
  it('is null when neither the endpoint nor the key is set', () => {
    const s = loadSecrets();
    expect(s.rpcHttp).toBeNull();
    expect(s.rpcHttpDerivedFromHeliusKey).toBe(false);
  });

  it('is derived when only the key is set', () => {
    process.env['HELIUS_API_KEY'] = 'k1';
    const s = loadSecrets();
    expect(s.rpcHttp).toBe(heliusRpcUrl('k1'));
    expect(s.rpcHttpDerivedFromHeliusKey).toBe(true);
  });

  it('does not override an explicitly configured endpoint', () => {
    // The operator's stated endpoint wins even though a key is available.
    // Preferring the key here would mean SOLANA_RPC_HTTP could be set to one
    // host and traffic could go to another, which is unauditable.
    process.env['HELIUS_API_KEY'] = 'k1';
    process.env['SOLANA_RPC_HTTP'] = 'https://rpc.invalid/';
    const s = loadSecrets();
    expect(s.rpcHttp).toBe('https://rpc.invalid/');
    expect(s.rpcHttpDerivedFromHeliusKey).toBe(false);
  });

  it('treats a whitespace-only key as absent rather than as a key', () => {
    // A trailing-space line in .env is the ordinary way this happens. Deriving
    // an endpoint whose api-key parameter is empty would produce 401s that look
    // like a provider outage.
    process.env['HELIUS_API_KEY'] = '   ';
    const s = loadSecrets();
    expect(s.rpcHttp).toBeNull();
    expect(s.rpcHttpDerivedFromHeliusKey).toBe(false);
  });

  it('percent-encodes the key rather than pasting it into the query string', () => {
    // Not hypothetical hygiene: an unencoded `&` would truncate the parameter
    // and send a partial key, and an unencoded `#` would send none of it.
    const url = heliusRpcUrl('a&b#c');
    expect(url).toContain('a%26b%23c');
    expect(url.split('?')[1]).toBe('api-key=a%26b%23c');
  });
});

describe('the derived URL cannot reach a log intact', () => {
  it('is scrubbed by the value-level redactor', () => {
    // scrubSecrets is the last line of defence, because a URL travels as a
    // plain string through error messages and fetch diagnostics where pino's
    // key-path redaction does not apply.
    const url = heliusRpcUrl('SECRETKEYMATERIAL0123456789');
    expect(scrubSecrets(url)).not.toContain('SECRETKEYMATERIAL0123456789');
    expect(scrubSecrets(url)).toContain('api-key=[REDACTED]');
  });

  it('is scrubbed when embedded in a longer error string', () => {
    // The realistic shape: a fetch failure that interpolates the endpoint.
    const line = `getTokenLargestAccounts failed against ${heliusRpcUrl('SECRETKEYMATERIAL0123456789')} after 3 attempts`;
    const scrubbed = scrubSecrets(line);
    expect(scrubbed).not.toContain('SECRETKEYMATERIAL0123456789');
    expect(scrubbed).toContain('after 3 attempts');
  });
});

/**
 * Confirmed to fail against a deliberately broken implementation.
 *
 * Dropping `encodeURIComponent` from `heliusRpcUrl` fails 1 of 7 tests.
 * Reversing the precedence in `loadSecrets` so the key beats an explicit
 * `SOLANA_RPC_HTTP` fails 1 of 7. Removing the `[?&]api-key=` branch from
 * `scrubSecrets` fails 2 of 7. config.ts and log.ts were restored after each.
 */
