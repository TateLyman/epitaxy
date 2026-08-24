/**
 * Where do the seconds of entry latency actually go?
 *
 * MT193 measured what delay costs: growth at f=0.20 runs 0.0179 at zero trades of delay, 0.0083 at
 * three and 0.0000 at five, while curves in the entry band trade a median 1.22 times a second and
 * 7.50 at the ninetieth percentile. A measured 1.6 second entry is therefore about two trades of
 * delay on a typical curve and twelve on a fast one - the difference between most of the edge and
 * none of it.
 *
 * That makes the breakdown of those seconds the most valuable number available, and it has never
 * been measured. Guessing which call dominates would be guessing at the one thing worth optimising,
 * so this times every step of the real entry path against live endpoints. It signs nothing and
 * sends nothing.
 */
import { loadSecrets } from '../packages/domain/src/config.js';
import { findProgramAddress } from '../packages/solana/src/pda.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const OWNER = '2TNUsCxbW8a8mG2UHU5KL3k36fecR9qxoF6F2JEY1bqR';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const MINT = arg('mint') ?? 'A7ednE7HBhYr6ZwV3uxAAXpcNsgN1C7J2BHx9FHBpump';
const AMOUNT = arg('amount') ?? '50000000';
const READ = arg('read') ?? 'https://rpc.solanatracker.io/public';

const secrets = await loadSecrets();
const JH: Record<string, string> = secrets.jupiterApiKey !== null ? { 'x-api-key': secrets.jupiterApiKey } : {};

interface Row { label: string; ms: number; ok: boolean; note: string }
const rows: Row[] = [];
async function time(label: string, note: string, fn: () => Promise<void>): Promise<void> {
  const t = Date.now();
  try { await fn(); rows.push({ label, ms: Date.now() - t, ok: true, note }); }
  catch { rows.push({ label, ms: Date.now() - t, ok: false, note }); }
}
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(READ, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`http ${String(r.status)}`);
  return await r.json();
}

const curve = findProgramAddress([new TextEncoder().encode('bonding-curve'), base58Decode(MINT, 64)], PUMP);

await time('getTokenLargestAccounts', 'concentration filter', async () => { await rpc('getTokenLargestAccounts', [MINT]); });
await time('getTokenAccountsByOwner', 'finds the curve vault to exclude', async () => {
  await rpc('getTokenAccountsByOwner', [curve?.address, { mint: MINT }, { encoding: 'jsonParsed' }]);
});

let quote: unknown = null;
await time('jupiter /swap/v1/quote', 'the price we judge on', async () => {
  const qs = new URLSearchParams({ inputMint: WSOL, outputMint: MINT, amount: AMOUNT, slippageBps: '300' });
  const r = await fetch(`https://api.jup.ag/swap/v1/quote?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error('http');
  quote = await r.json();
});
await time('jupiter /swap/v1/swap', 'builds the transaction we sign', async () => {
  if (quote === null) throw new Error('no quote');
  const r = await fetch('https://api.jup.ag/swap/v1/swap', {
    method: 'POST', headers: { 'content-type': 'application/json', ...JH },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: OWNER, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error('http');
  await r.json();
});

/** What an offline path would still owe: the curve's own reserves, and a blockhash. */
await time('getAccountInfo (curve)', 'offline path would still need this', async () => { await rpc('getAccountInfo', [curve?.address, { encoding: 'base64' }]); });
await time('getLatestBlockhash', 'offline path would still need this', async () => { await rpc('getLatestBlockhash', []); });

console.log('ENTRY PATH TIMING');
console.log(`  mint ${MINT}   reads via ${new URL(READ).host}`);
console.log('');
let total = 0;
for (const r of rows) {
  console.log(`  ${r.label.padEnd(26)} ${String(r.ms).padStart(6)} ms   ${r.ok ? '' : 'FAILED  '}${r.note}`);
  total += r.ms;
}
console.log(`  ${'TOTAL'.padEnd(26)} ${String(total).padStart(6)} ms`);
console.log('');
const sum = (p: string): number => rows.filter((r) => r.label.startsWith(p)).reduce((a, b) => a + b.ms, 0);
const jup = sum('jupiter');
const vault = rows.find((r) => r.label === 'getTokenAccountsByOwner')?.ms ?? 0;
console.log(`  removable by building the curve instruction ourselves: ${jup} ms of Jupiter round trips`);
console.log(`  removable by deriving the vault address locally:       ${vault} ms`);
console.log('');
console.log('  At a median 1.22 curve trades per second, every 820 ms is one trade of delay, and');
console.log('  MT193 prices three trades of delay at roughly half the edge.');
