/**
 * Exit whatever this wallet is holding. Nothing else.
 *
 * Written because a one-shot trade landed its BUY and was then rate-limited on the sell, leaving a
 * real position open. An open position is the one state this system must always be able to leave,
 * so the exit path has no candidate selection, no scan, and no dependence on anything the entry
 * did — it reads what is held from the chain and sells it.
 *
 * It retries the aggregator patiently rather than failing fast: a 429 between the buy and the sell
 * is transient, and giving up on it is how a transient error becomes a stranded position.
 *
 * Every per-transaction check is intact — policy, binding, effect-by-simulation — through the
 * signer's single entry point. Being in a hurry is not a reason to sign something unverified.
 */
import { loadConfig, loadSecrets, modeFromArgv } from '../packages/domain/src/config.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { ExecutionRpc } from '../packages/execution/src/rpc.js';
import { Signer } from '../packages/execution/src/signer.js';
import { buildSignableOrder } from '../packages/execution/src/order.js';
import { verifyEffect } from '../packages/execution/src/effect.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import type { TradeIntent } from '../packages/domain/src/types.js';
import { minOutputOnEffectBasis } from '../packages/execution/src/quote-basis.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const APPLY = process.argv.includes('--apply');
const SLIPPAGE_BPS = Number(arg('slippage-bps') ?? '300');
const ATTEMPTS = Number(arg('attempts') ?? '12');

const config = loadConfig(modeFromArgv(process.argv));
const secrets = loadSecrets();
if (secrets.tradingKeypairPath === null || secrets.rpcHttp === null) { console.error('keypair or rpc missing'); process.exit(2); }

const signer = Signer.fromFile(secrets.tradingKeypairPath);
const owner = signer.publicKey;
const limiter = new RateLimiter([
  { bucket: 'solana_rpc', requestsPerSecond: 8, burst: 8 },
  { bucket: 'jupiter_main', requestsPerSecond: 1, burst: 1 },
]);
const rpc = new ExecutionRpc(limiter, { primary: secrets.rpcHttp, fallback: secrets.rpcHttpFallback ?? null });

const bal = await rpc.getAccounts([owner]);
console.log(`owner ${owner}`);
console.log(`balance ${(Number(bal[0]?.lamports ?? 0n) / 1e9).toFixed(9)} SOL`);

interface Held { mint: string; amount: bigint; program: string }
const held: Held[] = [];
for (const programId of TOKEN_PROGRAMS) {
  const res = await fetch(secrets.rpcHttp, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { programId }, { encoding: 'jsonParsed' }] }),
  });
  const j = (await res.json()) as { result?: { value?: { account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }[] } };
  for (const a of j.result?.value ?? []) {
    const info = a.account?.data?.parsed?.info;
    if (info?.mint === undefined || info.tokenAmount?.amount === undefined) continue;
    const amt = BigInt(info.tokenAmount.amount);
    if (amt > 0n && info.mint !== WSOL) held.push({ mint: info.mint, amount: amt, program: programId });
  }
}

if (held.length === 0) { console.log('holding nothing — no position to exit'); process.exit(0); }
for (const h of held) console.log(`  HOLDING ${h.amount.toString()} of ${h.mint}`);
if (!APPLY) { console.log('dry run — re-run with --apply to sell'); process.exit(0); }

for (const h of held) {
  console.log('');
  console.log(`SELLING ${h.mint}`);
  let sold = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !sold; attempt += 1) {
    try {
      const order = await buildSignableOrder(limiter, secrets.jupiterApiKey, {
        inputMint: h.mint, outputMint: WSOL, amount: h.amount, slippageBps: SLIPPAGE_BPS, taker: owner,
      });
      const raw = order.transaction;
      const decoded = decodeTransaction(raw);
      const now = Date.now();
      // MT136: the quote reports gross proceeds; the effect check reports NET lamports when the
      // output is SOL. Comparing them directly refused three good sells on a live position.
      const minOut = minOutputOnEffectBasis({ outputMint: WSOL, quotedOut: order.quote.outAmount, slippageBps: SLIPPAGE_BPS });
      const intent: TradeIntent = {
        intentId: `exit-${String(now)}`, idempotencyKey: `exit-${String(now)}`,
        mint: h.mint, side: 'sell', inputMint: h.mint, outputMint: WSOL,
        maxInputAmount: h.amount, minOutputAmount: minOut,
        maxTotalFeeLamports: 8_000_000n, maxPriorityFeeLamports: 200_000n,
        deadlineUtcMs: now + 60_000, strategyVersion: config.strategyVersion,
        riskSnapshotHash: 'exit', createdUtcMs: now,
      };
      const effect = await verifyEffect(rpc, Buffer.from(raw).toString('base64'), decoded, intent, owner);
      if (!effect.verified) {
        console.log(`  attempt ${attempt}: effect refused — ${effect.refusals.map((r) => `${r.refusal}: ${r.detail}`).join('; ')}`);
        await new Promise((r) => setTimeout(r, 6_000));
        continue;
      }
      const outcome = signer.sign({ raw, intent, effect, nowUtcMs: Date.now() });
      if (!outcome.signed) {
        console.log(`  attempt ${attempt}: signer refused (${outcome.kind}) — ${outcome.detail}`);
        await new Promise((r) => setTimeout(r, 6_000));
        continue;
      }
      const sig = await rpc.send(outcome.transactionBase64);
      console.log(`  quoted ${order.quote.outAmount.toString()} lamports back`);
      console.log(`  SOLD ${sig}`);
      sold = true;
    } catch (e) {
      console.log(`  attempt ${attempt}: ${(e as Error).message.slice(0, 110)}`);
      await new Promise((r) => setTimeout(r, 8_000));
    }
  }
  if (!sold) console.log(`  COULD NOT SELL after ${ATTEMPTS} attempts — position still open`);
}

await new Promise((r) => setTimeout(r, 12_000));
const end = await rpc.getAccounts([owner]);
console.log('');
console.log(`final balance ${(Number(end[0]?.lamports ?? 0n) / 1e9).toFixed(9)} SOL`);
