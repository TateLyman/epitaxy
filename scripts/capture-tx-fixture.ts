import { writeFileSync, mkdirSync } from 'node:fs';
import { JUPITER_V6 } from '../packages/solana/src/txpolicy.js';

/**
 * Captures a real, already-confirmed Jupiter v6 swap transaction as a decoder
 * fixture.
 *
 * Historical transactions are used deliberately: they exercise the exact wire
 * format a router produces, including v0 address-table lookups, without this
 * repository ever requesting a signable payload for one of our own keys.
 */

const RPC = process.env['SOLANA_RPC_HTTP'] ?? 'https://api.mainnet-beta.solana.com';

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function main(): Promise<void> {
  const sigs = (await rpc('getSignaturesForAddress', [JUPITER_V6, { limit: 10 }])) as {
    signature: string;
    err: unknown;
  }[];
  const ok = sigs.filter((s) => s.err === null);
  if (ok.length === 0) throw new Error('no successful Jupiter transactions in the last 10 signatures');

  mkdirSync('tests/fixtures/transactions', { recursive: true });
  const captured: { signature: string; base64: string; version: unknown }[] = [];

  for (const s of ok.slice(0, 3)) {
    const tx = (await rpc('getTransaction', [
      s.signature,
      { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ])) as { transaction: [string, string]; version: unknown } | null;
    if (tx === null) continue;
    captured.push({ signature: s.signature, base64: tx.transaction[0], version: tx.version });
    console.log(`captured ${s.signature} (version ${String(tx.version)}, ${tx.transaction[0].length} b64 chars)`);
  }

  writeFileSync('tests/fixtures/transactions/jupiter-v6.json', JSON.stringify(captured, null, 2));
}

void main();
