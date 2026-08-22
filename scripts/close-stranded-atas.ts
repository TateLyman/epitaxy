/**
 * Recover the rent stranded in emptied token accounts.
 *
 * An associated token account holds 2,039,280 lamports of rent. On a 0.02 SOL position that is
 * 1,020 basis points — fourteen times the entire measured AMM fee of 71 bps (MT132). It is fully
 * refundable when the account is closed, so it is only a cost if the account is abandoned, and
 * until now nothing in this executor closed one.
 *
 * That single omission is what `doctor --mode=canary` reports as `config.viableCapital`: 97% of
 * the 20,912,800 lamport fee-viability floor is stranded rent, and the floor sits above the
 * largest position the sizing rule allows, so no trade could ever open.
 *
 * SAFETY, IN THE ORDER IT IS ENFORCED:
 *   - accounts come from `getTokenAccountsByOwner`, never from a derivation of ours
 *   - only accounts with a ZERO token balance are considered; a close cannot discard a position
 *   - the transaction is built by `encodeCloseAccountTransaction`, which can express nothing but
 *     a compute-unit limit and one `CloseAccount` whose rent destination is always the owner
 *   - it goes through the signer's ONE entry point, so policy and binding run unchanged
 *   - the effect is established by SIMULATING it and checking the account really empties and our
 *     lamports really rise; an unverified effect is a refusal, not a warning
 *
 * `--dry-run` is the default. Nothing is signed or sent without `--apply`.
 */
import { loadConfig, loadSecrets, modeFromArgv } from '../packages/domain/src/config.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { ExecutionRpc } from '../packages/execution/src/rpc.js';
import { Signer } from '../packages/execution/src/signer.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import {
  encodeCloseAccountTransaction,
  closeAccountIntent,
  verifyCloseEffect,
} from '../packages/execution/src/close-account.js';

const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const APPLY = process.argv.includes('--apply');

const config = loadConfig(modeFromArgv(process.argv));
const secrets = loadSecrets();
if (secrets.tradingKeypairPath === null) { console.error('TRADING_KEYPAIR_PATH is not set'); process.exit(2); }
if (secrets.rpcHttp === null) { console.error('no RPC configured'); process.exit(2); }

const signer = Signer.fromFile(secrets.tradingKeypairPath);
const owner = signer.publicKey;
const limiter = new RateLimiter([{ bucket: 'solana_rpc', requestsPerSecond: 8, burst: 8 }]);
const rpc = new ExecutionRpc(limiter, { primary: secrets.rpcHttp, fallback: secrets.rpcHttpFallback ?? null });

console.log(`owner ${owner}`);
console.log(`mode  ${APPLY ? 'APPLY — will sign and send' : 'DRY RUN — nothing will be signed'}`);
console.log('');

interface Found { address: string; mint: string; program: string; amount: bigint }

/**
 * Listing our own accounts is a plain read, so it goes straight to the endpoint rather than
 * through `ExecutionRpc`. That class is the SIGNING path's view of the chain — blockhash,
 * simulate, send — and widening it with a general call method to save one fetch here would put a
 * generic escape hatch on exactly the object whose narrowness is the safety property.
 */
async function listOwned(programId: string): Promise<{ pubkey: string; account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }[]> {
  const res = await fetch(secrets.rpcHttp as string, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { programId }, { encoding: 'jsonParsed' }] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];
  const j = (await res.json()) as { result?: { value?: unknown[] } };
  return (j.result?.value ?? []) as { pubkey: string; account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }[];
}

const found: Found[] = [];
for (const programId of TOKEN_PROGRAMS) {
  for (const a of await listOwned(programId)) {
    const info = a.account?.data?.parsed?.info;
    if (info?.mint === undefined || info.tokenAmount?.amount === undefined) continue;
    found.push({ address: a.pubkey, mint: info.mint, program: programId, amount: BigInt(info.tokenAmount.amount) });
  }
}

if (found.length === 0) { console.log('no token accounts owned by this wallet — nothing to recover'); process.exit(0); }
console.log(`token accounts owned: ${found.length}`);
for (const f of found) {
  console.log(`  ${f.address.slice(0, 12)}  mint ${f.mint.slice(0, 12)}  balance ${f.amount.toString()}`);
}

const empty = found.filter((f) => f.amount === 0n);
console.log('');
console.log(`empty and therefore closable: ${empty.length}   (a non-empty account is left alone)`);
if (empty.length === 0) process.exit(0);

let recovered = 0n;
for (const f of empty) {
  const { blockhash } = await rpc.getLatestBlockhash();
  const raw = encodeCloseAccountTransaction({
    owner, tokenAccount: f.address, tokenProgram: f.program, recentBlockhash: blockhash,
  });
  const decoded = decodeTransaction(raw);
  const rawB64 = Buffer.from(raw).toString('base64');

  const effect = await verifyCloseEffect(rpc, rawB64, decoded, f.address, owner);
  if (!effect.verified) {
    console.log(`  ${f.address.slice(0, 12)}  REFUSED: ${effect.refusals.map((r) => `${r.refusal}: ${r.detail}`).join('; ')}`);
    continue;
  }
  console.log(`  ${f.address.slice(0, 12)}  simulation clean, would return ${(effect.lamportDelta ?? 0n).toString()} lamports`);
  if (!APPLY) continue;

  const now = Date.now();
  const intent = closeAccountIntent({
    mint: f.mint, nowUtcMs: now,
    maxTotalFeeLamports: config.assumedSignatureFeeLamports + config.assumedPriorityFeeLamports,
    strategyVersion: config.strategyVersion, riskSnapshotHash: 'close-account',
  });
  const outcome = signer.sign({ raw, intent, effect, nowUtcMs: now });
  if (!outcome.signed) {
    console.log(`  ${f.address.slice(0, 12)}  SIGNER REFUSED (${outcome.kind}): ${outcome.detail}`);
    continue;
  }
  const sig = await rpc.send(outcome.transactionBase64);
  console.log(`  ${f.address.slice(0, 12)}  SENT ${sig}`);
  recovered += effect.lamportDelta ?? 0n;
}

console.log('');
if (APPLY) {
  console.log(`rent recovered: ${recovered.toString()} lamports (${(Number(recovered) / 1e9).toFixed(9)} SOL)`);
} else {
  console.log('dry run complete. Re-run with --apply to sign and send.');
}
