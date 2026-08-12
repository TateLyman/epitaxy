import { loadSecrets } from '../packages/domain/src/config.js';

/**
 * What is in the compute-budget instruction `/swap/v2/build` returns?
 *
 * `scripts/verify-observation.ts` found both policies failing on
 * `compute_limit_missing` for a route that otherwise built cleanly. The
 * response carries exactly one `computeBudgetInstructions` entry, so either it
 * is a SetComputeUnitPrice with no accompanying limit, or the request is not
 * asking for one.
 *
 * That distinction matters. "The endpoint cannot be used" and "we are not
 * asking correctly" lead to opposite conclusions, and the policy requirement is
 * legitimate either way: without an explicit unit limit the transaction is
 * charged at the default ceiling, which makes any fee we modelled a fiction.
 *
 * Tag 2 = SetComputeUnitLimit(u32), tag 3 = SetComputeUnitPrice(u64).
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

interface Ix {
  programId: string;
  data?: string;
}

async function probe(label: string, extra: string): Promise<void> {
  const url =
    `https://api.jup.ag/swap/v2/build?inputMint=${WSOL}&outputMint=${USDC}` +
    `&amount=20000000&taker=${taker}&slippageBps=300${extra}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  console.log(`\n=== ${label}  HTTP ${res.status}`);
  if (!res.ok) {
    console.log(`  ${text.slice(0, 200)}`);
    return;
  }
  const json = JSON.parse(text) as { computeBudgetInstructions?: Ix[] };
  const ixs = json.computeBudgetInstructions ?? [];
  console.log(`  computeBudgetInstructions: ${ixs.length}`);
  for (const ix of ixs) {
    if (ix.data === undefined) {
      console.log('    (no data)');
      continue;
    }
    const d = Buffer.from(ix.data, 'base64');
    const tag = d[0];
    const name =
      tag === 0
        ? 'RequestUnitsDeprecated'
        : tag === 1
          ? 'RequestHeapFrame'
          : tag === 2
            ? 'SetComputeUnitLimit'
            : tag === 3
              ? 'SetComputeUnitPrice'
              : tag === 4
                ? 'SetLoadedAccountsDataSizeLimit'
                : `unknown(${String(tag)})`;
    let value = '';
    if (tag === 2 && d.length >= 5) value = ` = ${d.readUInt32LE(1)} units`;
    if (tag === 3 && d.length >= 9) value = ` = ${d.readBigUInt64LE(1)} microLamports/unit`;
    console.log(`    tag ${String(tag)} ${name}${value}   (${d.length} bytes)`);
  }
}

await probe('default request', '');
await probe('dynamicComputeUnitLimit=true', '&dynamicComputeUnitLimit=true');
await probe('computeUnitPriceMicroLamports=1000', '&computeUnitPriceMicroLamports=1000');
await probe('both', '&dynamicComputeUnitLimit=true&computeUnitPriceMicroLamports=1000');
