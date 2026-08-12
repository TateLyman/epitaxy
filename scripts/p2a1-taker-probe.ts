import { loadSecrets } from '../packages/domain/src/config.js';
import { base58Decode } from '../packages/solana/src/base58.js';

/**
 * P2a.1 §P0.2 — does supplying a `taker` actually yield a buildable transaction?
 *
 * Establish this against the live endpoint BEFORE wiring it into the engine.
 * If the answer is no, the buildability gate cannot be satisfied in paper mode
 * at all and that is a different, larger finding.
 *
 * Nothing here is signed. Paper mode has no signer and no key exists; a
 * returned transaction is inspected for structure and discarded.
 */

const BASE = 'https://api.jup.ag';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TAKER = process.argv[2] ?? '';

let raw: Uint8Array | null = null;
try {
  raw = base58Decode(TAKER);
} catch (e) {
  console.error(`base58 decode failed: ${(e as Error).message}`);
}
console.log(`taker            ${TAKER}`);
console.log(`  base58 decodes ${raw === null ? 'NO' : 'yes'}`);
console.log(`  byte length    ${raw === null ? 'n/a' : raw.length} ${raw?.length === 32 ? '(valid ed25519 pubkey length)' : '(EXPECTED 32)'}`);
if (raw === null || raw.length !== 32) {
  console.error('\nnot a usable taker address — refusing to probe');
  process.exit(1);
}

const key = loadSecrets().jupiterApiKey;
const headers: Record<string, string> = { accept: 'application/json' };
if (key !== null) headers['x-api-key'] = key;

async function probe(label: string, amount: string, withTaker: boolean): Promise<void> {
  const qs = new URLSearchParams({ inputMint: SOL, outputMint: USDC, amount });
  if (withTaker) qs.set('taker', TAKER);
  const res = await fetch(`${BASE}/swap/v2/order?${qs.toString()}`, { headers });
  const text = await res.text();
  console.log(`\n=== ${label}`);
  console.log(`http ${res.status}`);
  if (!res.ok) {
    console.log(`  body: ${text.slice(0, 200)}`);
    return;
  }
  const j = JSON.parse(text) as Record<string, unknown>;
  const tx = j['transaction'];
  const buildable = typeof tx === 'string' && tx.length > 0;
  console.log(`  taker sent            ${withTaker ? TAKER : '(omitted)'}`);
  console.log(`  taker echoed          ${JSON.stringify(j['taker'])}`);
  console.log(`  transaction           ${tx === null ? 'null' : typeof tx === 'string' ? `${tx.length} base64 chars` : typeof tx}`);
  console.log(`  transactionBuildable  ${buildable}`);
  console.log(`  requestId             ${JSON.stringify(j['requestId'])}`);
  console.log(`  lastValidBlockHeight  ${JSON.stringify(j['lastValidBlockHeight'])}`);
  console.log(`  expireAt              ${JSON.stringify(j['expireAt'])}`);
  console.log(`  errorCode / message   ${JSON.stringify(j['errorCode'])} / ${JSON.stringify(j['errorMessage'])}`);
  if (buildable) {
    const bytes = Buffer.from(tx as string, 'base64');
    console.log(`  decoded              ${bytes.length} bytes; first byte 0x${bytes[0]?.toString(16)} (0x80+ = versioned)`);
  }
}

console.log(`\njupiter key active: ${key !== null ? 'yes' : 'NO'}`);
await probe('WITHOUT taker (what every stored row was)', '20000000', false);
await new Promise((r) => setTimeout(r, 2500));
await probe('WITH taker (what the gate needs)', '20000000', true);
