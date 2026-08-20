/**
 * `pnpm provider:probe` — what the keys we already hold can actually do.
 *
 * MT101's polled source is built on exactly one RPC method,
 * `getSignaturesForAddress`, and `config/source-limits.json` carries a measured
 * note from 2026-08-17 saying that method behaves very differently by provider:
 * refused 15 of 20 at 2.4 req/s against Alchemy, served 20 of 20 with zero
 * refusals at 10.7 req/s against Helius. A rate bucket does not describe a
 * provider, and a sweep built on the wrong endpoint fails for a reason that
 * looks like the market went quiet.
 *
 * This repository has been wrong about a provider once already, expensively:
 * `max usage reached` was read as an exhausted quota, a Helius purchase was
 * recommended on the strength of it, and the real cause was a batch-size bound
 * of five accounts. The recommendation was retracted and the lesson recorded —
 * a provider's error TEXT is not a diagnosis. So this probes.
 *
 * Three capabilities, each with a CONTROL, because a probe with no control
 * cannot tell a missing capability from a broken key or a blocked network:
 *
 *   1. HTTPS reachability of every configured endpoint (`getHealth`).
 *   2. WebSocket upgrade, with a public endpoint as the control. `atlas-…` is
 *      Helius Enhanced / LaserStream, which is what `transactionSubscribe`
 *      needs and what would let one subscription watch H1's whole 21,123-wallet
 *      top decile instead of the 128 a poll can afford.
 *   3. `getSignaturesForAddress` at MT102's frozen sweep rate and at double it,
 *      against real corpus addresses so the index lookup is representative.
 *
 * No key is ever printed, logged, or written to the artifact. Endpoints appear
 * with the key redacted.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadDotEnvOnce } from '../packages/domain/src/dotenv.js';
import { FORBIDDEN_SUBSCRIPTION_ADDRESSES } from '../packages/intelligence/src/targeted-flow.js';
import { MT101, sweepBudget } from '../packages/intelligence/src/wallet-watchlist.js';

loadDotEnvOnce();

const heliusKey = process.env['HELIUS_API_KEY'] ?? '';
const primary = process.env['SOLANA_RPC_HTTP'] ?? '';
const heliusHttp = heliusKey.length > 0 ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : '';

const redact = (s: string): string => {
  let out = s.replace(/api-key=[^&\s"]*/g, 'api-key=<redacted>');
  if (heliusKey.length > 0) out = out.split(heliusKey).join('<redacted>');
  // QuickNode and similar carry the credential as a path segment.
  out = out.replace(/(pro\/)[a-f0-9]{16,}/gi, '$1<redacted>');
  return out;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- 1. HTTPS -------------------------------------------------------------

interface HttpResult {
  readonly endpoint: string;
  readonly status: number | null;
  readonly ms: number;
  readonly healthy: boolean;
  readonly error: string | null;
}

async function http(label: string, url: string): Promise<HttpResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: AbortSignal.timeout(12_000),
    });
    const j = (await res.json()) as { result?: string };
    return { endpoint: label, status: res.status, ms: Date.now() - t0, healthy: j.result === 'ok', error: null };
  } catch (e) {
    return {
      endpoint: label,
      status: null,
      ms: Date.now() - t0,
      healthy: false,
      error: redact(String((e as Error).message)),
    };
  }
}

// --- 2. WebSocket ---------------------------------------------------------

interface WsResult {
  readonly endpoint: string;
  readonly opened: boolean;
  readonly closeCode: number | null;
  readonly ms: number;
}

async function ws(label: string, url: string): Promise<WsResult> {
  return await new Promise<WsResult>((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const fin = (opened: boolean, closeCode: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ endpoint: label, opened, closeCode, ms: Date.now() - t0 });
    };
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      fin(false, null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        sock.close();
      } catch {
        /* noop */
      }
      fin(false, null);
    }, 12_000);
    sock.addEventListener('open', () => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* noop */
      }
      fin(true, null);
    });
    sock.addEventListener('close', (ev: CloseEvent) => {
      clearTimeout(timer);
      fin(false, ev.code);
    });
    sock.addEventListener('error', () => {
      /* the close event follows and carries the code */
    });
  });
}

// --- 3. getSignaturesForAddress ------------------------------------------

interface SigResult {
  readonly endpoint: string;
  readonly targetRps: number;
  readonly actualRps: number;
  readonly ok: number;
  readonly refused429: number;
  readonly other: number;
  readonly n: number;
  readonly statuses: Record<string, number>;
}

