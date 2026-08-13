import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { decodeTransaction, readComputeBudget, priorityFeeLamports } from '../packages/solana/src/transaction.js';

/**
 * Captures the CONFIRMED outcome of already-executed mainnet transactions, so
 * the simulator can be checked against reality rather than against itself.
 *
 * §15 — a simulator that agrees with nothing external is a very expensive way
 * to restate your own assumptions. SIMULATED_OK is only worth anything if the
 * thing producing it reproduces outcomes we can independently verify, and the
 * only outcomes we can independently verify are ones the chain already settled.
 *
 * What this can and cannot establish is worth being exact about:
 *
 *   - FEE parity is establishable offline and exactly. A transaction's fee is
 *     5,000 lamports per signature plus ceil(unit_price * unit_limit / 1e6),
 *     and every input to that is in the transaction's own bytes. It does not
 *     depend on pool state, so a historical transaction prices identically
 *     today. This is the function the engine uses to cost every leg.
 *
 *   - COMPUTE parity and BALANCE parity are NOT establishable here. Replaying
 *     the transaction requires the accounts as they stood at its slot, and that
 *     needs an archival node this project does not have. Running it against
 *     today's pools would be a different experiment wearing the same signature.
 *
 * So this corpus proves the cost model and does not prove the simulator's
 * execution. Both facts are recorded; neither is rounded up.
 *
 * Reads only. It never requests a signable payload and never sends anything.
 */

const RPC = process.env['SOLANA_RPC_HTTP'] ?? 'https://api.mainnet-beta.solana.com';
const IN = 'tests/fixtures/transactions/jupiter-v6.json';
const OUT_DIR = 'tests/fixtures/parity';
const OUT = `${OUT_DIR}/mainnet-confirmed.json`;

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result ?? null;
}

interface Fixture {
  readonly signature: string;
  readonly base64: string;
  readonly version: string;
}

const fixtures = JSON.parse(readFileSync(IN, 'utf8')) as Fixture[];
const rows: unknown[] = [];

for (const f of fixtures) {
  const r = (await rpc('getTransaction', [f.signature, { encoding: 'base64', maxSupportedTransactionVersion: 0 }])) as
    | Record<string, unknown>
    | null;
  if (r === null) {
    console.log(`${f.signature.slice(0, 12)} unavailable from ${RPC} — skipped, not invented`);
    continue;
  }
  const meta = r['meta'] as Record<string, unknown>;
  const tx = decodeTransaction(Buffer.from(f.base64, 'base64'));
  const cb = readComputeBudget(tx);

  const observedFee = BigInt(String(meta['fee']));
  const base = 5_000n * BigInt(tx.numRequiredSignatures);
  const priority = priorityFeeLamports(cb);

  rows.push({
    signature: f.signature,
    slot: r['slot'],
    version: f.version,
    numRequiredSignatures: tx.numRequiredSignatures,
    unitLimit: cb.unitLimit,
    unitPriceMicroLamports: cb.unitPriceMicroLamports === null ? null : cb.unitPriceMicroLamports.toString(),
    // What the chain actually charged. The ground truth.
    observedFeeLamports: observedFee.toString(),
    observedComputeUnits: meta['computeUnitsConsumed'] ?? null,
    observedErr: meta['err'] ?? null,
    // What this repository's cost model says it should have charged.
    modelBaseFeeLamports: base.toString(),
    modelPriorityFeeLamports: priority.toString(),
    modelTotalFeeLamports: (base + priority).toString(),
    agrees: base + priority === observedFee,
  });
  console.log(
    `${f.signature.slice(0, 12)} slot=${String(r['slot'])} observed=${observedFee} ` +
      `model=${base + priority} (base ${base} + priority ${priority}) ` +
      `${base + priority === observedFee ? 'AGREES' : 'DISAGREES'}  cu=${String(meta['computeUnitsConsumed'])}`,
  );
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`\nwrote ${rows.length} row(s) to ${OUT}`);
