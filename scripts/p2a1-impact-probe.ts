import { loadSecrets } from '../packages/domain/src/config.js';

/**
 * P2a.1 §P1.1 — trace the impact field back to the raw Jupiter JSON.
 *
 * No raw payload was ever persisted, so the historical rows cannot be traced
 * from storage. What CAN be established is what the endpoint actually returns
 * today, for the exact request the engine makes, at a realistic size.
 *
 * Quote-only: no `taker`, so no transaction can be returned and nothing here is
 * signable. Two probes, one small and one deliberately oversized, because the
 * sign and scale question only shows itself when impact is large.
 */

const BASE = 'https://api.jup.ag';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const key = loadSecrets().jupiterApiKey;
const headers: Record<string, string> = { accept: 'application/json' };
if (key !== null) headers['x-api-key'] = key;

async function probe(label: string, inputMint: string, outputMint: string, amount: string): Promise<void> {
  const url = `${BASE}/swap/v2/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  console.log(`\n=== ${label}`);
  console.log(`GET /swap/v2/order  amount=${amount}  http ${res.status}`);
  if (!res.ok) {
    console.log(text.slice(0, 300));
    return;
  }
  const j = JSON.parse(text) as Record<string, unknown>;

  // Only the fields this audit is about. The full body is not printed because
  // it is large and contains no additional impact information.
  const keys = Object.keys(j);
  console.log(`  top-level keys present: ${keys.join(', ')}`);
  console.log(`  priceImpact      = ${JSON.stringify(j['priceImpact'])}   (type ${typeof j['priceImpact']})`);
  console.log(`  priceImpactPct   = ${JSON.stringify(j['priceImpactPct'])}   (type ${typeof j['priceImpactPct']})`);
  console.log(`  inAmount         = ${JSON.stringify(j['inAmount'])}`);
  console.log(`  outAmount        = ${JSON.stringify(j['outAmount'])}`);
  console.log(`  feeBps           = ${JSON.stringify(j['feeBps'])}`);
  console.log(`  platformFee      = ${JSON.stringify(j['platformFee'])}`);
  console.log(`  transaction      = ${j['transaction'] === null ? 'null' : typeof j['transaction']}`);
  console.log(`  taker            = ${JSON.stringify(j['taker'])}`);
  console.log(`  router           = ${JSON.stringify(j['router'])}`);
  console.log(`  swapType         = ${JSON.stringify(j['swapType'])}`);

  // What the current parser would store, both branches spelled out.
  const pi = j['priceImpact'];
  const pip = j['priceImpactPct'];
  const stored =
    typeof pi === 'number' ? pi / 100 : pip !== undefined ? Number(pip) : 0;
  console.log(`\n  branch taken     = ${typeof pi === 'number' ? 'priceImpact / 100' : pip !== undefined ? 'Number(priceImpactPct)' : 'fallback 0'}`);
  console.log(`  value stored     = ${stored}`);
  console.log(`  as bps           = ${Math.round(stored * 10_000)}`);
}

console.log(`jupiter api key active: ${key !== null ? 'yes' : 'NO (keyless)'}`);
console.log(`base: ${BASE}`);

await probe('1 SOL -> USDC (small, deep liquidity)', SOL, USDC, '1000000000');
await new Promise((r) => setTimeout(r, 2500));
await probe('50000 SOL -> USDC (oversized, forces large impact)', SOL, USDC, '50000000000000');
