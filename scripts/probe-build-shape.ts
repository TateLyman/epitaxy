import { loadSecrets } from '../packages/domain/src/config.js';

/**
 * What does `/swap/v2/build` actually return?
 *
 * §P2.3 makes BUILD_CUSTOM the primary paper route, which requires that the
 * build response carry its own economics — `outAmount`, `otherAmountThreshold`,
 * a route plan, fee fields — rather than borrowing them from an `/order` call
 * against a different route universe. Whether it does is a question about the
 * endpoint, and this project does not answer those by reading documentation.
 *
 * Prints the top-level key set and the economic fields, never a credential.
 */

const secrets = loadSecrets();
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const taker = secrets.paperTakerPubkey;

if (taker === null) {
  console.error('PAPER_TAKER_PUBKEY unset');
  process.exit(1);
}

const headers: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};

async function probe(label: string, url: string): Promise<void> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  console.log(`\n=== ${label}  HTTP ${res.status}`);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    console.log(`  non-JSON: ${text.slice(0, 200)}`);
    return;
  }
  console.log(`  keys: ${Object.keys(json).sort().join(', ')}`);
  for (const k of [
    'inAmount',
    'outAmount',
    'otherAmountThreshold',
    'swapMode',
    'slippageBps',
    'priceImpact',
    'priceImpactPct',
    'feeBps',
    'feeMint',
    'platformFee',
    'signatureFeeLamports',
    'prioritizationFeeLamports',
    'rentFeeLamports',
    'router',
    'requestId',
    'contextSlot',
    'expireAt',
    'lastValidBlockHeight',
    'errorCode',
    'errorMessage',
  ]) {
    if (k in json) console.log(`  ${k.padEnd(28)} ${JSON.stringify(json[k])}`);
  }
  if ('routePlan' in json && Array.isArray(json['routePlan'])) {
    console.log(`  routePlan                    ${(json['routePlan'] as unknown[]).length} step(s)`);
    const first = (json['routePlan'] as Record<string, unknown>[])[0];
    if (first) console.log(`    step0 keys: ${Object.keys(first).sort().join(', ')}`);
  }
  if ('blockhashWithMetadata' in json) {
    const b = json['blockhashWithMetadata'] as Record<string, unknown> | null;
    console.log(`  blockhashWithMetadata keys   ${b === null ? 'null' : Object.keys(b).sort().join(', ')}`);
  }
  if ('addressesByLookupTableAddress' in json) {
    const a = json['addressesByLookupTableAddress'] as Record<string, unknown> | null;
    console.log(`  lookupTables                 ${a === null ? 'null' : Object.keys(a).length} table(s)`);
  }
  const ixKeys = ['computeBudgetInstructions', 'setupInstructions', 'swapInstruction', 'cleanupInstruction', 'otherInstructions', 'tipInstruction'];
  for (const k of ixKeys) {
    if (!(k in json)) continue;
    const v = json[k];
    const n = Array.isArray(v) ? v.length : v === null ? 0 : 1;
    console.log(`  ${k.padEnd(28)} ${n}`);
  }
}

const amount = 20_000_000; // 0.02 SOL, the canary cap
await probe('build  0.02 SOL -> USDC', `https://api.jup.ag/swap/v2/build?inputMint=${WSOL}&outputMint=${USDC}&amount=${amount}&taker=${taker}&slippageBps=300`);
await probe('order  0.02 SOL -> USDC (quote-only)', `https://api.jup.ag/swap/v2/order?inputMint=${WSOL}&outputMint=${USDC}&amount=${amount}&slippageBps=300`);
