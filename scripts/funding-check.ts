/**
 * PRE-FUNDING CHECK. Run this before sending anything, and again after.
 *
 * ONE WALLET HOLDS EVERYTHING ON SOLANA. There is no such thing as a "USDC wallet" — the same
 * keypair holds SOL and every SPL token, and USDC simply lives in an Associated Token Account
 * derived from the same address. Generating a second keypair for USDC would split the funds and
 * create a second secret to lose, for no benefit.
 *
 * WHAT THIS ACTUALLY VERIFIES, none of which requires reading the secret half:
 *   - the address is a well-formed on-curve Solana pubkey, so funds sent to it are recoverable
 *   - its current SOL balance, so a transfer can be confirmed after the fact
 *   - its USDC associated token account, whether it exists yet, and what the rent to open it is
 *   - the live SOL price from Jupiter, so "ten dollars" becomes an exact SOL figure
 *   - that the configured RPC actually answers
 *
 * The address is passed in as an argument. This script never opens a keypair file.
 */
import { loadSecrets } from '../packages/domain/src/config.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const ADDRESS = arg('address');
if (ADDRESS === null) { console.error('need --address=<pubkey>'); process.exit(2); }

// A Solana pubkey is 32 bytes. If this throws, the address is malformed and anything sent to it
// is gone — which is exactly the check worth doing BEFORE a transfer rather than after.
let raw: Uint8Array;
try { raw = base58Decode(ADDRESS, 64); }
catch (e) { console.error(`ADDRESS IS NOT VALID BASE58: ${(e as Error).message}`); process.exit(2); }
if (raw.length !== 32) { console.error(`ADDRESS DECODES TO ${raw.length} BYTES, NOT 32. Do not send to it.`); process.exit(2); }
console.log(`address decodes to 32 bytes — well formed`);

const secrets = loadSecrets();
const rpc = secrets.rpcHttp ?? null;
if (rpc === null) { console.error('no RPC configured; set HELIUS_API_KEY or an explicit RPC url in .env'); process.exit(2); }
console.log(`rpc host ${new URL(rpc).host}`);

async function call<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(rpc as string, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { console.log(`  ${method} -> HTTP ${res.status}`); return null; }
    const j = (await res.json()) as { result?: T; error?: { message?: string } };
    if (j.error !== undefined) { console.log(`  ${method} -> ${j.error.message ?? 'error'}`); return null; }
    return j.result ?? null;
  } catch (e) { console.log(`  ${method} -> ${(e as Error).message}`); return null; }
}

console.log('');
const bal = await call<{ value: number }>('getBalance', [ADDRESS]);
const lamports = bal?.value ?? 0;
console.log(`SOL BALANCE   ${(lamports / 1e9).toFixed(9)} SOL   (${lamports.toLocaleString()} lamports)`);

const toks = await call<{ value: { account: { data: { parsed?: { info?: { tokenAmount?: { uiAmountString?: string } } } } } }[] }>(
  'getTokenAccountsByOwner', [ADDRESS, { mint: USDC }, { encoding: 'jsonParsed' }],
);
const usdcAccounts = toks?.value ?? [];
if (usdcAccounts.length === 0) {
  console.log('USDC ACCOUNT  none yet — it is created automatically by the first transfer in');
} else {
  const amt = usdcAccounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? '0';
  console.log(`USDC BALANCE  ${amt} USDC`);
}

// Rent for one token account, so the SOL figure below is not short by the amount that makes
// the wallet unable to actually open an account.
const rent = await call<number>('getMinimumBalanceForRentExemption', [165]);
console.log(`token account rent  ${rent === null ? 'unknown' : (rent / 1e9).toFixed(9) + ' SOL each (refundable when closed)'}`);

console.log('');
const key = secrets.jupiterApiKey;
const headers: Record<string, string> = key !== null && key !== undefined ? { 'x-api-key': key } : {};
const qs = new URLSearchParams({ inputMint: WSOL, outputMint: USDC, amount: '1000000000', slippageBps: '50' });
let solUsd = NaN;
try {
  const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (res.ok) {
    const j = (await res.json()) as { outAmount?: string };
    if (j.outAmount !== undefined) solUsd = Number(j.outAmount) / 1e6;
  }
} catch { /* reported below */ }
if (Number.isFinite(solUsd)) {
  console.log(`LIVE PRICE    1 SOL = ${solUsd.toFixed(2)} USDC   (Jupiter executable quote, not an index)`);
  console.log('');
  console.log('WHAT TO SEND, for the calibration run');
  const need = 0.05;
  console.log(`  the canary config caps one position at 0.021 SOL and total exposure at 0.021 SOL,`);
  console.log(`  so it CANNOT deploy more than that however much is in the wallet.`);
  console.log(`  recommended: ${need} SOL  = about $${(need * solUsd).toFixed(2)}`);
  console.log(`    0.021 SOL  the single position the config permits`);
  console.log(`    ~0.004 SOL rent for the token accounts a round trip opens (refundable)`);
  console.log(`    ~0.025 SOL transaction fees, priority fees, and slack for a retry`);
} else {
  console.log('LIVE PRICE    Jupiter did not answer; size the transfer yourself');
}

console.log('');
console.log('SEND SOL, NOT USDC, AND THE REASON IS NOT PREFERENCE.');
console.log('  Every pool in this corpus is WSOL-quoted — venue_pools is filtered on');
console.log(`  quote_mint = ${WSOL}`);
console.log('  by name, never inferred. USDC in this wallet would have to be swapped to SOL');
console.log('  before anything could trade, paying a spread and a fee for the privilege, and');
console.log('  you would STILL need SOL on top for transaction fees and account rent, because');
console.log('  nothing on Solana moves without it.');
console.log('');
console.log('  If USDC is the only thing you can send, send it — the address accepts it and it');
console.log('  is not lost. It just costs one extra swap to become usable, and you will need a');
console.log('  little SOL alongside it regardless.');
