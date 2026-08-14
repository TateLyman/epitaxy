/**
 * Which RPC endpoints exist, and which of them still answer.
 *
 * Deliberately prints HOSTS and verdicts, never URLs: the configured endpoints
 * carry API keys in their query strings, and a diagnostic that leaks a
 * credential into a log is worse than the outage it was diagnosing.
 */
import { loadSecrets } from '../packages/domain/src/config.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { SolanaRpc } from '../packages/solana/src/rpc.js';

const s = loadSecrets();

const hostOf = (url: string | null): string => {
  if (url === null) return '(not configured)';
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
};

const endpoints: { name: string; url: string | null }[] = [
  { name: 'primary', url: s.rpcHttp },
  { name: 'fallback', url: s.rpcHttpFallback ?? null },
  // Keyless public mainnet. Heavily throttled and non-archival, but it needs
  // no credential, so it is worth knowing whether it is reachable at all.
  { name: 'public (keyless)', url: 'https://api.mainnet-beta.solana.com' },
];

console.log('endpoint            host                                  verdict');
for (const e of endpoints) {
  if (e.url === null) {
    console.log(`${e.name.padEnd(18)}  ${hostOf(null).padEnd(36)}  -`);
    continue;
  }
  const rpc = new SolanaRpc(RateLimiter.fromConfig(true), { primary: e.url, fallback: null });
  let verdict: string;
  try {
    const slot = await rpc.getSlot();
    verdict = `OK, slot ${slot}`;
  } catch (err) {
    const m = (err as Error).message;
    verdict = /max usage/i.test(m)
      ? 'CAPPED (plan quota exhausted)'
      : /429/.test(m)
        ? 'rate limited (per-second)'
        : /401|403|unauthor/i.test(m)
          ? 'rejected (credential)'
          : m.slice(0, 44);
  }
  console.log(`${e.name.padEnd(18)}  ${hostOf(e.url).padEnd(36)}  ${verdict}`);
}

console.log('\nwhat each capability needs:');
console.log('  getAccountInfo        any endpoint, including keyless public');
console.log('  getTokenLargestAccounts / getTokenSupply   most endpoints');
console.log('  getSignaturesForAddress + getTransaction    recent history; keyless public is unreliable');
console.log('  historical account state at a past slot     ARCHIVAL only — not available on any tier here');