async function signatures(label: string, url: string, addrs: string[], spacingMs: number): Promise<SigResult> {
  let ok = 0;
  let refused = 0;
  let other = 0;
  const statuses: Record<string, number> = {};
  const t0 = Date.now();
  for (const a of addrs) {
    let status: number | null = null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [a, { limit: 10, commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      statuses[String(res.status)] = (statuses[String(res.status)] ?? 0) + 1;
      // Classify on the STATUS, before parsing. A 429 body is often not JSON,
      // and the first version of this probe let the parse throw and counted a
      // refusal as "other" — which understated the refusal rate, the direction
      // that would have flattered the endpoint.
      if (res.status === 429) {
        refused += 1;
      } else {
        const j = (await res.json()) as { result?: unknown };
        if (res.ok && Array.isArray(j.result)) ok += 1;
        else other += 1;
      }
    } catch {
      if (status === 429) refused += 1;
      else other += 1;
    }
    await sleep(spacingMs);
  }
  const secs = (Date.now() - t0) / 1000;
  return {
    endpoint: label,
    targetRps: 1000 / spacingMs,
    actualRps: addrs.length / secs,
    ok,
    refused429: refused,
    other,
    n: addrs.length,
    statuses,
  };
}

// --- run ------------------------------------------------------------------

const QUIET = ['SysvarC1ock11111111111111111111111111111111', 'SysvarRent111111111111111111111111111111111'];
for (const a of QUIET) {
  if (FORBIDDEN_SUBSCRIPTION_ADDRESSES.includes(a)) throw new Error(`${a} is a forbidden subscription target`);
}

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const addrs = db
  .prepare('SELECT DISTINCT pool FROM development_trajectories WHERE pool IS NOT NULL LIMIT 20')
  .all()
  .map((r) => (r as { pool: string }).pool);
db.close();

const httpResults = [
  await http('SOLANA_RPC_HTTP (primary)', primary),
  await http('helius mainnet', heliusHttp),
  await http('public solana (control)', 'https://api.mainnet-beta.solana.com'),
];

const wsResults = [
  await ws('helius atlas (Enhanced/LaserStream)', `wss://atlas-mainnet.helius-rpc.com/?api-key=${heliusKey}`),
  await ws('helius mainnet', `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`),
  await ws('public solana (control)', 'wss://api.mainnet-beta.solana.com'),
];

// MT102 freezes 128 wallets on a 90s sweep = 1.42 req/s. Probe at the frozen
// rate and at double it, so the answer is about the rate that will be used.
const frozenSpacing = Math.round(1000 / (MT101.watchlistSize / (MT101.sweepIntervalMs / 1000)));
const sigResults: SigResult[] = [];
for (const [label, url] of [
  ['SOLANA_RPC_HTTP (primary)', primary],
  ['helius mainnet', heliusHttp],
] as const) {
  if (url.length === 0) continue;
  sigResults.push(await signatures(label, url, addrs, frozenSpacing));
  sigResults.push(await signatures(label, url, addrs, Math.round(frozenSpacing / 2)));
}

const streamAvailable = wsResults.some((r) => r.endpoint.includes('atlas') && r.opened);
const wsControlOk = wsResults.some((r) => r.endpoint.includes('control') && r.opened);
const best = [...sigResults].sort((a, b) => b.ok / b.n - a.ok / a.n)[0] ?? null;

const artifact = {
  probedUtc: new Date().toISOString(),
  ledgerRow: MT101.ledgerRow,
  frozenSweep: { wallets: MT101.watchlistSize, intervalMs: MT101.sweepIntervalMs, budget: sweepBudget() },
  http: httpResults,
  websocket: wsResults,
  getSignaturesForAddress: sigResults,
  verdict: {
    streamAvailable,
    wsControlOk,
    // A capability claim is only meaningful when its control passed.
    streamVerdictMeaningful: wsControlOk,
    bestSignaturesEndpoint: best === null ? null : best.endpoint,
  },
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/provider-capability.json', `${JSON.stringify(artifact, null, 2)}\n`);

console.log('HTTPS (the key is never printed):');
for (const r of httpResults) {
  console.log(`  ${r.endpoint.padEnd(28)} ${r.healthy ? 'ok  ' : 'FAIL'} status=${r.status ?? '-'} ${r.ms}ms`);
}
console.log('\nWebSocket upgrade:');
for (const r of wsResults) {
  console.log(`  ${r.endpoint.padEnd(38)} ${r.opened ? 'OPENED' : `refused (close ${r.closeCode ?? '-'})`} ${r.ms}ms`);
}
console.log('\ngetSignaturesForAddress:');
for (const r of sigResults) {
  console.log(
    `  ${r.endpoint.padEnd(28)} target ${r.targetRps.toFixed(2)} req/s -> ok ${r.ok}/${r.n} ` +
      `429 ${r.refused429} other ${r.other}  actual ${r.actualRps.toFixed(2)} req/s  ${JSON.stringify(r.statuses)}`,
  );
}

console.log('\n---');
if (!wsControlOk) {
  console.log('WEBSOCKET CONTROL FAILED. Nothing here is a statement about transactionSubscribe.');
} else if (streamAvailable) {
  console.log('Enhanced WebSockets ARE available on the key we hold. The stream path is open,');
  console.log('and it is a different arm from MT101 that needs its own ledger row.');
} else {
  console.log('Enhanced WebSockets are NOT available and the control passed, so this is a plan');
  console.log('capability rather than a broken key or a blocked network. MT101 stays polled.');
}
if (best !== null) {
  console.log(`getSignaturesForAddress is best served by: ${best.endpoint} (${best.ok}/${best.n} at the frozen rate).`);
}
console.log('\nartifacts/provider-capability.json');
