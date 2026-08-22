/**
 * What has this wallet ACTUALLY done on chain, according to the chain?
 *
 * The operator reports running a trade and the SOL balance is unchanged to the lamport. Those two
 * facts cannot both describe a signed transaction: a send that fails still burns the base fee, and
 * a send that lands moves rent and priority on top. So one of them is wrong, and the chain decides
 * which — not the script's own logs, and not what either of us expects to have happened.
 *
 * This exists because "never fabricate a fill" is an invariant of this repository. A trade is real
 * when a signature confirms it, and the only way to know that is to ask.
 *
 * Reads signatures and token balances. Signs nothing.
 */
import { loadSecrets } from '../packages/domain/src/config.js';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const OWNER = arg('address') ?? '2TNUsCxbW8a8mG2UHU5KL3k36fecR9qxoF6F2JEY1bqR';
const LIMIT = Number(arg('limit') ?? '15');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const secrets = await loadSecrets();
const url = secrets.rpcHttp ?? secrets.rpcHttpFallback ?? '';
if (url === '') { console.log('no RPC url configured'); process.exit(1); }

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error !== undefined) throw new Error(j.error.message ?? 'rpc error');
  return j.result;
}

const bal = (await rpc('getBalance', [OWNER])) as { value?: number };
console.log(`owner ${OWNER}`);
console.log(`SOL balance  ${((bal.value ?? 0) / 1e9).toFixed(9)} SOL  (${(bal.value ?? 0).toLocaleString()} lamports)`);
console.log('');

const sigs = (await rpc('getSignaturesForAddress', [OWNER, { limit: LIMIT }])) as {
  signature: string; slot: number; err: unknown; blockTime: number | null; confirmationStatus?: string;
}[];
console.log(`LAST ${sigs.length} SIGNATURES (newest first) — this is the record, not the logs`);
if (sigs.length === 0) console.log('  none. This wallet has never signed anything.');
for (const s of sigs) {
  const when = s.blockTime === null ? 'unknown time' : new Date(s.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`  ${when}  slot ${s.slot}  ${s.err === null ? 'ok     ' : 'FAILED '}  ${s.signature}`);
}

console.log('');
for (const prog of [TOKEN_PROGRAM, TOKEN_2022]) {
  const accs = (await rpc('getTokenAccountsByOwner', [OWNER, { programId: prog }, { encoding: 'jsonParsed' }])) as {
    value?: { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmountString: string; amount: string } } } } } }[];
  };
  const v = accs.value ?? [];
  const label = prog === TOKEN_PROGRAM ? 'legacy token program' : 'Token-2022';
  if (v.length === 0) { console.log(`${label}: no token accounts`); continue; }
  console.log(`${label}: ${v.length} token account(s) — each strands 2,039,280 lamports until closed`);
  for (const a of v) {
    const i = a.account.data.parsed.info;
    console.log(`  ${a.pubkey.slice(0, 12)}  mint ${i.mint.slice(0, 12)}  balance ${i.tokenAmount.uiAmountString} (raw ${i.tokenAmount.amount})`);
  }
}
