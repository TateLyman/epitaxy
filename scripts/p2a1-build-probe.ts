import { loadSecrets } from '../packages/domain/src/config.js';

/**
 * P2a.1 §P0.2 — is there a build path that does NOT require the taker to hold
 * the funds?
 *
 * `/swap/v2/order` with a taker returns errorCode 1 "Insufficient funds" and an
 * empty transaction when the wallet is unfunded, so it cannot validate a
 * hypothetical paper position. The directive's alternative is a raw-instruction
 * endpoint whose output can be inspected by the transaction-policy decoder and
 * simulated against a local SVM fixture with a synthetic balance.
 *
 * This probes the candidate endpoints to find which, if any, exist and build
 * without funding. Nothing is signed or sent.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TAKER = process.argv[2] ?? '';
const AMOUNT = '20000000';

const key = loadSecrets().jupiterApiKey;
const headers: Record<string, string> = { accept: 'application/json' };
if (key !== null) headers['x-api-key'] = key;

const CANDIDATES = [
  `https://api.jup.ag/swap/v2/build?inputMint=${SOL}&outputMint=${USDC}&amount=${AMOUNT}&taker=${TAKER}`,
  `https://api.jup.ag/swap/v1/swap-instructions`,
  `https://api.jup.ag/swap/v2/instructions?inputMint=${SOL}&outputMint=${USDC}&amount=${AMOUNT}&taker=${TAKER}`,
];

for (const url of CANDIDATES) {
  const path = new URL(url).pathname;
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    console.log(`\n=== GET ${path}`);
    console.log(`  http ${res.status}`);
    if (res.ok) {
      const j = JSON.parse(text) as Record<string, unknown>;
      console.log(`  keys: ${Object.keys(j).slice(0, 25).join(', ')}`);
      const tx = j['transaction'];
      console.log(`  transaction: ${typeof tx === 'string' ? `${tx.length} chars` : String(tx)}`);
      console.log(`  errorCode/message: ${JSON.stringify(j['errorCode'])} / ${JSON.stringify(j['errorMessage'])}`);
    } else {
      console.log(`  body: ${text.slice(0, 160)}`);
    }
  } catch (e) {
    console.log(`\n=== GET ${path}\n  threw: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 2200));
}

// Does the wallet hold anything at all? Answers whether "insufficient funds"
// is about SOL specifically or about the account not existing.
const rpc = loadSecrets().rpcHttp;
if (rpc !== null && TAKER.length > 0) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [TAKER] }),
  });
  const j = (await res.json()) as { result?: { value?: number }; error?: unknown };
  console.log(`\n=== taker on-chain balance`);
  console.log(`  lamports: ${JSON.stringify(j.result?.value ?? j.error)}`);
  if (typeof j.result?.value === 'number') {
    console.log(`  SOL:      ${(j.result.value / 1e9).toFixed(9)}`);
  }
}
